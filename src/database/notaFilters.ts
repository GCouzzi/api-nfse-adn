import type { FindAllByCnpjOptions } from "./types";
import type { NotaFilterDialect } from "./dialects/notaFilterDialect";

type FilterParameter = string | number;

interface NotaFiltersResult {
  where: string;
  params: FilterParameter[];
  bind(value: FilterParameter): string;
}

export function isCompetencia(value: string): boolean {
  const year = Number(value.slice(0, 4));

  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && year > 0 && year < 9999;
}

export function notaFilters(
  cnpj: string,
  options: FindAllByCnpjOptions,
  dialect: NotaFilterDialect,
): NotaFiltersResult {
  const params: FilterParameter[] = [];

  const bind = (value: FilterParameter): string => {
    params.push(value);
    return dialect.placeholder(params.length);
  };

  const document = cnpj.replace(/\D/g, "");
  const columns =
    options.papel === "prestador"
      ? ["cnpj_prestador"]
      : options.papel === "tomador"
        ? ["cnpj_tomador", "cpf_tomador"]
        : ["cnpj_prestador", "cnpj_tomador", "cpf_tomador"];
  const conditions: string[] = [];

  if (options.empresaId) {
    conditions.push(
      `EXISTS (SELECT 1 FROM empresa_notas en WHERE en.chave_acesso = n.chave_acesso AND en.empresa_id = ${bind(options.empresaId)} AND en.ambiente = ${bind(options.ambiente ?? "homologacao")})`,
    );
  }

  if (!options.empresaId || (options.papel && options.papel !== "todos")) {
    const documentConditions = columns.map(
      (column) => `n.${column} = ${bind(document)}`,
    );
    conditions.push(`(${documentConditions.join(" OR ")})`);
  }

  if (options.status) {
    conditions.push(`n.status = ${bind(options.status.toUpperCase())}`);
  }

  if (options.competencia) {
    if (!isCompetencia(options.competencia)) {
      throw new Error("Competência inválida. Use AAAA-MM.");
    }

    const [year, month] = options.competencia.split("-").map(Number);
    const next =
      month === 12
        ? `${String(year + 1).padStart(4, "0")}-01`
        : `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;

    conditions.push(
      `n.competencia >= ${bind(options.competencia)} AND n.competencia < ${bind(next)}`,
    );
  }

  const contains = (column: string, value: string) => {
    const expression = dialect.normalizeText(
      column,
      `COALESCE(n.${column}, '')`,
    );

    return dialect.contains(expression, bind(value.toLowerCase()));
  };

  for (const role of ["prestador", "tomador"] as const) {
    const value = options[role]?.trim();

    if (!value) {
      continue;
    }

    const digits = value.replace(/\D/g, "");
    const parts = [contains(`razao_social_${role}`, value)];

    if (digits && /^[\d\s./-]+$/.test(value)) {
      parts.push(contains(`cnpj_${role}`, digits));

      if (role === "tomador") {
        parts.push(contains("cpf_tomador", digits));
      }
    }

    conditions.push(`(${parts.join(" OR ")})`);
  }

  if (options.chaveAcesso) {
    const accessKey = options.chaveAcesso.replace(/\D/g, "");
    conditions.push(`n.chave_acesso = ${bind(accessKey)}`);
  }

  if (options.busca?.trim()) {
    const search = options.busca.trim();
    const searchableColumns = [
      "numero_nfse",
      "chave_acesso",
      "razao_social_prestador",
      "razao_social_tomador",
      "cnpj_prestador",
      "cnpj_tomador",
      "cpf_tomador",
    ];
    const searchConditions = searchableColumns.map((column) =>
      contains(column, search),
    );

    conditions.push(`(${searchConditions.join(" OR ")})`);
  }

  return { where: conditions.join(" AND "), params, bind };
}

export const notaOrder = [
  "CASE WHEN NULLIF(n.competencia, '') IS NULL THEN 1 ELSE 0 END",
  "SUBSTR(n.competencia, 1, 7) DESC",
  "n.data_emissao DESC",
  "n.nsu DESC",
  "n.chave_acesso DESC",
].join(", ");
