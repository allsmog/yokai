import type Database from "better-sqlite3";
import type { StageId, CanaryToken, Alert, RegistryInteraction } from "../types.js";

// ── Checkpoint CRUD ──

export function saveCheckpoint(
  db: Database.Database,
  runId: string,
  stageId: StageId,
  output: unknown,
): void {
  const outputJson = JSON.stringify(output);
  const costUsd = extractCost(output);

  db.prepare(`
    INSERT OR REPLACE INTO stage_checkpoints (run_id, stage_id, output_json, cost_usd, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(runId, stageId, outputJson, costUsd);
}

export function loadCheckpoint(
  db: Database.Database,
  runId: string,
  stageId: StageId,
): unknown | null {
  const row = db.prepare(
    "SELECT output_json FROM stage_checkpoints WHERE run_id = ? AND stage_id = ?",
  ).get(runId, stageId) as { output_json: string } | undefined;

  if (!row) return null;

  try {
    return JSON.parse(row.output_json);
  } catch {
    return null;
  }
}

export function listCheckpoints(
  db: Database.Database,
  runId: string,
): Array<{ stageId: string; createdAt: string }> {
  const rows = db.prepare(
    "SELECT stage_id, created_at FROM stage_checkpoints WHERE run_id = ? ORDER BY created_at",
  ).all(runId) as Array<{ stage_id: string; created_at: string }>;

  return rows.map((r) => ({ stageId: r.stage_id, createdAt: r.created_at }));
}

// ── Pipeline Run CRUD ──

export function savePipelineRun(
  db: Database.Database,
  runId: string,
  configJson: string,
  status: "running" | "complete" | "error" | "paused" = "running",
): void {
  db.prepare(`
    INSERT OR REPLACE INTO pipeline_runs (run_id, started_at, status, config_json, updated_at)
    VALUES (?, datetime('now'), ?, ?, datetime('now'))
  `).run(runId, status, configJson);
}

export function updatePipelineStatus(
  db: Database.Database,
  runId: string,
  status: "running" | "complete" | "error" | "paused",
  totalCostUsd?: number,
): void {
  if (totalCostUsd != null) {
    db.prepare(`
      UPDATE pipeline_runs SET status = ?, total_cost_usd = ?, completed_at = datetime('now'), updated_at = datetime('now')
      WHERE run_id = ?
    `).run(status, totalCostUsd, runId);
  } else {
    db.prepare(`
      UPDATE pipeline_runs SET status = ?, updated_at = datetime('now')
      WHERE run_id = ?
    `).run(status, runId);
  }
}

// ── Canary Token CRUD ──

export function saveCanaryToken(
  db: Database.Database,
  token: CanaryToken & { runId: string },
): void {
  db.prepare(`
    INSERT OR REPLACE INTO canary_tokens (id, run_id, package_name, callback_url, token_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token.id, token.runId, token.packageName, token.callbackUrl, token.type, token.createdAt);
}

export function loadCanaryTokens(
  db: Database.Database,
  runId: string,
): CanaryToken[] {
  const rows = db.prepare(
    "SELECT id, package_name, callback_url, token_type, created_at FROM canary_tokens WHERE run_id = ?",
  ).all(runId) as Array<{
    id: string;
    package_name: string;
    callback_url: string;
    token_type: string;
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    packageName: r.package_name,
    callbackUrl: r.callback_url,
    type: r.token_type as CanaryToken["type"],
    createdAt: r.created_at,
  }));
}

export function findCanaryTokenById(
  db: Database.Database,
  tokenId: string,
): (CanaryToken & { runId: string }) | null {
  const row = db.prepare(
    "SELECT id, run_id, package_name, callback_url, token_type, created_at FROM canary_tokens WHERE id = ?",
  ).get(tokenId) as {
    id: string;
    run_id: string;
    package_name: string;
    callback_url: string;
    token_type: string;
    created_at: string;
  } | undefined;

  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    packageName: row.package_name,
    callbackUrl: row.callback_url,
    type: row.token_type as CanaryToken["type"],
    createdAt: row.created_at,
  };
}

// ── Alert CRUD ──

export function saveAlert(db: Database.Database, alert: Alert): void {
  db.prepare(`
    INSERT OR REPLACE INTO alerts (id, run_id, token_id, alert_type, severity, title, description, source_ip, user_agent, package_name, mitre_json, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    alert.id,
    alert.runId,
    alert.tokenId ?? null,
    alert.alertType,
    alert.severity,
    alert.title,
    alert.description,
    alert.sourceIp ?? null,
    alert.userAgent ?? null,
    alert.packageName ?? null,
    JSON.stringify(alert.mitre),
    JSON.stringify(alert.metadata),
    alert.createdAt,
  );
}

export function loadAlerts(
  db: Database.Database,
  runId: string,
): Alert[] {
  const rows = db.prepare(
    "SELECT * FROM alerts WHERE run_id = ? ORDER BY created_at DESC",
  ).all(runId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r["id"] as string,
    runId: r["run_id"] as string,
    tokenId: r["token_id"] as string | undefined,
    alertType: r["alert_type"] as Alert["alertType"],
    severity: r["severity"] as Alert["severity"],
    title: r["title"] as string,
    description: r["description"] as string,
    sourceIp: r["source_ip"] as string | undefined,
    userAgent: r["user_agent"] as string | undefined,
    packageName: r["package_name"] as string | undefined,
    mitre: JSON.parse(r["mitre_json"] as string),
    metadata: JSON.parse(r["metadata_json"] as string),
    createdAt: r["created_at"] as string,
  }));
}

// ── Interaction CRUD ──

export function saveInteraction(db: Database.Database, interaction: RegistryInteraction): void {
  db.prepare(`
    INSERT INTO registry_interactions (id, run_id, method, path, source_ip, user_agent, package_name, token_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    interaction.id,
    interaction.runId,
    interaction.method,
    interaction.path,
    interaction.sourceIp,
    interaction.userAgent,
    interaction.packageName ?? null,
    interaction.tokenId ?? null,
    interaction.createdAt,
  );
}

export function loadInteractions(
  db: Database.Database,
  runId: string,
): RegistryInteraction[] {
  const rows = db.prepare(
    "SELECT * FROM registry_interactions WHERE run_id = ? ORDER BY created_at DESC",
  ).all(runId) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: r["id"] as string,
    runId: r["run_id"] as string,
    method: r["method"] as string,
    path: r["path"] as string,
    sourceIp: r["source_ip"] as string,
    userAgent: r["user_agent"] as string,
    packageName: r["package_name"] as string | undefined,
    tokenId: r["token_id"] as string | undefined,
    createdAt: r["created_at"] as string,
  }));
}

function extractCost(output: unknown): number {
  if (output && typeof output === "object" && "costUsd" in output) {
    const cost = (output as Record<string, unknown>)["costUsd"];
    if (typeof cost === "number" && Number.isFinite(cost)) return cost;
  }
  return 0;
}
