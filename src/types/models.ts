export interface SyncControle {
  cnpj: string;
  ultimo_nsu: number;
  max_nsu: number;
  ultima_sincronizacao: string | null;
  status: "IDLE" | "SYNCING" | "ERROR" | "SUCCESS";
  mensagem_erro?: string | null;
}

export type SyncJobStatus = "QUEUED" | "PROCESSING" | "COMPLETED" | "FAILED";

export interface SyncJob {
  id: number;
  cnpj: string;
  status: SyncJobStatus;
  nsu_inicial?: number | null;
  nsu_final?: number | null;
  novos_documentos: number;
  total_notas: number;
  total_eventos: number;
  ciclos_executados: number;
  erro?: string | null;
  created_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface NotaFiscal {
  id: number;
  chave_acesso: string;
  nsu: number;
  cnpj_prestador: string;
  cnpj_tomador?: string | null;
  cpf_tomador?: string | null;
  razao_social_prestador?: string | null;
  razao_social_tomador?: string | null;
  numero_nfse?: string | null;
  serie?: string | null;
  data_emissao?: string | null;
  competencia?: string | null;
  valor_servicos: number;
  valor_liquido: number;
  descricao_servico?: string | null;
  codigo_municipio?: string | null;
  status: "AUTORIZADA" | "CANCELADA" | "SUBSTITUIDA" | "DENEGADA";
  created_at: string;
  updated_at: string;
}

export interface DocumentoXml {
  id: number;
  chave_acesso: string;
  nsu: number;
  tipo_documento: string; // 'NFSE' | 'EVENTO' | 'DPS' | etc.
  tipo_evento?: string | null;
  xml_conteudo: string; // XML UTF-8 descompactado
  data_hora_geracao?: string | null;
  created_at: string;
}

export interface EventoNfse {
  id: number;
  chave_acesso: string;
  nsu: number;
  tipo_evento: string;
  descricao_evento?: string | null;
  motivo?: string | null;
  data_hora_evento?: string | null;
  documento_xml_id?: number | null;
  created_at: string;
}

export interface NotaFiscalComEventos extends NotaFiscal {
  eventos: EventoNfse[];
  documentos: Array<{
    id: number;
    tipo_documento: string;
    tipo_evento?: string | null;
    data_hora_geracao?: string | null;
  }>;
}
