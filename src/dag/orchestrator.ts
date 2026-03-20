import type Database from "better-sqlite3";
import type { StageId, YokaiTaskContext, YokaiConfig } from "../types.js";
import type { MessageBus } from "../bus/types.js";
import type { StageStartEvent, StageCompleteEvent, StageErrorEvent, StageSkippedEvent } from "../bus/events.js";
import { createLogger } from "../logger.js";
import { loadCheckpoint, saveCheckpoint } from "../store/checkpoint.js";
import { TaskRegistry } from "./registry.js";

const log = createLogger({ stage: "orchestrator" });

export interface OrchestratorOptions {
  runId: string;
  config: YokaiConfig;
  bus: MessageBus;
  db: Database.Database;
  registry: TaskRegistry;
  abortSignal?: AbortSignal;
}

export interface OrchestratorResult {
  outputs: Map<string, unknown>;
  totalCostUsd: number;
  durationMs: number;
}

export async function runOrchestrator(opts: OrchestratorOptions): Promise<OrchestratorResult> {
  const { runId, config, bus, db, registry, abortSignal } = opts;
  const startMs = Date.now();
  let totalCostUsd = 0;

  registry.validate();
  const groups = registry.resolveOrder(config.stages);
  const outputs = new Map<string, unknown>();

  // Load checkpointed outputs for resumed runs
  if (config.resumeRunId) {
    for (const stageId of config.stages) {
      const checkpoint = loadCheckpoint(db, runId, stageId);
      if (checkpoint) {
        outputs.set(stageId, checkpoint);
        log.info(`Restored checkpoint for ${stageId}`);
      }
    }
  }

  for (const group of groups) {
    if (abortSignal?.aborted) break;

    const promises = group.map(async (stageId) => {
      if (outputs.has(stageId)) {
        await publishEvent<StageSkippedEvent>(bus, "stage:skipped", runId, {
          stageId: stageId as StageId,
          runId,
          reason: "Restored from checkpoint",
        });
        return;
      }

      const stageStartMs = Date.now();
      await publishEvent<StageStartEvent>(bus, "stage:start", runId, {
        stageId: stageId as StageId,
        runId,
      });

      const task = registry.get(stageId as StageId);
      const context: YokaiTaskContext = {
        runId,
        config,
        bus,
        db,
        upstreamOutputs: outputs,
        abortSignal,
      };

      try {
        log.info(`Running stage: ${task.displayName}`);
        const output = await task.run(undefined, context);
        outputs.set(stageId, output);

        saveCheckpoint(db, runId, stageId as StageId, output);

        const durationMs = Date.now() - stageStartMs;
        const costUsd = extractCost(output);
        totalCostUsd += costUsd;

        await publishEvent<StageCompleteEvent>(bus, "stage:complete", runId, {
          stageId: stageId as StageId,
          runId,
          durationMs,
          costUsd,
        });

        log.info(`Stage ${stageId} complete (${(durationMs / 1000).toFixed(1)}s, $${costUsd.toFixed(4)})`);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await publishEvent<StageErrorEvent>(bus, "stage:error", runId, {
          stageId: stageId as StageId,
          runId,
          error: errorMsg,
        });
        throw error;
      }
    });

    await Promise.all(promises);
  }

  return {
    outputs,
    totalCostUsd,
    durationMs: Date.now() - startMs,
  };
}

function extractCost(output: unknown): number {
  if (output && typeof output === "object" && "costUsd" in output) {
    const cost = (output as Record<string, unknown>)["costUsd"];
    if (typeof cost === "number" && Number.isFinite(cost)) return cost;
  }
  return 0;
}

async function publishEvent<E extends { type: string; meta: { id: string; timestamp: string; runId: string }; payload: unknown }>(
  bus: MessageBus,
  type: E["type"],
  runId: string,
  payload: E["payload"],
): Promise<void> {
  try {
    await bus.publish({
      type,
      meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId },
      payload,
    });
  } catch {
    // Non-fatal
  }
}
