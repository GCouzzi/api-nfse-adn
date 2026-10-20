import { config } from "../config/env";
import type { IDatabaseRepository } from "../database/types";
import type { AdnGateway, AdnGatewayFactory } from "../application/contracts";
import { createHash } from "node:crypto";
import { CompanyService } from "../companies/companyService";
import { statusFromEvents } from "./noteStatus";
import { XMLValidator } from "fast-xml-parser";
import {
  decompressAndDecodeXml,
  parseNfseXml,
  parseEventoXml,
} from "./xmlParser";
import type { SyncControle } from "../types/models";

export interface SyncResult {
  cnpj: string;
  nsuInicial: number;
  nsuFinal: number;
  novosDocumentos: number;
  totalNotas: number;
  totalEventos: number;
  ciclosExecutados: number;
  statusProcessamento: string;
  mensagens: any[];
}

export class SyncService {
  constructor(
    private readonly repository: IDatabaseRepository,
    private readonly companies: CompanyService,
    private readonly gateways: AdnGatewayFactory,
  ) {}
  /**
   * Obtém ou inicializa o controle de sincronização para um CNPJ
   */
  async getOrCreateSyncControle(cnpj: string): Promise<SyncControle> {
    return this.repository.getSyncControle(cnpj);
  }

  /**
   * Executa a sincronização de NSUs para um determinado CNPJ com Throttling e controle de taxa ao ADN
   */
  async sincronizarCnpj(
    cnpj: string,
    nsuForcado?: number,
    maxLoops = 10,
  ): Promise<SyncResult> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    const repository = this.repository;
    const company = await this.companies.byCnpj(cleanCnpj, true);
    if (!cleanCnpj || cleanCnpj.length !== 14) {
      throw new Error(
        `CNPJ inválido: ${cnpj}. O CNPJ deve conter exatamente 14 dígitos.`,
      );
    }

    const controle = await this.getOrCreateSyncControle(cleanCnpj);
    let currentNsu =
      nsuForcado !== undefined ? nsuForcado : Number(controle.ultimo_nsu);
    if (!Number.isSafeInteger(currentNsu) || currentNsu < 0)
      throw new Error("NSU inicial inválido.");
    const nsuInicial = currentNsu;

    // Atualiza status para SYNCING
    await repository.setSyncStatus(cleanCnpj, "SYNCING");

    let totalNovos = 0;
    let totalNotas = 0;
    let totalEventos = 0;
    let loops = 0;
    let ultimoStatus = "NENHUM_DOCUMENTO_LOCALIZADO";
    const mensagens: any[] = [];
    let adnClient: AdnGateway | undefined;

    try {
      adnClient = await this.gateways.create(company);
      while (loops < maxLoops) {
        loops++;

        // Throttling outbound: Aguarda intervalo entre requisições consecutivas para não tomar bloqueio/WAF do governo
        if (loops > 1 && config.adnRequestDelayMs > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, config.adnRequestDelayMs),
          );
        }

        const response = await adnClient.consultarNSU({
          nsu: currentNsu,
          cnpjConsulta: cleanCnpj,
          lote: true,
        });

        ultimoStatus = response.StatusProcessamento;

        if (response.Alertas && response.Alertas.length > 0) {
          mensagens.push(...response.Alertas);
        }
        if (response.Erros && response.Erros.length > 0) {
          mensagens.push(...response.Erros);
        }

        if (response.StatusProcessamento === "REJEICAO") {
          const descErro =
            response.Erros?.map((e) => e.Descricao || e.Codigo).join("; ") ||
            "Rejeição na consulta do ADN";
          throw new Error(descErro);
        }

        const documentos = response.LoteDFe || [];
        if (
          documentos.length === 0 ||
          response.StatusProcessamento === "NENHUM_DOCUMENTO_LOCALIZADO"
        ) {
          break;
        }

