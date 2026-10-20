import { afterAll, beforeAll, expect, test } from "bun:test";
import express from "express";
import AdmZip from "adm-zip";
import type { Server } from "http";
import { config } from "../config/env";
import { parseNfseXml } from "../services/xmlParser";
import type { NotaFiscal } from "../types/models";

config.dbClient = "sqlite";
config.dbPath = ":memory:";
config.enableMock = true;
config.apiToken = "test-notas-token";
function authenticatedFetch(input: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${config.apiToken}`);
  }
  return fetch(input, { ...init, headers });
}
const { default: repository } = await import("../database");
const { default: routes } = await import("../routes");
const { authMiddleware } = await import("../middlewares/authMiddleware");
const { companies } = await import("../main/services");
const { ApplicationError } = await import("../application/contracts");
const cnpj = "12345678000195";
const other = "98765432000100";
const cpf = "12345678901";
let server: Server;
let base: string;
const key = (id: number) => String(id).padStart(50, "0");
const nota = (
  id: number,
  overrides: Partial<NotaFiscal> = {},
): Omit<NotaFiscal, "id"> => ({
  chave_acesso: key(id),
  nsu: id,
  cnpj_prestador: cnpj,
  cpf_tomador: cpf,
  razao_social_prestador: "Empresa Alfa",
  razao_social_tomador: "Maria Silva",
  competencia: "2026-09-01",
  data_emissao: "2026-10-01T12:00:00Z",
  valor_servicos: 100,
  valor_liquido: 90,
  status: "AUTORIZADA",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

beforeAll(async () => {
  await repository.init();
  for (let id = 1; id <= 30; id++) {
    await repository.saveNotaFiscal(nota(id));
    await repository.saveDocumentoXml({
      chave_acesso: key(id),
      nsu: id,
      tipo_documento: "NFSE",
      xml_conteudo: `<NFSe>${id}</NFSe>`,
      created_at: new Date().toISOString(),
    });
  }
  await repository.saveNotaFiscal(
    nota(31, {
      competencia: "2026-08-31",
      data_emissao: "2026-11-01T12:00:00Z",
      status: "CANCELADA",
    }),
  );
  await repository.saveNotaFiscal(nota(32, { competencia: null }));
  await repository.saveNotaFiscal(nota(33, { competencia: "2025-09-01" }));
  await repository.saveNotaFiscal(
    nota(34, { cnpj_prestador: other, cpf_tomador: null }),
  );
  await repository.saveNotaFiscal(nota(35, { competencia: "2026-12-31" }));
  await repository.saveNotaFiscal(nota(36, { competencia: "2027-01-01" }));
  for (let i = 1; i <= 2; i++)
    await repository.saveDocumentoXml({
      chave_acesso: key(1),
      nsu: 100 + i,
      tipo_documento: "EVENTO",
      tipo_evento: "CONFIRMACAO",
      xml_conteudo: `<evento>${i}</evento>`,
      created_at: new Date().toISOString(),
    });
  const app = express();
  const company = await companies.save({ nome: "Empresa Alfa", cnpj });
  for (const note of await repository.findAllByCnpj(cnpj)) {
    let docs = await repository.getXmlsForChave(note.chave_acesso);
    if (!docs.length) {
      const id = await repository.saveDocumentoXml({
        chave_acesso: note.chave_acesso,
        nsu: note.nsu,
        tipo_documento: "NFSE",
        xml_conteudo: `<NFSe>${note.nsu}</NFSe>`,
        created_at: new Date().toISOString(),
      });
      docs = [(await repository.getXmlById(id))!];
    }
    for (const doc of docs)
      await repository.application.linkDocument(
        company,
        config.adnEnv,
        doc.nsu,
        doc.id,
        note.chave_acesso,
      );
  }
  app.use(express.json());
  app.use("/api", authMiddleware, routes);
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res
        .status(error instanceof ApplicationError ? error.status : 500)
        .json({ error: error.message });
    },
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  base = `http://127.0.0.1:${address.port}/api/notas`;
});

afterAll(async () => {
  server?.closeAllConnections();
  server?.close();
  await repository.close();
});

test("filters by competence rather than issuance and keeps months descending across pages", async () => {
  const notes = await repository.findAllByCnpj(cnpj, { limit: 100 });
  expect(notes.slice(0, 2).map((n) => n.competencia)).toEqual([
    "2027-01-01",
    "2026-12-31",
  ]);
  expect(notes.at(-1)?.competencia).toBeNull();
  const page = await repository.findAllByCnpj(cnpj, {
    competencia: "2026-09",
    limit: 25,
  });
  const next = await repository.findAllByCnpj(cnpj, {
    competencia: "2026-09",
    limit: 25,
    offset: 25,
  });
  expect(page).toHaveLength(25);
  expect(next).toHaveLength(5);
  expect(new Set([...page, ...next].map((n) => n.chave_acesso)).size).toBe(30);
  expect(
    await repository.findAllByCnpj(cnpj, { competencia: "2026-12" }),
  ).toHaveLength(1);
});

