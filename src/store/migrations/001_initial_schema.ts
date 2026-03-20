import type Database from "better-sqlite3";
import type { Migration } from "../db.js";

export const migration001: Migration = {
  version: 1,
  name: "initial_schema",
  up(db: Database.Database): void {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS pipeline_runs (
        run_id         TEXT PRIMARY KEY,
        started_at     TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('running','complete','error','paused')),
        config_json    TEXT NOT NULL,
        total_cost_usd REAL NOT NULL DEFAULT 0,
        completed_at   TEXT,
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS stage_checkpoints (
        run_id     TEXT NOT NULL,
        stage_id   TEXT NOT NULL,
        output_json TEXT NOT NULL,
        cost_usd   REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (run_id, stage_id)
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS canary_tokens (
        id           TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL,
        package_name TEXT NOT NULL,
        callback_url TEXT NOT NULL,
        token_type   TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS registry_interactions (
        id           TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL,
        method       TEXT NOT NULL,
        path         TEXT NOT NULL,
        source_ip    TEXT NOT NULL,
        user_agent   TEXT NOT NULL DEFAULT '',
        package_name TEXT,
        token_id     TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();

    db.prepare(`
      CREATE TABLE IF NOT EXISTS alerts (
        id           TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL,
        token_id     TEXT,
        alert_type   TEXT NOT NULL,
        severity     TEXT NOT NULL,
        title        TEXT NOT NULL,
        description  TEXT NOT NULL,
        source_ip    TEXT,
        user_agent   TEXT,
        package_name TEXT,
        mitre_json   TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `).run();

    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_canary_tokens_run ON canary_tokens(run_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_alerts_run ON alerts(run_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_alerts_type ON alerts(alert_type)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_interactions_run ON registry_interactions(run_id)`).run();
  },
};
