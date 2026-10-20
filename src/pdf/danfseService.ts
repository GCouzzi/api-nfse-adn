import { DanfseHtmlBuilder, DanfseXmlParser } from "@notaas/danfse-viewer";
import { ApplicationError } from "../application/contracts";
import type {
  Company,
  Environment,
  PdfRenderer,
} from "../application/contracts";
import type { IDatabaseRepository } from "../database/types";

export class DanfseService {
  constructor(
    private readonly repository: IDatabaseRepository,
    private readonly renderer: PdfRenderer,
    private readonly environment: Environment,
  ) {}

  async generate(company: Company, chave: string): Promise<Buffer> {
    if (!/^\d{50}$/.test(chave))
      throw new ApplicationError("Chave de acesso inválida.");
    if (
      !(await this.repository.application.hasNote(
        company.id,
        this.environment,
        chave,
      ))
    ) {
      throw new ApplicationError("Nota não encontrada para esta empresa.", 404);
    }
    const [note, xml] = await Promise.all([
      this.repository.findByChave(chave),
      this.repository.getXmlByChave(chave, "NFSE"),
    ]);
    if (!note || !xml)
      throw new ApplicationError("XML da NFS-e não disponível.", 404);
    // Every request owns its parser: its municipality lookup is mutable.
    const data = await new DanfseXmlParser().parse(xml);
    if (data.chaveAcesso !== chave)
      throw new ApplicationError(
        "O XML armazenado não corresponde à chave solicitada.",
      );
    data.cancelada = note.status === "CANCELADA";
    data.substituida = note.status === "SUBSTITUIDA";
    data.homologacao = this.environment === "homologacao";
    data.cStat = note.status;
    data.tpAmb = data.homologacao ? "Homologação" : "Produção";
    return this.renderer.render(new DanfseHtmlBuilder().build(data));
  }
}
