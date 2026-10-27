import path from "node:path";
import { dbFilePath, dataDir } from "../paths.js";

export interface DbConfig {
  mode: "sqlite";
  databaseUrl: string;
  fallbackUrl: string;
}

export function readDbConfig(): DbConfig {
  const configuredMode = String(process.env.UI_AGENT_DB_MODE ?? "sqlite").trim().toLowerCase();
  if (configuredMode && configuredMode !== "sqlite") {
    throw new Error("The open-source desktop build supports local SQLite only");
  }
  const databaseUrl = `sqlite://${dbFilePath}`;
  return { mode: "sqlite", databaseUrl, fallbackUrl: databaseUrl };
}

export function sqlitePathFromUrl(url: string): string {
  if (url.startsWith("sqlite://")) return url.slice("sqlite://".length) || dbFilePath;
  return url || dbFilePath;
}

export function maskDatabaseUrl(url: string): string {
  return url.startsWith("sqlite://") ? url : "<unsupported-database>";
}

export function databaseKind(url: string): string {
  return url.startsWith("sqlite") ? "sqlite" : "unknown";
}

export function ensureSqliteParentDir(sqliteUrl: string): void {
  const parent = path.dirname(sqlitePathFromUrl(sqliteUrl));
  void import("node:fs/promises").then((fs) => fs.mkdir(parent, { recursive: true }));
}

export { dbFilePath, dataDir };
