export interface NotaFilterDialect {
  placeholder(position: number): string;
  normalizeText(column: string, expression: string): string;
  contains(expression: string, placeholder: string): string;
}
