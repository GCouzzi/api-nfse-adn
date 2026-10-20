import { Router } from "express";
import syncRoutes from "./syncRoutes";
import notaRoutes from "./notaRoutes";
import companyRoutes from "./companyRoutes";
import pdfRoutes from "./pdfRoutes";
import { companyContext } from "../middlewares/companyContext";

const router = Router();

router.use("/sync", syncRoutes);
router.use(companyRoutes);
router.use("/notas", companyContext, pdfRoutes, notaRoutes);

export default router;
