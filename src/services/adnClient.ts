import axios, { type AxiosInstance } from "axios";
import https from "https";
import fs from "fs";
import zlib from "zlib";
import { config } from "../config/env";
import type { LoteDistribuicaoNSUResponse, ConsultaNSUParams, DistribuicaoNSU } from "../types/adn";

export class AdnClient {
  private axiosInstance: AxiosInstance | null = null;

  constructor() {
    this.initHttpClient();
  }

  private initHttpClient(): void {
    let pfxBuffer: Buffer | null = null;

    if (config.certBase64) {
      try {
        pfxBuffer = Buffer.from(config.certBase64, "base64");
      } catch (err) {
        console.error("Erro ao carregar CERT_BASE64:", err);
      }
    } else if (config.certPath && fs.existsSync(config.certPath)) {
      try {
        pfxBuffer = fs.readFileSync(config.certPath);
      } catch (err) {
        console.error(`Erro ao ler certificado em ${config.certPath}:`, err);
      }
    }

    if (pfxBuffer) {
      const httpsAgent = new https.Agent({
        pfx: pfxBuffer,
        passphrase: config.certPassword || "",
        rejectUnauthorized: true, // Garante validação segura das ACs ICP-Brasil
        minVersion: "TLSv1.2"
      });

      this.axiosInstance = axios.create({
        baseURL: config.adnBaseUrl,
        httpsAgent,
        timeout: 30000,
        headers: {
          Accept: "application/json",
          "User-Agent": "API-NFSe-ADN-Client/1.0"
        }
      });
      console.log(`[AdnClient] mTLS configurado com sucesso para ambiente: ${config.adnEnv} (${config.adnBaseUrl})`);
    } else {
      if (!config.enableMock) {
        console.warn(`[AdnClient] ATENÇÃO: Nenhum certificado A1 encontrado em "${config.certPath}". Chamadas reais ao ADN falharão sem mTLS.`);
      } else {
        console.log(`[AdnClient] Modo Mock ativo para simulação de dados do ADN.`);
      }
    }
  }

  /**
   * Consulta o endpoint de distribuição de NSU do ADN
   * GET /DFe/{NSU}?cnpjConsulta={cnpjConsulta}&lote={lote}
   */
  async consultarNSU(params: ConsultaNSUParams): Promise<LoteDistribuicaoNSUResponse> {
    const { nsu, cnpjConsulta, lote = true } = params;

    // Se mock estiver ativo ou não houver instância mTLS configurada
    if (config.enableMock || !this.axiosInstance) {
      return this.gerarRespostaMock(nsu, cnpjConsulta, lote);
    }

    try {
      const endpoint = config.adnBaseUrl.includes("/contribuintes")
        ? `/DFe/${nsu}`
        : `/contribuintes/DFe/${nsu}`;

      console.log(`[AdnClient] Requisitando ADN: ${config.adnBaseUrl}${endpoint}?cnpjConsulta=${cnpjConsulta}&lote=${lote}`);

      const response = await this.axiosInstance.get<LoteDistribuicaoNSUResponse>(endpoint, {
        params: {
          cnpjConsulta,
          lote
        }
      });

      console.log(`[AdnClient] Resposta ADN: StatusProcessamento = "${response.data?.StatusProcessamento}", Documentos = ${response.data?.LoteDFe?.length ?? 0}`);
      if (response.data?.Alertas?.length) {
        console.warn(`[AdnClient] Alertas do ADN:`, response.data.Alertas);
      }
      if (response.data?.Erros?.length) {
        console.error(`[AdnClient] Erros do ADN:`, response.data.Erros);
      }

      return response.data;
    } catch (error: any) {
      if (error.response) {
        console.error(`[AdnClient] Erro HTTP ${error.response.status} do ADN:`, error.response.data);
        const errMsg = typeof error.response.data === "string" 
          ? error.response.data 
          : JSON.stringify(error.response.data);
        throw new Error(`Erro HTTP ${error.response.status} retornado pelo ADN: ${errMsg}`);
      }
      throw new Error(`Falha na comunicação com o ADN (${config.adnBaseUrl}): ${error.message}`);
    }
  }

