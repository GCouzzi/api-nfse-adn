import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import express from "express";
import puppeteer from "puppeteer-core";
import AdmZip from "adm-zip";
import forge from "node-forge";
import { config } from "../src/config/env";
import { ApplicationError } from "../src/application/contracts";

const executablePath =
  process.env.CHROMIUM_TEST_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sandbox = await mkdtemp(path.join(tmpdir(), "nfse-browser-smoke-"));
config.dbClient = "sqlite";
config.dbPath = ":memory:";
config.certificatesDir = path.join(sandbox, "certificates");
config.certificateEncryptionKey = "33".repeat(32);
config.enableMock = true;
config.pdfRenderer = "puppeteer";
config.chromiumPath = executablePath;
config.pdfTempDir = path.join(sandbox, "pdfs");
config.apiToken = "token-de-teste";
config.adminUsername = "escritorio";
config.adminPassword = "senha-segura-smoke";
config.sessionSecure = false;
config.appOrigin = "";

const keys = forge.pki.rsa.generateKeyPair(2048);
const testCertificate = forge.pki.createCertificate();
testCertificate.publicKey = keys.publicKey;
testCertificate.serialNumber = "01";
testCertificate.validity.notBefore = new Date(Date.now() - 86400000);
testCertificate.validity.notAfter = new Date(Date.now() + 365 * 86400000);
testCertificate.setSubject([
  { name: "commonName", value: "Certificado de Teste do Painel" },
]);
testCertificate.setIssuer(testCertificate.subject.attributes);
testCertificate.sign(keys.privateKey, forge.md.sha256.create());
const testPfx = Buffer.from(
  forge.asn1
    .toDer(
      forge.pkcs12.toPkcs12Asn1(
        keys.privateKey,
        [testCertificate],
        "senha-smoke",
        { algorithm: "3des" },
      ),
    )
    .getBytes(),
  "binary",
);
const testPfxPath = path.join(sandbox, "certificado-teste.pfx");
await writeFile(testPfxPath, testPfx);

