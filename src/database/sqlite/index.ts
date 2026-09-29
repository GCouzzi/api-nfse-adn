import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
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

export class SqliteRepository implements IDatabaseRepository {
  private db!: Database;

  async init(): Promise<void> {
    const dir = path.dirname(config.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(config.dbPath, { create: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA foreign_keys = ON;");

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_controle (
        cnpj TEXT PRIMARY KEY,
        ultimo_nsu INTEGER NOT NULL DEFAULT 0,
        max_nsu INTEGER NOT NULL DEFAULT 0,
        ultima_sincronizacao TEXT,
        status TEXT NOT NULL DEFAULT 'IDLE',
        mensagem_erro TEXT
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cnpj TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'QUEUED',
        nsu_inicial INTEGER,
        nsu_final INTEGER,
        novos_documentos INTEGER DEFAULT 0,
        total_notas INTEGER DEFAULT 0,
        total_eventos INTEGER DEFAULT 0,
        ciclos_executados INTEGER DEFAULT 0,
        erro TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS notas_fiscais (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chave_acesso TEXT UNIQUE NOT NULL,
        nsu INTEGER NOT NULL,
        cnpj_prestador TEXT NOT NULL,
        cnpj_tomador TEXT,
        cpf_tomador TEXT,
        razao_social_prestador TEXT,
        razao_social_tomador TEXT,
        numero_nfse TEXT,
        serie TEXT,
        data_emissao TEXT,
        competencia TEXT,
        valor_servicos REAL DEFAULT 0.0,
        valor_liquido REAL DEFAULT 0.0,
        descricao_servico TEXT,
        codigo_municipio TEXT,
        status TEXT NOT NULL DEFAULT 'AUTORIZADA',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS documentos_xml (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chave_acesso TEXT NOT NULL,
        nsu INTEGER NOT NULL,
        tipo_documento TEXT NOT NULL,
        tipo_evento TEXT,
        xml_conteudo TEXT NOT NULL,
        data_hora_geracao TEXT,
        created_at TEXT NOT NULL
      );
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS eventos_nfse (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chave_acesso TEXT NOT NULL,
        nsu INTEGER NOT NULL,
        tipo_evento TEXT NOT NULL,
        descricao_evento TEXT,
        motivo TEXT,
        data_hora_evento TEXT,
        documento_xml_id INTEGER REFERENCES documentos_xml(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_notas_cnpj_prestador ON notas_fiscais(cnpj_prestador);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_notas_cnpj_tomador ON notas_fiscais(cnpj_tomador);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_notas_chave ON notas_fiscais(chave_acesso);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_notas_nsu ON notas_fiscais(nsu);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_docs_chave ON documentos_xml(chave_acesso);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_docs_nsu ON documentos_xml(nsu);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_eventos_chave ON eventos_nfse(chave_acesso);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_cnpj ON sync_jobs(cnpj);`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON sync_jobs(status);`);

    console.log("[SqliteRepository] Banco SQLite nativo inicializado com sucesso.");
  }

  async getSyncControle(cnpj: string): Promise<SyncControle> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    const row = this.db.query<SyncControle, [string]>("SELECT * FROM sync_controle WHERE cnpj = ?").get(cleanCnpj);

    if (row) return row;

    const novo: SyncControle = {
      cnpj: cleanCnpj,
      ultimo_nsu: 0,
      max_nsu: 0,
      ultima_sincronizacao: null,
      status: "IDLE",
      mensagem_erro: null
    };

    this.db.run(
      "INSERT INTO sync_controle (cnpj, ultimo_nsu, max_nsu, ultima_sincronizacao, status, mensagem_erro) VALUES (?, ?, ?, ?, ?, ?)",
      [cleanCnpj, 0, 0, null, "IDLE", null]
    );

    return novo;
  }

  async setSyncStatus(cnpj: string, status: "IDLE" | "SYNCING" | "ERROR" | "SUCCESS", errorMsg?: string | null): Promise<void> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    this.db.run("UPDATE sync_controle SET status = ?, mensagem_erro = ? WHERE cnpj = ?", [
      status,
      errorMsg || null,
      cleanCnpj
    ]);
  }

  async updateSyncProgress(cnpj: string, ultimoNsu: number, maxNsu: number): Promise<void> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    this.db.run(
      "UPDATE sync_controle SET ultimo_nsu = ?, max_nsu = MAX(max_nsu, ?), ultima_sincronizacao = ?, status = 'SUCCESS', mensagem_erro = NULL WHERE cnpj = ?",
      [ultimoNsu, maxNsu, new Date().toISOString(), cleanCnpj]
    );
  }

  async createSyncJob(cnpj: string, nsuInicial?: number): Promise<SyncJob> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    const now = new Date().toISOString();
    const res = this.db.run(
      "INSERT INTO sync_jobs (cnpj, status, nsu_inicial, created_at) VALUES (?, 'QUEUED', ?, ?)",
      [cleanCnpj, nsuInicial ?? null, now]
    );
    const id = Number(res.lastInsertRowid);
    return {
      id,
      cnpj: cleanCnpj,
      status: "QUEUED",
      nsu_inicial: nsuInicial ?? null,
      nsu_final: null,
      novos_documentos: 0,
      total_notas: 0,
      total_eventos: 0,
      ciclos_executados: 0,
      erro: null,
      created_at: now,
      started_at: null,
      finished_at: null
    };
  }

  async getSyncJob(id: number): Promise<SyncJob | null> {
    return this.db.query<SyncJob, [number]>("SELECT * FROM sync_jobs WHERE id = ?").get(id);
  }

  async listSyncJobs(cnpj?: string, limit = 20): Promise<SyncJob[]> {
    if (cnpj) {
      const cleanCnpj = cnpj.replace(/\D/g, "");
      return this.db.query<SyncJob, [string, number]>(
        "SELECT * FROM sync_jobs WHERE cnpj = ? ORDER BY id DESC LIMIT ?"
      ).all(cleanCnpj, limit);
    }
    return this.db.query<SyncJob, [number]>("SELECT * FROM sync_jobs ORDER BY id DESC LIMIT ?").all(limit);
  }

  async updateSyncJob(id: number, updates: Partial<SyncJob>): Promise<void> {
    const fields: string[] = [];
    const values: any[] = [];
    for (const [key, value] of Object.entries(updates)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.run(`UPDATE sync_jobs SET ${fields.join(", ")} WHERE id = ?`, values);
  }

  async getActiveSyncJobByCnpj(cnpj: string): Promise<SyncJob | null> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    return this.db.query<SyncJob, [string]>(
      "SELECT * FROM sync_jobs WHERE cnpj = ? AND status IN ('QUEUED', 'PROCESSING') ORDER BY id DESC LIMIT 1"
    ).get(cleanCnpj);
  }

  async saveDocumentoXml(doc: Omit<DocumentoXml, "id">): Promise<number> {
    const now = new Date().toISOString();
    const res = this.db.run(
      `INSERT INTO documentos_xml (
        chave_acesso, nsu, tipo_documento, tipo_evento, xml_conteudo, data_hora_geracao, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        doc.chave_acesso,
        doc.nsu,
        doc.tipo_documento,
        doc.tipo_evento || null,
        doc.xml_conteudo,
        doc.data_hora_geracao || now,
        now
      ]
    );
    return Number(res.lastInsertRowid);
  }

  async saveNotaFiscal(nota: Omit<NotaFiscal, "id">): Promise<void> {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO notas_fiscais (
        chave_acesso, nsu, cnpj_prestador, cnpj_tomador, cpf_tomador,
        razao_social_prestador, razao_social_tomador, numero_nfse, serie,
        data_emissao, competencia, valor_servicos, valor_liquido,
        descricao_servico, codigo_municipio, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chave_acesso) DO UPDATE SET
        nsu = excluded.nsu,
        valor_servicos = CASE WHEN excluded.valor_servicos > 0 THEN excluded.valor_servicos ELSE notas_fiscais.valor_servicos END,
        valor_liquido = CASE WHEN excluded.valor_liquido > 0 THEN excluded.valor_liquido ELSE notas_fiscais.valor_liquido END,
        updated_at = excluded.updated_at`,
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
        nota.status || "AUTORIZADA",
        now,
        now
      ]
    );
  }

  async saveEvento(evento: Omit<EventoNfse, "id">): Promise<void> {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO eventos_nfse (
        chave_acesso, nsu, tipo_evento, descricao_evento, motivo, data_hora_evento, documento_xml_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        evento.chave_acesso,
        evento.nsu,
        evento.tipo_evento,
        evento.descricao_evento || null,
        evento.motivo || null,
        evento.data_hora_evento || null,
        evento.documento_xml_id || null,
        now
      ]
    );
  }

