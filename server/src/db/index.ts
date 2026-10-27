import path from "node:path";
import fs from "node:fs/promises";
import knex, { type Knex } from "knex";
import {
  type DbConfig,
  readDbConfig,
  databaseKind,
  maskDatabaseUrl,
  sqlitePathFromUrl
} from "./env.js";
import { dbFilePath } from "../paths.js";

export interface DatabaseRuntime {
  knex: Knex;
  config: DbConfig;
  mode: "sqlite";
  status: "ok";
  fallback: false;
  activeKind: "sqlite";
  activeUrl: string;
  targetUrl: string;
  fallbackUrl: string;
  reason: string;
}

export interface DatabaseStatusDict {
  mode: string;
  status: string;
  target: string;
  active: string;
  fallback: boolean;
  reason: string;
  targetUrl: string;
  activeUrl: string;
  fallbackUrl: string;
  dialect: string;
}

function buildKnexConnection(url: string): Knex {
  return knex({
    client: "better-sqlite3",
    connection: { filename: sqlitePathFromUrl(url) },
    useNullAsDefault: true,
    pool: {
      afterCreate: (conn: unknown, cb: (err: Error | null) => void) => {
        const db = conn as { exec?: (sql: string) => void };
        db.exec?.("PRAGMA journal_mode=WAL;");
        db.exec?.("PRAGMA busy_timeout=5000;");
        db.exec?.("PRAGMA foreign_keys=ON;");
        cb(null);
      }
    }
  });
}

export async function createDatabaseRuntime(config: DbConfig = readDbConfig()): Promise<DatabaseRuntime> {
  const activeUrl = config.databaseUrl;
  await fs.mkdir(path.dirname(sqlitePathFromUrl(activeUrl)), { recursive: true });
  const database = buildKnexConnection(activeUrl);
  await database.raw("SELECT 1");
  return {
    knex: database,
    config,
    mode: "sqlite",
    status: "ok",
    fallback: false,
    activeKind: "sqlite",
    activeUrl,
    targetUrl: activeUrl,
    fallbackUrl: activeUrl,
    reason: ""
  };
}

let runtime: DatabaseRuntime | undefined;

export async function getDatabase(): Promise<DatabaseRuntime> {
  if (!runtime) {
    runtime = await createDatabaseRuntime();
    console.log("[db] local SQLite runtime ready");
  }
  return runtime;
}

export function getDatabaseSync(): DatabaseRuntime {
  if (!runtime) throw new Error("Database runtime not initialized; call getDatabase() first.");
  return runtime;
}

export function setDatabaseRuntime(nextRuntime: DatabaseRuntime): void {
  runtime = nextRuntime;
}

export async function closeDatabase(): Promise<void> {
  if (!runtime) return;
  await runtime.knex.destroy();
  runtime = undefined;
}

export function runtimeStatusDict(current: DatabaseRuntime): DatabaseStatusDict {
  return {
    mode: current.mode,
    status: current.status,
    target: databaseKind(current.targetUrl),
    active: current.activeKind,
    fallback: false,
    reason: "",
    targetUrl: maskDatabaseUrl(current.targetUrl),
    activeUrl: maskDatabaseUrl(current.activeUrl),
    fallbackUrl: maskDatabaseUrl(current.fallbackUrl),
    dialect: current.activeKind
  };
}

export { dbFilePath };
