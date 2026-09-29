import rateLimit from "express-rate-limit";
import { config } from "../config/env";

export const apiRateLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === "/health" || req.path === "/",
  message: {
    success: false,
    error: "Muitas requisições recebidas. Limite de taxa excedido. Tente novamente mais tarde."
  }
});
