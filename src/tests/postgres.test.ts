import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { PostgresRepository } from "../database/postgres";
import { CompanyService } from "../companies/companyService";
import { config } from "../config/env";

test("PostgreSQL repository initializes companies, scopes notes, imports legacy data and persists exports", async () => {
  const database = new PGlite();
  const query = async <T>(sql: string, params: any[] = []) => ({
    rows: (await database.query<T>(sql, params)).rows,
  });
  const repository = new PostgresRepository({
    query,
    connect: async () => ({ query, release() {} }),
    end: () => database.close(),
    on() {},
  });
  try {
    await repository.init();
    const chave = "1".padStart(50, "0");
    await repository.saveNotaFiscal({
      chave_acesso: chave,
      nsu: 1,
      cnpj_prestador: "12345678000195",
      cnpj_tomador: "98765432000188",
      razao_social_prestador: "Empresa Alfa",
      competencia: "2026-09-10",
      valor_servicos: 100,
      valor_liquido: 90,
      status: "AUTORIZADA",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const companies = new CompanyService(repository.application, config.adnEnv);
    const a = await companies.save({
      nome: "Empresa A",
      cnpj: "12345678000195",
    });
    const b = await companies.save({
      nome: "Empresa B",
      cnpj: "00000000000001",
    });
    const documentId = await repository.saveDocumentoXml({
      chave_acesso: chave,
      nsu: 1,
      tipo_documento: "NFSE",
      xml_conteudo: "<NFSe/>",
      created_at: new Date().toISOString(),
    });
    await repository.application.linkDocument(
      a,
      config.adnEnv,
      1,
      documentId,
      chave,
    );
    expect(
      await repository.findAllByCnpj(a.cnpj, {
        empresaId: a.id,
        ambiente: config.adnEnv,
        competencia: "2026-09",
        prestador: "ALFA",
      }),
    ).toHaveLength(1);
    expect(
      await repository.findAllByCnpj(b.cnpj, {
        empresaId: b.id,
        ambiente: config.adnEnv,
      }),
    ).toHaveLength(0);
    expect(
      await repository.getXmlsForCnpj(a.cnpj, {
        empresaId: a.id,
        ambiente: config.adnEnv,
      }),
    ).toHaveLength(1);
    expect(
      await repository.application.exportNoteKeys(
        a.id,
        config.adnEnv,
        "2026-09",
      ),
    ).toEqual([chave]);
    expect(
      await repository.application.exportNoteKeys(
        a.id,
        config.adnEnv,
        "2026-08",
      ),
    ).toEqual([]);
    expect(
      (await repository.application.noteNsus(a.id, config.adnEnv, [chave])).get(
        chave,
      ),
    ).toBe(1);
    await repository.application.registerDocument("teste-hash", documentId);
    expect(await repository.application.findDocument("teste-hash")).toBe(
      documentId,
    );
    const job = {
      id: crypto.randomUUID(),
      empresa_id: a.id,
      ambiente: config.adnEnv,
      status: "QUEUED" as const,
      competencia: "2026-09",
      total: 1,
      processadas: 0,
      falhas: 0,
      erro: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    };
    await repository.application.createExport(job);
    await repository.application.updateExport(job.id, {
      status: "COMPLETED",
      processadas: 1,
    });
    expect((await repository.application.getExport(job.id))?.status).toBe(
      "COMPLETED",
    );
    expect(
      (await repository.application.listExports(a.id, config.adnEnv, 20)).map(
        (item) => item.id,
      ),
    ).toEqual([job.id]);
    expect(
      await repository.application.listExports(b.id, config.adnEnv, 20),
    ).toEqual([]);
    expect(
      await repository.application.listExports(
        a.id,
        config.adnEnv === "producao" ? "homologacao" : "producao",
        20,
      ),
    ).toEqual([]);
    const certificate = {
      id: crypto.randomUUID(),
      arquivo: "empresa.pfx",
      titular: "Empresa A",
      validade: "2027-01-01",
      fingerprint: "fingerprint",
      senha_criptografada: "valor-cifrado",
      updated_at: new Date().toISOString(),
    };
    await repository.application.saveCertificate(certificate);
    await companies.save(
      { nome: a.nome, cnpj: a.cnpj, certificado_id: certificate.id },
      a.id,
    );
    expect(
      (await repository.application.getCompany(a.id))?.certificado_id,
    ).toBe(certificate.id);
  } finally {
    await repository.close();
  }
}, 30000);
