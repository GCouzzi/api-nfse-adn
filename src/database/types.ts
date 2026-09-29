import type {
  NotaFiscal,
  EventoNfse,
  DocumentoXml,
  NotaFiscalComEventos,
  SyncControle,
  SyncJob
} from "../types/models";

export interface FindAllByCnpjOptions {
  status?: string;
  papel?: "prestador" | "tomador" | "todos";
  limit?: number;
  offset?: number;
}

export interface IDatabaseRepository {
  init(): Promise<void>;
  
  // Controle de Sincronização
  getSyncControle(cnpj: string): Promise<SyncControle>;
  setSyncStatus(cnpj: string, status: "IDLE" | "SYNCING" | "ERROR" | "SUCCESS", errorMsg?: string | null): Promise<void>;
  updateSyncProgress(cnpj: string, ultimoNsu: number, maxNsu: number): Promise<void>;

  // Fila de Sincronização Assíncrona (SyncJob)
  createSyncJob(cnpj: string, nsuInicial?: number): Promise<SyncJob>;
  getSyncJob(id: number): Promise<SyncJob | null>;
  listSyncJobs(cnpj?: string, limit?: number): Promise<SyncJob[]>;
  updateSyncJob(id: number, updates: Partial<SyncJob>): Promise<void>;
  getActiveSyncJobByCnpj(cnpj: string): Promise<SyncJob | null>;
  
  // Documentos e Notas
  saveDocumentoXml(doc: Omit<DocumentoXml, "id">): Promise<number>;
  saveNotaFiscal(nota: Omit<NotaFiscal, "id">): Promise<void>;
  saveEvento(evento: Omit<EventoNfse, "id">): Promise<void>;
  updateNotaStatus(chaveAcesso: string, status: string): Promise<void>;
  
  // Consultas
  findAllByCnpj(cnpj: string, options?: FindAllByCnpjOptions): Promise<NotaFiscalComEventos[]>;
  findByChave(chaveAcesso: string): Promise<NotaFiscalComEventos | null>;
  getXmlByChave(chaveAcesso: string, tipoDocumento?: string): Promise<string | null>;
  getXmlById(id: number): Promise<DocumentoXml | null>;
  getXmlsForChave(chaveAcesso: string): Promise<DocumentoXml[]>;
  getXmlsForCnpj(cnpj: string): Promise<Array<{ chave_acesso: string; tipo_documento: string; tipo_evento?: string | null; xml_conteudo: string }>>;
  
  close(): Promise<void>;
}
