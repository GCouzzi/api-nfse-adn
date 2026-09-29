import zlib from "zlib";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  trimValues: true,
  removeNSPrefix: true
});

export interface ParsedNfseData {
  chave_acesso?: string;
  numero_nfse?: string;
  serie?: string;
  data_emissao?: string;
  competencia?: string;
  cnpj_prestador?: string;
  razao_social_prestador?: string;
  cnpj_tomador?: string;
  cpf_tomador?: string;
  razao_social_tomador?: string;
  valor_servicos: number;
  valor_liquido: number;
  descricao_servico?: string;
  codigo_municipio?: string;
}

export interface ParsedEventoData {
  chave_acesso?: string;
  tipo_evento?: string;
  descricao_evento?: string;
  motivo?: string;
  data_hora_evento?: string;
}

/**
 * Descompacta e decodifica o XML retornado pelo ADN.
 * Conforme Swagger do ADN: GZip com representação base64binary.
 */
export function decompressAndDecodeXml(arquivoXmlBase64: string): string {
  if (!arquivoXmlBase64) return "";

  const buffer = Buffer.from(arquivoXmlBase64.trim(), "base64");

  // Tenta descompactar via Gzip
  try {
    const decompressed = zlib.gunzipSync(buffer);
    return decompressed.toString("utf-8");
  } catch {
    // Se não for gzip (ou já for texto puro), decodifica diretamente
    try {
      return buffer.toString("utf-8");
    } catch {
      return arquivoXmlBase64;
    }
  }
}

/**
 * Busca recursivamente por um campo ou objeto dentro de um JSON parseado do XML
 */
function findNode(obj: any, keyName: string): any {
  if (!obj || typeof obj !== "object") return null;
  if (keyName in obj) return obj[keyName];

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === "object") {
      const found = findNode(val, keyName);
      if (found !== null) return found;
    }
  }
  return null;
}

/**
 * Extrai dados estruturados de um XML de NFS-e Nacional
 */
export function parseNfseXml(xmlString: string, chaveFallback?: string): ParsedNfseData {
  const result: ParsedNfseData = {
    chave_acesso: chaveFallback,
    valor_servicos: 0,
    valor_liquido: 0
  };

  try {
    const parsed = parser.parse(xmlString);

    const infNFSe = findNode(parsed, "infNFSe") || findNode(parsed, "infDPS") || parsed;

    // Chave de Acesso
    if (infNFSe?.["@_Id"]) {
      result.chave_acesso = String(infNFSe["@_Id"]).replace(/^NFS/i, "").trim();
    } else if (infNFSe?.chNFSe) {
      result.chave_acesso = String(infNFSe.chNFSe).trim();
    }

    // Número da NFS-e
    result.numero_nfse = infNFSe?.nNFSe || infNFSe?.nDPS || findNode(parsed, "nNFSe") || findNode(parsed, "nDPS");
    if (result.numero_nfse) result.numero_nfse = String(result.numero_nfse);

    // Série
    result.serie = infNFSe?.sNFSe || infNFSe?.serie || findNode(parsed, "sNFSe") || findNode(parsed, "serie");
    if (result.serie) result.serie = String(result.serie);

    // Datas
    result.data_emissao = infNFSe?.dhProc || infNFSe?.dhEmi || findNode(parsed, "dhProc") || findNode(parsed, "dhEmi");
    result.competencia = infNFSe?.dCompet || findNode(parsed, "dCompet");

    // Prestador / Emitente
    const emit = findNode(parsed, "emit") || findNode(parsed, "prest") || findNode(parsed, "prestador");
    if (emit) {
      result.cnpj_prestador = emit.CNPJ || emit.CPF;
      result.razao_social_prestador = emit.xNome || emit.xFant;
    }

    // Tomador
    const toma = findNode(parsed, "toma") || findNode(parsed, "tomador");
    if (toma) {
      result.cnpj_tomador = toma.CNPJ;
      result.cpf_tomador = toma.CPF;
      result.razao_social_tomador = toma.xNome || toma.xRazaoSocial;
    }

    // Valores
    const valores = findNode(parsed, "valores") || findNode(parsed, "valr");
    if (valores) {
      const vServ = valores.vServ || valores.vNFSe || valores.vServPrest || 0;
      const vLiq = valores.vLiq || valores.vLiquido || vServ;
      result.valor_servicos = parseFloat(String(vServ)) || 0;
      result.valor_liquido = parseFloat(String(vLiq)) || result.valor_servicos;
    }

    // Descrição do Serviço
    const serv = findNode(parsed, "serv") || findNode(parsed, "servico");
    if (serv) {
      result.descricao_servico = serv.xDescServ || serv.xServ || (typeof serv === "string" ? serv : undefined);
      result.codigo_municipio = serv.cMunEmi || serv.cMun;
    }
    if (!result.descricao_servico) {
      result.descricao_servico = findNode(parsed, "xDescServ");
    }
  } catch (error) {
    console.error("Erro ao fazer parse do XML da NFS-e:", error);
  }

  return result;
}

/**
 * Extrai dados estruturados de um XML de Evento (ex: Cancelamento)
 */
export function parseEventoXml(xmlString: string, chaveFallback?: string): ParsedEventoData {
  const result: ParsedEventoData = {
    chave_acesso: chaveFallback
  };

  try {
    const parsed = parser.parse(xmlString);
    const infEvento = findNode(parsed, "infEvento") || findNode(parsed, "evento") || parsed;

    result.chave_acesso = infEvento?.chNFSe || infEvento?.chaveAcesso || chaveFallback;
    result.tipo_evento = infEvento?.tpEvento || infEvento?.tipoEvento;
    result.descricao_evento = infEvento?.descEvento || infEvento?.xDesc;
    result.motivo = infEvento?.xMotivo || infEvento?.xJust || infEvento?.xCorrecao;
    result.data_hora_evento = infEvento?.dhEvento || infEvento?.dhRegEvento || infEvento?.dhProc;
  } catch (error) {
    console.error("Erro ao fazer parse do XML de Evento:", error);
  }

  return result;
}
