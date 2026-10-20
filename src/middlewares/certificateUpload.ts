import type { RequestHandler } from "express";
import multer from "multer";
import {
  ApplicationError,
  MAX_CERTIFICATE_BYTES,
} from "../application/contracts";

const receive = multer({
  storage: multer.memoryStorage(),
  preservePath: true,
  limits: {
    fileSize: MAX_CERTIFICATE_BYTES,
    files: 1,
    fields: 1,
    parts: 2,
    fieldNameSize: 100,
    fieldSize: 4000,
    headerPairs: 100,
  },
  fileFilter: (_req, file, callback) => {
    if (
      file.originalname.length > 255 ||
      !/^[^/\\\x00:]+\.(pfx|p12)$/i.test(file.originalname)
    ) {
      callback(
        new ApplicationError("Envie um arquivo .pfx ou .p12 com nome válido."),
      );
      return;
    }
    callback(null, true);
  },
}).single("arquivo");

// Mounted only on certificate upload routes, after API authentication.
export const receiveCertificateUpload: RequestHandler = (req, res, next) => {
  if (!req.is("multipart/form-data")) {
    next(
      new ApplicationError(
        "Envie o certificado como multipart/form-data.",
        415,
      ),
    );
    return;
  }
  receive(req, res, (error: unknown) => {
    if (!error) return next();
    if (error instanceof ApplicationError) return next(error);
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE")
      return next(
        new ApplicationError("O certificado deve ter até 10 MB.", 413),
      );
    next(
      new ApplicationError(
        "Envio inválido. Informe somente um arquivo no campo arquivo e a senha no campo senha.",
      ),
    );
  });
};
