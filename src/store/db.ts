import Database from "better-sqlite3";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { migration001 } from "./migrations/001_initial_schema.js";

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const ALL_MIGRATIONS: Migration[] = [migration001];

export function openDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? path.join(process.cwd(), ".yokai", "yokai.sqlite3");
  mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  runMigrations(db, ALL_MIGRATIONS);
  return db;
}

function ensureSchemaVersionTable(db: Database.Database): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `).run();
}

function getAppliedVersions(db: Database.Database): Set<number> {
  const rows = db.prepare("SELECT version FROM schema_version").all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

export function runMigrations(
  db: Database.Database,
  migrations: Migration[],
): Array<{ version: number; name: string }> {
  ensureSchemaVersionTable(db);

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const applied = getAppliedVersions(db);
  const newlyApplied: Array<{ version: number; name: string }> = [];

  for (const migration of sorted) {
    if (applied.has(migration.version)) continue;

    const runOne = db.transaction(() => {
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, new Date().toISOString());
    });

    runOne();
    newlyApplied.push({ version: migration.version, name: migration.name });
  }

  return newlyApplied;
}