  /**
   * Gera uma resposta mock realista compatível com a especificação do ADN e padrão SPED NFS-e
   */
  private gerarRespostaMock(nsu: number, cnpjConsulta: string, lote: boolean): LoteDistribuicaoNSUResponse {
    // Se NSU >= 10, simula que não há mais documentos novos
    if (nsu >= 10) {
      return {
        StatusProcessamento: "NENHUM_DOCUMENTO_LOCALIZADO",
        LoteDFe: [],
        TipoAmbiente: "HOMOLOGACAO",
        VersaoAplicativo: "ADN_MOCK_1.0",
        DataHoraProcessamento: new Date().toISOString()
      };
    }

    const docs: DistribuicaoNSU[] = [];
    const proximoNsu1 = nsu + 1;
    const chave1 = `432609${cnpjConsulta.padEnd(14, "0")}550010000000011234567890`;

    // XML simulado de NFS-e Nacional
    const xmlNfse = `<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse">
  <infNFSe Id="NFS${chave1}">
    <nNFSe>${proximoNsu1 * 100}</nNFSe>
    <sNFSe>1</sNFSe>
    <dhProc>${new Date().toISOString()}</dhProc>
    <dCompet>${new Date().toISOString().substring(0, 10)}</dCompet>
    <emit>
      <CNPJ>${cnpjConsulta}</CNPJ>
      <xNome>EMPRESA PRESTADORA LTDA</xNome>
    </emit>
    <toma>
      <CNPJ>98765432000188</CNPJ>
      <xNome>TOMADOR DOS SERVICOS S.A.</xNome>
    </toma>
    <valores>
      <vServ>1500.00</vServ>
      <vLiq>1450.00</vLiq>
    </valores>
    <serv>
      <xDescServ>Consultoria e desenvolvimento de software especializado em integração NFS-e</xDescServ>
      <cMunEmi>4314902</cMunEmi>
    </serv>
  </infNFSe>
</NFSe>`;

    const gzipBase64Nfse = zlib.gzipSync(Buffer.from(xmlNfse, "utf-8")).toString("base64");

    docs.push({
      NSU: proximoNsu1,
      ChaveAcesso: chave1,
      TipoDocumento: "NFSE",
      TipoEvento: null,
      ArquivoXml: gzipBase64Nfse,
      DataHoraGeracao: new Date().toISOString()
    });

    // Se lote === true, gera um segundo documento simulando um evento de cancelamento ou confirmação
    if (lote && nsu === 0) {
      const proximoNsu2 = nsu + 2;
      const xmlEvento = `<?xml version="1.0" encoding="UTF-8"?>
<evento xmlns="http://www.sped.fazenda.gov.br/nfse">
  <infEvento>
    <chNFSe>${chave1}</chNFSe>
    <tpEvento>CONFIRMACAO_TOMADOR</tpEvento>
    <descEvento>Confirmação da Prestação do Serviço pelo Tomador</descEvento>
    <xMotivo>Serviço conferido e atestado</xMotivo>
    <dhEvento>${new Date().toISOString()}</dhEvento>
  </infEvento>
</evento>`;

      const gzipBase64Evento = zlib.gzipSync(Buffer.from(xmlEvento, "utf-8")).toString("base64");

      docs.push({
        NSU: proximoNsu2,
        ChaveAcesso: chave1,
        TipoDocumento: "EVENTO",
        TipoEvento: "CONFIRMACAO_TOMADOR",
        ArquivoXml: gzipBase64Evento,
        DataHoraGeracao: new Date().toISOString()
      });
    }

    return {
      StatusProcessamento: "DOCUMENTOS_LOCALIZADOS",
      LoteDFe: docs,
      TipoAmbiente: "HOMOLOGACAO",
      VersaoAplicativo: "ADN_MOCK_1.0",
      DataHoraProcessamento: new Date().toISOString()
    };
  }
}

export const adnClient = new AdnClient();
