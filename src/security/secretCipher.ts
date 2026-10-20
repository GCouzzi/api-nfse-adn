import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ApplicationError } from "../application/contracts";

export class SecretCipher {
  private readonly key: Buffer;

  constructor(hexKey: string) {
    if (!/^[a-f\d]{64}$/i.test(hexKey)) {
      throw new ApplicationError(
        "Configure CERT_ENCRYPTION_KEY com 32 bytes em hexadecimal ou seu arquivo de segredo para cadastrar certificados.",
        503,
      );
    }
    this.key = Buffer.from(hexKey, "hex");
  }

  encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return [
      "v1",
      iv.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      encrypted.toString("base64"),
    ].join(":");
  }

  decrypt(value: string): string {
    try {
      const [version, iv, tag, ciphertext] = value.split(":");
      if (version !== "v1" || !iv || !tag || ciphertext === undefined)
        throw new Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new ApplicationError(
        "Não foi possível abrir a senha do certificado. Verifique a chave de criptografia.",
        503,
      );
    }
  }
}
