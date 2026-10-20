import type { Request, Response, NextFunction } from "express";
import { companies } from "../main/services";
import { ApplicationError } from "../application/contracts";
import type { Company } from "../application/contracts";

export function companyContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  void (async () => {
    const id = req.query.empresaId;
    const cnpj =
      req.query.cnpj ||
      req.query.cnpjConsulta ||
      req.path.match(/^\/cnpj\/(\d{14})\//)?.[1];
    let company: Company;
    if (typeof id === "string" && id) company = await companies.require(id);
    else if (
      typeof cnpj === "string" &&
      /^\d{14}$/.test(cnpj.replace(/\D/g, ""))
    )
      company = await companies.byCnpj(cnpj);
    else
      throw new ApplicationError(
        "Selecione a empresa de consulta (empresaId ou cnpj).",
      );
    if (
      cnpj !== undefined &&
      (typeof cnpj !== "string" || cnpj.replace(/\D/g, "") !== company.cnpj)
    )
      throw new ApplicationError(
        "O CNPJ não corresponde à empresa selecionada.",
      );
    const pathCnpj = req.path.match(/^\/cnpj\/([^/]+)\//)?.[1];
    if (pathCnpj && pathCnpj.replace(/\D/g, "") !== company.cnpj)
      throw new ApplicationError(
        "O CNPJ do download não corresponde à empresa selecionada.",
      );
    res.locals.company = company;
    next();
  })().catch(next);
}
