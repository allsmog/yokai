import type Database from "better-sqlite3";
import type {
  Alert,
  CanaryPackage,
  CanaryToken,
  DiscoverNamespacesOutput,
  DiscoveredNamespace,
  GenerateCanariesOutput,
  RegistryInteraction,
  YokaiConfig,
} from "../types.js";
import {
  loadAlerts,
  loadCanaryTokens,
  loadCheckpoint,
  loadInteractions,
  loadLatestPipelineRun,
  loadPipelineRun,
  type PipelineRunRecord,
} from "../store/checkpoint.js";
import { parseStoredConfigJson } from "../config.js";

export interface PersistedRunArtifacts {
  run: PipelineRunRecord;
  config: YokaiConfig | null;
  namespaces: DiscoveredNamespace[];
  packages: CanaryPackage[];
  tokens: CanaryToken[];
  alerts: Alert[];
  interactions: RegistryInteraction[];
  durationMs: number;
}

export function loadPersistedRunArtifacts(
  db: Database.Database,
  runId: string,
): PersistedRunArtifacts | null {
  const run = loadPipelineRun(db, runId);
  if (!run) return null;

  return {
    run,
    config: parseStoredConfigJson(run.configJson),
    namespaces: loadNamespaces(db, runId),
    packages: loadCanaryPackages(db, runId),
    tokens: loadCanaryTokens(db, runId),
    alerts: loadAlerts(db, runId),
    interactions: loadInteractions(db, runId),
    durationMs: computeDurationMs(run),
  };
}

export function loadRequestedOrLatestRunArtifacts(
  db: Database.Database,
  runId?: string,
): PersistedRunArtifacts | null {
  if (runId) {
    return loadPersistedRunArtifacts(db, runId);
  }

  const run = loadLatestPipelineRun(db);
  if (!run) return null;
  return loadPersistedRunArtifacts(db, run.runId);
}

function loadNamespaces(db: Database.Database, runId: string): DiscoveredNamespace[] {
  const checkpoint = loadCheckpoint(db, runId, "s1-discover-namespaces") as DiscoverNamespacesOutput | null;
  return checkpoint?.namespaces ?? [];
}

function loadCanaryPackages(db: Database.Database, runId: string): CanaryPackage[] {
  const checkpoint = loadCheckpoint(db, runId, "s2-generate-canaries") as GenerateCanariesOutput | null;
  return checkpoint?.packages ?? [];
}

function computeDurationMs(run: PipelineRunRecord): number {
  const startMs = Date.parse(run.startedAt);
  const endMs = Date.parse(run.completedAt ?? run.updatedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return 0;
  }
  return endMs - startMs;
}
