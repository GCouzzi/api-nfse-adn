import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { ZipFile } from "yazl";
import { ApplicationError } from "../application/contracts";
import type { Company, Environment, PdfExport } from "../application/contracts";
import type { IDatabaseRepository } from "../database/types";
import { DanfseService } from "./danfseService";

const validId = (id: string) =>
  /^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id);

export class PdfExportService {
  private readonly queue: Array<{
    job: PdfExport;
    company: Company;
    keys: string[];
  }> = [];
  private running?: Promise<void>;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly downloading = new Set<string>();

  constructor(
    private readonly repository: IDatabaseRepository,
    private readonly danfse: DanfseService,
    private readonly environment: Environment,
    private readonly directory: string,
    private readonly ttlMs: number,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const job of await this.repository.application.listExports()) {
      if (["PROCESSING", "QUEUED"].includes(job.status)) {
        await this.repository.application.updateExport(job.id, {
          status: "FAILED",
          erro: "Exportação interrompida pela reinicialização. Solicite um novo pacote.",
        });
        await this.remove(job.id);
      }
    }
    await this.cleanup();
    this.timer = setInterval(() => {
      void this.cleanup().catch(() =>
        console.error("Falha na limpeza das exportações PDF."),
      );
    }, 60000);
    this.timer.unref();
  }

  async create(company: Company, competencia?: string): Promise<PdfExport> {
    if (this.stopping || this.queue.length >= 10)
      throw new ApplicationError(
        "A fila de exportação está cheia. Tente novamente em instantes.",
        429,
      );
    const keys = await this.repository.application.exportNoteKeys(
      company.id,
      this.environment,
      competencia,
    );
    if (!keys.length)
      throw new ApplicationError(
        "Nenhuma nota encontrada para exportação.",
        404,
      );
    const job: PdfExport = {
      id: crypto.randomUUID(),
      empresa_id: company.id,
      ambiente: this.environment,
      status: "QUEUED",
      competencia: competencia ?? null,
      total: keys.length,
      processadas: 0,
      falhas: 0,
      erro: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + this.ttlMs).toISOString(),
    };
    await this.repository.application.createExport(job);
    this.queue.push({ job, company, keys });
    this.start();
    return job;
  }

  private start(): void {
    if (this.running || this.stopping) return;
    this.running = this.work().finally(() => {
      this.running = undefined;
      if (this.queue.length && !this.stopping) this.start();
    });
  }

  private async work(): Promise<void> {
    while (this.queue.length && !this.stopping) {
      const task = this.queue.shift()!;
      const { job, company, keys } = task;
      const folder = this.folder(job.id);
      const failures: Array<{ chave: string; erro: string }> = [];
      const zip = new ZipFile();
      let archive: Promise<void> | undefined;
      try {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await this.repository.application.updateExport(job.id, {
          status: "PROCESSING",
        });
        for (const chave of keys) {
          if (this.stopping)
            throw new Error(
              "Exportação interrompida pelo encerramento da aplicação.",
            );
          try {
            const pdf = await this.danfse.generate(company, chave);
            const filename = `DANFSe_${chave}.pdf`;
            const file = path.join(folder, filename);
            await writeFile(file, pdf, { mode: 0o600 });
            zip.addFile(file, filename);
          } catch (error) {
            failures.push({
              chave,
              erro:
                error instanceof ApplicationError
                  ? error.message
                  : "Falha ao gerar o PDF desta nota.",
            });
          }
          job.processadas++;
          await this.repository.application.updateExport(job.id, {
            processadas: job.processadas,
            falhas: failures.length,
          });
        }
        if (failures.length === keys.length)
          throw new Error(
            "Não foi possível gerar nenhum PDF. Verifique o renderizador e os XMLs.",
          );
        if (failures.length)
          zip.addBuffer(
            Buffer.from(JSON.stringify(failures, null, 2)),
            "falhas.json",
          );
        archive = pipeline(
          zip.outputStream,
          createWriteStream(path.join(folder, "pdfs.zip"), { mode: 0o600 }),
        );
        zip.end();
        await archive;
        for (const name of await readdir(folder))
          if (name.endsWith(".pdf")) await rm(path.join(folder, name));
        await this.repository.application.updateExport(job.id, {
          status: failures.length ? "PARTIAL" : "COMPLETED",
          falhas: failures.length,
          erro: failures.length
            ? `${failures.length} nota(s) não puderam ser geradas. Consulte falhas.json no pacote.`
            : null,
          expires_at: new Date(Date.now() + this.ttlMs).toISOString(),
        });
      } catch (error) {
        (zip.outputStream as Readable).destroy();
        await archive?.catch(() => {});
        await this.remove(job.id);
        await this.repository.application.updateExport(job.id, {
          status: "FAILED",
          erro: error instanceof Error ? error.message : "Falha na exportação.",
        });
      }
    }
  }

  async list(company: Company): Promise<PdfExport[]> {
    const jobs = await this.repository.application.listExports(
      company.id,
      this.environment,
      20,
    );
    for (const job of jobs) {
      if (this.isExpired(job)) {
        await this.expire(job.id);
        job.status = "EXPIRED";
      }
    }
    return jobs;
  }

  private isExpired(job: PdfExport): boolean {
    return (
      ["COMPLETED", "PARTIAL"].includes(job.status) &&
      Date.parse(job.expires_at) <= Date.now() &&
      !this.downloading.has(job.id)
    );
  }

  async get(id: string, company: Company): Promise<PdfExport> {
    if (!validId(id))
      throw new ApplicationError("Exportação não encontrada.", 404);
    let job = await this.repository.application.getExport(id);
    if (
      !job ||
      job.empresa_id !== company.id ||
      job.ambiente !== this.environment
    )
      throw new ApplicationError("Exportação não encontrada.", 404);
    if (this.isExpired(job)) {
      await this.expire(id);
      job = { ...job, status: "EXPIRED" };
    }
    return job;
  }

  async claim(id: string, company: Company) {
    const job = await this.get(id, company);
    if (job.status === "EXPIRED")
      throw new ApplicationError(
        "O pacote expirou. Gere uma nova exportação.",
        410,
      );
    if (!["COMPLETED", "PARTIAL"].includes(job.status))
      throw new ApplicationError("O pacote ainda não está disponível.", 409);
    if (this.downloading.has(id))
      throw new ApplicationError("Este pacote já está sendo transferido.", 409);
    this.downloading.add(id);
    return { job, file: path.join(this.folder(id), "pdfs.zip") };
  }

  async release(id: string): Promise<void> {
    this.downloading.delete(id);
    await this.expire(id);
  }

  private folder(id: string): string {
    if (!validId(id)) throw new Error("Identificador de exportação inválido.");
    return path.join(this.directory, id);
  }

  private async remove(id: string): Promise<void> {
    await rm(this.folder(id), { recursive: true, force: true });
  }

  private async expire(id: string): Promise<void> {
    await this.remove(id);
    await this.repository.application.updateExport(id, { status: "EXPIRED" });
  }

  async cleanup(): Promise<void> {
    for (const job of await this.repository.application.listExports()) {
      if (
        ["COMPLETED", "PARTIAL"].includes(job.status) &&
        Date.parse(job.expires_at) <= Date.now() &&
        !this.downloading.has(job.id)
      )
        await this.expire(job.id);
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.running;
    for (const task of this.queue.splice(0))
      await this.repository.application.updateExport(task.job.id, {
        status: "FAILED",
        erro: "Aplicação encerrada antes do processamento.",
      });
  }
}
