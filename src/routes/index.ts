import { Router } from "express";
import syncRoutes from "./syncRoutes";
import notaRoutes from "./notaRoutes";

const router = Router();

router.use("/sync", syncRoutes);
router.use("/notas", notaRoutes);

export default router;
