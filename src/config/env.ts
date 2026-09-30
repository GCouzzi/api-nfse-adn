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
  dbClient: "postgres" | "sqlite";
  databaseUrl: string;
  pgPoolSize: number;
  dbPath: string;
  
  // Autenticação da API
  apiToken: string;
  
  // Rate Limiting (Inbound - requisições à nossa API)
  rateLimitWindowMs: number;
  rateLimitMax: number;
  
  // Throttling do ADN (Outbound - controle de requisições ao governo)
  adnRequestDelayMs: number;
  adnMaxRetries: number;
}

const adnEnv = (process.env.ADN_ENV?.toLowerCase() === "producao" ? "producao" : "homologacao") as "homologacao" | "producao";
const adnBaseUrlHomologacao = process.env.ADN_BASE_URL_HOMOLOGACAO || "https://adn.producaorestrita.nfse.gov.br";
const adnBaseUrlProducao = process.env.ADN_BASE_URL_PRODUCAO || "https://adn.nfse.gov.br";

const dbClient = (process.env.DB_CLIENT?.toLowerCase() === "sqlite" ? "sqlite" : "postgres") as "postgres" | "sqlite";

// Detecção inteligente de Docker Secrets ou variáveis locais
const defaultCertSecretPath = "/run/secrets/cert_pfx";
const detectedCertPath = fs.existsSync(defaultCertSecretPath)
  ? defaultCertSecretPath
  : (process.env.CERT_PATH || path.resolve(process.cwd(), "certs", "certificado.pfx"));

const detectedCertPassword = readSecretFile("/run/secrets/cert_password", process.env.CERT_PASSWORD || "");
const detectedApiToken = readSecretFile("/run/secrets/api_token", process.env.API_TOKEN || "");

export const config: AppConfig = {
  port: Number(process.env.PORT) || 4000,
  adnEnv,
  adnBaseUrl: adnEnv === "producao" ? adnBaseUrlProducao : adnBaseUrlHomologacao,
  certPath: detectedCertPath,
  certPassword: detectedCertPassword,
  certBase64: process.env.CERT_BASE64 || "",
  enableMock: process.env.ENABLE_MOCK === "true",
  dbClient,
  databaseUrl: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/nfse_db",
  pgPoolSize: Number(process.env.PG_POOL_SIZE) || 10,
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), "data", "nfse.db"),
  
  apiToken: detectedApiToken,
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60000, // 1 minuto
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX) || 100, // 100 reqs por minuto
  adnRequestDelayMs: Number(process.env.ADN_REQUEST_DELAY_MS) || 500, // 500ms entre lotes ao ADN
  adnMaxRetries: Number(process.env.ADN_MAX_RETRIES) || 3
};
