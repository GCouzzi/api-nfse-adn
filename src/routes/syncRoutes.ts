import { Router } from "express";
import { syncController } from "../controllers/syncController";

const router = Router();

// Dispara a sincronização de NSUs para um CNPJ (assíncrono por padrão)
router.post("/", (req, res) => syncController.sincronizar(req, res));

// Consulta histórico de jobs de sincronização
router.get("/jobs", (req, res) => syncController.listarJobs(req, res));

// Consulta detalhes e status de um job específico pelo ID
router.get("/jobs/:id", (req, res) => syncController.obterJob(req, res));

// Obtém o status da sincronização e último NSU registrado para um CNPJ
router.get("/:cnpj", (req, res) => syncController.obterStatus(req, res));

export default router;
