import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import forge from "node-forge";
import express from "express";
import { createCertificateUploadRoutes } from "../routes/certificateUploadRoutes";
import { authMiddleware } from "../middlewares/authMiddleware";
import {
  ApplicationError,
  MAX_CERTIFICATE_BYTES,
} from "../application/contracts";
import AdmZip from "adm-zip";
import { SqliteRepository } from "../database/sqlite";
import { config } from "../config/env";
import { CompanyService } from "../companies/companyService";
import { FolderCertificateProvider } from "../certificates/folderCertificateProvider";
import { SecretCipher } from "../security/secretCipher";
import { AdnClient } from "../services/adnClient";
import { SyncService } from "../services/syncService";
import { statusFromEvents } from "../services/noteStatus";
import { DanfseService } from "../pdf/danfseService";
import { PdfExportService } from "../pdf/pdfExportService";
import { GotenbergPdfRenderer, SerialPdfRenderer } from "../pdf/renderers";
import type {
  AdnGatewayFactory,
  Company,
  PdfRenderer,
} from "../application/contracts";
import type { DistribuicaoNSU } from "../types/adn";

let sandbox: string;
let pfx: Buffer;
const cnpjA = "12345678000195";
const cnpjB = "98765432000188";
const key = (id: number) => String(id).padStart(50, "0");
const secret = "11".repeat(32);
const environment = config.adnEnv;
const xml = (id: number, month = "2026-09") =>
  `<NFSe><infNFSe Id="NFS${key(id)}"><nNFSe>${id}</nNFSe><cStat>100</cStat><emit><CNPJ>${cnpjA}</CNPJ><xNome>Empresa &amp; Filhos</xNome></emit><DPS><infDPS><tpAmb>2</tpAmb><dCompet>${month}-10</dCompet><prest><CNPJ>${cnpjA}</CNPJ></prest><toma><CNPJ>${cnpjB}</CNPJ><xNome>Tomador</xNome></toma><valores><vServPrest><vServ>123.45</vServ></vServPrest></valores></infDPS></DPS><valores><vLiq>100</vLiq></valores></infNFSe></NFSe>`;

async function database() {
  config.dbPath = ":memory:";
  const repository = new SqliteRepository();
  await repository.init();
  const companies = new CompanyService(repository.application, environment);
  const a = await companies.save({ nome: "Empresa A", cnpj: cnpjA });
  const b = await companies.save({ nome: "Empresa B", cnpj: cnpjB });
  return { repository, companies, a, b };
}

