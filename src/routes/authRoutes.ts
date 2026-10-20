import { Router, json, type ErrorRequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import type { AppConfig } from "../config/env";
import { AdminAuth, constantTimeEqual } from "../security/adminAuth";
import { sessionCookie, sessionToken } from "../middlewares/authMiddleware";

export function createAuthRoutes(
  auth: AdminAuth,
  settings: Pick<AppConfig, "sessionSecure" | "appOrigin">,
) {
  const router = Router();
  const cookieOptions = {
    httpOnly: true,
    secure: settings.sessionSecure,
    sameSite: "strict" as const,
    path: "/",
  };
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  // No forwarded headers are trusted. Behind HTTPS proxies set APP_ORIGIN.
  router.use((req, res, next) => {
    const expected =
      settings.appOrigin || `${req.protocol}://${req.get("host")}`;
    if (req.get("origin") && req.get("origin") !== expected) {
      res.status(403).json({ success: false, error: "Origem não autorizada." });
      return;
    }
    if (req.method !== "GET" && req.get("x-nfse-request") !== "panel") {
      res.status(403).json({
        success: false,
        error: "Requisição de autenticação inválida.",
      });
      return;
    }
    next();
  });
  router.post(
    "/login",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 10,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: {
        success: false,
        error: "Muitas tentativas. Aguarde 15 minutos para tentar novamente.",
      },
    }),
    json({ limit: "4kb" }),
    async (req, res, next) => {
      try {
        const session = await auth.login(
          req.body?.username,
          req.body?.password,
        );
        if (!session) {
          res
            .status(401)
            .json({ success: false, error: "Usuário ou senha inválidos." });
          return;
        }
        auth.logout(sessionToken(req));
        res.cookie(sessionCookie, session.token, {
          ...cookieOptions,
          maxAge: auth.lifetimeMs,
        });
        res.json({
          success: true,
          csrfToken: session.csrf,
          expiresAt: session.expiresAt,
        });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get("/session", (req, res) => {
    const session = auth.get(sessionToken(req));
    if (!session) {
      res.status(401).json({ success: false });
      return;
    }
    res.json({
      success: true,
      csrfToken: session.csrf,
      expiresAt: session.expiresAt,
    });
  });
  router.post("/logout", (req, res) => {
    const token = sessionToken(req);
    const session = auth.get(token);
    if (
      session &&
      !constantTimeEqual(req.get("x-csrf-token") || "", session.csrf)
    ) {
      res
        .status(403)
        .json({ success: false, error: "Verificação de sessão inválida." });
      return;
    }
    auth.logout(token);
    res.clearCookie(sessionCookie, cookieOptions);
    res.json({ success: true });
  });
  const handleError: ErrorRequestHandler = (error, _req, res, _next) => {
    // Parser errors may contain the submitted password in error.body.
    const status =
      error?.type === "entity.too.large"
        ? 413
        : error?.type === "entity.parse.failed"
          ? 400
          : 500;
    res.status(status).json({
      success: false,
      error:
        status === 500
          ? "Não foi possível autenticar. Tente novamente."
          : "Corpo da requisição inválido ou muito grande.",
    });
  };
  router.use(handleError);
  return router;
}
