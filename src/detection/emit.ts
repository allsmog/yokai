import type Database from "better-sqlite3";
import type { MessageBus } from "../bus/types.js";
import type { Alert } from "../types.js";
import { saveAlert } from "../store/checkpoint.js";
import { classifyAlert } from "./alert-engine.js";
import { withBaselineMetadata } from "./baseline.js";

export interface CredentialProbeOptions {
  db: Database.Database;
  bus: MessageBus;
  runId: string;
  method: string;
  path: string;
  sourceIp?: string;
  userAgent?: string;
  packageName?: string;
  authorizationHeader?: string;
  metadata?: Record<string, unknown>;
}

export function persistAndEmitAlert(
  db: Database.Database,
  bus: MessageBus,
  runId: string,
  alert: Alert,
): void {
  saveAlert(db, alert);
  bus.publish({
    type: "alert:triggered",
    meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId },
    payload: {
      alertId: alert.id,
      alertType: alert.alertType,
      severity: alert.severity,
      packageName: alert.packageName,
      sourceIp: alert.sourceIp,
    },
  }).catch(() => {});
}

export function maybeEmitCredentialProbe(opts: CredentialProbeOptions): Alert | null {
  if (!hasAuthorizationHeader(opts.authorizationHeader)) {
    return null;
  }

  const alert = classifyAlert({
    runId: opts.runId,
    packageName: opts.packageName,
    sourceIp: opts.sourceIp,
    userAgent: opts.userAgent,
    method: opts.method,
    path: opts.path,
    metadata: withBaselineMetadata(
      opts.db,
      opts.runId,
      {
        protocol: String(opts.metadata?.["protocol"] ?? "unknown"),
        method: opts.method,
        path: opts.path,
        packageName: opts.packageName,
      },
      {
        ...opts.metadata,
        authorizationPresent: true,
      },
    ),
  });

  persistAndEmitAlert(opts.db, opts.bus, opts.runId, alert);
  return alert;
}

export function hasAuthorizationHeader(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
