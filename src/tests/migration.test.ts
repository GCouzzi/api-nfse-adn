import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../database/schema";
import { SqlApplicationRepository } from "../database/sqlApplicationRepository";
import { CompanyService } from "../companies/companyService";

test("legacy migration snapshots old notes once and never attributes new distributions by participation", async () => {
  const db = new Database(":memory:");
  initSchema(db);
  const insert = (id: number) =>
    db.run(
      `INSERT INTO notas_fiscais
    (chave_acesso, nsu, cnpj_prestador, cnpj_tomador, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(id).padStart(50, "0"),
        id,
        "12345678000195",
        "98765432000188",
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    );
  insert(1);
  const repository = new SqlApplicationRepository({
    atomic: async (statements) => {
      db.transaction(() => {
        for (const { sql, params = [] } of statements)
          db.query(sql).run(...params);
      })();
    },
    query: async <T>(sql: string, params: Array<string | number | null> = []) =>
      db.query<T, any[]>(sql).all(...params),
  });
  try {
    await repository.init("homologacao");
    insert(2);
    await repository.init("homologacao");
    const companies = new CompanyService(repository, "homologacao");
    for (const cnpj of ["12345678000195", "98765432000188"]) {
      const company = await companies.save({ nome: "Empresa", cnpj });
      expect(
        await repository.hasNote(
          company.id,
          "homologacao",
          "1".padStart(50, "0"),
        ),
      ).toBe(true);
      expect(
        await repository.hasNote(
          company.id,
          "homologacao",
          "2".padStart(50, "0"),
        ),
      ).toBe(false);
    }
    expect(
      db.query("SELECT COUNT(*) AS total FROM notas_fiscais").get(),
    ).toEqual({ total: 2 });
  } finally {
    db.close();
  }
});
