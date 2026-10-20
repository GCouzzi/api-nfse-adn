import type { NotaFiscal } from "../types/models";

const cancellationEvents = new Set([
  "CANCELAMENTO",
  "CANCELAMENTO_DEFERIDO_ANALISE_FISCAL",
  "CANCELAMENTO_POR_OFICIO",
]);

export function statusFromEvents(types: string[]): NotaFiscal["status"] | null {
  if (types.includes("CANCELAMENTO_POR_SUBSTITUICAO")) return "SUBSTITUIDA";
  if (types.some((type) => cancellationEvents.has(type))) return "CANCELADA";
  return null;
}
