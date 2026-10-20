import axios, { type AxiosInstance } from "axios";
import https from "https";
import { ApplicationError } from "../application/contracts";
import type {
  AdnGatewayFactory,
  CertificateCredentials,
  CertificateProvider,
  Company,
} from "../application/contracts";
import zlib from "zlib";
import { config } from "../config/env";
import type {
  LoteDistribuicaoNSUResponse,
  ConsultaNSUParams,
  DistribuicaoNSU,
} from "../types/adn";

export class AdnClient {
  private axiosInstance: AxiosInstance | null = null;
  private agent?: https.Agent;

  constructor(
    credentials?: CertificateCredentials,
    private readonly mockMode = config.enableMock,
  ) {
    if (credentials) this.initHttpClient(credentials);
  }

  private initHttpClient(credentials: CertificateCredentials): void {
    this.agent = new https.Agent({
      pfx: credentials.pfx,
      passphrase: credentials.passphrase,
      rejectUnauthorized: true, // Garante validação segura das ACs ICP-Brasil
      minVersion: "TLSv1.2",
    });

    this.axiosInstance = axios.create({
      baseURL: config.adnBaseUrl,
      httpsAgent: this.agent,
      timeout: 30000,
      headers: {
        Accept: "application/json",
        "User-Agent": "API-NFSe-ADN-Client/1.0",
      },
    });
    console.log(
      `[AdnClient] mTLS configurado com sucesso para ambiente: ${config.adnEnv} (${config.adnBaseUrl})`,
    );
  }

  close(): void {
    this.agent?.destroy();
  }

  /**
   * Consulta o endpoint de distribuição de NSU do ADN
   * GET /DFe/{NSU}?cnpjConsulta={cnpjConsulta}&lote={lote}
   */
  async consultarNSU(
    params: ConsultaNSUParams,
  ): Promise<LoteDistribuicaoNSUResponse> {
    const { nsu, cnpjConsulta, lote = true } = params;

    if (this.mockMode) {
      return this.gerarRespostaMock(nsu, cnpjConsulta, lote);
    }
    if (!this.axiosInstance)
      throw new ApplicationError(
        "Certificado não configurado. A sincronização real exige mTLS.",
      );

    try {
      const endpoint = config.adnBaseUrl.includes("/contribuintes")
        ? `/DFe/${nsu}`
        : `/contribuintes/DFe/${nsu}`;

      console.log(
        `[AdnClient] Requisitando ADN: ${config.adnBaseUrl}${endpoint}?cnpjConsulta=${cnpjConsulta}&lote=${lote}`,
      );

      const response =
        await this.axiosInstance.get<LoteDistribuicaoNSUResponse>(endpoint, {
          params: {
            cnpjConsulta,
            lote,
          },
        });

      console.log(
        `[AdnClient] Resposta ADN: StatusProcessamento = "${response.data?.StatusProcessamento}", Documentos = ${response.data?.LoteDFe?.length ?? 0}`,
      );
      if (response.data?.Alertas?.length) {
        console.warn(`[AdnClient] Alertas do ADN:`, response.data.Alertas);
      }
      if (response.data?.Erros?.length) {
        console.error(`[AdnClient] Erros do ADN:`, response.data.Erros);
      }

      return response.data;
    } catch (error: any) {
      if (error.response) {
        // O ADN da Receita Federal retorna HTTP 404 com código E2220 quando não há mais documentos a partir do NSU consultado.
        // Isso é o comportamento oficial e esperado de término de lote (Nenhum documento adicional localizado).
        const data = error.response.data;
        if (
          error.response.status === 404 &&
          (data?.StatusProcessamento === "NENHUM_DOCUMENTO_LOCALIZADO" ||
            data?.Erros?.some((e: any) => e.Codigo === "E2220"))
        ) {
          console.log(
            `[AdnClient] Fim do lote alcançado no NSU ${params.nsu}: Nenhum documento adicional localizado no ADN.`,
          );
          return data;
        }

        console.error(
          `[AdnClient] Erro HTTP ${error.response.status} do ADN:`,
          data,
        );
        const errMsg = typeof data === "string" ? data : JSON.stringify(data);
        throw new Error(
          `Erro HTTP ${error.response.status} retornado pelo ADN: ${errMsg}`,
        );
      }
      throw new Error(
        `Falha na comunicação com o ADN (${config.adnBaseUrl}): ${error.message}`,
      );
    }
  }

