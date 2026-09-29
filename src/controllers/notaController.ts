import type { Request, Response } from "express";
import { notaService } from "../services/notaService";

export class NotaController {
  /**
   * GET /api/notas?cnpj=...&papel=todos&status=AUTORIZADA
   * Retorna todas as notas fiscais de um CNPJ com seus eventos e metadados de XMLs
   */
  async listarPorCnpj(req: Request, res: Response): Promise<void> {
    try {
      const cnpj = (req.query.cnpj || req.query.cnpjConsulta) as string;
      if (!cnpj) {
        res.status(400).json({ error: "O parâmetro query 'cnpj' é obrigatório." });
        return;
      }

      const status = req.query.status as string | undefined;
      const papel = req.query.papel as "prestador" | "tomador" | "todos" | undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      const offset = req.query.offset ? Number(req.query.offset) : 0;

      const notas = await notaService.findAllByCnpj(cnpj, { status, papel, limit, offset });

      res.status(200).json({
        success: true,
        total: notas.length,
        data: notas
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * GET /api/notas/:chaveAcesso
   * Retorna os detalhes de uma nota fiscal por chave de acesso
   */
  async obterPorChave(req: Request, res: Response): Promise<void> {
    try {
      const { chaveAcesso } = req.params;
      const nota = await notaService.findByChave(chaveAcesso);

      if (!nota) {
        res.status(404).json({ error: "Nota fiscal não encontrada no banco." });
        return;
      }

      res.status(200).json({
        success: true,
        data: nota
      });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * GET /api/notas/:chaveAcesso/xml
   * Faz o download direto do XML original da NFS-e
   */
  async baixarXmlNota(req: Request, res: Response): Promise<void> {
    try {
      const { chaveAcesso } = req.params;
      const xml = await notaService.getXmlByChave(chaveAcesso, "NFSE");

      if (!xml) {
        res.status(404).json({ error: "XML da NFS-e não encontrado para a chave informada." });
        return;
      }

      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="NFSe_${chaveAcesso}.xml"`);
      res.status(200).send(xml);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
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

      const fileName =
        doc.tipo_documento === "NFSE"
          ? `NFSe_${doc.chave_acesso}.xml`
          : `Evento_${doc.tipo_evento || doc.tipo_documento}_${doc.chave_acesso}.xml`;

      res.setHeader("Content-Type", "application/xml; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.status(200).send(doc.xml_conteudo);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }

  /**
   * GET /api/notas/:chaveAcesso/zip
   * Baixa um arquivo ZIP contendo a NFS-e e todos os seus eventos
   */
  async baixarZipNota(req: Request, res: Response): Promise<void> {
    try {
      const { chaveAcesso } = req.params;
      const zipBuffer = await notaService.generateZipForNota(chaveAcesso);

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="NFSe_completa_${chaveAcesso}.zip"`);
      res.status(200).send(zipBuffer);
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }

  /**
   * GET /api/cnpjs/:cnpj/zip
   * Baixa um arquivo ZIP contendo todos os XMLs de notas e eventos de um CNPJ
   */
  async baixarZipCnpj(req: Request, res: Response): Promise<void> {
    try {
      const { cnpj } = req.params;
      const zipBuffer = await notaService.generateZipForCnpj(cnpj);

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="Pacote_XMLs_${cnpj}.zip"`);
      res.status(200).send(zipBuffer);
    } catch (error: any) {
      res.status(400).json({ success: false, error: error.message });
    }
  }
}

export const notaController = new NotaController();
