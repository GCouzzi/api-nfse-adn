import { parseNotaQuery, validateCnpj, NotaQueryError } from "./notaQuery";
import type { Request, Response } from "express";
import { notaService } from "../services/notaService";
import { companies } from "../main/services";
import { config } from "../config/env";
import type { Company } from "../application/contracts";
import { ApplicationError } from "../application/contracts";
import repository from "../database";

const errorStatus = (error: unknown, fallback = 500) =>
  error instanceof ApplicationError
    ? error.status
    : error instanceof NotaQueryError
      ? 400
      : fallback;

function scope(res: Response) {
  const company = res.locals.company as Company;
  return { empresaId: company.id, ambiente: config.adnEnv };
}

export class NotaController {
  /**
   * GET /api/notas?cnpj=...&papel=todos&status=AUTORIZADA
   * Retorna todas as notas fiscais de um CNPJ com seus eventos e metadados de XMLs
   */
  async listarPorCnpj(req: Request, res: Response): Promise<void> {
    try {
      const cnpj = (res.locals.company as Company).cnpj;
      if (!cnpj) {
        res
          .status(400)
          .json({ error: "O parâmetro query 'cnpj' é obrigatório." });
        return;
      }

      validateCnpj(cnpj);
      const options = { ...parseNotaQuery(req.query), ...scope(res) };
      const notas = await notaService.findAllByCnpj(cnpj, options);

      res.status(200).json({
        success: true,
        total: notas.length,
        data: notas,
      });
    } catch (error: any) {
      res
        .status(errorStatus(error))
        .json({ success: false, error: error.message });
    }
  }

  /**
   * GET /api/notas/:chaveAcesso
   * Retorna os detalhes de uma nota fiscal por chave de acesso
   */
  async obterPorChave(req: Request, res: Response): Promise<void> {
    try {
      const { chaveAcesso } = req.params;
      await companies.assertNote(res.locals.company, chaveAcesso);
      const nota = await notaService.findByChave(chaveAcesso);

      if (!nota) {
        res.status(404).json({ error: "Nota fiscal não encontrada no banco." });
        return;
      }
      const nsus = await repository.application.noteNsus(
        res.locals.company.id,
        config.adnEnv,
        [chaveAcesso],
      );
      nota.nsu = nsus.get(chaveAcesso) ?? nota.nsu;

      res.status(200).json({
        success: true,
        data: nota,
      });
    } catch (error: any) {
      res
        .status(errorStatus(error))
        .json({ success: false, error: error.message });
    }
  }

  /**
   * GET /api/notas/:chaveAcesso/xml
   * Faz o download direto do XML original da NFS-e
   */
  async baixarXmlNota(req: Request, res: Response): Promise<void> {
    try {
      const { chaveAcesso } = req.params;
      await companies.assertNote(res.locals.company, chaveAcesso);
      const xml = await notaService.getXmlByChave(chaveAcesso, "NFSE");

      if (!xml) {
        res.status(404).json({
          error: "XML da NFS-e não encontrado para a chave informada.",
        });
        return;
      }

      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="NFSe_${chaveAcesso}.xml"`,
      );
      res.status(200).send(xml);
    } catch (error: any) {
      res
        .status(errorStatus(error))
        .json({ success: false, error: error.message });
    }
  }

  /**
   * GET /api/documentos/:id/xml
   * Faz o download de um XML específico (NFS-e ou Evento) pelo ID
   */
  async baixarXmlDocumento(req: Request, res: Response): Promise<void> {
    try {
      const id = Number(req.params.id);
      const doc = await notaService.getXmlById(id);

      if (!doc) {
        res.status(404).json({ error: "Documento XML não encontrado." });
        return;
      }
      await companies.assertNote(res.locals.company, doc.chave_acesso);

      const fileName =
        doc.tipo_documento === "NFSE"
          ? `NFSe_${doc.chave_acesso}.xml`
          : `Evento_${doc.tipo_evento || doc.tipo_documento}_${doc.chave_acesso}.xml`;

      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`,
      );
      res.status(200).send(doc.xml_conteudo);
    } catch (error: any) {
      res
        .status(errorStatus(error))
        .json({ success: false, error: error.message });
    }
  }

  /**
   * GET /api/notas/:chaveAcesso/zip
   * Baixa um arquivo ZIP contendo a NFS-e e todos os seus eventos
   */
  async baixarZipNota(req: Request, res: Response): Promise<void> {
    try {
      const { chaveAcesso } = req.params;
      await companies.assertNote(res.locals.company, chaveAcesso);
      const zipBuffer = await notaService.generateZipForNota(chaveAcesso);

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="NFSe_completa_${chaveAcesso}.zip"`,
      );
      res.status(200).send(zipBuffer);
    } catch (error: any) {
      res
        .status(errorStatus(error, 400))
        .json({ success: false, error: error.message });
    }
  }

  /**
   * GET /api/cnpjs/:cnpj/zip
   * Baixa um arquivo ZIP contendo todos os XMLs de notas e eventos de um CNPJ
   */
  async baixarZipCnpj(req: Request, res: Response): Promise<void> {
    try {
      const { cnpj } = req.params;
      validateCnpj(cnpj);
      const options = { ...parseNotaQuery(req.query), ...scope(res) };
      const zipBuffer = await notaService.generateZipForCnpj(cnpj, options);
      const suffix = options.competencia ? `_${options.competencia}` : "";

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Pacote_XMLs_${cnpj}${suffix}.zip"`,
      );
      res.status(200).send(zipBuffer);
    } catch (error: any) {
      res
        .status(errorStatus(error, 400))
        .json({ success: false, error: error.message });
    }
  }
}

export const notaController = new NotaController();
