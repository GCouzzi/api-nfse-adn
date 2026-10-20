import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { ApplicationError } from "../application/contracts";
import type {
  ApplicationRepository,
  CertificateRegistry,
} from "../application/contracts";
import { receiveCertificateUpload } from "../middlewares/certificateUpload";

export function createCertificateUploadRoutes(
  certificates: CertificateRegistry,
  repository: ApplicationRepository,
) {
  const router = Router();
  async function upload(req: Request, res: Response) {
    const password = req.body?.senha;
    if (
      !req.file ||
      typeof password !== "string" ||
      Object.keys(req.body).some((key) => key !== "senha")
    )
      throw new ApplicationError("Informe o arquivo e a senha do certificado.");
    const id = req.params.id;
    if (id && !(await repository.getCertificate(id)))
      throw new ApplicationError("Certificado não encontrado.", 404);
    const { senha_criptografada: _secret, ...record } =
      await certificates.upload(
        {
          filename: req.file.originalname,
          content: req.file.buffer,
          password,
        },
        id,
      );
    res.status(id ? 200 : 201).json({ success: true, data: record });
  }
  const handler = (req: Request, res: Response, next: NextFunction) => {
    upload(req, res).catch(next);
  };
  router.post("/certificados/upload", receiveCertificateUpload, handler);
  router.put("/certificados/:id/upload", receiveCertificateUpload, handler);
  return router;
}
