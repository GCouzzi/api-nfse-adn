import type { Request, Response } from "express";
import { syncService, companies } from "../main/services";
import { ApplicationError } from "../application/contracts";
import { syncQueueService } from "../services/syncQueueService";

export class SyncController {
  /**
   * POST /api/sync
   * Dispara sincronização com Mutex Lock por CNPJ e suporte a modo assíncrono (default) ou síncrono
   */
  async sincronizar(req: Request, res: Response): Promise<void> {
    try {
      const { cnpj, nsuInicial, maxLoops } = req.body;
      const isAsync = req.body.async !== false && req.query.sync !== "true";

      if (!cnpj) {
        res.status(400).json({
          success: false,
          error: "O campo 'cnpj' é obrigatório no corpo da requisição.",
        });
        return;
      }
      await companies.byCnpj(String(cnpj), true);

      // Modo Assíncrono (Padrão): Enfileira na fila com Mutex Lock e responde 202 imediatamente
      if (isAsync) {
        const queueResult = await syncQueueService.queueSync(String(cnpj), {
          nsuInicial: nsuInicial !== undefined ? Number(nsuInicial) : undefined,
          maxLoops: maxLoops !== undefined ? Number(maxLoops) : 10,
        });

        if (queueResult.alreadyRunning) {
          res.status(409).json({
            success: false,
            message: "Já existe uma sincronização em andamento para este CNPJ.",
            data: queueResult.job,
          });
          return;
        }

        res.status(202).json({
          success: true,
          message: "Sincronização enfileirada com sucesso em segundo plano.",
          data: queueResult.job,
        });
        return;
      }

      // Both modes share the queue and the same per-company exclusion.
      const submitted = await syncQueueService.queueSync(String(cnpj), {
        nsuInicial: nsuInicial === undefined ? undefined : Number(nsuInicial),
        maxLoops: maxLoops === undefined ? 10 : Number(maxLoops),
      });
      if (submitted.alreadyRunning) {
        res.status(409).json({
          success: false,
          error: "Já existe uma sincronização em andamento para este CNPJ.",
        });
        return;
      }

      let completed = submitted.job;
      while (["QUEUED", "PROCESSING"].includes(completed.status)) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        completed = (await syncQueueService.getJob(completed.id))!;
      }
      if (completed.status === "FAILED")
        throw new ApplicationError(
          completed.erro || "A sincronização falhou.",
          502,
        );
      const result = {
        cnpj: completed.cnpj,
        nsuInicial: completed.nsu_inicial,
        nsuFinal: completed.nsu_final,
        novosDocumentos: completed.novos_documentos,
        totalNotas: completed.total_notas,
        totalEventos: completed.total_eventos,
        ciclosExecutados: completed.ciclos_executados,
      };

      res.status(200).json({
        success: true,
        message: "Sincronização concluída com sucesso.",
        data: result,
      });
    } catch (error: any) {
      console.error("Erro na sincronização:", error);
      res.status(error instanceof ApplicationError ? error.status : 500).json({
        success: false,
        error:
          error.message || "Erro interno ao processar sincronização com o ADN.",
      });
    }
  }

  /**
   * GET /api/sync/jobs/:id
   * Consulta o andamento e resultado de um job específico
   */
  async obterJob(req: Request, res: Response): Promise<void> {
    try {
      const id = Number(req.params.id);
      const job = await syncQueueService.getJob(id);

      if (!job) {
        res.status(404).json({
          success: false,
          error: "Job de sincronização não encontrado.",
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: job,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * GET /api/sync/jobs?cnpj=...
   * Lista histórico de jobs de sincronização
   */
  async listarJobs(req: Request, res: Response): Promise<void> {
    try {
      const cnpj = req.query.cnpj as string | undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 20;

      const jobs = await syncQueueService.listJobs(cnpj, limit);
      res.status(200).json({
        success: true,
        total: jobs.length,
        data: jobs,
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * GET /api/sync/:cnpj
   * Retorna o status atual do controle de sincronização e último NSU
   */
  async obterStatus(req: Request, res: Response): Promise<void> {
    try {
      const { cnpj } = req.params;
      if (!cnpj) {
        res
          .status(400)
          .json({ success: false, error: "O parâmetro 'cnpj' é obrigatório." });
        return;
      }

      const status = await syncService.getOrCreateSyncControle(cnpj);
      const isSyncing = syncQueueService.isSyncing(cnpj);

      res.status(200).json({
        success: true,
        data: {
          ...status,
          emExecucao: isSyncing,
        },
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
}

export const syncController = new SyncController();
