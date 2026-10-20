import type { NotaFilterDialect } from "./notaFilterDialect";

const uppercaseAccentedCharacters = "ÁÀÂÃÉÊÍÓÔÕÚÜÇ";

export const sqliteNotaFilterDialect: NotaFilterDialect = {
  placeholder: () => "?",
  normalizeText: (column, expression) => {
    const lowerExpression = `LOWER(${expression})`;

    if (!column.startsWith("razao_social")) {
      return lowerExpression;
    }

    return [...uppercaseAccentedCharacters].reduce(
      (sql, character) =>
        `REPLACE(${sql}, '${character}', '${character.toLowerCase()}')`,
      lowerExpression,
    );
  },
  contains: (expression, placeholder) =>
    `INSTR(${expression}, ${placeholder}) > 0`,
};
