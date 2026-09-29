import type { Request, Response, NextFunction } from "express";
import { config } from "../config/env";

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Se nenhuma chave estiver configurada no .env, libera acesso com aviso no log
  if (!config.apiToken) {
    return next();
  }

  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers["x-api-key"] as string | undefined;

  let providedToken: string | null = null;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    providedToken = authHeader.substring(7).trim();
  } else if (apiKeyHeader) {
    providedToken = apiKeyHeader.trim();
  }

  if (!providedToken || providedToken !== config.apiToken) {
    res.status(401).json({
      success: false,
      error: "Acesso não autorizado. Forneça um API Token válido via 'Authorization: Bearer <TOKEN>' ou cabeçalho 'x-api-key'."
    });
    return;
  }

  next();
}