  async updateNotaStatus(chaveAcesso: string, status: string): Promise<void> {
    this.db.run(
      "UPDATE notas_fiscais SET status = ?, updated_at = ? WHERE chave_acesso = ?",
      [status, new Date().toISOString(), chaveAcesso]
    );
  }

  async findAllByCnpj(cnpj: string, options: FindAllByCnpjOptions = {}): Promise<NotaFiscalComEventos[]> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    const papel = options.papel || "todos";
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    let query = "SELECT * FROM notas_fiscais WHERE 1=1";
    const params: any[] = [];

    if (papel === "prestador") {
      query += " AND cnpj_prestador = ?";
      params.push(cleanCnpj);
    } else if (papel === "tomador") {
      query += " AND (cnpj_tomador = ? OR cpf_tomador = ?)";
      params.push(cleanCnpj, cleanCnpj);
    } else {
      query += " AND (cnpj_prestador = ? OR cnpj_tomador = ? OR cpf_tomador = ?)";
      params.push(cleanCnpj, cleanCnpj, cleanCnpj);
    }

    if (options.status) {
      query += " AND status = ?";
      params.push(options.status.toUpperCase());
    }

    query += " ORDER BY data_emissao DESC, nsu DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const notas = this.db.query<NotaFiscal, any[]>(query).all(...params);

