import type { FindAllByCnpjOptions } from "../database/types";
import { isCompetencia } from "../database/notaFilters";

export class NotaQueryError extends Error {}

export function parseNotaQuery(
  query: Record<string, unknown>,
): FindAllByCnpjOptions {
  const result: FindAllByCnpjOptions = {};
  for (const key of [
    "competencia",
    "prestador",
    "tomador",
    "chaveAcesso",
    "busca",
    "status",
    "papel",
  ] as const) {
    const value = query[key];
    if (value === undefined || value === "") continue;
    if (typeof value !== "string" || value.length > 200)
      throw new NotaQueryError(`Filtro inválido: ${key}.`);
    Object.assign(result, { [key]: value.trim() });
  }
  if (result.competencia && !isCompetencia(result.competencia))
    throw new NotaQueryError("Competência inválida. Use AAAA-MM.");
  if (result.papel && !["prestador", "tomador", "todos"].includes(result.papel))
    throw new NotaQueryError("Papel inválido.");
  if (result.status) {
    result.status = result.status.toUpperCase();
    if (
      !["AUTORIZADA", "CANCELADA", "SUBSTITUIDA", "DENEGADA"].includes(
        result.status,
      )
    )
      throw new NotaQueryError("Status inválido.");
  }
  if (result.chaveAcesso && !/^\d+$/.test(result.chaveAcesso))
    throw new NotaQueryError("A chave de acesso deve conter apenas dígitos.");
  for (const key of ["limit", "offset"] as const) {
    if (query[key] === undefined) continue;
    const value = query[key];
    const number = Number(value);
    if (
      typeof value !== "string" ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(number) ||
      number < (key === "limit" ? 1 : 0) ||
      (key === "limit" && number > 1000)
    ) {
      throw new NotaQueryError(`Paginação inválida: ${key}.`);
    }
    result[key] = number;
  }
  return result;
}

export function validateCnpj(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[\d\s./-]+$/.test(value) ||
    value.replace(/\D/g, "").length !== 14
  ) {
    throw new NotaQueryError("Informe um CNPJ com 14 dígitos.");
  }
}
