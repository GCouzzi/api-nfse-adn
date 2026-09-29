import { Database } from "bun:sqlite";
import fs from "fs";
import path from "path";
import { config } from "../config/env";
import { initSchema } from "./schema";

const dir = path.dirname(config.dbPath);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

export const db = new Database(config.dbPath, { create: true });
initSchema(db);

export default db;
