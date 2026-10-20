import type { Request, Response, NextFunction } from "express";
import { config } from "../config/env";
import { AdminAuth, constantTimeEqual } from "../security/adminAuth";
import { adminAuth } from "../security/authInstance";

export const sessionCookie = "nfse_session";

export function sessionToken(req: Request): string {
  return (
    (req.headers.cookie || "")
      .split(";")
      .map((cookie) => cookie.trim())
      .find((cookie) => cookie.startsWith(`${sessionCookie}=`))
      ?.slice(sessionCookie.length + 1) || ""
  );
}

export function createAuthMiddleware(auth: AdminAuth, apiToken: () => string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Cache-Control", "no-store");
    const authorization = req.get("authorization");
    const provided = authorization?.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : req.get("x-api-key");
    if (provided !== undefined || authorization) {
      const expected = apiToken();
      if (provided && expected && constantTimeEqual(provided, expected)) {
        next();
        return;
      }
    } else {
      const session = auth.get(sessionToken(req));
      if (session) {
        const readOnly = ["GET", "HEAD", "OPTIONS"].includes(req.method);
        if (
          !readOnly &&
          !constantTimeEqual(req.get("x-csrf-token") || "", session.csrf)
        ) {
          res.status(403).json({
            success: false,
            error: "Verificação de sessão inválida. Recarregue a página.",
          });
          return;
        }
        next();
        return;
      }
    }
    res.status(401).json({
      success: false,
      error: "Não autorizado. Entre no painel ou forneça um API Token válido.",
    });
  };
}

export const authMiddleware = createAuthMiddleware(
  adminAuth,
  () => config.apiToken,
);
