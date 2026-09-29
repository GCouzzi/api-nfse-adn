import repository from "../database";
import { config } from "../config/env";
import { adnClient } from "./adnClient";
import { decompressAndDecodeXml, parseNfseXml, parseEventoXml } from "./xmlParser";
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
  /**
   * Obtém ou inicializa o controle de sincronização para um CNPJ
   */
  async getOrCreateSyncControle(cnpj: string): Promise<SyncControle> {
    return repository.getSyncControle(cnpj);
  }

  /**
   * Executa a sincronização de NSUs para um determinado CNPJ com Throttling e controle de taxa ao ADN
   */
  async sincronizarCnpj(cnpj: string, nsuForcado?: number, maxLoops = 10): Promise<SyncResult> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    if (!cleanCnpj || cleanCnpj.length !== 14) {
      throw new Error(`CNPJ inválido: ${cnpj}. O CNPJ deve conter exatamente 14 dígitos.`);
    }

    const controle = await this.getOrCreateSyncControle(cleanCnpj);
    let currentNsu = nsuForcado !== undefined ? nsuForcado : controle.ultimo_nsu;
    const nsuInicial = currentNsu;

    // Atualiza status para SYNCING
    await repository.setSyncStatus(cleanCnpj, "SYNCING");

    let totalNovos = 0;
    let totalNotas = 0;
    let totalEventos = 0;
    let loops = 0;
    let ultimoStatus = "NENHUM_DOCUMENTO_LOCALIZADO";
    const mensagens: any[] = [];

    try {
      while (loops < maxLoops) {
        loops++;

        // Throttling outbound: Aguarda intervalo entre requisições consecutivas para não tomar bloqueio/WAF do governo
        if (loops > 1 && config.adnRequestDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, config.adnRequestDelayMs));
        }

        const response = await adnClient.consultarNSU({
          nsu: currentNsu,
          cnpjConsulta: cleanCnpj,
          lote: true
        });

        ultimoStatus = response.StatusProcessamento;

        if (response.Alertas && response.Alertas.length > 0) {
          mensagens.push(...response.Alertas);
        }
        if (response.Erros && response.Erros.length > 0) {
          mensagens.push(...response.Erros);
        }

        if (response.StatusProcessamento === "REJEICAO") {
          const descErro = response.Erros?.map((e) => e.Descricao || e.Codigo).join("; ") || "Rejeição na consulta do ADN";
          await repository.setSyncStatus(cleanCnpj, "ERROR", descErro);
          break;
        }

        const documentos = response.LoteDFe || [];
        if (documentos.length === 0 || response.StatusProcessamento === "NENHUM_DOCUMENTO_LOCALIZADO") {
          break;
        }

        for (const doc of documentos) {
          const docNsu = doc.NSU;
          const chaveAcessoOriginal = doc.ChaveAcesso || "";
          const tipoDoc = doc.TipoDocumento;
          const tipoEvento = doc.TipoEvento || null;
          const xmlStr = doc.ArquivoXml ? decompressAndDecodeXml(doc.ArquivoXml) : "";
          const now = new Date().toISOString();

          if (!xmlStr) continue;

          // Salva o documento XML descompactado
          const docXmlId = await repository.saveDocumentoXml({
            chave_acesso: chaveAcessoOriginal,
            nsu: docNsu,
            tipo_documento: tipoDoc,
            tipo_evento: tipoEvento,
            xml_conteudo: xmlStr,
            data_hora_geracao: doc.DataHoraGeracao || now,
            created_at: now
          });

          if (tipoDoc === "NFSE") {
            const parsed = parseNfseXml(xmlStr, chaveAcessoOriginal);
            const chaveFinal = parsed.chave_acesso || chaveAcessoOriginal;

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
              updated_at: now
            });

            totalNotas++;
          } else if (tipoDoc === "EVENTO") {
            const parsedEvento = parseEventoXml(xmlStr, chaveAcessoOriginal);
            const chaveFinal = parsedEvento.chave_acesso || chaveAcessoOriginal;
            const evTipo = tipoEvento || parsedEvento.tipo_evento || "EVENTO";

            await repository.saveEvento({
              chave_acesso: chaveFinal,
              nsu: docNsu,
              tipo_evento: evTipo,
              descricao_evento: parsedEvento.descricao_evento || null,
              motivo: parsedEvento.motivo || null,
              data_hora_evento: parsedEvento.data_hora_evento || doc.DataHoraGeracao || now,
              documento_xml_id: docXmlId,
              created_at: now
            });

            if (evTipo.includes("CANCELAMENTO")) {
              await repository.updateNotaStatus(chaveFinal, "CANCELADA");
            }

            totalEventos++;
          }

          totalNovos++;
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
        mensagens
      };
    } catch (error: any) {
      await repository.setSyncStatus(cleanCnpj, "ERROR", error.message);
      throw error;
    }
  }
}

export const syncService = new SyncService();
