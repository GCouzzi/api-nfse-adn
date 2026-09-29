import { Pool } from "pg";
import { config } from "../../config/env";
import type { IDatabaseRepository, FindAllByCnpjOptions } from "../types";
import type {
  NotaFiscal,
  EventoNfse,
  DocumentoXml,
  NotaFiscalComEventos,
  SyncControle,
  SyncJob
} from "../../types/models";

export class PostgresRepository implements IDatabaseRepository {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.pgPoolSize,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });

    this.pool.on("error", (err) => {
      console.error("[PostgresPool] Erro inesperado no cliente ocioso:", err);
    });
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Tabela de controle de sincronização
      await client.query(`
        CREATE TABLE IF NOT EXISTS sync_controle (
          cnpj VARCHAR(14) PRIMARY KEY,
          ultimo_nsu BIGINT NOT NULL DEFAULT 0,
          max_nsu BIGINT NOT NULL DEFAULT 0,
          ultima_sincronizacao TIMESTAMPTZ,
          status VARCHAR(20) NOT NULL DEFAULT 'IDLE',
          mensagem_erro TEXT
        );
      `);

      // Tabela de fila e histórico de jobs de sincronização assíncrona
      await client.query(`
        CREATE TABLE IF NOT EXISTS sync_jobs (
          id BIGSERIAL PRIMARY KEY,
          cnpj VARCHAR(14) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
          nsu_inicial BIGINT,
          nsu_final BIGINT,
          novos_documentos INTEGER DEFAULT 0,
          total_notas INTEGER DEFAULT 0,
          total_eventos INTEGER DEFAULT 0,
          ciclos_executados INTEGER DEFAULT 0,
          erro TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at TIMESTAMPTZ,
          finished_at TIMESTAMPTZ
        );
      `);

      // Tabela de Notas Fiscais
      await client.query(`
        CREATE TABLE IF NOT EXISTS notas_fiscais (
          id BIGSERIAL PRIMARY KEY,
          chave_acesso VARCHAR(50) UNIQUE NOT NULL,
          nsu BIGINT NOT NULL,
          cnpj_prestador VARCHAR(14) NOT NULL,
          cnpj_tomador VARCHAR(14),
          cpf_tomador VARCHAR(11),
          razao_social_prestador TEXT,
          razao_social_tomador TEXT,
          numero_nfse VARCHAR(30),
          serie VARCHAR(10),
          data_emissao TIMESTAMPTZ,
          competencia VARCHAR(10),
          valor_servicos NUMERIC(15,2) DEFAULT 0.00,
          valor_liquido NUMERIC(15,2) DEFAULT 0.00,
          descricao_servico TEXT,
          codigo_municipio VARCHAR(10),
          status VARCHAR(20) NOT NULL DEFAULT 'AUTORIZADA',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // Tabela de XMLs originais
      await client.query(`
        CREATE TABLE IF NOT EXISTS documentos_xml (
          id BIGSERIAL PRIMARY KEY,
          chave_acesso VARCHAR(50) NOT NULL,
          nsu BIGINT NOT NULL,
          tipo_documento VARCHAR(30) NOT NULL,
          tipo_evento VARCHAR(60),
          xml_conteudo TEXT NOT NULL,
          data_hora_geracao TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // Tabela de Eventos (Cancelamentos, Confirmações, etc.)
      await client.query(`
        CREATE TABLE IF NOT EXISTS eventos_nfse (
          id BIGSERIAL PRIMARY KEY,
          chave_acesso VARCHAR(50) NOT NULL,
          nsu BIGINT NOT NULL,
          tipo_evento VARCHAR(60) NOT NULL,
          descricao_evento TEXT,
          motivo TEXT,
          data_hora_evento TIMESTAMPTZ,
          documento_xml_id BIGINT REFERENCES documentos_xml(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      // Índices B-Tree compostos e parciais otimizados
      await client.query(`CREATE INDEX IF NOT EXISTS idx_notas_prestador_emissao ON notas_fiscais(cnpj_prestador, data_emissao DESC);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_notas_tomador_emissao ON notas_fiscais(cnpj_tomador, data_emissao DESC) WHERE cnpj_tomador IS NOT NULL;`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_notas_cpf_tomador ON notas_fiscais(cpf_tomador) WHERE cpf_tomador IS NOT NULL;`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_notas_chave ON notas_fiscais(chave_acesso);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_notas_nsu ON notas_fiscais(nsu);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_docs_chave ON documentos_xml(chave_acesso);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_docs_nsu ON documentos_xml(nsu);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_eventos_chave ON eventos_nfse(chave_acesso);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_cnpj ON sync_jobs(cnpj);`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON sync_jobs(status);`);

      await client.query("COMMIT");
      console.log("[PostgresRepository] Banco PostgreSQL e índices otimizados inicializados com sucesso.");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getSyncControle(cnpj: string): Promise<SyncControle> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    const res = await this.pool.query<SyncControle>(
      "SELECT * FROM sync_controle WHERE cnpj = $1",
      [cleanCnpj]
    );

    if (res.rows.length > 0) {
      return res.rows[0];
    }

    const novo: SyncControle = {
      cnpj: cleanCnpj,
      ultimo_nsu: 0,
      max_nsu: 0,
      ultima_sincronizacao: null,
      status: "IDLE",
      mensagem_erro: null
    };

    await this.pool.query(
      `INSERT INTO sync_controle (cnpj, ultimo_nsu, max_nsu, ultima_sincronizacao, status, mensagem_erro)
       VALUES ($1, 0, 0, NULL, 'IDLE', NULL)
       ON CONFLICT (cnpj) DO NOTHING`,
      [cleanCnpj]
    );

    return novo;
  }

  async setSyncStatus(cnpj: string, status: "IDLE" | "SYNCING" | "ERROR" | "SUCCESS", errorMsg?: string | null): Promise<void> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    await this.pool.query(
      `UPDATE sync_controle 
       SET status = $1, mensagem_erro = $2 
       WHERE cnpj = $3`,
      [status, errorMsg || null, cleanCnpj]
    );
  }

  async updateSyncProgress(cnpj: string, ultimoNsu: number, maxNsu: number): Promise<void> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    await this.pool.query(
      `UPDATE sync_controle 
       SET ultimo_nsu = $1, 
           max_nsu = GREATEST(max_nsu, $2), 
           ultima_sincronizacao = NOW(), 
           status = 'SUCCESS', 
           mensagem_erro = NULL 
       WHERE cnpj = $3`,
      [ultimoNsu, maxNsu, cleanCnpj]
    );
  }

  async createSyncJob(cnpj: string, nsuInicial?: number): Promise<SyncJob> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    const res = await this.pool.query<SyncJob>(
      `INSERT INTO sync_jobs (cnpj, status, nsu_inicial, created_at)
       VALUES ($1, 'QUEUED', $2, NOW())
       RETURNING *`,
      [cleanCnpj, nsuInicial ?? null]
    );
    return res.rows[0];
  }

  async getSyncJob(id: number): Promise<SyncJob | null> {
    const res = await this.pool.query<SyncJob>("SELECT * FROM sync_jobs WHERE id = $1", [id]);
    return res.rows.length > 0 ? res.rows[0] : null;
  }

  async listSyncJobs(cnpj?: string, limit = 20): Promise<SyncJob[]> {
    if (cnpj) {
      const cleanCnpj = cnpj.replace(/\D/g, "");
      const res = await this.pool.query<SyncJob>(
        "SELECT * FROM sync_jobs WHERE cnpj = $1 ORDER BY id DESC LIMIT $2",
        [cleanCnpj, limit]
      );
      return res.rows;
    }
    const res = await this.pool.query<SyncJob>("SELECT * FROM sync_jobs ORDER BY id DESC LIMIT $1", [limit]);
    return res.rows;
  }

  async updateSyncJob(id: number, updates: Partial<SyncJob>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = $${idx++}`);
      values.push(value);
    }

    if (fields.length === 0) return;

    values.push(id);
    await this.pool.query(`UPDATE sync_jobs SET ${fields.join(", ")} WHERE id = $${idx}`, values);
  }

  async getActiveSyncJobByCnpj(cnpj: string): Promise<SyncJob | null> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    const res = await this.pool.query<SyncJob>(
      `SELECT * FROM sync_jobs 
       WHERE cnpj = $1 AND status IN ('QUEUED', 'PROCESSING') 
       ORDER BY id DESC LIMIT 1`,
      [cleanCnpj]
    );
    return res.rows.length > 0 ? res.rows[0] : null;
  }

  async saveDocumentoXml(doc: Omit<DocumentoXml, "id">): Promise<number> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO documentos_xml (
        chave_acesso, nsu, tipo_documento, tipo_evento, xml_conteudo, data_hora_geracao, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING id`,
      [
        doc.chave_acesso,
        doc.nsu,
        doc.tipo_documento,
        doc.tipo_evento || null,
        doc.xml_conteudo,
        doc.data_hora_geracao || null
      ]
    );
    return Number(res.rows[0].id);
  }

  async saveNotaFiscal(nota: Omit<NotaFiscal, "id">): Promise<void> {
    await this.pool.query(
      `INSERT INTO notas_fiscais (
        chave_acesso, nsu, cnpj_prestador, cnpj_tomador, cpf_tomador,
        razao_social_prestador, razao_social_tomador, numero_nfse, serie,
        data_emissao, competencia, valor_servicos, valor_liquido,
        descricao_servico, codigo_municipio, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW(), NOW())
      ON CONFLICT (chave_acesso) DO UPDATE SET
        nsu = EXCLUDED.nsu,
        valor_servicos = CASE WHEN EXCLUDED.valor_servicos > 0 THEN EXCLUDED.valor_servicos ELSE notas_fiscais.valor_servicos END,
        valor_liquido = CASE WHEN EXCLUDED.valor_liquido > 0 THEN EXCLUDED.valor_liquido ELSE notas_fiscais.valor_liquido END,
        updated_at = NOW()`,
      [
        nota.chave_acesso,
        nota.nsu,
        nota.cnpj_prestador,
        nota.cnpj_tomador || null,
        nota.cpf_tomador || null,
        nota.razao_social_prestador || null,
        nota.razao_social_tomador || null,
        nota.numero_nfse || null,
        nota.serie || null,
        nota.data_emissao || null,
        nota.competencia || null,
        nota.valor_servicos,
        nota.valor_liquido,
        nota.descricao_servico || null,
        nota.codigo_municipio || null,
        nota.status || "AUTORIZADA"
      ]
    );
  }

  async saveEvento(evento: Omit<EventoNfse, "id">): Promise<void> {
    await this.pool.query(
      `INSERT INTO eventos_nfse (
        chave_acesso, nsu, tipo_evento, descricao_evento, motivo, data_hora_evento, documento_xml_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        evento.chave_acesso,
        evento.nsu,
        evento.tipo_evento,
        evento.descricao_evento || null,
        evento.motivo || null,
        evento.data_hora_evento || null,
        evento.documento_xml_id || null
      ]
    );
  }

  async updateNotaStatus(chaveAcesso: string, status: string): Promise<void> {
    await this.pool.query(
      "UPDATE notas_fiscais SET status = $1, updated_at = NOW() WHERE chave_acesso = $2",
      [status, chaveAcesso]
    );
  }

  async findAllByCnpj(cnpj: string, options: FindAllByCnpjOptions = {}): Promise<NotaFiscalComEventos[]> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    const papel = options.papel || "todos";
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const conditions: string[] = [];
    const params: any[] = [];
    let pIdx = 1;

    if (papel === "prestador") {
      conditions.push(`n.cnpj_prestador = $${pIdx++}`);
      params.push(cleanCnpj);
    } else if (papel === "tomador") {
      conditions.push(`(n.cnpj_tomador = $${pIdx} OR n.cpf_tomador = $${pIdx++})`);
      params.push(cleanCnpj);
    } else {
      conditions.push(`(n.cnpj_prestador = $${pIdx} OR n.cnpj_tomador = $${pIdx} OR n.cpf_tomador = $${pIdx++})`);
      params.push(cleanCnpj);
    }

    if (options.status) {
      conditions.push(`n.status = $${pIdx++}`);
      params.push(options.status.toUpperCase());
    }

    params.push(limit);
    const limitIdx = pIdx++;
    params.push(offset);
    const offsetIdx = pIdx++;

    const sql = `
      SELECT
        n.id,
        n.chave_acesso,
        n.nsu,
        n.cnpj_prestador,
        n.cnpj_tomador,
        n.cpf_tomador,
        n.razao_social_prestador,
        n.razao_social_tomador,
        n.numero_nfse,
        n.serie,
        n.data_emissao,
        n.competencia,
        n.valor_servicos::float AS valor_servicos,
        n.valor_liquido::float AS valor_liquido,
        n.descricao_servico,
        n.codigo_municipio,
        n.status,
        n.created_at,
        n.updated_at,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', e.id,
                'chave_acesso', e.chave_acesso,
                'nsu', e.nsu,
                'tipo_evento', e.tipo_evento,
                'descricao_evento', e.descricao_evento,
                'motivo', e.motivo,
                'data_hora_evento', e.data_hora_evento,
                'documento_xml_id', e.documento_xml_id,
                'created_at', e.created_at
              ) ORDER BY e.data_hora_evento ASC, e.id ASC
            )
            FROM eventos_nfse e
            WHERE e.chave_acesso = n.chave_acesso
          ), '[]'::json
        ) AS eventos,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', d.id,
                'tipo_documento', d.tipo_documento,
                'tipo_evento', d.tipo_evento,
                'data_hora_geracao', d.data_hora_geracao
              ) ORDER BY d.id ASC
            )
            FROM documentos_xml d
            WHERE d.chave_acesso = n.chave_acesso
          ), '[]'::json
        ) AS documentos
      FROM notas_fiscais n
      WHERE ${conditions.join(" AND ")}
      ORDER BY n.data_emissao DESC, n.nsu DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const res = await this.pool.query<NotaFiscalComEventos>(sql, params);
    return res.rows;
  }

  async findByChave(chaveAcesso: string): Promise<NotaFiscalComEventos | null> {
    const cleanChave = chaveAcesso.replace(/\D/g, "");

    const sql = `
      SELECT
        n.id,
        n.chave_acesso,
        n.nsu,
        n.cnpj_prestador,
        n.cnpj_tomador,
        n.cpf_tomador,
        n.razao_social_prestador,
        n.razao_social_tomador,
        n.numero_nfse,
        n.serie,
        n.data_emissao,
        n.competencia,
        n.valor_servicos::float AS valor_servicos,
        n.valor_liquido::float AS valor_liquido,
        n.descricao_servico,
        n.codigo_municipio,
        n.status,
        n.created_at,
        n.updated_at,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', e.id,
                'chave_acesso', e.chave_acesso,
                'nsu', e.nsu,
                'tipo_evento', e.tipo_evento,
                'descricao_evento', e.descricao_evento,
                'motivo', e.motivo,
                'data_hora_evento', e.data_hora_evento,
                'documento_xml_id', e.documento_xml_id,
                'created_at', e.created_at
              ) ORDER BY e.data_hora_evento ASC, e.id ASC
            )
            FROM eventos_nfse e
            WHERE e.chave_acesso = n.chave_acesso
          ), '[]'::json
        ) AS eventos,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'id', d.id,
                'tipo_documento', d.tipo_documento,
                'tipo_evento', d.tipo_evento,
                'data_hora_geracao', d.data_hora_geracao
              ) ORDER BY d.id ASC
            )
            FROM documentos_xml d
            WHERE d.chave_acesso = n.chave_acesso
          ), '[]'::json
        ) AS documentos
      FROM notas_fiscais n
      WHERE n.chave_acesso = $1
      LIMIT 1;
    `;

    const res = await this.pool.query<NotaFiscalComEventos>(sql, [cleanChave]);
    return res.rows.length > 0 ? res.rows[0] : null;
  }

  async getXmlByChave(chaveAcesso: string, tipoDocumento = "NFSE"): Promise<string | null> {
    const cleanChave = chaveAcesso.replace(/\D/g, "");
    const res = await this.pool.query<{ xml_conteudo: string }>(
      `SELECT xml_conteudo FROM documentos_xml 
       WHERE chave_acesso = $1 AND tipo_documento = $2 
       ORDER BY id DESC LIMIT 1`,
      [cleanChave, tipoDocumento]
    );
    return res.rows.length > 0 ? res.rows[0].xml_conteudo : null;
  }

  async getXmlById(id: number): Promise<DocumentoXml | null> {
    const res = await this.pool.query<DocumentoXml>(
      "SELECT * FROM documentos_xml WHERE id = $1",
      [id]
    );
    return res.rows.length > 0 ? res.rows[0] : null;
  }

  async getXmlsForChave(chaveAcesso: string): Promise<DocumentoXml[]> {
    const cleanChave = chaveAcesso.replace(/\D/g, "");
    const res = await this.pool.query<DocumentoXml>(
      "SELECT * FROM documentos_xml WHERE chave_acesso = $1 ORDER BY id ASC",
      [cleanChave]
    );
    return res.rows;
  }

  async getXmlsForCnpj(cnpj: string): Promise<Array<{ chave_acesso: string; tipo_documento: string; tipo_evento?: string | null; xml_conteudo: string }>> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    const sql = `
      SELECT d.chave_acesso, d.tipo_documento, d.tipo_evento, d.xml_conteudo
      FROM documentos_xml d
      INNER JOIN notas_fiscais n ON n.chave_acesso = d.chave_acesso
      WHERE n.cnpj_prestador = $1 OR n.cnpj_tomador = $1 OR n.cpf_tomador = $1
      ORDER BY d.id ASC
    `;
    const res = await this.pool.query(sql, [cleanCnpj]);
    return res.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
