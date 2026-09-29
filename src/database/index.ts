import { config } from "../config/env";
import type { IDatabaseRepository } from "./types";
import { PostgresRepository } from "./postgres";
import { SqliteRepository } from "./sqlite";

export const repository: IDatabaseRepository =
  config.dbClient === "postgres" ? new PostgresRepository() : new SqliteRepository();

export async function initDatabase(): Promise<void> {
  console.log(`[Database] Inicializando repositório: ${config.dbClient.toUpperCase()}`);
  await repository.init();
}

export default repository;
