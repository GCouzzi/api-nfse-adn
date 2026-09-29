export type StatusProcessamentoDistribuicao =
  | "DOCUMENTOS_LOCALIZADOS"
  | "NENHUM_DOCUMENTO_LOCALIZADO"
  | "REJEICAO";

export type TipoDocumentoRequisicao =
  | "NENHUM"
  | "DPS"
  | "PEDIDO_REGISTRO_EVENTO"
  | "NFSE"
  | "EVENTO"
  | "CNC";

export type TipoEvento =
  | "CANCELAMENTO"
  | "SOLICITACAO_CANCELAMENTO_ANALISE_FISCAL"
  | "CANCELAMENTO_POR_SUBSTITUICAO"
  | "CANCELAMENTO_DEFERIDO_ANALISE_FISCAL"
  | "CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL"
  | "CONFIRMACAO_PRESTADOR"
  | "REJEICAO_PRESTADOR"
  | "CONFIRMACAO_TOMADOR"
  | "REJEICAO_TOMADOR"
  | "CONFIRMACAO_INTERMEDIARIO"
  | "REJEICAO_INTERMEDIARIO"
  | "CONFIRMACAO_TACITA"
  | "ANULACAO_REJEICAO"
  | "CANCELAMENTO_POR_OFICIO"
  | "BLOQUEIO_POR_OFICIO"
  | "DESBLOQUEIO_POR_OFICIO"
  | "INCLUSAO_NFSE_DAN"
  | "TRIBUTOS_NFSE_RECOLHIDOS";

export interface DistribuicaoNSU {
  NSU: number;
  ChaveAcesso?: string | null;
  TipoDocumento: TipoDocumentoRequisicao;
  TipoEvento?: TipoEvento | null;
  ArquivoXml?: string | null; // GZip compactado e codificado em Base64
  DataHoraGeracao?: string | null;
}

export interface MensagemProcessamento {
  Mensagem?: any;
  Parametros?: string[] | null;
  Codigo?: string | null;
  Descricao?: string | null;
  Complemento?: string | null;
}

export interface LoteDistribuicaoNSUResponse {
  StatusProcessamento: StatusProcessamentoDistribuicao;
  LoteDFe?: DistribuicaoNSU[] | null;
  Alertas?: MensagemProcessamento[] | null;
  Erros?: MensagemProcessamento[] | null;
  TipoAmbiente?: "PRODUCAO" | "HOMOLOGACAO";
  VersaoAplicativo?: string | null;
  DataHoraProcessamento?: string;
}

export interface ConsultaNSUParams {
  nsu: number;
  cnpjConsulta: string;
  lote?: boolean;
}
