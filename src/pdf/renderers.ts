import { ApplicationError } from "../application/contracts";
import type { PdfRenderer } from "../application/contracts";
import type { Browser } from "puppeteer-core";

export class GotenbergPdfRenderer implements PdfRenderer {
  constructor(
    private readonly url: string,
    private readonly timeoutMs = 60000,
    private readonly username = "",
    private readonly password = "",
  ) {}

  async render(html: string): Promise<Buffer> {
    if (!this.url)
      throw new ApplicationError(
        "Configure GOTENBERG_URL para gerar PDFs.",
        503,
      );
    const url = new URL(
      this.url.replace(/\/$/, "") + "/forms/chromium/convert/html",
    );
    if (!["http:", "https:"].includes(url.protocol))
      throw new ApplicationError("Endereço do Gotenberg inválido.", 503);
    const form = new FormData();
    form.append("files", new Blob([html], { type: "text/html" }), "index.html");
    form.append("preferCssPageSize", "true");
    form.append("printBackground", "true");
    for (const margin of [
      "marginTop",
      "marginBottom",
      "marginLeft",
      "marginRight",
    ])
      form.append(margin, "0");
    const headers: Record<string, string> = {};
    if (this.username)
      headers.Authorization = `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        body: form,
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new ApplicationError(
        "Não foi possível gerar o PDF no Gotenberg. Verifique a conexão e o tempo limite.",
        502,
      );
    }
    if (!response.ok)
      throw new ApplicationError(
        `Gotenberg retornou HTTP ${response.status}.`,
        502,
      );
    const pdf = Buffer.from(await response.arrayBuffer());
    if (pdf.subarray(0, 5).toString() !== "%PDF-")
      throw new ApplicationError(
        "O renderizador não retornou um PDF válido.",
        502,
      );
    return pdf;
  }

  async close(): Promise<void> {}
}

export class PuppeteerPdfRenderer implements PdfRenderer {
  private browser?: Promise<Browser>;

  constructor(
    private readonly executablePath: string,
    private readonly timeoutMs = 60000,
  ) {}

  async render(html: string): Promise<Buffer> {
    if (!this.executablePath)
      throw new ApplicationError(
        "Configure CHROMIUM_EXECUTABLE_PATH para utilizar o renderizador local.",
        503,
      );
    if (!this.browser) {
      this.browser = import("puppeteer-core")
        .then(({ default: puppeteer }) =>
          puppeteer.launch({
            executablePath: this.executablePath,
            headless: true,
            timeout: this.timeoutMs,
          }),
        )
        .catch(() => {
          this.browser = undefined;
          throw new ApplicationError(
            "Não foi possível iniciar o Chromium configurado.",
            503,
          );
        });
    }
    const browser = await this.browser;
    if (!browser.connected) {
      this.browser = undefined;
      throw new ApplicationError(
        "A conexão com Chromium foi interrompida. Tente novamente.",
        503,
      );
    }
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(this.timeoutMs);
      await page.setJavaScriptEnabled(false);
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        if (/^(data:|about:)/.test(request.url())) void request.continue();
        else void request.abort();
      });
      await page.setContent(html, {
        waitUntil: "load",
        timeout: this.timeoutMs,
      });
      return Buffer.from(
        await page.pdf({
          format: "A4",
          preferCSSPageSize: true,
          printBackground: true,
          timeout: this.timeoutMs,
        }),
      );
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    if (this.browser) await (await this.browser).close();
    this.browser = undefined;
  }
}

// A single render at a time bounds browser memory for both individual and batch requests.
export class SerialPdfRenderer implements PdfRenderer {
  private pending: Promise<void> = Promise.resolve();
  private waiting = 0;
  constructor(private readonly renderer: PdfRenderer) {}

  async render(html: string): Promise<Buffer> {
    if (this.waiting >= 20)
      throw new ApplicationError(
        "O renderizador está ocupado. Tente novamente em instantes.",
        429,
      );
    this.waiting++;
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.renderer.render(html);
    } finally {
      this.waiting--;
      release();
    }
  }

  async close() {
    await this.pending;
    await this.renderer.close();
  }
}
