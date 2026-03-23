import type Database from "better-sqlite3";
import type { BaselineTrafficOutput, RegistryInteraction, YokaiConfig } from "../types.js";
import { loadCheckpoint } from "../store/checkpoint.js";

export interface InteractionSignatureInput {
  protocol: string;
  method: string;
  path: string;
  packageName?: string;
}

const baselineCache = new Map<string, BaselineTrafficOutput>();

export function summarizeInteractionsForBaseline(
  interactions: RegistryInteraction[],
  config: YokaiConfig,
): BaselineTrafficOutput["signatures"] {
  const counts = new Map<string, BaselineTrafficOutput["signatures"][number]>();

  for (const interaction of interactions) {
    const protocol = inferProtocolForInteraction(interaction, config);
    const key = createInteractionSignatureKey({
      protocol,
      method: interaction.method,
      path: interaction.path,
      packageName: interaction.packageName,
    });

    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }

    counts.set(key, {
      protocol,
      method: interaction.method,
      path: interaction.path,
      packageName: interaction.packageName,
      count: 1,
    });
  }

  return [...counts.values()].sort((a, b) =>
    a.protocol.localeCompare(b.protocol)
    || a.method.localeCompare(b.method)
    || a.path.localeCompare(b.path)
    || (a.packageName ?? "").localeCompare(b.packageName ?? ""),
  );
}

export function createInteractionSignatureKey(input: InteractionSignatureInput): string {
  return JSON.stringify([
    input.protocol,
    input.method.toUpperCase(),
    input.path,
    input.packageName ?? "",
  ]);
}

export function getBaselineMetadata(
  db: Database.Database,
  runId: string,
  input: InteractionSignatureInput,
): Record<string, unknown> {
  const baseline = loadBaselineOutput(db, runId);
  if (!baseline) return {};
  if (baseline.baselineWindowMs <= 0 || baseline.signatures.length === 0) return {};

  const readyAtMs = Date.parse(baseline.readyAt);
  if (Number.isFinite(readyAtMs) && Date.now() < readyAtMs) {
    return {};
  }

  const signatureKey = createInteractionSignatureKey(input);
  const known = baseline.signatures.some((signature) => createInteractionSignatureKey(signature) === signatureKey);
  if (known) return {};

  return {
    baselineDeviation: true,
    baselineReadyAt: baseline.readyAt,
  };
}

export function withBaselineMetadata(
  db: Database.Database,
  runId: string,
  input: InteractionSignatureInput,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...metadata,
    ...getBaselineMetadata(db, runId, input),
  };
}

function loadBaselineOutput(
  db: Database.Database,
  runId: string,
): BaselineTrafficOutput | null {
  const cached = baselineCache.get(runId);
  if (cached) return cached;

  const checkpoint = loadCheckpoint(db, runId, "s5-baseline-traffic") as BaselineTrafficOutput | null;
  if (!checkpoint) return null;

  baselineCache.set(runId, checkpoint);
  return checkpoint;
}

function inferProtocolForInteraction(
  interaction: RegistryInteraction,
  config: YokaiConfig,
): string {
  if (config.mode === "proxy") return config.protocol;
  if (interaction.path.startsWith("/simple/") || interaction.path.startsWith("/packages/")) return "pypi";
  if (interaction.path.endsWith("/maven-metadata.xml") || /\.(jar|pom|sha1|md5)$/.test(interaction.path)) return "maven";
  if (interaction.path.includes("/@v/") || interaction.path.endsWith("/@latest")) return "go";
  if (interaction.path === "/config.json" || interaction.path.startsWith("/api/v1/crates/")) return "cargo";
  if (interaction.path.endsWith(".git") || interaction.path.includes("git-upload-pack") || interaction.path.includes("git-receive-pack")) return "git";
  return config.protocol;
}
