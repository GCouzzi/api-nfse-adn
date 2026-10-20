import {
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createSecureContext } from "node:tls";
import forge from "node-forge";
import {
  ApplicationError,
  MAX_CERTIFICATE_BYTES,
} from "../application/contracts";
import type {
  ApplicationRepository,
  CertificateRegistry,
  CertificateRecord,
  CertificateUpload,
  Company,
} from "../application/contracts";
import { SecretCipher } from "../security/secretCipher";

export class FolderCertificateProvider implements CertificateRegistry {
  constructor(
    private readonly repository: ApplicationRepository,
    private readonly directory: string,
    private readonly key: () => string,
    private readonly legacyFile?: string,
    private readonly legacyBase64?: string,
  ) {}

  async files(): Promise<string[]> {
    try {
      const entries = await readdir(this.directory, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !/\.(pfx|p12)$/i.test(entry.name)) continue;
        await this.read(entry.name);
        files.push(entry.name);
      }
      if (this.legacyBase64 || (this.legacyFile && existsSync(this.legacyFile)))
        files.push("certificado-configurado.pfx");
      return [...new Set(files)].sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return this.legacyBase64 ||
          (this.legacyFile && existsSync(this.legacyFile))
          ? ["certificado-configurado.pfx"]
          : [];
      throw error;
    }
  }

  private async read(filename: string): Promise<Buffer> {
    if (filename === "certificado-configurado.pfx" && this.legacyBase64) {
      const pfx = Buffer.from(this.legacyBase64, "base64");
      if (!pfx.length || pfx.length > 10 * 1024 * 1024)
        throw new ApplicationError("Certificado Base64 inválido.");
      return pfx;
    }
    if (
      filename === "certificado-configurado.pfx" &&
      this.legacyFile &&
      existsSync(this.legacyFile)
    ) {
      const info = await stat(this.legacyFile);
      if (!info.isFile() || info.size > 10 * 1024 * 1024)
        throw new ApplicationError("Arquivo do certificado inválido.");
      return readFile(this.legacyFile);
    }
    if (
      typeof filename !== "string" ||
      !/^[^/\\\x00]+\.(pfx|p12)$/i.test(filename) ||
      filename.includes(":")
    ) {
      throw new ApplicationError(
        "Selecione um certificado da pasta configurada.",
      );
    }
    const root = await realpath(this.directory);
    let resolved: string;
    try {
      resolved = await realpath(path.join(root, filename));
    } catch {
      throw new ApplicationError(
        "O arquivo do certificado não está disponível.",
      );
    }
    if (path.dirname(resolved) !== root)
      throw new ApplicationError("Certificado fora da pasta permitida.");
    const info = await stat(resolved);
    if (!info.isFile() || info.size > 10 * 1024 * 1024)
      throw new ApplicationError(
        "O certificado deve ser um arquivo de até 10 MB.",
      );
    return readFile(resolved);
  }

  private inspect(pfx: Buffer, passphrase: string) {
    try {
      createSecureContext({ pfx, passphrase, minVersion: "TLSv1.2" });
      const asn1 = forge.asn1.fromDer(pfx.toString("binary"));
      const container = forge.pkcs12.pkcs12FromAsn1(asn1, passphrase);
      const bags =
        container.getBags({ bagType: forge.pki.oids.certBag })[
          forge.pki.oids.certBag
        ] ?? [];
      const keys = [
        forge.pki.oids.pkcs8ShroudedKeyBag,
        forge.pki.oids.keyBag,
      ].flatMap((type) => container.getBags({ bagType: type })[type] ?? []);
      const privateKey = keys.find((bag) => bag.key)?.key;
      if (!privateKey || !("n" in privateKey) || !("e" in privateKey))
        throw new Error();
      const certificate = bags
        .map((bag) => bag.cert)
        .find(
          (cert) =>
            cert &&
            forge.pki.publicKeyToPem(cert.publicKey) ===
              forge.pki.publicKeyToPem(
                forge.pki.rsa.setPublicKey(privateKey.n, privateKey.e),
              ),
        );
      if (!certificate) throw new Error();
      const now = new Date();
      if (
        certificate.validity.notBefore > now ||
        certificate.validity.notAfter <= now
      ) {
        throw new ApplicationError(
          "O certificado está vencido ou ainda não é válido.",
        );
      }
      return {
        titular: String(
          certificate.subject.getField("CN")?.value || "Certificado A1",
        ),
        validade: certificate.validity.notAfter.toISOString(),
        fingerprint: createHash("sha256").update(pfx).digest("hex"),
      };
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "Certificado A1 inválido, sem chave privada ou senha incorreta.",
      );
    }
  }

  async register(
    filename: string,
    password: string,
    id: string = crypto.randomUUID(),
  ): Promise<CertificateRecord> {
    const cipher = new SecretCipher(this.key());
    const pfx = await this.read(filename);
    const metadata = this.inspect(pfx, password);
    const record: CertificateRecord = {
      id,
      arquivo: filename,
      senha_criptografada: cipher.encrypt(password),
      ...metadata,
      updated_at: new Date().toISOString(),
    };
    await this.repository.saveCertificate(record);
    return record;
  }

  async remove(id: string): Promise<{ aviso?: string }> {
    const certificate = await this.repository.getCertificate(id);
    if (!certificate)
      throw new ApplicationError("Certificado não encontrado.", 404);
    if (!(await this.repository.removeCertificate(id))) {
      throw new ApplicationError(
        "Desvincule o certificado das empresas antes de removê-lo.",
        409,
      );
    }
    const managed =
      /^certificado-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.pfx$/i.test(
        certificate.arquivo,
      );
    if (!managed)
      return {
        aviso:
          "Cadastro removido. O arquivo disponibilizado manualmente permanece na pasta do servidor.",
      };
    if (await this.repository.isCertificateFileRegistered(certificate.arquivo))
      return {};
    try {
      await unlink(path.join(this.directory, certificate.arquivo));
      return {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      return {
        aviso:
          "Cadastro removido, mas não foi possível apagar o arquivo da pasta do servidor. Verifique as permissões.",
      };
    }
  }

  async upload(
    input: CertificateUpload,
    id: string = crypto.randomUUID(),
  ): Promise<CertificateRecord> {
    if (
      typeof input.filename !== "string" ||
      input.filename.length > 255 ||
      !/^[^/\\\x00:]+\.(pfx|p12)$/i.test(input.filename)
    )
      throw new ApplicationError(
        "Envie um arquivo .pfx ou .p12 com nome válido.",
      );
    if (
      !Buffer.isBuffer(input.content) ||
      !input.content.length ||
      input.content.length > MAX_CERTIFICATE_BYTES
    )
      throw new ApplicationError(
        "O certificado deve ser um arquivo de até 10 MB.",
        413,
      );
    if (typeof input.password !== "string" || input.password.length > 1000)
      throw new ApplicationError(
        "Informe a senha do certificado, com até 1000 caracteres.",
      );

    const cipher = new SecretCipher(this.key());
    const metadata = this.inspect(input.content, input.password);
    const record: CertificateRecord = {
      id,
      arquivo: `certificado-${crypto.randomUUID()}.pfx`,
      senha_criptografada: cipher.encrypt(input.password),
      ...metadata,
      updated_at: new Date().toISOString(),
    };
    let destination: string | undefined;
    let created = false;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const root = await realpath(this.directory);
      const publicRoot = await realpath(path.resolve("public")).catch(() =>
        path.resolve("public"),
      );
      const relative = path.relative(publicRoot, root);
      if (
        !relative ||
        (!path.isAbsolute(relative) &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`))
      )
        throw new ApplicationError(
          "Configure CERTIFICATES_DIR fora da pasta pública da aplicação.",
          503,
        );
      destination = path.join(root, record.arquivo);
      const file = await open(destination, "wx", 0o600);
      created = true;
      try {
        await file.writeFile(input.content);
        await file.sync();
      } finally {
        await file.close();
      }
      await this.repository.saveCertificate(record);
      return record;
    } catch (error) {
      if (created && destination)
        await unlink(destination).catch(() => {
          console.error(
            "Não foi possível remover o arquivo de um cadastro de certificado que falhou.",
          );
        });
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        "Não foi possível salvar o certificado. Verifique o banco e a permissão de escrita em CERTIFICATES_DIR. Docker Secrets são somente leitura.",
        503,
      );
    }
  }

  async resolve(company: Company) {
    const certificate = company.certificado_id
      ? await this.repository.getCertificate(company.certificado_id)
      : null;
    if (!certificate)
      throw new ApplicationError(
        "Cadastre e vincule um certificado à empresa antes de sincronizar.",
      );
    const pfx = await this.read(certificate.arquivo);
    if (
      createHash("sha256").update(pfx).digest("hex") !== certificate.fingerprint
    ) {
      throw new ApplicationError(
        "O arquivo do certificado foi alterado. Valide novamente o certificado no cadastro.",
      );
    }
    const passphrase = new SecretCipher(this.key()).decrypt(
      certificate.senha_criptografada,
    );
    this.inspect(pfx, passphrase);
    return { pfx, passphrase };
  }
}
