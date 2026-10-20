import { ApplicationError } from "../application/contracts";
import type {
  ApplicationRepository,
  Company,
  Environment,
} from "../application/contracts";

export class CompanyService {
  constructor(
    private readonly repository: ApplicationRepository,
    private readonly environment: Environment,
  ) {}

  async require(id: string, active = false): Promise<Company> {
    const company = await this.repository.getCompany(id);
    if (!company) throw new ApplicationError("Empresa não encontrada.", 404);
    if (active && !company.ativa)
      throw new ApplicationError("A empresa está inativa.");
    return company;
  }

  async byCnpj(cnpj: string, active = false): Promise<Company> {
    const company = await this.repository.getCompanyByCnpj(
      cnpj.replace(/\D/g, ""),
    );
    if (!company)
      throw new ApplicationError(
        "Cadastre a empresa antes de consultar ou sincronizar.",
        404,
      );
    if (active && !company.ativa)
      throw new ApplicationError("A empresa está inativa.");
    return company;
  }

  async save(input: Record<string, unknown>, id?: string): Promise<Company> {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new ApplicationError(
        "Informe os dados da empresa em um objeto JSON.",
      );
    let existing = id ? await this.require(id) : null;
    const nome = typeof input.nome === "string" ? input.nome.trim() : "";
    const cnpj =
      typeof input.cnpj === "string" ? input.cnpj.replace(/\D/g, "") : "";
    if (!nome || nome.length > 200)
      throw new ApplicationError(
        "Informe o nome da empresa, com até 200 caracteres.",
      );
    if (!/^\d{14}$/.test(cnpj))
      throw new ApplicationError("Informe um CNPJ com 14 dígitos.");
    if (existing && cnpj !== existing.cnpj)
      throw new ApplicationError(
        "O CNPJ não pode ser alterado. Cadastre outra empresa.",
      );
    const duplicate = await this.repository.getCompanyByCnpj(cnpj, true);
    if (duplicate && duplicate.id !== id) {
      if (!id && duplicate.removida_em) existing = duplicate;
      else
        throw new ApplicationError(
          "Já existe uma empresa cadastrada com este CNPJ.",
          409,
        );
    }
    if (input.ativa !== undefined && typeof input.ativa !== "boolean")
      throw new ApplicationError("Situação da empresa inválida.");
    const certificateId =
      input.certificado_id === undefined
        ? (existing?.certificado_id ?? null)
        : input.certificado_id;
    if (
      certificateId !== null &&
      (typeof certificateId !== "string" ||
        !(await this.repository.getCertificate(certificateId)))
    ) {
      throw new ApplicationError("Selecione um certificado cadastrado.");
    }
    const now = new Date().toISOString();
    const company: Company = {
      id: existing?.id ?? crypto.randomUUID(),
      nome,
      cnpj,
      ativa:
        input.ativa === undefined
          ? (existing?.ativa ?? 1)
          : Number(input.ativa),
      certificado_id: certificateId as string | null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await this.repository.saveCompany(company);
    if (!existing)
      await this.repository.linkLegacyNotes(company, this.environment);
    return company;
  }

  async assertNote(company: Company, chave: string): Promise<void> {
    if (!(await this.repository.hasNote(company.id, this.environment, chave))) {
      throw new ApplicationError(
        "Nota não encontrada para a empresa selecionada.",
        404,
      );
    }
  }

  async remove(id: string): Promise<void> {
    await this.require(id);
    await this.repository.removeCompany(id);
  }
}
