import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { danfse, pdfExports } from "../main/services";
import { ApplicationError } from "../application/contracts";
import { isCompetencia } from "../database/notaFilters";

const router = Router();
const handler =
  (action: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    action(req, res).catch(next);
  };

router.get(
  "/:chaveAcesso/pdf",
  handler(async (req, res) => {
    const pdf = await danfse.generate(
      res.locals.company,
      req.params.chaveAcesso,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.attachment(`DANFSe_${req.params.chaveAcesso}.pdf`).send(pdf);
  }),
);

router.get(
  "/pdf/exportacoes",
  handler(async (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      success: true,
      data: await pdfExports.list(res.locals.company),
    });
  }),
);

router.post(
  "/pdf/exportacoes",
  handler(async (req, res) => {
    const competencia = req.body?.competencia;
    if (
      competencia !== undefined &&
      (typeof competencia !== "string" || !isCompetencia(competencia))
    )
      throw new ApplicationError("Competência inválida. Use AAAA-MM.");
    res.status(202).json({
      success: true,
      data: await pdfExports.create(res.locals.company, competencia),
    });
  }),
);

router.get(
  "/pdf/exportacoes/:id",
  handler(async (req, res) => {
    res.json({
      success: true,
      data: await pdfExports.get(req.params.id, res.locals.company),
    });
  }),
);

router.get(
  "/pdf/exportacoes/:id/arquivo",
  handler(async (req, res) => {
    const { job, file } = await pdfExports.claim(
      req.params.id,
      res.locals.company,
    );
    res.setHeader("Cache-Control", "no-store");
    const name = `PDFs_${res.locals.company.cnpj}${job.competencia ? `_${job.competencia}` : ""}.zip`;
    res.download(file, name, (error) => {
      void pdfExports
        .release(job.id)
        .catch(() =>
          console.error(
            "Não foi possível remover a exportação PDF finalizada.",
          ),
        );
      if (error && !res.headersSent && !res.destroyed)
        res.status(500).json({
          success: false,
          error:
            "Não foi possível transferir o pacote. Gere uma nova exportação.",
        });
    });
  }),
);

export default router;