const { default: repository } = await import("../src/database");
const { default: routes } = await import("../src/routes");
const { authMiddleware } = await import("../src/middlewares/authMiddleware");
const { adminAuth } = await import("../src/security/authInstance");
const { createAuthRoutes } = await import("../src/routes/authRoutes");
await adminAuth.init();
const { companies, pdfExports, pdfRenderer } = await import(
  "../src/main/services"
);
await repository.init();
await pdfExports.init();
const company = await companies.save({
  nome: "Empresa de Teste",
  cnpj: "12345678000195",
});
for (let id = 1; id <= 3; id++) {
  const chave = String(id).padStart(50, "0");
  const month = id === 3 ? "2026-08" : "2026-09";
  await repository.saveNotaFiscal({
    chave_acesso: chave,
    nsu: id,
    cnpj_prestador: company.cnpj,
    razao_social_prestador:
      "Prestadora de Serviços de Consultoria e Desenvolvimento de Sistemas de Informação",
    razao_social_tomador:
      "Tomadora de Serviços Administrativos e Gestão Empresarial com Nome Extenso",
    cnpj_tomador: "98765432000188",
    numero_nfse: String(id),
    competencia: `${month}-10`,
    valor_servicos: 100,
    valor_liquido: 90,
    status: id === 1 ? "CANCELADA" : "AUTORIZADA",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const xml = `<NFSe><infNFSe Id="NFS${chave}"><nNFSe>${id}</nNFSe><emit><CNPJ>${company.cnpj}</CNPJ><xNome>${company.nome}</xNome></emit><DPS><infDPS><tpAmb>2</tpAmb><dCompet>${month}-10</dCompet><prest><CNPJ>${company.cnpj}</CNPJ></prest><valores><vServPrest><vServ>100</vServ></vServPrest></valores></infDPS></DPS><valores><vLiq>90</vLiq></valores></infNFSe></NFSe>`;
  const documentId = await repository.saveDocumentoXml({
    chave_acesso: chave,
    nsu: id,
    tipo_documento: "NFSE",
    xml_conteudo: xml,
    created_at: new Date().toISOString(),
  });
  await repository.application.linkDocument(
    company,
    config.adnEnv,
    id,
    documentId,
    chave,
  );
}

const app = express();
app.use("/auth", createAuthRoutes(adminAuth, config));
app.use(express.json());
app.get("/", (_req, res) =>
  res.json({
    environment: "homologacao",
    database: "sqlite",
    authRequired: true,
  }),
);
app.use("/app", express.static(path.resolve("public")));
app.use("/api", authMiddleware, routes);
app.use(
  (
    error: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) =>
    res
      .status(error instanceof ApplicationError ? error.status : 500)
      .json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await puppeteer.launch({ executablePath, headless: true });
try {
  const errors: string[] = [];
  async function openPage() {
    const page = await browser.newPage();
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().startsWith(origin) || request.url().startsWith("data:"))
        void request.continue();
      else void request.abort();
    });
    return page;
  }
  let page = await openPage();
  await page.goto(`${origin}/app/empresas.html`);
  await page.waitForSelector("#modalLogin[open]");
  await page.type("#loginUsername", config.adminUsername);
  await page.type("#loginPassword", "senha-incorreta");
  await page.click("#loginSubmit");
  await page.waitForSelector("#loginError:not([hidden])");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("nfse_api_token")),
    null,
  );
  await page.$eval("#loginPassword", (input) => {
    (input as HTMLInputElement).value = "";
  });
  await page.type("#loginPassword", "senha-segura-smoke");
  await page.click("#loginSubmit");
  await page.waitForFunction(() =>
    document
      .querySelector("#companyRows")!
      .textContent!.includes("Empresa de Teste"),
  );
  const cookies = await page.cookies();
  const session = cookies.find((cookie) => cookie.name === "nfse_session");
  assert(session?.httpOnly);
  assert.equal(
    await page.evaluate(() => document.cookie.includes("nfse_session")),
    false,
  );
  const uploadInput = await page.$("#certificateUpload");
  assert(uploadInput);
  await uploadInput.uploadFile(testPfxPath);
  await page.type("#certificatePassword", "senha-smoke");
  const uploadResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/certificados/upload"),
  );
  await page.click("#certificateSave");
  const uploadResult = await uploadResponse;
  assert.equal(uploadResult.status(), 201);
  const uploadedCertificate = (await uploadResult.json()).data;
  assert.equal(uploadedCertificate.senha_criptografada, undefined);
  assert.deepEqual(
    await readFile(
      path.join(config.certificatesDir, uploadedCertificate.arquivo),
    ),
    testPfx,
  );
  await page.waitForFunction(() =>
    document
      .querySelector("#certificateFeedback")!
      .textContent!.includes("Certificado validado e salvo"),
  );
  await page.click(`[data-company="${company.id}"]`);
  await page.select("#companyCertificate", uploadedCertificate.id);
  await page.click("#companySave");
  await page.waitForFunction(() =>
    document
      .querySelector("#companyFeedback")!
      .textContent!.includes("Empresa salva"),
  );
  assert.equal(
    (await repository.application.getCompany(company.id))?.certificado_id,
    uploadedCertificate.id,
  );
  await page.click(`[data-certificate="${uploadedCertificate.id}"]`);
  assert.equal(
    await page.$eval(
      "#certificateSource",
      (select) => (select as HTMLSelectElement).value,
    ),
    "existing",
  );
  await page.type("#certificatePassword", "senha-smoke");
  await page.click("#certificateSave");
  await page.waitForFunction(() =>
    document
      .querySelector("#certificateFeedback")!
      .textContent!.includes("Certificado validado e salvo"),
  );
  await page.goto(`${origin}/app/`);
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLSelectElement>("#cnpj")!.options.length > 1,
  );
  await page.select("#cnpj", company.cnpj);
  await page.click("#btnBuscar");
  await page.waitForFunction(() =>
    document.querySelector("#tbody")!.textContent!.includes("setembro"),
  );
  for (const width of [1440, 1366, 1024, 768, 390, 375, 360]) {
    await page.setViewport({ width, height: 900 });
    const overflow = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth > window.innerWidth + 1,
      tables: [...document.querySelectorAll(".table-wrap")].filter(
        (element) => element.scrollWidth > element.clientWidth + 1,
      ).length,
      actions: [
        ...document.querySelectorAll("#tbody button, .table-toolbar button"),
      ].filter((element) => {
        if (!(element instanceof HTMLElement) || !element.offsetHeight)
          return false;
        const box = element.getBoundingClientRect();
        return box.left < 0 || box.right > window.innerWidth + 1;
      }).length,
    }));
    assert.deepEqual(
      overflow,
      { page: false, tables: 0, actions: 0 },
      `Notes layout at ${width}px: ${JSON.stringify(overflow)}`,
    );
    const filters = await page.evaluate(() =>
      ["cnpj", "papel", "status", "competencia"].map(
        (id) => document.getElementById(id)!.getBoundingClientRect().top,
      ),
    );
    if (width >= 1024)
      assert(
        filters.every((top) => Math.abs(top - filters[0]) <= 1),
        "Filter inputs must align",
      );
    if (width === 1366 || width === 390) {
      await mkdir("scratch", { recursive: true });
      await page.screenshot({
        path: `scratch/notas-${width}.png`,
        fullPage: true,
      });
    }
  }
  await page.setViewport({ width: 1440, height: 1000 });
  assert.equal(
    await page.$$eval("#tbody tr:not(.month-heading)", (rows) => rows.length),
    3,
  );
  await page.$eval("#competencia", (input) => {
    (input as HTMLInputElement).value = "2026-09";
  });
  await page.click("#btnBuscar");
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#tbody tr:not(.month-heading)").length === 2 &&
      !document.querySelector<HTMLButtonElement>("#btnPdfMes")!.disabled,
  );
  const createdResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/pdf/exportacoes?"),
  );
  await page.click("#btnPdfTodos");
  const exportJob = (await (await createdResponse).json()).data;
  // Close the page while the backend owns the export, then recover it without searching again.
  await page.close();
  page = await openPage();
  await page.goto(`${origin}/app/`);
  await page.waitForSelector(`[data-export-id="${exportJob.id}"]`, {
    timeout: 60000,
  });
  assert(
    (
      await page.$eval("#exportList", (element) => element.textContent)
    )?.includes("3 PDF(s)"),
  );
  const response = await page.evaluate(async (companyId) => {
    const res = await (window as any).NfseApi.request(
      `/api/notas/${"1".padStart(50, "0")}/pdf?empresaId=${companyId}`,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      length: bytes.length,
      signature: new TextDecoder().decode(bytes.slice(0, 5)),
    };
  }, company.id);
  assert.equal(response.status, 200);
  assert.equal(response.signature, "%PDF-");
  assert(response.length > 5000);
  await mkdir("scratch", { recursive: true });
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: "scratch/painel-desktop.png", fullPage: true });
  await page.goto(`${origin}/app/empresas.html`);
  await page.waitForFunction(() =>
    document
      .querySelector("#companyRows")!
      .textContent!.includes("Empresa de Teste"),
  );
  await page.type("#companyName", "Outra empresa");
  await page.type("#companyCnpj", "123");
  await page.click("#companyName");
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    "companyName",
    "Invalid CNPJ must not trap focus",
  );
  await page.$eval("#companyCnpj", (input) => {
    (input as HTMLInputElement).value = "";
  });
  await page.type("#companyCnpj", "98765432000188");
  await page.click("#companySave");
  await page.waitForFunction(() =>
    document
      .querySelector("#companyRows")!
      .textContent!.includes("Outra empresa"),
  );
  await page.goto(`${origin}/app/`);
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLSelectElement>("#cnpj")!.options.length === 3,
  );
  await page.select("#cnpj", "98765432000188");
  await page.waitForFunction(() =>
    document
      .querySelector("#exportMessage")!
      .textContent!.includes("Nenhuma exportação"),
  );
  assert.equal(
    await page.$$eval("[data-export-id]", (buttons) => buttons.length),
    0,
  );
  await page.select("#cnpj", company.cnpj);
  await page.waitForSelector(`[data-export-id="${exportJob.id}"]`);
  // Inspect the Blob received by the download helper, before the browser saves it.
  await page.evaluate(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      if (blob instanceof Blob)
        void blob.arrayBuffer().then((bytes) => {
          (window as any).downloadedBytes = Array.from(new Uint8Array(bytes));
        });
      return original(blob);
    };
  });
  const downloadedResponse = page.waitForResponse((response) =>
    response.url().includes(`/pdf/exportacoes/${exportJob.id}/arquivo?`),
  );
  await page.click(`[data-export-id="${exportJob.id}"]`);
  const downloaded = await downloadedResponse;
  assert.equal(downloaded.status(), 200);
  await page.waitForFunction(
    () => (window as any).downloadedBytes !== undefined,
  );
  const zipBytes = Buffer.from(
    await page.evaluate(() => (window as any).downloadedBytes),
  );
  assert.equal(zipBytes.subarray(0, 2).toString(), "PK");
  const zip = new AdmZip(zipBytes);
  assert.equal(
    zip.getEntries().filter((entry) => entry.entryName.endsWith(".pdf")).length,
    3,
  );
  await page.waitForFunction(() =>
    document
      .querySelector("#exportList")!
      .textContent!.includes("Removido / expirado"),
  );
  assert.equal(
    await page.$$eval("[data-export-id]", (buttons) => buttons.length),
    0,
  );
  await page.reload();
  await page.waitForFunction(() =>
    document
      .querySelector("#exportList")!
      .textContent!.includes("Removido / expirado"),
  );
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({
    path: "scratch/exportacoes-mobile.png",
    fullPage: true,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.goto(`${origin}/app/empresas.html`);
  await page.screenshot({
    path: "scratch/empresas-mobile.png",
    fullPage: true,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.waitForSelector(
    `[data-remove-certificate="${uploadedCertificate.id}"]`,
  );
  await page.click(`[data-remove-certificate="${uploadedCertificate.id}"]`);
  await page.waitForFunction(() =>
    document.getElementById("pageError")!.textContent!.includes("Desvincule"),
  );
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.click(`[data-remove-company="${company.id}"]`);
  await page.waitForFunction(
    (id) => !document.querySelector(`[data-company="${id}"]`),
    {},
    company.id,
  );
  assert.equal(await repository.application.getCompany(company.id), null);
  assert(
    await repository.findByChave("1".padStart(50, "0")),
    "Removing company must preserve notes",
  );
  await page.type("#companyName", company.nome);
  await page.type("#companyCnpj", company.cnpj);
  await page.click("#companySave");
  await page.waitForSelector(`[data-company="${company.id}"]`);
  assert(
    await repository.application.hasNote(
      company.id,
      config.adnEnv,
      "1".padStart(50, "0"),
    ),
    "Restoring CNPJ must recover notes",
  );
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.click(`[data-remove-company="${company.id}"]`);
  await page.waitForFunction(
    (id) => !document.querySelector(`[data-company="${id}"]`),
    {},
    company.id,
  );
  page.once("dialog", (dialog) => {
    void dialog.accept();
  });
  await page.click(`[data-remove-certificate="${uploadedCertificate.id}"]`);
  await page.waitForFunction(
    (id) => !document.querySelector(`[data-certificate="${id}"]`),
    {},
    uploadedCertificate.id,
  );
  assert.equal(
    await repository.application.getCertificate(uploadedCertificate.id),
    null,
  );
  await assert.rejects(
    readFile(path.join(config.certificatesDir, uploadedCertificate.arquivo)),
  );
  await page.click("[data-auth]");
  await page.waitForSelector("#modalLogin[open]");
  assert.equal(
    (await page.cookies()).some((cookie) => cookie.name === "nfse_session"),
    false,
  );
  assert.equal((await fetch(origin + "/api/empresas")).status, 401);
  assert.deepEqual(errors, []);
  console.log(
    "Browser smoke: login, upload, remoção e restauração de empresa, remoção de certificado, foco do CNPJ, notas sem rolagem horizontal em 7 tamanhos, recuperação de lote, PDFs e logout aprovados.",
  );
} finally {
  await browser.close();
  await pdfExports.close();
  await pdfRenderer.close();
  await repository.close();
  server.close();
  await rm(sandbox, { recursive: true, force: true });
}