        for (const doc of documentos) {
          const docNsu = Number(doc.NSU);
          if (!Number.isSafeInteger(docNsu) || docNsu < 0)
            throw new Error("O ADN retornou um NSU inválido.");
          const chaveAcessoOriginal = doc.ChaveAcesso || "";
          const tipoDoc = doc.TipoDocumento;
          const tipoEvento = doc.TipoEvento || null;
          const xmlStr = doc.ArquivoXml
            ? decompressAndDecodeXml(doc.ArquivoXml)
            : "";
          const now = new Date().toISOString();

          if (!xmlStr)
            throw new Error(`O documento do NSU ${docNsu} não contém XML.`);
          if (XMLValidator.validate(xmlStr) !== true)
            throw new Error(
              `O documento do NSU ${docNsu} contém XML inválido.`,
            );
          if (
            tipoDoc === "NFSE" &&
            !/<(?:[\w.-]+:)?infNFSe(?:\s|>)/.test(xmlStr)
          )
            throw new Error(
              `O documento do NSU ${docNsu} não contém uma NFS-e autorizada.`,
            );

          const parsedNota =
            tipoDoc === "NFSE"
              ? parseNfseXml(xmlStr, chaveAcessoOriginal)
              : null;
          const parsedEvento =
            tipoDoc === "EVENTO"
              ? parseEventoXml(xmlStr, chaveAcessoOriginal)
              : null;
          const chave =
            parsedNota?.chave_acesso ||
            parsedEvento?.chave_acesso ||
            chaveAcessoOriginal;
          if (
            (tipoDoc === "NFSE" || tipoDoc === "EVENTO") &&
            !/^\d{50}$/.test(chave)
          )
            throw new Error(
              `Documento do NSU ${docNsu} sem chave de acesso válida.`,
            );
          const hash = createHash("sha256")
            .update(`${tipoDoc}\0${chave}\0${xmlStr}`)
            .digest("hex");
          let docXmlId = await repository.application.findDocument(hash);
          const imported = docXmlId !== null;
          if (docXmlId === null)
            docXmlId = await repository.saveDocumentoXml({
              chave_acesso: chave,
              nsu: docNsu,
              tipo_documento: tipoDoc,
              tipo_evento: tipoEvento,
              xml_conteudo: xmlStr,
              data_hora_geracao: doc.DataHoraGeracao || now,
              created_at: now,
            });
          await repository.application.registerDocument(hash, docXmlId);

          if (tipoDoc === "NFSE") {
            const parsed = parsedNota!;
            const chaveFinal = chave;

            await repository.saveNotaFiscal({
              chave_acesso: chaveFinal,
              nsu: docNsu,
              cnpj_prestador: parsed.cnpj_prestador || cleanCnpj,
              cnpj_tomador: parsed.cnpj_tomador || null,
              cpf_tomador: parsed.cpf_tomador || null,
              razao_social_prestador: parsed.razao_social_prestador || null,
              razao_social_tomador: parsed.razao_social_tomador || null,
              numero_nfse: parsed.numero_nfse || null,
              serie: parsed.serie || null,
              data_emissao: parsed.data_emissao || null,
              competencia: parsed.competencia || null,
              valor_servicos: parsed.valor_servicos,
              valor_liquido: parsed.valor_liquido,
              descricao_servico: parsed.descricao_servico || null,
              codigo_municipio: parsed.codigo_municipio || null,
              status: "AUTORIZADA",
              created_at: now,
              updated_at: now,
            });

            // An event may arrive before its original note. Reconcile persisted events on every import.
            const saved = await repository.findByChave(chaveFinal);
            const status = statusFromEvents(
              saved?.eventos.map((event) => event.tipo_evento) ?? [],
            );
            if (status) await repository.updateNotaStatus(chaveFinal, status);
            if (!imported) totalNotas++;
          } else if (tipoDoc === "EVENTO") {
            const chaveFinal = chave;
            const evTipo = tipoEvento || parsedEvento!.tipo_evento || "EVENTO";

            if (!(await repository.application.hasEvent(docXmlId)))
              await repository.saveEvento({
                chave_acesso: chaveFinal,
                nsu: docNsu,
                tipo_evento: evTipo,
                descricao_evento: parsedEvento!.descricao_evento || null,
                motivo: parsedEvento!.motivo || null,
                data_hora_evento:
                  parsedEvento!.data_hora_evento || doc.DataHoraGeracao || now,
                documento_xml_id: docXmlId,
                created_at: now,
              });

            const saved = await repository.findByChave(chaveFinal);
            const status = statusFromEvents(
              saved?.eventos.map((event) => event.tipo_evento) ?? [evTipo],
            );
            if (status) await repository.updateNotaStatus(chaveFinal, status);

            if (!imported) totalEventos++;
          }

          await repository.application.linkDocument(
            company,
            config.adnEnv,
            docNsu,
            docXmlId,
            chave,
          );
          if (!imported) totalNovos++;
          if (docNsu > currentNsu) {
            currentNsu = docNsu;
          }
        }

        // Atualiza o progresso do NSU no banco
        await repository.updateSyncProgress(cleanCnpj, currentNsu, currentNsu);
      }

      // Finalização com sucesso
      await repository.updateSyncProgress(cleanCnpj, currentNsu, currentNsu);

      return {
        cnpj: cleanCnpj,
        nsuInicial,
        nsuFinal: currentNsu,
        novosDocumentos: totalNovos,
        totalNotas,
        totalEventos,
        ciclosExecutados: loops,
        statusProcessamento: ultimoStatus,
        mensagens,
      };
    } catch (error: any) {
      await repository.setSyncStatus(cleanCnpj, "ERROR", error.message);
      throw error;
    } finally {
      adnClient?.close();
    }
  }
}