  /**
   * Gera uma resposta mock realista compatível com a especificação do ADN e padrão SPED NFS-e
   */
  private gerarRespostaMock(
    nsu: number,
    cnpjConsulta: string,
    lote: boolean,
  ): LoteDistribuicaoNSUResponse {
    // Se NSU >= 10, simula que não há mais documentos novos
    if (nsu >= 10) {
      return {
        StatusProcessamento: "NENHUM_DOCUMENTO_LOCALIZADO",
        LoteDFe: [],
        TipoAmbiente: "HOMOLOGACAO",
        VersaoAplicativo: "ADN_MOCK_1.0",
        DataHoraProcessamento: new Date().toISOString(),
      };
    }

    const docs: DistribuicaoNSU[] = [];
    const proximoNsu1 = nsu + 1;
    const chave1 = `${cnpjConsulta}${String(proximoNsu1).padStart(36, "0")}`;

    // XML simulado de NFS-e Nacional
    const xmlNfse = `<?xml version="1.0" encoding="UTF-8"?>
<NFSe xmlns="http://www.sped.fazenda.gov.br/nfse">
  <infNFSe Id="NFS${chave1}">
    <nNFSe>${proximoNsu1 * 100}</nNFSe>
    <sNFSe>1</sNFSe>
    <dhProc>${new Date().toISOString()}</dhProc>
    <cStat>100</cStat>
    <emit>
      <CNPJ>${cnpjConsulta}</CNPJ>
      <xNome>EMPRESA PRESTADORA LTDA</xNome>
    </emit>
    <DPS><infDPS>
    <tpAmb>2</tpAmb>
    <dCompet>${new Date().toISOString().substring(0, 10)}</dCompet>
    <prest><CNPJ>${cnpjConsulta}</CNPJ><xNome>EMPRESA PRESTADORA LTDA</xNome></prest>
    <toma>
      <CNPJ>98765432000188</CNPJ>
      <xNome>TOMADOR DOS SERVICOS S.A.</xNome>
    </toma>
    <valores>
      <vServPrest><vServ>1500.00</vServ></vServPrest>
      <vLiq>1450.00</vLiq>
    </valores>
    <serv>
      <xDescServ>Consultoria e desenvolvimento de software especializado em integração NFS-e</xDescServ>
      <cMunEmi>4314902</cMunEmi>
    </serv>
    </infDPS></DPS>
    <valores><vLiq>1450.00</vLiq></valores>
  </infNFSe>
</NFSe>`;

    const gzipBase64Nfse = zlib
      .gzipSync(Buffer.from(xmlNfse, "utf-8"))
      .toString("base64");

    docs.push({
      NSU: proximoNsu1,
      ChaveAcesso: chave1,
      TipoDocumento: "NFSE",
      TipoEvento: null,
      ArquivoXml: gzipBase64Nfse,
      DataHoraGeracao: new Date().toISOString(),
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

      const gzipBase64Evento = zlib
        .gzipSync(Buffer.from(xmlEvento, "utf-8"))
        .toString("base64");

      docs.push({
        NSU: proximoNsu2,
        ChaveAcesso: chave1,
        TipoDocumento: "EVENTO",
        TipoEvento: "CONFIRMACAO_TOMADOR",
        ArquivoXml: gzipBase64Evento,
        DataHoraGeracao: new Date().toISOString(),
      });
    }

    return {
      StatusProcessamento: "DOCUMENTOS_LOCALIZADOS",
      LoteDFe: docs,
      TipoAmbiente: "HOMOLOGACAO",
      VersaoAplicativo: "ADN_MOCK_1.0",
      DataHoraProcessamento: new Date().toISOString(),
    };
  }
}

export class CompanyAdnGatewayFactory implements AdnGatewayFactory {
  constructor(
    private readonly certificates: CertificateProvider,
    private readonly mockMode: boolean,
  ) {}

  async create(company: Company) {
    return new AdnClient(
      this.mockMode ? undefined : await this.certificates.resolve(company),
      this.mockMode,
    );
  }
}
