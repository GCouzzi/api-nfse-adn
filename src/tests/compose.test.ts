import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

interface Compose {
  services: {
    api: {
      secrets?: (string | { source: string })[];
      environment: string[];
      volumes: string[];
    };
  };
  secrets?: Record<string, { file?: string }>;
}

for (const filename of [
  "docker-compose.sqlite.yml",
  "docker-compose.postgres.yml",
]) {
  test(`${filename} permits initial deployment without a certificate and keeps persistent uploads`, () => {
    const compose = Bun.YAML.parse(readFileSync(filename, "utf8")) as Compose;
    const api = compose.services.api;
    for (const mounted of api.secrets || []) {
      const name = typeof mounted === "string" ? mounted : mounted.source;
      const file = compose.secrets?.[name]?.file || "";
      expect(file).not.toMatch(/\.(pfx|p12)(?:\}|$)/i);
    }
    expect(api.environment).toContain("CERTIFICATES_DIR=/app/certs");
    expect(api.environment).toContain(
      "CERT_ENCRYPTION_KEY=${CERT_ENCRYPTION_KEY:-}",
    );
    expect(
      api.volumes.some((volume: string) => /:\/app\/certs:rw$/.test(volume)),
    ).toBe(true);
  });
}
