import type {
  ApplicationRepository,
  CertificateRecord,
  Company,
  Environment,
  PdfExport,
  SqlExecutor,
} from "../application/contracts";
import { createHash } from "node:crypto";

export class SqlApplicationRepository implements ApplicationRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async init(environment: Environment): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS application_metadata (chave TEXT PRIMARY KEY, valor TEXT NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS notas_legadas (chave_acesso TEXT PRIMARY KEY)`,
      `CREATE TABLE IF NOT EXISTS certificados (
        id TEXT PRIMARY KEY, arquivo TEXT NOT NULL, senha_criptografada TEXT NOT NULL,
        titular TEXT NOT NULL, validade TEXT NOT NULL, fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS empresas (
        id TEXT PRIMARY KEY, nome TEXT NOT NULL, cnpj TEXT UNIQUE NOT NULL,
        ativa INTEGER NOT NULL DEFAULT 1, certificado_id TEXT REFERENCES certificados(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS empresas_removidas (
        empresa_id TEXT PRIMARY KEY REFERENCES empresas(id), removida_em TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS empresa_notas (
        empresa_id TEXT NOT NULL REFERENCES empresas(id), ambiente TEXT NOT NULL,
        chave_acesso TEXT NOT NULL, origem TEXT NOT NULL,
        PRIMARY KEY (empresa_id, ambiente, chave_acesso)
      )`,
      `CREATE TABLE IF NOT EXISTS empresa_documentos (
        empresa_id TEXT NOT NULL REFERENCES empresas(id), ambiente TEXT NOT NULL,
        nsu BIGINT NOT NULL, documento_id BIGINT NOT NULL REFERENCES documentos_xml(id),
        PRIMARY KEY (empresa_id, ambiente, nsu)
      )`,
      `CREATE TABLE IF NOT EXISTS documento_identidades (
        hash TEXT PRIMARY KEY, documento_id BIGINT NOT NULL REFERENCES documentos_xml(id)
      )`,
      `CREATE TABLE IF NOT EXISTS exportacoes_pdf (
        id TEXT PRIMARY KEY, empresa_id TEXT NOT NULL REFERENCES empresas(id), ambiente TEXT NOT NULL,
        status TEXT NOT NULL, competencia TEXT, total INTEGER NOT NULL DEFAULT 0,
        processadas INTEGER NOT NULL DEFAULT 0, falhas INTEGER NOT NULL DEFAULT 0,
        erro TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_empresa_documentos_documento ON empresa_documentos(documento_id)`,
    ];

    for (const statement of statements) await this.sql.query(statement);

    await this.sql.query(
      "INSERT INTO application_metadata (chave, valor) VALUES ('ambiente', ?) ON CONFLICT (chave) DO NOTHING",
      [environment],
    );
    const [saved] = await this.sql.query<{ valor: string }>(
      "SELECT valor FROM application_metadata WHERE chave = 'ambiente'",
    );
    if (saved.valor !== environment) {
      throw new Error(
        "Este banco pertence a outro ambiente ADN. Utilize um banco separado para cada ambiente.",
      );
    }
    await this.sql.query(`INSERT INTO notas_legadas (chave_acesso)
      SELECT chave_acesso FROM notas_fiscais WHERE NOT EXISTS (
        SELECT 1 FROM application_metadata WHERE chave = 'legacy_snapshot'
      ) ON CONFLICT (chave_acesso) DO NOTHING`);
    await this.sql.query(
      "INSERT INTO application_metadata (chave, valor) VALUES ('legacy_snapshot', '1') ON CONFLICT (chave) DO NOTHING",
    );
    let lastId = 0;
    while (true) {
      const documents = await this.sql.query<{
        id: number;
        tipo_documento: string;
        chave_acesso: string;
        xml_conteudo: string;
      }>(
        "SELECT d.id, d.tipo_documento, d.chave_acesso, d.xml_conteudo FROM documentos_xml d WHERE d.id > ? AND NOT EXISTS (SELECT 1 FROM documento_identidades i WHERE i.documento_id = d.id) ORDER BY d.id LIMIT 200",
        [lastId],
      );
      for (const doc of documents) {
        const hash = createHash("sha256")
          .update(
            `${doc.tipo_documento}\0${doc.chave_acesso}\0${doc.xml_conteudo}`,
          )
          .digest("hex");
        await this.registerDocument(hash, Number(doc.id));
        lastId = Number(doc.id);
      }
      if (documents.length < 200) break;
    }
  }

  listCompanies() {
    return this.sql.query<Company>(
      "SELECT e.* FROM empresas e WHERE NOT EXISTS (SELECT 1 FROM empresas_removidas r WHERE r.empresa_id = e.id) ORDER BY nome, cnpj",
    );
  }

  async getCompany(id: string) {
    return (
      (
        await this.sql.query<Company>(
          "SELECT e.* FROM empresas e WHERE e.id = ? AND NOT EXISTS (SELECT 1 FROM empresas_removidas r WHERE r.empresa_id = e.id)",
          [id],
        )
      )[0] ?? null
    );
  }

  async getCompanyByCnpj(cnpj: string, includeRemoved = false) {
    return (
      (
        await this.sql.query<Company>(
          `SELECT e.*, r.removida_em FROM empresas e LEFT JOIN empresas_removidas r ON r.empresa_id = e.id WHERE e.cnpj = ? ${includeRemoved ? "" : "AND r.empresa_id IS NULL"}`,
          [cnpj],
        )
      )[0] ?? null
    );
  }

  async saveCompany(company: Company) {
    await this.sql.atomic([
      {
        sql: `INSERT INTO empresas (id, nome, cnpj, ativa, certificado_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET
      nome = excluded.nome, ativa = excluded.ativa, certificado_id = excluded.certificado_id, updated_at = excluded.updated_at`,
        params: [
          company.id,
          company.nome,
          company.cnpj,
          company.ativa,
          company.certificado_id,
          company.created_at,
          company.updated_at,
        ],
      },
      {
        sql: "DELETE FROM empresas_removidas WHERE empresa_id = ?",
        params: [company.id],
      },
    ]);
  }

  async removeCompany(id: string) {
    await this.sql.atomic([
      {
        sql: "INSERT INTO empresas_removidas (empresa_id, removida_em) VALUES (?, ?) ON CONFLICT (empresa_id) DO NOTHING",
        params: [id, new Date().toISOString()],
      },
      {
        sql: "UPDATE empresas SET certificado_id = NULL, updated_at = ? WHERE id = ?",
        params: [new Date().toISOString(), id],
      },
    ]);
  }

  async removeCertificate(id: string) {
    const rows = await this.sql.query<{ id: string }>(
      "DELETE FROM certificados WHERE id = ? AND NOT EXISTS (SELECT 1 FROM empresas WHERE certificado_id = ?) RETURNING id",
      [id, id],
    );
    return rows.length > 0;
  }

  async isCertificateFileRegistered(filename: string) {
    return (
      (
        await this.sql.query(
          "SELECT 1 FROM certificados WHERE arquivo = ? LIMIT 1",
          [filename],
        )
      ).length > 0
    );
  }

  listCertificates() {
    return this.sql.query<CertificateRecord>(
      "SELECT * FROM certificados ORDER BY titular, arquivo",
    );
  }

  async getCertificate(id: string) {
    return (
      (
        await this.sql.query<CertificateRecord>(
          "SELECT * FROM certificados WHERE id = ?",
          [id],
        )
      )[0] ?? null
    );
  }

  async saveCertificate(certificate: CertificateRecord) {
    await this.sql.query(
      `INSERT INTO certificados (id, arquivo, senha_criptografada, titular, validade, fingerprint, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET
      arquivo = excluded.arquivo, senha_criptografada = excluded.senha_criptografada, titular = excluded.titular,
      validade = excluded.validade, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
      [
        certificate.id,
        certificate.arquivo,
        certificate.senha_criptografada,
        certificate.titular,
        certificate.validade,
        certificate.fingerprint,
        certificate.updated_at,
      ],
    );
  }

  async linkLegacyNotes(company: Company, environment: Environment) {
    await this.sql.query(
      `INSERT INTO empresa_notas (empresa_id, ambiente, chave_acesso, origem)
      SELECT ?, ?, n.chave_acesso, 'LEGADO' FROM notas_fiscais n
      INNER JOIN notas_legadas l ON l.chave_acesso = n.chave_acesso
      WHERE n.cnpj_prestador = ? OR n.cnpj_tomador = ? OR n.cpf_tomador = ?
      ON CONFLICT (empresa_id, ambiente, chave_acesso) DO NOTHING`,
      [company.id, environment, company.cnpj, company.cnpj, company.cnpj],
    );
  }

  async linkDocument(
    company: Company,
    environment: Environment,
    nsu: number,
    documentId: number,
    chave: string,
  ) {
    await this.sql.query(
      `INSERT INTO empresa_documentos (empresa_id, ambiente, nsu, documento_id)
      VALUES (?, ?, ?, ?) ON CONFLICT (empresa_id, ambiente, nsu) DO UPDATE SET documento_id = excluded.documento_id`,
      [company.id, environment, nsu, documentId],
    );
    if (!/^\d{50}$/.test(chave)) return;
    await this.sql.query(
      `INSERT INTO empresa_notas (empresa_id, ambiente, chave_acesso, origem)
      VALUES (?, ?, ?, 'SINCRONIZACAO') ON CONFLICT (empresa_id, ambiente, chave_acesso) DO UPDATE SET origem = excluded.origem`,
      [company.id, environment, chave],
    );
  }

  async hasNote(companyId: string, environment: Environment, chave: string) {
    return (
      (
        await this.sql.query(
          "SELECT 1 FROM empresa_notas WHERE empresa_id = ? AND ambiente = ? AND chave_acesso = ?",
          [companyId, environment, chave],
        )
      ).length > 0
    );
  }

  async findDocument(hash: string) {
    const [row] = await this.sql.query<{ documento_id: number }>(
      "SELECT documento_id FROM documento_identidades WHERE hash = ?",
      [hash],
    );
    return row ? Number(row.documento_id) : null;
  }

  async noteNsus(companyId: string, environment: Environment, keys: string[]) {
    if (!keys.length) return new Map<string, number>();
    const rows = await this.sql.query<{ chave_acesso: string; nsu: number }>(
      `SELECT d.chave_acesso, MAX(ed.nsu) AS nsu FROM empresa_documentos ed
       INNER JOIN documentos_xml d ON d.id = ed.documento_id
       WHERE ed.empresa_id = ? AND ed.ambiente = ? AND d.tipo_documento = 'NFSE'
       AND d.chave_acesso IN (${keys.map(() => "?").join(", ")}) GROUP BY d.chave_acesso`,
      [companyId, environment, ...keys],
    );
    return new Map(rows.map((row) => [row.chave_acesso, Number(row.nsu)]));
  }

  async exportNoteKeys(
    companyId: string,
    environment: Environment,
    competencia?: string,
  ) {
    const rows = await this.sql.query<{ chave_acesso: string }>(
      `SELECT n.chave_acesso FROM empresa_notas en INNER JOIN notas_fiscais n ON n.chave_acesso = en.chave_acesso
       WHERE en.empresa_id = ? AND en.ambiente = ? ${competencia ? "AND SUBSTR(n.competencia, 1, 7) = ?" : ""}
       ORDER BY n.chave_acesso`,
      competencia
        ? [companyId, environment, competencia]
        : [companyId, environment],
    );
    return rows.map((row) => row.chave_acesso);
  }

  async registerDocument(hash: string, documentId: number) {
    await this.sql.query(
      "INSERT INTO documento_identidades (hash, documento_id) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING",
      [hash, documentId],
    );
  }

  async hasEvent(documentId: number) {
    return (
      (
        await this.sql.query(
          "SELECT 1 FROM eventos_nfse WHERE documento_xml_id = ?",
          [documentId],
        )
      ).length > 0
    );
  }

  async createExport(job: PdfExport) {
    await this.sql.query(
      `INSERT INTO exportacoes_pdf (id, empresa_id, ambiente, status, competencia, total, processadas, falhas, erro, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        job.empresa_id,
        job.ambiente,
        job.status,
        job.competencia,
        job.total,
        job.processadas,
        job.falhas,
        job.erro,
        job.created_at,
        job.expires_at,
      ],
    );
  }

  async getExport(id: string) {
    return (
      (
        await this.sql.query<PdfExport>(
          "SELECT * FROM exportacoes_pdf WHERE id = ?",
          [id],
        )
      )[0] ?? null
    );
  }

  listExports(companyId?: string, environment?: Environment, limit?: number) {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (companyId) {
      conditions.push("empresa_id = ?");
      params.push(companyId);
    }
    if (environment) {
      conditions.push("ambiente = ?");
      params.push(environment);
    }
    if (limit !== undefined) params.push(limit);
    return this.sql.query<PdfExport>(
      `SELECT * FROM exportacoes_pdf ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC ${limit !== undefined ? "LIMIT ?" : ""}`,
      params,
    );
  }

  async updateExport(id: string, fields: Partial<PdfExport>) {
    const entries = Object.entries(fields).filter(([key]) =>
      [
        "status",
        "total",
        "processadas",
        "falhas",
        "erro",
        "expires_at",
      ].includes(key),
    );
    if (!entries.length) return;
    await this.sql.query(
      `UPDATE exportacoes_pdf SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`,
      [...entries.map(([, value]) => value as string | number | null), id],
    );
  }
}
