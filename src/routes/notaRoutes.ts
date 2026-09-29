import { Router } from "express";
import { notaController } from "../controllers/notaController";

const router = Router();

// findAllByCnpj: Lista todas as notas fiscais de um CNPJ com eventos e metadados de XMLs
router.get("/", (req, res) => notaController.listarPorCnpj(req, res));

// Download em lote (.zip) de todos os XMLs de notas e eventos de um CNPJ
router.get("/cnpj/:cnpj/zip", (req, res) => notaController.baixarZipCnpj(req, res));

// Busca uma nota fiscal específica com seus eventos e documentos vinculados
router.get("/:chaveAcesso", (req, res) => notaController.obterPorChave(req, res));

// Download direto do XML da NFS-e
router.get("/:chaveAcesso/xml", (req, res) => notaController.baixarXmlNota(req, res));

// Download em ZIP da NFS-e + todos os seus eventos
router.get("/:chaveAcesso/zip", (req, res) => notaController.baixarZipNota(req, res));

// Download de um documento XML individual por ID
router.get("/documento/:id/xml", (req, res) => notaController.baixarXmlDocumento(req, res));

export default router;
