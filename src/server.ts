import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { config } from "./config/env";
import { initDatabase, repository } from "./database";
import { authMiddleware } from "./middlewares/authMiddleware";
import { apiRateLimiter } from "./middlewares/rateLimitMiddleware";
import apiRoutes from "./routes";

const app = express();

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Rate Limiter global para proteger a API contra abusos
app.use(apiRateLimiter);

// Rota raiz pública informativa
app.get("/", (req, res) => {
  res.json({
    service: "API NFS-e Nacional - ADN Contribuinte",
    version: "1.1.0",
    database: config.dbClient.toUpperCase(),
    environment: config.adnEnv,
    adnBaseUrl: config.adnBaseUrl,
    mockMode: config.enableMock,
    authRequired: Boolean(config.apiToken),
    rateLimit: {
      windowMs: config.rateLimitWindowMs,
      maxRequests: config.rateLimitMax
    },
    outboundThrottlingMs: config.adnRequestDelayMs,
    endpoints: {
      health: "GET /health",
      documentacaoInterativa: "GET /docs",
      especificacaoOpenAPI: "GET /docs/openapi.json",
      sincronizarNSU_Async: "POST /api/sync",
      consultarJobSync: "GET /api/sync/jobs/:id",
      listarJobsSync: "GET /api/sync/jobs?cnpj={cnpj}",
      statusSincronizacao: "GET /api/sync/:cnpj",
      listarNotasPorCnpj: "GET /api/notas?cnpj={cnpj}",
      obterNotaPorChave: "GET /api/notas/:chaveAcesso",
      downloadXmlNota: "GET /api/notas/:chaveAcesso/xml",
      downloadZipNotaComEventos: "GET /api/notas/:chaveAcesso/zip",
      downloadZipTodasNotasCnpj: "GET /api/notas/cnpj/:cnpj/zip",
      downloadXmlDocumentoPorId: "GET /api/notas/documento/:id/xml"
    }
  });
});

// Health check público
app.get("/health", (req, res) => {
  res.json({
    status: "UP",
    database: config.dbClient,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Especificação OpenAPI 3.0 em JSON (público)
app.get("/docs/openapi.json", (req, res) => {
  const specPath = path.resolve(process.cwd(), "docs", "openapi.json");
  if (fs.existsSync(specPath)) {
    res.setHeader("Content-Type", "application/json");
    res.sendFile(specPath);
  } else {
    res.status(404).json({ success: false, error: "Arquivo openapi.json não encontrado." });
  }
});

// Interface visual interativa de documentação (Scalar / Swagger)
app.get("/docs", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html lang="pt-BR">
  <head>
    <title>API NFS-e Nacional - Documentação Interativa</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="/docs/openapi.json" data-configuration='{"theme":"purple","layout":"modern"}'></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`);
});

// Rotas da API protegidas por autenticação via API Token
app.use("/api", authMiddleware, apiRoutes);

// Tratamento de rota não encontrada
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Rota não encontrada: ${req.method} ${req.path}` });
});

// Tratamento global de erros
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Erro interno não tratado:", err);
  res.status(500).json({
    success: false,
    error: err.message || "Erro interno do servidor"
  });
});

async function bootstrap() {
  try {
    await initDatabase();

    const server = app.listen(config.port, () => {
      console.log(`=======================================================`);
      console.log(`🚀 API NFS-e ADN iniciada na porta ${config.port}`);
      console.log(`🗄️  Banco de Dados: ${config.dbClient.toUpperCase()}`);
      console.log(`📡 Ambiente ADN: ${config.adnEnv.toUpperCase()} (${config.adnBaseUrl})`);
      console.log(`🔒 Modo Mock: ${config.enableMock ? "ATIVADO (simulação)" : "DESATIVADO (mTLS real)"}`);
      console.log(`🔑 Autenticação: ${config.apiToken ? "ATIVADA (Token obrigatório)" : "DESATIVADA (Modo aberto/Dev)"}`);
      console.log(`📖 Documentação Interativa: http://localhost:${config.port}/docs`);
      console.log(`🌐 Base URL: http://localhost:${config.port}`);
      console.log(`=======================================================`);
    });

    const shutdown = async (signal: string) => {
      console.log(`Recebido sinal ${signal}. Encerrando aplicação...`);
      server.close(async () => {
        await repository.close();
        console.log("Servidor e conexões de banco encerrados com segurança.");
        process.exit(0);
      });
    };

    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    console.error("Falha fatal na inicialização da API:", error);
    process.exit(1);
  }
}

bootstrap();

export default app;
