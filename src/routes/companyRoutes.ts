import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import repository from "../database";
import { companies, certificates } from "../main/services";
import { ApplicationError } from "../application/contracts";
import { createCertificateUploadRoutes } from "./certificateUploadRoutes";

const router = Router();
const handler =
  (action: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    action(req, res).catch(next);
  };

router.get(
  "/empresas",
  handler(async (_req, res) => {
    const records = await repository.application.listCompanies();
    const certs = await repository.application.listCertificates();
    res.json({
      success: true,
      data: records.map((company) => {
        const certificate = certs.find(
          (cert) => cert.id === company.certificado_id,
        );
        return {
          ...company,
          certificado: certificate
            ? {
                titular: certificate.titular,
                validade: certificate.validade,
                arquivo: certificate.arquivo,
              }
            : null,
        };
      }),
    });
  }),
);

router.post(
  "/empresas",
  handler(async (req, res) => {
    res
      .status(201)
      .json({ success: true, data: await companies.save(req.body) });
  }),
);

router.put(
  "/empresas/:id",
  handler(async (req, res) => {
    res.json({
      success: true,
      data: await companies.save(req.body, req.params.id),
    });
  }),
);

router.get(
  "/certificados/arquivos",
  handler(async (_req, res) => {
    res.json({ success: true, data: await certificates.files() });
  }),
);

router.delete(
  "/empresas/:id",
  handler(async (req, res) => {
    await companies.remove(req.params.id);
    res.json({ success: true });
  }),
);

router.delete(
  "/certificados/:id",
  handler(async (req, res) => {
    res.json({ success: true, data: await certificates.remove(req.params.id) });
  }),
);

router.get(
  "/certificados",
  handler(async (_req, res) => {
    const data = (await repository.application.listCertificates()).map(
      ({ senha_criptografada: _secret, ...certificate }) => certificate,
    );
    res.json({ success: true, data });
  }),
);

async function saveCertificate(req: Request, res: Response) {
  const { arquivo, senha } = req.body ?? {};
  if (
    typeof arquivo !== "string" ||
    typeof senha !== "string" ||
    senha.length > 1000
  )
    throw new ApplicationError("Informe o arquivo e a senha do certificado.");
  const id = req.params.id;
  if (id && !(await repository.application.getCertificate(id)))
    throw new ApplicationError("Certificado não encontrado.", 404);
  const { senha_criptografada: _secret, ...record } =
    await certificates.register(arquivo, senha, id);
  res.status(id ? 200 : 201).json({ success: true, data: record });
}

router.post("/certificados", handler(saveCertificate));
router.put("/certificados/:id", handler(saveCertificate));

router.use(createCertificateUploadRoutes(certificates, repository.application));

export default router;
