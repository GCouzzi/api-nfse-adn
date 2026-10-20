import type { FindAllByCnpjOptions } from "../database/types";
import type {
  ConsultaNSUParams,
  LoteDistribuicaoNSUResponse,
} from "../types/adn";

export type Environment = "homologacao" | "producao";

export class ApplicationError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export interface Company {
  id: string;
  nome: string;
  cnpj: string;
  ativa: number;
  certificado_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CertificateRecord {
  id: string;
  arquivo: string;
  senha_criptografada: string;
  titular: string;
  validade: string;
  fingerprint: string;
  updated_at: string;
}

export interface CertificateCredentials {
  pfx: Buffer;
  passphrase: string;
}

export interface CertificateProvider {
  resolve(company: Company): Promise<CertificateCredentials>;
}

export const MAX_CERTIFICATE_BYTES = 10 * 1024 * 1024;

export interface CertificateUpload {
  filename: string;
  content: Buffer;
  password: string;
}

export interface CertificateRegistry extends CertificateProvider {
  files(): Promise<string[]>;
  register(
    filename: string,
    password: string,
    id?: string,
  ): Promise<CertificateRecord>;
  upload(input: CertificateUpload, id?: string): Promise<CertificateRecord>;
}

export interface AdnGateway {
  consultarNSU(params: ConsultaNSUParams): Promise<LoteDistribuicaoNSUResponse>;
  close(): void;
}

export interface AdnGatewayFactory {
  create(company: Company): Promise<AdnGateway>;
}

export interface PdfRenderer {
  render(html: string): Promise<Buffer>;
  close(): Promise<void>;
}

export type ExportStatus =
  | "QUEUED"
  | "PROCESSING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "EXPIRED";

export interface PdfExport {
  id: string;
  empresa_id: string;
  ambiente: Environment;
  status: ExportStatus;
  competencia: string | null;
  total: number;
  processadas: number;
  falhas: number;
  erro: string | null;
  created_at: string;
  expires_at: string;
}

export interface SqlExecutor {
  query<T>(sql: string, params?: Array<string | number | null>): Promise<T[]>;
}

export interface ApplicationRepository {
  init(environment: Environment): Promise<void>;
  listCompanies(): Promise<Company[]>;
  getCompany(id: string): Promise<Company | null>;
  getCompanyByCnpj(cnpj: string): Promise<Company | null>;
  saveCompany(company: Company): Promise<void>;
  listCertificates(): Promise<CertificateRecord[]>;
  getCertificate(id: string): Promise<CertificateRecord | null>;
  saveCertificate(certificate: CertificateRecord): Promise<void>;
  linkLegacyNotes(company: Company, environment: Environment): Promise<void>;
  linkDocument(
    company: Company,
    environment: Environment,
    nsu: number,
    documentId: number,
    chave: string,
  ): Promise<void>;
  hasNote(
    companyId: string,
    environment: Environment,
    chave: string,
  ): Promise<boolean>;
  noteNsus(
    companyId: string,
    environment: Environment,
    keys: string[],
  ): Promise<Map<string, number>>;
  exportNoteKeys(
    companyId: string,
    environment: Environment,
    competencia?: string,
  ): Promise<string[]>;
  findDocument(hash: string): Promise<number | null>;
  registerDocument(hash: string, documentId: number): Promise<void>;
  hasEvent(documentId: number): Promise<boolean>;
  createExport(job: PdfExport): Promise<void>;
  getExport(id: string): Promise<PdfExport | null>;
  listExports(
    companyId?: string,
    environment?: Environment,
    limit?: number,
  ): Promise<PdfExport[]>;
  updateExport(
    id: string,
    fields: Partial<
      Pick<
        PdfExport,
        "status" | "total" | "processadas" | "falhas" | "erro" | "expires_at"
      >
    >,
  ): Promise<void>;
}

export interface CompanyNoteFilter extends FindAllByCnpjOptions {
  empresaId: string;
  ambiente: Environment;
}
