import type { Database } from "bun:sqlite";

export function initSchema(db: Database): void {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA foreign_keys = ON;");

  // Tabela de controle de sincronização por CNPJ
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_controle (
      cnpj TEXT PRIMARY KEY,
      ultimo_nsu INTEGER NOT NULL DEFAULT 0,
      max_nsu INTEGER NOT NULL DEFAULT 0,
      ultima_sincronizacao TEXT,
      status TEXT NOT NULL DEFAULT 'IDLE',
      mensagem_erro TEXT
    );
  `);

  // Tabela com as informações consolidadas das Notas Fiscais de Serviço
  db.run(`
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

  // Tabela para guardar os XMLs originais descompactados
  db.run(`
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

  // Tabela para os eventos atrelados às notas (ex: Cancelamentos, Confirmações, etc.)
  db.run(`
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

  // Índices para otimização de busca rápida por CNPJ, Chave de Acesso e NSU
  db.run(`CREATE INDEX IF NOT EXISTS idx_notas_cnpj_prestador ON notas_fiscais(cnpj_prestador);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notas_cnpj_tomador ON notas_fiscais(cnpj_tomador);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notas_chave ON notas_fiscais(chave_acesso);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_notas_nsu ON notas_fiscais(nsu);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_docs_chave ON documentos_xml(chave_acesso);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_docs_nsu ON documentos_xml(nsu);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_eventos_chave ON eventos_nfse(chave_acesso);`);
}
