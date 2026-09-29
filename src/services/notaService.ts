import AdmZip from "adm-zip";
import repository from "../database";
import type { FindAllByCnpjOptions } from "../database/types";
import type { DocumentoXml, NotaFiscalComEventos } from "../types/models";

export class NotaService {
  /**
   * Retorna todas as notas fiscais de um CNPJ com seus respectivos eventos e metadados de XMLs
   */
  async findAllByCnpj(cnpj: string, options: FindAllByCnpjOptions = {}): Promise<NotaFiscalComEventos[]> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    return repository.findAllByCnpj(cleanCnpj, options);
  }

  /**
   * Busca uma nota fiscal específica pela chave de acesso
   */
  async findByChave(chaveAcesso: string): Promise<NotaFiscalComEventos | null> {
    const cleanChave = chaveAcesso.replace(/\D/g, "");
    return repository.findByChave(cleanChave);
  }

  /**
   * Obtém o XML da NFS-e principal ou evento pela chave de acesso
   */
  async getXmlByChave(chaveAcesso: string, tipoDocumento = "NFSE"): Promise<string | null> {
    const cleanChave = chaveAcesso.replace(/\D/g, "");
    return repository.getXmlByChave(cleanChave, tipoDocumento);
  }

  /**
   * Obtém um XML específico pelo ID
   */
  async getXmlById(id: number): Promise<DocumentoXml | null> {
    return repository.getXmlById(id);
  }

  /**
   * Cria um arquivo ZIP contendo a NFS-e e todos os seus eventos
   */
  async generateZipForNota(chaveAcesso: string): Promise<Buffer> {
    const cleanChave = chaveAcesso.replace(/\D/g, "");
    const docs = await repository.getXmlsForChave(cleanChave);

    if (docs.length === 0) {
      throw new Error(`Nenhum documento XML localizado para a chave: ${chaveAcesso}`);
    }

    const zip = new AdmZip();

    for (const doc of docs) {
      const fileName =
        doc.tipo_documento === "NFSE"
          ? `NFSe_${cleanChave}.xml`
          : `Evento_${doc.tipo_evento || doc.tipo_documento}_NSU${doc.nsu}_${cleanChave}.xml`;

      zip.addFile(fileName, Buffer.from(doc.xml_conteudo, "utf-8"));
    }

    return zip.toBuffer();
  }

  /**
   * Cria um arquivo ZIP contendo todos os XMLs de notas e eventos de um CNPJ
   */
  async generateZipForCnpj(cnpj: string): Promise<Buffer> {
    const cleanCnpj = cnpj.replace(/\D/g, "");
    const docs = await repository.getXmlsForCnpj(cleanCnpj);

    if (docs.length === 0) {
      throw new Error(`Nenhum documento XML encontrado para o CNPJ: ${cnpj}`);
    }

    const zip = new AdmZip();

    for (const doc of docs) {
      const folder = doc.tipo_documento === "NFSE" ? "Notas" : "Eventos";
      const fileName =
        doc.tipo_documento === "NFSE"
          ? `${folder}/NFSe_${doc.chave_acesso}.xml`
          : `${folder}/Evento_${doc.tipo_evento || doc.tipo_documento}_${doc.chave_acesso}.xml`;

      zip.addFile(fileName, Buffer.from(doc.xml_conteudo, "utf-8"));
    }

    return zip.toBuffer();
  }
}

export const notaService = new NotaService();