async function note(
  repository: SqliteRepository,
  company: Company,
  id: number,
  month = "2026-09",
  status: "AUTORIZADA" | "CANCELADA" | "SUBSTITUIDA" = "AUTORIZADA",
) {
  await repository.saveNotaFiscal({
    chave_acesso: key(id),
    nsu: id,
    cnpj_prestador: cnpjA,
    cnpj_tomador: cnpjB,
    competencia: `${month}-10`,
    valor_servicos: 123.45,
    valor_liquido: 100,
    status,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const documentId = await repository.saveDocumentoXml({
    chave_acesso: key(id),
    nsu: id,
    tipo_documento: "NFSE",
    xml_conteudo: xml(id, month),
    created_at: new Date().toISOString(),
  });
  await repository.application.linkDocument(
    company,
    environment,
    id,
    documentId,
    key(id),
  );
}

beforeAll(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(), "nfse-features-test-"));
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 86400000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  cert.setSubject([{ name: "commonName", value: "Empresa A de Teste" }]);
  cert.setIssuer(cert.subject.attributes);
  cert.setExtensions([{ name: "basicConstraints", cA: false }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const asn1 = forge.pkcs12.toPkcs12Asn1(
    keys.privateKey,
    [cert],
    "senha-teste",
    { algorithm: "3des" },
  );
  pfx = Buffer.from(forge.asn1.toDer(asn1).getBytes(), "binary");
});

afterAll(async () => {
  await rm(sandbox, { recursive: true, force: true });
});

test("password encryption authenticates ciphertext and rejects the wrong key", () => {
  const cipher = new SecretCipher(secret);
  const encrypted = cipher.encrypt("senha-secreta");
  expect(encrypted).not.toContain("senha-secreta");
  expect(cipher.decrypt(encrypted)).toBe("senha-secreta");
  expect(() => new SecretCipher("22".repeat(32)).decrypt(encrypted)).toThrow();
  expect(() => new SecretCipher("")).toThrow();
});

test("folder certificates validate password, metadata and file integrity without exposing the private key", async () => {
  const { repository, a } = await database();
  const directory = path.join(sandbox, "certificates");
  await mkdir(directory);
  await writeFile(path.join(directory, "empresa.pfx"), pfx);
  const provider = new FolderCertificateProvider(
    repository.application,
    directory,
    () => secret,
  );
  try {
    expect(await provider.files()).toEqual(["empresa.pfx"]);
    await expect(
      provider.register("../empresa.pfx", "senha-teste"),
    ).rejects.toThrow();
    await expect(provider.register("empresa.pfx", "errada")).rejects.toThrow();
    const certificate = await provider.register("empresa.pfx", "senha-teste");
    expect(certificate.titular).toBe("Empresa A de Teste");
    expect(certificate.senha_criptografada).not.toContain("senha-teste");
    const credentials = await provider.resolve({
      ...a,
      certificado_id: certificate.id,
    });
    expect(credentials.pfx.equals(pfx)).toBe(true);
    expect(credentials.passphrase).toBe("senha-teste");
    await writeFile(
      path.join(directory, "empresa.pfx"),
      Buffer.from("alterado"),
    );
    await expect(
      provider.resolve({ ...a, certificado_id: certificate.id }),
    ).rejects.toThrow("alterado");
  } finally {
    await repository.close();
  }
});

test("company associations distinguish note participation from receiving a distribution", async () => {
  const { repository, companies, a, b } = await database();
  try {
    await note(repository, a, 1);
    expect(
      await repository.findAllByCnpj(cnpjA, {
        empresaId: a.id,
        ambiente: environment,
      }),
    ).toHaveLength(1);
    // B appears as taker in the XML, but has not received this distribution.
    expect(
      await repository.findAllByCnpj(cnpjB, {
        empresaId: b.id,
        ambiente: environment,
      }),
    ).toHaveLength(0);
    await expect(companies.assertNote(b, key(1))).rejects.toThrow();
    const documents = await repository.getXmlsForChave(key(1));
    await repository.application.linkDocument(
      b,
      environment,
      500,
      documents[0].id,
      key(1),
    );
    expect(
      await repository.findAllByCnpj(cnpjB, {
        empresaId: b.id,
        ambiente: environment,
      }),
    ).toHaveLength(1);
    expect(await repository.getXmlsForChave(key(1))).toHaveLength(1);
    await companies.save({ nome: a.nome, cnpj: a.cnpj, ativa: false }, a.id);
    await expect(companies.byCnpj(cnpjA, true)).rejects.toThrow("inativa");
    await expect(companies.assertNote(a, key(1))).resolves.toBeUndefined();
    await expect(
      companies.save({ nome: "Duplicada", cnpj: cnpjA }),
    ).rejects.toThrow("Já existe");
    await expect(
      repository.application.init(
        environment === "producao" ? "homologacao" : "producao",
      ),
    ).rejects.toThrow("outro ambiente");
  } finally {
    await repository.close();
  }
});

test("certificate uploads authenticate, validate multipart and PKCS12 before writing, and preserve failed replacements", async () => {
  const { repository, a } = await database();
  const directory = path.join(sandbox, "uploaded-certificates");
  const provider = new FolderCertificateProvider(
    repository.application,
    directory,
    () => secret,
  );
  const previousToken = config.apiToken;
  config.apiToken = "token-upload-teste";
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    authMiddleware,
    createCertificateUploadRoutes(provider, repository.application),
  );
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
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Servidor indisponível");
  const base = `http://127.0.0.1:${address.port}/api/certificados`;
  const headers = { Authorization: `Bearer ${config.apiToken}` };
  const form = (
    filename = "empresa.p12",
    content = pfx,
    password = "senha-teste",
  ) => {
    const body = new FormData();
    body.append("arquivo", new Blob([new Uint8Array(content)]), filename);
    body.append("senha", password);
    return body;
  };
  try {
    expect(
      (await fetch(`${base}/upload`, { method: "POST", body: form() })).status,
    ).toBe(401);
    expect(await provider.files()).toEqual([]);
    const uploaded = await fetch(`${base}/upload`, {
      method: "POST",
      headers,
      body: form(),
    });
    expect(uploaded.status).toBe(201);
    const text = await uploaded.text();
    expect(text).not.toContain("senha-teste");
    expect(text).not.toContain("senha_criptografada");
    const record = JSON.parse(text).data;
    expect(record.arquivo).toMatch(/^certificado-[a-f\d-]+\.pfx$/);
    expect(record.arquivo).not.toBe("empresa.p12");
    expect(
      (await readFile(path.join(directory, record.arquivo))).equals(pfx),
    ).toBe(true);
    const credentials = await provider.resolve({
      ...a,
      certificado_id: record.id,
    });
    expect(credentials.passphrase).toBe("senha-teste");
    expect(credentials.pfx).toEqual(pfx);
    if (process.platform !== "win32")
      expect(
        (await stat(path.join(directory, record.arquivo))).mode & 0o777,
      ).toBe(0o600);
    for (const body of [
      form("../fora.pfx"),
      form("C:\\fora.pfx"),
      form("arquivo.pem"),
      form("arquivo.pfx", Buffer.from("não é um certificado")),
      form("arquivo.pfx", pfx, "senha-incorreta"),
    ]) {
      expect(
        (await fetch(`${base}/upload`, { method: "POST", headers, body }))
          .status,
      ).toBe(400);
      expect(await provider.files()).toEqual([record.arquivo]);
    }
    const oversized = form(
      "grande.pfx",
      Buffer.alloc(MAX_CERTIFICATE_BYTES + 1),
    );
    expect(
      (
        await fetch(`${base}/upload`, {
          method: "POST",
          headers,
          body: oversized,
        })
      ).status,
    ).toBe(413);
    const duplicate = form();
    duplicate.append("arquivo", new Blob([new Uint8Array(pfx)]), "segundo.pfx");
    expect(
      (
        await fetch(`${base}/upload`, {
          method: "POST",
          headers,
          body: duplicate,
        })
      ).status,
    ).toBe(400);
    const missing = new FormData();
    missing.append("senha", "senha-teste");
    expect(
      (
        await fetch(`${base}/upload`, {
          method: "POST",
          headers,
          body: missing,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/upload`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "multipart/form-data" },
          body: "inválido",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/upload`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await fetch(`${base}/${crypto.randomUUID()}/upload`, {
          method: "PUT",
          headers,
          body: form(),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${base}/${record.id}/upload`, {
          method: "PUT",
          headers,
          body: form("novo.pfx", pfx, "errada"),
        })
      ).status,
    ).toBe(400);
    expect(
      (await repository.application.getCertificate(record.id))?.arquivo,
    ).toBe(record.arquivo);
    expect(await provider.files()).toEqual([record.arquivo]);
    const replaced = await fetch(`${base}/${record.id}/upload`, {
      method: "PUT",
      headers,
      body: form(),
    });
    expect(replaced.status).toBe(200);
    const replacement = (await replaced.json()).data;
    expect(replacement.id).toBe(record.id);
    expect(replacement.arquivo).not.toBe(record.arquivo);
    expect(
      (await readFile(path.join(directory, record.arquivo))).equals(pfx),
    ).toBe(true);
    expect(
      (await provider.resolve({ ...a, certificado_id: record.id })).pfx,
    ).toEqual(pfx);
  } finally {
    config.apiToken = previousToken;
    server.closeAllConnections();
    server.close();
    await repository.close();
  }
});

test("certificate upload removes its file if persistence fails and refuses missing encryption keys or public storage", async () => {
  const { repository } = await database();
  const directory = path.join(sandbox, "rollback-certificates");
  const input = {
    filename: "empresa.pfx",
    content: pfx,
    password: "senha-teste",
  };
  const provider = new FolderCertificateProvider(
    repository.application,
    directory,
    () => secret,
  );
  try {
    await expect(
      new FolderCertificateProvider(
        repository.application,
        directory,
        () => "",
      ).upload(input),
    ).rejects.toThrow();
    expect(await provider.files()).toEqual([]);
    const save = spyOn(
      repository.application,
      "saveCertificate",
    ).mockRejectedValueOnce(new Error("Falha de persistência"));
    try {
      await expect(provider.upload(input)).rejects.toThrow(
        "Não foi possível salvar",
      );
      expect(await readdir(directory)).toEqual([]);
      expect(await repository.application.listCertificates()).toEqual([]);
    } finally {
      save.mockRestore();
    }
    await expect(
      new FolderCertificateProvider(
        repository.application,
        path.resolve("public"),
        () => secret,
      ).upload(input),
    ).rejects.toThrow("fora da pasta pública");
    await provider.upload(input);
    expect(await provider.files()).toHaveLength(1);
  } finally {
    await repository.close();
  }
});

test("real ADN calls fail without credentials even with no HTTP client", async () => {
  const client = new AdnClient(undefined, false);
  await expect(
    client.consultarNSU({ nsu: 0, cnpjConsulta: cnpjA }),
  ).rejects.toThrow("Certificado");
});

test("pending and rejected cancellation requests never cancel a note", () => {
  expect(
    statusFromEvents(["SOLICITACAO_CANCELAMENTO_ANALISE_FISCAL"]),
  ).toBeNull();
  expect(
    statusFromEvents(["CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL"]),
  ).toBeNull();
  expect(statusFromEvents(["CANCELAMENTO_DEFERIDO_ANALISE_FISCAL"])).toBe(
    "CANCELADA",
  );
  expect(statusFromEvents(["CANCELAMENTO_POR_SUBSTITUICAO"])).toBe(
    "SUBSTITUIDA",
  );
});

test("sync replays and shared XMLs keep company NSUs separate and reconcile events received before notes", async () => {
  const { repository, companies, a, b } = await database();
  let closed = 0;
  const event = `<evento><infEvento><chNFSe>${key(2)}</chNFSe><tpEvento>CANCELAMENTO</tpEvento></infEvento></evento>`;
  const documents: DistribuicaoNSU[] = [
    {
      NSU: 1,
      ChaveAcesso: key(2),
      TipoDocumento: "EVENTO",
      TipoEvento: "CANCELAMENTO",
      ArquivoXml: gzipSync(event).toString("base64"),
    },
    {
      NSU: 2,
      ChaveAcesso: key(2),
      TipoDocumento: "NFSE",
      ArquivoXml: gzipSync(xml(2)).toString("base64"),
    },
  ];
  const factory: AdnGatewayFactory = {
    create: async () => ({
      consultarNSU: async () => ({
        StatusProcessamento: "DOCUMENTOS_LOCALIZADOS",
        LoteDFe: documents,
      }),
      close: () => {
        closed++;
      },
    }),
  };
  try {
    const service = new SyncService(repository, companies, factory);
    await service.sincronizarCnpj(cnpjA, 0, 1);
    expect((await repository.findByChave(key(2)))?.status).toBe("CANCELADA");
    await service.sincronizarCnpj(cnpjA, 0, 1);
    await service.sincronizarCnpj(cnpjB, 0, 1);
    expect(await repository.getXmlsForChave(key(2))).toHaveLength(2);
    expect((await repository.findByChave(key(2)))?.eventos).toHaveLength(1);
    expect(
      await repository.application.hasNote(a.id, environment, key(2)),
    ).toBe(true);
    expect(
      await repository.application.hasNote(b.id, environment, key(2)),
    ).toBe(true);
    expect(Number((await repository.getSyncControle(cnpjA)).ultimo_nsu)).toBe(
      2,
    );
    expect(closed).toBe(3);
  } finally {
    await repository.close();
  }
});

test("ADN rejection and invalid certificates persist errors without advancing the NSU", async () => {
  const { repository, companies } = await database();
  try {
    const rejection: AdnGatewayFactory = {
      create: async () => ({
        consultarNSU: async () => ({
          StatusProcessamento: "REJEICAO",
          Erros: [{ Descricao: "Sem autorização" }],
        }),
        close() {},
      }),
    };
    await expect(
      new SyncService(repository, companies, rejection).sincronizarCnpj(
        cnpjA,
        0,
        1,
      ),
    ).rejects.toThrow("Sem autorização");
    expect((await repository.getSyncControle(cnpjA)).status).toBe("ERROR");
    expect(Number((await repository.getSyncControle(cnpjA)).ultimo_nsu)).toBe(
      0,
    );
    const invalid: AdnGatewayFactory = {
      create: async () => {
        throw new Error("Certificado vencido");
      },
    };
    await expect(
      new SyncService(repository, companies, invalid).sincronizarCnpj(
        cnpjA,
        0,
        1,
      ),
    ).rejects.toThrow("vencido");
    expect((await repository.getSyncControle(cnpjA)).status).toBe("ERROR");
  } finally {
    await repository.close();
  }
});

test("DANFSe uses original XML and persisted status, and rejects unrelated companies", async () => {
  const { repository, a, b } = await database();
  let rendered = "";
  const renderer: PdfRenderer = {
    render: async (html) => {
      rendered = html;
      return Buffer.from("%PDF-1.4\n");
    },
    async close() {},
  };
  try {
    await note(repository, a, 3, "2026-09", "CANCELADA");
    const service = new DanfseService(repository, renderer, environment);
    expect((await service.generate(a, key(3))).toString()).toStartWith("%PDF-");
    expect(rendered).toContain("CANCELADA");
    expect(rendered).toContain('class="folha');
    expect(rendered).toContain("Empresa &amp; Filhos");
    await expect(service.generate(b, key(3))).rejects.toThrow("não encontrada");
    expect(await repository.getXmlByChave(key(3))).toBe(xml(3));
  } finally {
    await repository.close();
  }
});

test("monthly PDF ZIP processes all pages, reports failures and removes PDFs and ZIP after transfer", async () => {
  const { repository, a, b } = await database();
  const directory = path.join(sandbox, "exports");
  let rendered = 0;
  const renderer: PdfRenderer = {
    render: async () => {
      rendered++;
      if (rendered === 2) throw new Error("Falha de teste");
      return Buffer.from("%PDF-1.4\n");
    },
    async close() {},
  };
  const service = new PdfExportService(
    repository,
    new DanfseService(repository, renderer, environment),
    environment,
    directory,
    60000,
  );
  try {
    for (let id = 1; id <= 27; id++) await note(repository, a, id);
    await note(repository, a, 28, "2026-08");
    await service.init();
    const created = await service.create(a, "2026-09");
    let job = await service.get(created.id, a);
    for (
      let attempt = 0;
      ["QUEUED", "PROCESSING"].includes(job.status) && attempt < 500;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      job = await service.get(created.id, a);
    }
    expect(job.status).toBe("PARTIAL");
    expect(job.total).toBe(27);
    expect(job.falhas).toBe(1);
    expect((await service.list(a)).map((item) => item.id)).toContain(
      created.id,
    );
    expect(await service.list(b)).toEqual([]);
    await expect(service.claim(created.id, b)).rejects.toThrow();
    const { file } = await service.claim(created.id, a);
    const zip = new AdmZip(await readFile(file));
    expect(
      zip.getEntries().filter((entry) => entry.entryName.endsWith(".pdf")),
    ).toHaveLength(26);
    expect(zip.getEntry("falhas.json")).not.toBeNull();
    expect(await readdir(path.dirname(file))).toEqual(["pdfs.zip"]);
    await expect(service.claim(created.id, a)).rejects.toThrow("transferido");
    await service.release(created.id);
    expect((await service.get(created.id, a)).status).toBe("EXPIRED");
    await expect(readFile(file)).rejects.toThrow();
    await expect(service.claim(created.id, a)).rejects.toThrow("expirou");
    await expect(service.get("../../outro", a)).rejects.toThrow();
  } finally {
    await service.close();
    await repository.close();
  }
});

test("Gotenberg adapter sends self-contained HTML as index.html and never returns a non-PDF response", async () => {
  let receivedHtml = "";
  let filename = "";
  let invalid = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      expect(new URL(request.url).pathname).toBe(
        "/forms/chromium/convert/html",
      );
      const form = await request.formData();
      const file = form.get("files") as File;
      filename = file.name;
      receivedHtml = await file.text();
      expect(form.get("printBackground")).toBe("true");
      return new Response(invalid ? "HTML de erro" : "%PDF-1.4\n");
    },
  });
  try {
    const renderer = new GotenbergPdfRenderer(
      `http://127.0.0.1:${server.port}`,
    );
    expect((await renderer.render("<html>Nota</html>")).toString()).toStartWith(
      "%PDF-",
    );
    expect(filename).toBe("index.html");
    expect(receivedHtml).toBe("<html>Nota</html>");
    invalid = true;
    await expect(renderer.render("<html>Nota</html>")).rejects.toThrow(
      "PDF válido",
    );
  } finally {
    server.stop(true);
  }
});

test("serial renderer bounds concurrent browser work", async () => {
  let active = 0;
  let maximum = 0;
  const renderer = new SerialPdfRenderer({
    async render() {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return Buffer.from("%PDF-1.4\n");
    },
    async close() {},
  });
  await Promise.all(Array.from({ length: 5 }, () => renderer.render("nota")));
  expect(maximum).toBe(1);
  await renderer.close();
});
