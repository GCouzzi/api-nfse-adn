import type { NotaFilterDialect } from "./notaFilterDialect";

export const postgresNotaFilterDialect: NotaFilterDialect = {
  placeholder: (position) => `$${position}`,
  normalizeText: (_column, expression) => `LOWER(${expression})`,
  contains: (expression, placeholder) =>
    `STRPOS(${expression}, ${placeholder}) > 0`,
};
