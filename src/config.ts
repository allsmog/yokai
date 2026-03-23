import type { YokaiConfig, StageId } from "./types.js";
import { ALL_STAGE_IDS } from "./types.js";
import { isRecord } from "./utils.js";

export interface BuildConfigOptions {
  mode?: "standalone" | "proxy" | "git-decoy";
  protocol?: "npm" | "pypi" | "maven" | "go" | "cargo";
  upstreamUrl?: string;
  upstreamApiUrl?: string;
  upstreamIndexUrl?: string;
  model?: string;
  stageModels?: string[];
  stages?: string;
  resume?: string;
  json?: string;
  sarif?: string;
  port?: number;
  host?: string;
  callbackUrl?: string;
  repo?: string;
  maxBudget?: number;
  baselineWindowMs?: number;
  verbose?: boolean;
}

export function buildConfig(opts: BuildConfigOptions): YokaiConfig {
  const stageModels: Partial<Record<StageId, string>> = {};
  if (opts.stageModels) {
    for (const entry of opts.stageModels) {
      const [stageId, modelId] = entry.split("=");
      if (stageId && modelId) {
        stageModels[stageId as StageId] = modelId;
      }
    }
  }

  let stages: StageId[];
  if (opts.stages) {
    stages = opts.stages.split(",").map((s) => s.trim()) as StageId[];
  } else {
    stages = [...ALL_STAGE_IDS];
  }

  const port = opts.port ?? 4873;

  return normalizeConfig({
    mode: opts.mode ?? "standalone",
    protocol: opts.protocol ?? "npm",
    upstreamUrl: opts.upstreamUrl,
    upstreamApiUrl: opts.upstreamApiUrl,
    upstreamIndexUrl: opts.upstreamIndexUrl,
    model: opts.model ?? "anthropic:claude-sonnet-4-6",
    modelExplicitlyConfigured: typeof opts.model === "string" && opts.model.length > 0,
    stageModels,
    stages,
    resumeRunId: opts.resume,
    jsonOutput: opts.json,
    sarifOutput: opts.sarif,
    port,
    host: opts.host ?? "0.0.0.0",
    callbackBaseUrl: opts.callbackUrl ?? `http://localhost:${port}`,
    repoPath: opts.repo,
    maxBudgetUsd: opts.maxBudget,
    baselineWindowMs: opts.baselineWindowMs ?? 0,
    verbose: opts.verbose ?? false,
  });
}

export function resolveStageModel(config: YokaiConfig, stageId: StageId): string {
  return config.stageModels[stageId] ?? config.model;
}

export function normalizeConfig(input: Partial<YokaiConfig>): YokaiConfig {
  return {
    mode: input.mode === "proxy" || input.mode === "git-decoy" ? input.mode : "standalone",
    protocol: normalizeProtocol(input.protocol),
    upstreamUrl: typeof input.upstreamUrl === "string" ? input.upstreamUrl : undefined,
    upstreamApiUrl: typeof input.upstreamApiUrl === "string" ? input.upstreamApiUrl : undefined,
    upstreamIndexUrl: typeof input.upstreamIndexUrl === "string" ? input.upstreamIndexUrl : undefined,
    model: typeof input.model === "string" ? input.model : "anthropic:claude-sonnet-4-6",
    modelExplicitlyConfigured: input.modelExplicitlyConfigured === true,
    stageModels: normalizeStageModels(input.stageModels),
    stages: normalizeStages(input.stages),
    resumeRunId: typeof input.resumeRunId === "string" ? input.resumeRunId : undefined,
    jsonOutput: typeof input.jsonOutput === "string" ? input.jsonOutput : undefined,
    sarifOutput: typeof input.sarifOutput === "string" ? input.sarifOutput : undefined,
    port: normalizePort(input.port),
    host: typeof input.host === "string" && input.host.length > 0 ? input.host : "0.0.0.0",
    callbackBaseUrl: typeof input.callbackBaseUrl === "string" && input.callbackBaseUrl.length > 0
      ? input.callbackBaseUrl
      : `http://localhost:${normalizePort(input.port)}`,
    repoPath: typeof input.repoPath === "string" ? input.repoPath : undefined,
    maxBudgetUsd: typeof input.maxBudgetUsd === "number" && Number.isFinite(input.maxBudgetUsd)
      ? input.maxBudgetUsd
      : undefined,
    baselineWindowMs: normalizeNonNegativeInteger(input.baselineWindowMs),
    verbose: input.verbose === true,
  };
}

function normalizeProtocol(value: unknown): YokaiConfig["protocol"] {
  if (value === "pypi" || value === "maven" || value === "go" || value === "cargo") {
    return value;
  }
  return "npm";
}

export function parseStoredConfigJson(configJson: string): YokaiConfig | null {
  try {
    const parsed = JSON.parse(configJson) as unknown;
    if (!isRecord(parsed)) return null;
    return normalizeConfig(parsed as Partial<YokaiConfig>);
  } catch {
    return null;
  }
}

function normalizePort(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return 4873;
}

function normalizeNonNegativeInteger(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }
  return 0;
}

function normalizeStageModels(
  value: Partial<Record<StageId, string>> | undefined,
): Partial<Record<StageId, string>> {
  if (!value || typeof value !== "object") return {};

  const stageModels: Partial<Record<StageId, string>> = {};
  for (const stageId of ALL_STAGE_IDS) {
    const model = value[stageId];
    if (typeof model === "string" && model.length > 0) {
      stageModels[stageId] = model;
    }
  }
  return stageModels;
}

function normalizeStages(value: StageId[] | undefined): StageId[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [...ALL_STAGE_IDS];
  }

  const stages = value.filter((stageId): stageId is StageId => ALL_STAGE_IDS.includes(stageId));
  return stages.length > 0 ? [...new Set(stages)] : [...ALL_STAGE_IDS];
}
