import repository from "../database";
import { companies, syncService } from "../main/services";
import { ApplicationError } from "../application/contracts";
import type { SyncJob } from "../types/models";

export interface QueueJobResult {
  job: SyncJob;
  isNew: boolean;
  alreadyRunning: boolean;
}

export class SyncQueueService {
  private readonly pending = new Map<string, Promise<QueueJobResult>>();
  private readonly active = new Set<string>();
  private readonly queue: Array<{
    job: SyncJob;
    nsuInicial?: number;
    maxLoops?: number;
  }> = [];
  private worker?: Promise<void>;
  private stopping = false;

  async init(): Promise<void> {
    for (const job of await repository.listSyncJobs(undefined, 100000)) {
      if (["QUEUED", "PROCESSING"].includes(job.status)) {
        await repository.updateSyncJob(job.id, {
          status: "FAILED",
          erro: "Sincronização interrompida pela reinicialização. Solicite uma nova execução.",
          finished_at: new Date().toISOString(),
        });
      }
    }
  }

  async queueSync(
    cnpj: string,
    options: { nsuInicial?: number; maxLoops?: number } = {},
  ): Promise<QueueJobResult> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    if (this.stopping)
      throw new ApplicationError("Aplicação em encerramento.", 503);
    if (
      options.nsuInicial !== undefined &&
      (!Number.isSafeInteger(options.nsuInicial) || options.nsuInicial < 0)
    )
      throw new ApplicationError("NSU inicial inválido.");
    if (
      options.maxLoops !== undefined &&
      (!Number.isSafeInteger(options.maxLoops) ||
        options.maxLoops < 1 ||
        options.maxLoops > 10000)
    )
      throw new ApplicationError("maxLoops deve estar entre 1 e 10000.");
    const pending = this.pending.get(cleanCnpj);
    if (pending)
      return { ...(await pending), alreadyRunning: true, isNew: false };
    const submission = this.submit(cleanCnpj, options);
    this.pending.set(cleanCnpj, submission);
    try {
      return await submission;
    } finally {
      this.pending.delete(cleanCnpj);
    }
  }

  private async submit(
    cnpj: string,
    options: { nsuInicial?: number; maxLoops?: number },
  ): Promise<QueueJobResult> {
    await companies.byCnpj(cnpj, true);
    const activeJob = await repository.getActiveSyncJobByCnpj(cnpj);
    if (activeJob)
      return { job: activeJob, alreadyRunning: true, isNew: false };
    const job = await repository.createSyncJob(cnpj, options.nsuInicial);
    this.active.add(cnpj);
    this.queue.push({ job, ...options });
    this.start();
    return { job, alreadyRunning: false, isNew: true };
  }

  private start(): void {
    if (this.worker || this.stopping) return;
    this.worker = this.work().finally(() => {
      this.worker = undefined;
      if (this.queue.length && !this.stopping) this.start();
    });
  }

  private async work(): Promise<void> {
    while (this.queue.length && !this.stopping) {
      const { job, nsuInicial, maxLoops } = this.queue.shift()!;
      try {
        await repository.updateSyncJob(job.id, {
          status: "PROCESSING",
          started_at: new Date().toISOString(),
        });
        const result = await syncService.sincronizarCnpj(
          job.cnpj,
          nsuInicial,
          maxLoops,
        );
        await repository.updateSyncJob(job.id, {
          status: "COMPLETED",
          nsu_final: result.nsuFinal,
          novos_documentos: result.novosDocumentos,
          total_notas: result.totalNotas,
          total_eventos: result.totalEventos,
          ciclos_executados: result.ciclosExecutados,
          finished_at: new Date().toISOString(),
        });
      } catch (error) {
        await repository.updateSyncJob(job.id, {
          status: "FAILED",
          erro:
            error instanceof Error ? error.message : "Falha na sincronização.",
          finished_at: new Date().toISOString(),
        });
      } finally {
        this.active.delete(job.cnpj);
      }
    }
  }

  getJob(id: number) {
    return repository.getSyncJob(id);
  }
  listJobs(cnpj?: string, limit?: number) {
    return repository.listSyncJobs(cnpj, limit);
  }
  isSyncing(cnpj: string) {
    return this.active.has(cnpj.replace(/\D/g, ""));
  }

  async close(): Promise<void> {
    this.stopping = true;
    await this.worker;
    for (const { job } of this.queue.splice(0))
      await repository.updateSyncJob(job.id, {
        status: "FAILED",
        erro: "Aplicação encerrada antes do processamento.",
        finished_at: new Date().toISOString(),
      });
  }
}

export const syncQueueService = new SyncQueueService();
