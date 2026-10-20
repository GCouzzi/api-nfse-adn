import { describe, expect, test } from "bun:test";
import { postgresNotaFilterDialect } from "../database/dialects/postgresNotaFilterDialect";
import { sqliteNotaFilterDialect } from "../database/dialects/sqliteNotaFilterDialect";
import { notaFilters } from "../database/notaFilters";

const cnpj = "12345678000195";

describe("notaFilters", () => {
  test("uses PostgreSQL placeholders and text functions through its adapter", () => {
    const filters = notaFilters(
      cnpj,
      {
        competencia: "2026-09",
        prestador: "Empresa",
        chaveAcesso: "123",
      },
      postgresNotaFilterDialect,
    );

    expect(filters.where).toContain("n.cnpj_prestador = $1");
    expect(filters.where).toContain("STRPOS(LOWER(");
    expect(filters.where).toContain("n.competencia >= $4");
    expect(filters.where).toContain("n.chave_acesso = $7");
    expect(filters.params).toEqual([
      cnpj,
      cnpj,
      cnpj,
      "2026-09",
      "2026-10",
      "empresa",
      "123",
    ]);
  });

  test("uses SQLite placeholders and accent normalization through its adapter", () => {
    const filters = notaFilters(
      cnpj,
      { papel: "prestador", prestador: "Árvore" },
      sqliteNotaFilterDialect,
    );

    expect(filters.where).toContain("n.cnpj_prestador = ?");
    expect(filters.where).toContain("INSTR(REPLACE(");
    expect(filters.where).not.toContain("STRPOS");
    expect(filters.params).toEqual([cnpj, "árvore"]);
  });
});
