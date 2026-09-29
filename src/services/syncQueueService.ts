import repository from "../database";
import { syncService, type SyncResult } from "./syncService";
import type { SyncJob } from "../types/models";

export interface QueueJobResult {
  job: SyncJob;
  isNew: boolean;
  alreadyRunning: boolean;
}

export class SyncQueueService {
  // Mutex Lock em memória por CNPJ para evitar sincronizações concorrentes no mesmo processo
  private activeLocks: Set<string> = new Set();
  private queue: Array<{ jobId: number; cnpj: string; nsuInicial?: number; maxLoops?: number }> = [];
  private isProcessing = false;

  constructor() {
    this.recoverInterruptedJobs();
  }

  /**
   * Recupera jobs que estavam em processamento caso o servidor tenha sido reiniciado
   */
  private async recoverInterruptedJobs(): Promise<void> {
    try {
      const pendingJobs = await repository.listSyncJobs(undefined, 50);
      for (const job of pendingJobs) {
        if (job.status === "PROCESSING") {
          // Marca como FAILED por interrupção de servidor para permitir novo disparo
          await repository.updateSyncJob(job.id, {
            status: "FAILED",
            erro: "Processo interrompido por reinicialização do servidor.",
            finished_at: new Date().toISOString()
          });
        }
      }
    } catch {
      // Ignora erro inicial se tabelas ainda não estiverem prontas
    }
  }

  /**
   * Enfileira uma solicitação de sincronização com Mutex Lock por CNPJ
   */
  async queueSync(cnpj: string, options?: { nsuInicial?: number; maxLoops?: number }): Promise<QueueJobResult> {
    const cleanCnpj = cnpj.replace(/\D/g, "");

    // 1. Verifica Lock em memória e no banco
    if (this.activeLocks.has(cleanCnpj)) {
      const activeJob = await repository.getActiveSyncJobByCnpj(cleanCnpj);
      if (activeJob) {
        return { job: activeJob, isNew: false, alreadyRunning: true };
      }
    }

    const dbActiveJob = await repository.getActiveSyncJobByCnpj(cleanCnpj);
    if (dbActiveJob) {
      this.activeLocks.add(cleanCnpj);
      return { job: dbActiveJob, isNew: false, alreadyRunning: true };
    }

    // 2. Adquire o Lock para este CNPJ
    this.activeLocks.add(cleanCnpj);

    // 3. Cria registro persistente do Job no banco
    const job = await repository.createSyncJob(cleanCnpj, options?.nsuInicial);

    // 4. Adiciona à fila de processamento em background
    this.queue.push({
      jobId: job.id,
      cnpj: cleanCnpj,
      nsuInicial: options?.nsuInicial,
      maxLoops: options?.maxLoops
    });

    // 5. Aciona o loop do worker em background (sem bloquear o HTTP)
    setTimeout(() => this.processNext(), 0);

    return { job, isNew: true, alreadyRunning: false };
  }

  /**
   * Worker que consome a fila em background
   */
  private async processNext(): Promise<void> {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const task = this.queue.shift();

    if (!task) {
      this.isProcessing = false;
      return;
    }

    const { jobId, cnpj, nsuInicial, maxLoops } = task;

    try {
      // Atualiza job para PROCESSING
      await repository.updateSyncJob(jobId, {
        status: "PROCESSING",
        started_at: new Date().toISOString()
      });

      // Executa a sincronização real no ADN
      const result: SyncResult = await syncService.sincronizarCnpj(cnpj, nsuInicial, maxLoops);

      // Atualiza job com resultado de sucesso
      await repository.updateSyncJob(jobId, {
        status: "COMPLETED",
        nsu_final: result.nsuFinal,
        novos_documentos: result.novosDocumentos,
        total_notas: result.totalNotas,
        total_eventos: result.totalEventos,
        ciclos_executados: result.ciclosExecutados,
        finished_at: new Date().toISOString()
      });
    } catch (error: any) {
      console.error(`[SyncQueue] Falha no Job #${jobId} (CNPJ: ${cnpj}):`, error.message);
      await repository.updateSyncJob(jobId, {
        status: "FAILED",
        erro: error.message || "Erro desconhecido",
        finished_at: new Date().toISOString()
      });
    } finally {
      // Libera o Mutex Lock para este CNPJ
      this.activeLocks.delete(cnpj);
      this.isProcessing = false;

      // Se houver mais jobs na fila, continua
      if (this.queue.length > 0) {
        setTimeout(() => this.processNext(), 50);
      }
    }
  }

  /**
   * Consulta o status de um Job específico
   */
  async getJob(id: number): Promise<SyncJob | null> {
    return repository.getSyncJob(id);
  }

  /**
   * Lista jobs recentes
   */
  async listJobs(cnpj?: string, limit?: number): Promise<SyncJob[]> {
    return repository.listSyncJobs(cnpj, limit);
  }

  /**
   * Verifica se há sincronização ativa para o CNPJ
   */
  isSyncing(cnpj: string): boolean {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    return this.activeLocks.has(cleanCnpj);
  }
}

export const syncQueueService = new SyncQueueService();
