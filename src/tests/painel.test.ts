import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { runInNewContext } from "vm";

test("panel groups months, submits filters to API, preserves them during pagination and exports entire month", async () => {
  const html = readFileSync("public/index.html", "utf8");
  const script = readFileSync("public/app.js", "utf8");
  const elements = new Map<string, any>();
  for (const match of html.matchAll(/id="([^"]+)"/g))
    elements.set(match[1], {
      value: "",
      textContent: "",
      innerHTML: "",
      hidden: false,
      disabled: false,
      addEventListener(type: string, callback: Function) {
        this.listeners[type] = callback;
      },
      listeners: {},
      appendChild() {},
      setAttribute() {},
      querySelector() {
        return {};
      },
      focus() {},
      showModal() {},
      classList: { add() {}, remove() {} },
    });
  const el = (id: string) => elements.get(id);
  const requests: string[] = [];
  const notes = Array.from({ length: 26 }, (_, index) => ({
    chave_acesso: String(index).padStart(50, "0"),
    numero_nfse: index + 1,
    competencia: index < 12 ? "2026-09-01" : index < 24 ? "2026-08-31" : null,
    data_emissao: "2026-10-01",
    status: "AUTORIZADA",
    valor_servicos: 100,
    razao_social_prestador: "<script>alert(1)</script>",
  }));
  const context: Record<string, any> = {
    document: {
      getElementById: el,
      addEventListener() {},
      body: { appendChild() {} },
      createElement() {
        return { click() {}, remove() {} };
      },
    },
    localStorage: {
      getItem() {
        return null;
      },
      setItem() {},
    },
    URLSearchParams,
    URL,
    setTimeout() {},
    clearTimeout() {},
    fetch: async (path: string) => {
      requests.push(path);
      const url = new URL(path, "http://test");
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        blob: async () => new Blob(["zip"]),
        json: async () => {
          if (url.pathname === "/")
            return { environment: "test", database: "sqlite" };
          if (url.pathname.startsWith("/api/sync/"))
            return { data: { ultimo_nsu: 26 } };
          return {
            data:
              url.searchParams.get("offset") === "25" ? notes.slice(25) : notes,
          };
        },
      };
    },
  };
  context.window = {
    NfseApi: { getToken: () => "", request: context.fetch },
    addEventListener() {},
  };
  runInNewContext(script, context);
  el("cnpj").value = "12345678000195";
  el("prestador").value = "Empresa";
  el("tomador").value = "123.456.789-01";
  el("papel").value = "todos";
  el("filtroTexto").value = "123";
  await el("searchForm").listeners.submit({ preventDefault() {} });
  // Event listeners trigger async work; let fetch/json and stats finish.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const rendered = el("tbody").innerHTML;
  expect(rendered.indexOf("setembro de 2026")).toBeLessThan(
    rendered.indexOf("agosto de 2026"),
  );
  expect(rendered).toContain("Sem competência informada");
  expect(rendered).toContain("&lt;script&gt;");
  expect(rendered).not.toContain("<script>");
  const initial = new URL(
    requests.find((path) => path.startsWith("/api/notas?"))!,
    "http://test",
  );
  expect(initial.searchParams.get("prestador")).toBe("Empresa");
  expect(initial.searchParams.get("tomador")).toBe("123.456.789-01");
  expect(initial.searchParams.get("busca")).toBe("123");
  el("prestador").value = "Filtro ainda não aplicado";
  await el("btnNext").listeners.click();
  const next = new URL(
    requests.find((path) => path.includes("offset=25"))!,
    "http://test",
  );
  expect(next.searchParams.get("prestador")).toBe("Empresa");
  const button = {
    dataset: { act: "zipmes", month: "2026-09" },
    disabled: false,
    textContent: "Baixar mês completo",
  };
  el("tbody").listeners.click({
    target: {
      closest() {
        return button;
      },
    },
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const zip = new URL(
    requests.find((path) => path.includes("/zip?"))!,
    "http://test",
  );
  expect([...zip.searchParams.keys()]).toEqual(["competencia"]);
  expect(zip.searchParams.get("competencia")).toBe("2026-09");
});
