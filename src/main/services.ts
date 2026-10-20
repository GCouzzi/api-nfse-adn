import repository from "../database";
import { config } from "../config/env";
import { CompanyService } from "../companies/companyService";
import { FolderCertificateProvider } from "../certificates/folderCertificateProvider";
import {
  GotenbergPdfRenderer,
  PuppeteerPdfRenderer,
  SerialPdfRenderer,
} from "../pdf/renderers";
import { DanfseService } from "../pdf/danfseService";
import { SyncService } from "../services/syncService";
import { CompanyAdnGatewayFactory } from "../services/adnClient";
import { PdfExportService } from "../pdf/pdfExportService";
import type { CertificateRegistry } from "../application/contracts";

// Composition root. Domain services only depend on the contracts they consume.
export const companies = new CompanyService(
  repository.application,
  config.adnEnv,
);
export const certificates: CertificateRegistry = new FolderCertificateProvider(
  repository.application,
  config.certificatesDir,
  () => config.certificateEncryptionKey,
  config.certPath,
  config.certBase64,
);
export const pdfRenderer = new SerialPdfRenderer(
  config.pdfRenderer === "puppeteer"
    ? new PuppeteerPdfRenderer(config.chromiumPath, config.pdfTimeoutMs)
    : new GotenbergPdfRenderer(
        config.gotenbergUrl,
        config.pdfTimeoutMs,
        config.gotenbergUsername,
        config.gotenbergPassword,
      ),
);
export const danfse = new DanfseService(repository, pdfRenderer, config.adnEnv);
export const syncService = new SyncService(
  repository,
  companies,
  new CompanyAdnGatewayFactory(certificates, config.enableMock),
);
export const pdfExports = new PdfExportService(
  repository,
  danfse,
  config.adnEnv,
  config.pdfTempDir,
  config.pdfExportTtlMs,
);
