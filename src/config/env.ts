import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

function readSecretFile(secretPath: string, envFallback = ""): string {
  try {
    if (fs.existsSync(secretPath)) {
      return fs.readFileSync(secretPath, "utf-8").trim();
    }
  } catch {
    // ignora se não for possível ler
  }
  return envFallback;
}

export interface AppConfig {
  port: number;
  adnEnv: "homologacao" | "producao";
  adnBaseUrl: string;
  certPath: string;
  certPassword?: string;
  certBase64?: string;
  enableMock: boolean;
  enableUi: boolean;
  dbClient: "postgres" | "sqlite";
  databaseUrl: string;
  pgPoolSize: number;
  dbPath: string;
  certificatesDir: string;
  certificateEncryptionKey: string;
  pdfRenderer: "gotenberg" | "puppeteer";
  gotenbergUrl: string;
  gotenbergUsername: string;
  gotenbergPassword: string;
  chromiumPath: string;
  pdfTempDir: string;
  pdfTimeoutMs: number;
  pdfExportTtlMs: number;

  // Autenticação da API
  apiToken: string;
  adminUsername: string;
  adminPassword: string;
  appOrigin: string;
  sessionSecure: boolean;

  // Rate Limiting (Inbound - requisições à nossa API)
  rateLimitWindowMs: number;
  rateLimitMax: number;

  // Throttling do ADN (Outbound - controle de requisições ao governo)
  adnRequestDelayMs: number;
  adnMaxRetries: number;
}

const adnEnv = (
  process.env.ADN_ENV?.toLowerCase() === "producao" ? "producao" : "homologacao"
) as "homologacao" | "producao";
const adnBaseUrlHomologacao =
  process.env.ADN_BASE_URL_HOMOLOGACAO ||
  "https://adn.producaorestrita.nfse.gov.br";
const adnBaseUrlProducao =
  process.env.ADN_BASE_URL_PRODUCAO || "https://adn.nfse.gov.br";

// SQLite é o padrão local e não exige serviço externo. PostgreSQL deve ser
// escolhido explicitamente com DB_CLIENT=postgres.
const dbClient = (
  process.env.DB_CLIENT?.toLowerCase() === "postgres" ? "postgres" : "sqlite"
) as "postgres" | "sqlite";

function resolveSqlitePath(
  customPath: string | undefined,
  env: string,
): string {
  if (!customPath) {
    return path.resolve(process.cwd(), "data", `nfse_${env}.db`);
  }
  if (customPath.endsWith("nfse.db")) {
    return customPath.replace(/nfse\.db$/, `nfse_${env}.db`);
  }
  if (customPath.includes(`_${env}.db`)) {
    return customPath;
  }
  if (customPath.endsWith(".db")) {
    return customPath.replace(/\.db$/, `_${env}.db`);
  }
  return customPath;
}

// Detecção inteligente de Docker Secrets ou variáveis locais
const defaultCertSecretPath = "/run/secrets/cert_pfx";
const detectedCertPath = fs.existsSync(defaultCertSecretPath)
  ? defaultCertSecretPath
  : process.env.CERT_PATH ||
    path.resolve(process.cwd(), "certs", "certificado.pfx");

const detectedCertPassword = readSecretFile(
  "/run/secrets/cert_password",
  process.env.CERT_PASSWORD || "",
);
const detectedApiToken = readSecretFile(
  "/run/secrets/api_token",
  process.env.API_TOKEN || "",
);

export const config: AppConfig = {
  port: Number(process.env.PORT) || 4000,
  adnEnv,
  adnBaseUrl:
    adnEnv === "producao" ? adnBaseUrlProducao : adnBaseUrlHomologacao,
  certPath: detectedCertPath,
  certPassword: detectedCertPassword,
  certBase64: process.env.CERT_BASE64 || "",
  enableMock: process.env.ENABLE_MOCK === "true",
  enableUi: process.env.ENABLE_UI !== "false",
  dbClient,
  databaseUrl:
    process.env.DATABASE_URL ||
    "postgresql://postgres:postgres@localhost:5432/nfse_db",
  pgPoolSize: Number(process.env.PG_POOL_SIZE) || 10,
  dbPath: resolveSqlitePath(process.env.DB_PATH, adnEnv),
  certificatesDir: path.resolve(process.env.CERTIFICATES_DIR || "certs"),
  certificateEncryptionKey: readSecretFile(
    process.env.CERT_ENCRYPTION_KEY_FILE || "/run/secrets/cert_encryption_key",
    process.env.CERT_ENCRYPTION_KEY || "",
  ),
  pdfRenderer:
    process.env.PDF_RENDERER === "puppeteer" ? "puppeteer" : "gotenberg",
  gotenbergUrl: process.env.GOTENBERG_URL || "",
  gotenbergUsername: process.env.GOTENBERG_USERNAME || "",
  gotenbergPassword: readSecretFile(
    "/run/secrets/gotenberg_password",
    process.env.GOTENBERG_PASSWORD || "",
  ),
  chromiumPath: process.env.CHROMIUM_EXECUTABLE_PATH || "",
  pdfTempDir: path.resolve(
    process.env.PDF_TEMP_DIR ||
      path.join(process.env.TEMP || "/tmp", "nfse-pdf-exports"),
  ),
  pdfTimeoutMs: Math.max(1000, Number(process.env.PDF_TIMEOUT_MS) || 60000),
  pdfExportTtlMs: Math.max(
    60000,
    Number(process.env.PDF_EXPORT_TTL_MS) || 3600000,
  ),

  apiToken: detectedApiToken,
  adminUsername: process.env.ADMIN_USERNAME || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  appOrigin: process.env.APP_ORIGIN || "",
  sessionSecure: process.env.NODE_ENV === "production",
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000, // 1 minuto
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX) || 100, // 100 reqs por minuto
  adnRequestDelayMs: Number(process.env.ADN_REQUEST_DELAY_MS) || 500, // 500ms entre lotes ao ADN
  adnMaxRetries: Number(process.env.ADN_MAX_RETRIES) || 3,
};