test("combines provider name/document, taker CPF/name, access key, role and status", async () => {
  for (const prestador of ["alfa", "12.345.678/0001-95"]) {
    const response = await authenticatedFetch(
      `${base}?${new URLSearchParams({ cnpj, competencia: "2026-09", prestador, tomador: "123.456.789-01", chaveAcesso: key(1), status: "autorizada", papel: "prestador" })}`,
    );
    expect(response.status).toBe(200);
    expect(
      (await response.json()).data.map((n: NotaFiscal) => n.chave_acesso),
    ).toEqual([key(1)]);
  }
  expect(
    await repository.findAllByCnpj(cnpj, { tomador: "MARIA", busca: key(2) }),
  ).toHaveLength(1);
  expect(await repository.findAllByCnpj(cnpj, { prestador: "%" })).toHaveLength(
    0,
  );
  expect(
    await repository.findAllByCnpj(cnpj, { prestador: "' OR 1=1 --" }),
  ).toHaveLength(0);
  expect(
    await repository.findAllByCnpj(cnpj, { papel: "tomador" }),
  ).toHaveLength(0);
});

test("monthly ZIP includes the whole month plus distinct events, independent of pagination", async () => {
  const response = await authenticatedFetch(
    `${base}/cnpj/${cnpj}/zip?competencia=2026-09&limit=1&offset=25`,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Disposition")).toContain("_2026-09.zip");
  const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  expect(
    entries.filter((entry) => entry.entryName.startsWith("Notas/")),
  ).toHaveLength(30);
  expect(
    entries.filter((entry) => entry.entryName.startsWith("Eventos/")),
  ).toHaveLength(2);
  expect(entries.map((entry) => entry.getData().toString())).toContain(
    "<NFSe>1</NFSe>",
  );
  const individual = await authenticatedFetch(
    `${base}/${key(1)}/zip?cnpj=${cnpj}`,
  );
  expect(
    new AdmZip(Buffer.from(await individual.arrayBuffer())).getEntries(),
  ).toHaveLength(3);
  expect((await authenticatedFetch(`${base}/cnpj/${cnpj}/zip`)).status).toBe(
    200,
  );
  expect(
    (await authenticatedFetch(`${base}/${key(1)}/xml?cnpj=${cnpj}`)).status,
  ).toBe(200);
});

test("invalid month/filter/pagination is rejected for listing and ZIP", async () => {
  for (const query of [
    "competencia=2026-13",
    "competencia=2026-9",
    "competencia[x]=2026-09",
    "papel=invalid",
    "limit=-1",
    "offset=abc",
    "limit=1001",
    "chaveAcesso=abc",
  ]) {
    expect(
      (await authenticatedFetch(`${base}?cnpj=${cnpj}&${query}`)).status,
    ).toBe(400);
    expect(
      (await authenticatedFetch(`${base}/cnpj/${cnpj}/zip?${query}`)).status,
    ).toBe(400);
  }
});

test("repeated import fills metadata while preserving cancellation status", async () => {
  await repository.saveNotaFiscal(
    nota(31, {
      razao_social_prestador: "JOÃO ATUALIZADO",
      competencia: "2026-08-15",
    }),
  );
  const saved = await repository.findByChave(key(31));
  expect(saved?.competencia).toBe("2026-08-15");
  expect(saved?.razao_social_prestador).toBe("JOÃO ATUALIZADO");
  expect(saved?.status).toBe("CANCELADA");
  expect(
    await repository.findAllByCnpj(cnpj, { prestador: "joão" }),
  ).toHaveLength(1);
});

test("extracts national XML nested values and preserves zero net amount", () => {
  const parsed = parseNfseXml(
    `<NFSe><infNFSe Id="NFS${key(99)}"><nNFSe>99</nNFSe><emit><CNPJ>${cnpj}</CNPJ><xNome>Empresa Alfa</xNome></emit><valores><vLiq>0.00</vLiq></valores><DPS><infDPS><dCompet>2026-09-30</dCompet><toma><CPF>${cpf}</CPF><xNome>Maria Silva</xNome></toma><valores><vServPrest><vServ>1250.75</vServ></vServPrest></valores></infDPS></DPS></infNFSe></NFSe>`,
  );
  expect(parsed.competencia).toBe("2026-09-30");
  expect(parsed.valor_servicos).toBe(1250.75);
  expect(parsed.valor_liquido).toBe(0);
  expect(parsed.cpf_tomador).toBe(cpf);
  expect(parsed.razao_social_prestador).toBe("Empresa Alfa");
});

test("company context applies to keys, XML IDs, PDF and ZIP downloads", async () => {
  const b = await companies.save({
    nome: "Empresa sem vínculo",
    cnpj: "00000000000001",
  });
  const [document] = await repository.getXmlsForChave(key(1));
  expect((await authenticatedFetch(`${base}/${key(1)}`)).status).toBe(400);
  for (const suffix of ["", "/xml", "/zip", "/pdf"]) {
    const response = await authenticatedFetch(
      `${base}/${key(1)}${suffix}?empresaId=${b.id}`,
    );
    expect(response.status).toBe(404);
  }
  expect(
    (
      await authenticatedFetch(
        `${base}/documento/${document.id}/xml?empresaId=${b.id}`,
      )
    ).status,
  ).toBe(404);
  expect(
    (await authenticatedFetch(`${base}/cnpj/${cnpj}/zip?empresaId=${b.id}`))
      .status,
  ).toBe(400);
});

test("API token protects company administration and certificate responses redact secrets", async () => {
  const previousToken = config.apiToken;
  config.apiToken = "token-de-integracao";
  const apiBase = base.replace(/\/notas$/, "");
  const certificateId = crypto.randomUUID();
  try {
    await repository.application.saveCertificate({
      id: certificateId,
      arquivo: "teste.pfx",
      senha_criptografada: "segredo-que-nao-pode-sair",
      titular: "Teste",
      validade: "2027-01-01",
      fingerprint: "fingerprint",
      updated_at: new Date().toISOString(),
    });
    expect((await fetch(`${apiBase}/empresas`)).status).toBe(401);
    expect((await fetch(`${apiBase}/certificados`)).status).toBe(401);
    const response = await authenticatedFetch(`${apiBase}/certificados`, {
      headers: { Authorization: `Bearer ${config.apiToken}` },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("segredo-que-nao-pode-sair");
    expect(text).not.toContain("senha_criptografada");
    expect(text).toContain("teste.pfx");
  } finally {
    config.apiToken = previousToken;
  }
});

test("simultaneous sync submissions for a company share one queued job", async () => {
  const { syncQueueService } = await import("../services/syncQueueService");
  const results = await Promise.all(
    Array.from({ length: 3 }, () =>
      syncQueueService.queueSync(cnpj, { nsuInicial: 0, maxLoops: 1 }),
    ),
  );
  expect(new Set(results.map((result) => result.job.id)).size).toBe(1);
  expect(results.filter((result) => result.alreadyRunning)).toHaveLength(2);
  let job = await syncQueueService.getJob(results[0].job.id);
  for (
    let i = 0;
    job && ["QUEUED", "PROCESSING"].includes(job.status) && i < 100;
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    job = await syncQueueService.getJob(job.id);
  }
  expect(job?.status).toBe("COMPLETED");
  await syncQueueService.close();
});

test("recent PDF exports require authentication, isolate company and environment, and expire old packages", async () => {
  const company = await companies.byCnpj(cnpj);
  const second = await companies.save({
    nome: "Outra empresa",
    cnpj: "00000000000002",
  });
  const previousToken = config.apiToken;
  config.apiToken = "token-exportacoes";
  const endpoint = `${base}/pdf/exportacoes`;
  const headers = { Authorization: `Bearer ${config.apiToken}` };
  const job = {
    id: crypto.randomUUID(),
    empresa_id: company.id,
    ambiente: config.adnEnv,
    status: "COMPLETED" as const,
    competencia: "2026-09",
    total: 10,
    processadas: 10,
    falhas: 0,
    erro: null,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
  };
  try {
    for (let index = 0; index < 25; index++)
      await repository.application.createExport({
        ...job,
        id: crypto.randomUUID(),
        created_at: new Date(Date.now() - 60000 - index * 1000).toISOString(),
      });
    await repository.application.createExport({
      ...job,
      expires_at: new Date(0).toISOString(),
    });
    const otherId = crypto.randomUUID();
    await repository.application.createExport({
      ...job,
      id: otherId,
      empresa_id: second.id,
    });
    await repository.application.createExport({
      ...job,
      id: crypto.randomUUID(),
      ambiente: config.adnEnv === "producao" ? "homologacao" : "producao",
    });
    expect((await fetch(`${endpoint}?cnpj=${cnpj}`)).status).toBe(401);
    expect((await authenticatedFetch(endpoint, { headers })).status).toBe(400);
    const response = await authenticatedFetch(`${endpoint}?cnpj=${cnpj}`, {
      headers,
    });
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data).toHaveLength(20);
    expect(
      data.every(
        (item: any) =>
          item.empresa_id === company.id && item.ambiente === config.adnEnv,
      ),
    ).toBe(true);
    expect(data[0].id).toBe(job.id);
    expect(data[0].status).toBe("EXPIRED");
    expect(data[1].created_at > data[2].created_at).toBe(true);
    expect((await repository.application.getExport(job.id))?.status).toBe(
      "EXPIRED",
    );
    const otherResponse = await authenticatedFetch(
      `${endpoint}?empresaId=${second.id}`,
      {
        headers,
      },
    );
    expect(
      (await otherResponse.json()).data.map((item: any) => item.id),
    ).toEqual([otherId]);
    expect(
      (
        await authenticatedFetch(
          `${endpoint}/${job.id}?empresaId=${second.id}`,
          { headers },
        )
      ).status,
    ).toBe(404);
  } finally {
    config.apiToken = previousToken;
  }
});
