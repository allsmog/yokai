import type { YokaiConfig, StageId } from "./types.js";
import { ALL_STAGE_IDS } from "./types.js";

export interface BuildConfigOptions {
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

  return {
    model: opts.model ?? "anthropic:claude-sonnet-4-6",
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
    verbose: opts.verbose ?? false,
  };
}

export function resolveStageModel(config: YokaiConfig, stageId: StageId): string {
  return config.stageModels[stageId] ?? config.model;
}