    const eventosStmt = this.db.prepare<EventoNfse, [string]>(
      "SELECT * FROM eventos_nfse WHERE chave_acesso = ? ORDER BY data_hora_evento ASC, id ASC"
    );

    const docsStmt = this.db.prepare<Pick<DocumentoXml, "id" | "tipo_documento" | "tipo_evento" | "data_hora_geracao">, [string]>(
      "SELECT id, tipo_documento, tipo_evento, data_hora_geracao FROM documentos_xml WHERE chave_acesso = ? ORDER BY id ASC"
    );

    return notas.map((nota) => ({
      ...nota,
      eventos: eventosStmt.all(nota.chave_acesso),
      documentos: docsStmt.all(nota.chave_acesso)
    }));
  }

  async findByChave(chaveAcesso: string): Promise<NotaFiscalComEventos | null> {
    const cleanChave = chaveAcesso.replace(/\D/g, "");
    const nota = this.db.query<NotaFiscal, [string]>("SELECT * FROM notas_fiscais WHERE chave_acesso = ?").get(cleanChave);

    if (!nota) return null;

    const eventos = this.db.query<EventoNfse, [string]>(
      "SELECT * FROM eventos_nfse WHERE chave_acesso = ? ORDER BY data_hora_evento ASC, id ASC"
    ).all(cleanChave);

    const documentos = this.db.query<Pick<DocumentoXml, "id" | "tipo_documento" | "tipo_evento" | "data_hora_geracao">, [string]>(
      "SELECT id, tipo_documento, tipo_evento, data_hora_geracao FROM documentos_xml WHERE chave_acesso = ? ORDER BY id ASC"
    ).all(cleanChave);

    return {
      ...nota,
      eventos,
      documentos
    };
  }

  async getXmlByChave(chaveAcesso: string, tipoDocumento = "NFSE"): Promise<string | null> {
    const cleanChave = chaveAcesso.replace(/\D/g, "");
    const doc = this.db.query<DocumentoXml, [string, string]>(
      "SELECT * FROM documentos_xml WHERE chave_acesso = ? AND tipo_documento = ? ORDER BY id DESC LIMIT 1"
    ).get(cleanChave, tipoDocumento);

    return doc ? doc.xml_conteudo : null;
  }

  async getXmlById(id: number): Promise<DocumentoXml | null> {
    return this.db.query<DocumentoXml, [number]>("SELECT * FROM documentos_xml WHERE id = ?").get(id);
  }

  async getXmlsForChave(chaveAcesso: string): Promise<DocumentoXml[]> {
    const cleanChave = chaveAcesso.replace(/\D/g, "");
    return this.db.query<DocumentoXml, [string]>(
      "SELECT * FROM documentos_xml WHERE chave_acesso = ? ORDER BY id ASC"
    ).all(cleanChave);
  }

  async getXmlsForCnpj(cnpj: string): Promise<Array<{ chave_acesso: string; tipo_documento: string; tipo_evento?: string | null; xml_conteudo: string }>> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    const sql = `
      SELECT d.chave_acesso, d.tipo_documento, d.tipo_evento, d.xml_conteudo
      FROM documentos_xml d
      INNER JOIN notas_fiscais n ON n.chave_acesso = d.chave_acesso
      WHERE n.cnpj_prestador = ? OR n.cnpj_tomador = ? OR n.cpf_tomador = ?
      ORDER BY d.id ASC
    `;
    return this.db.query<any, [string, string, string]>(sql).all(cleanCnpj, cleanCnpj, cleanCnpj);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
