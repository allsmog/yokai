import type { YokaiTask } from "../dag/types.js";
import type {
  StageId, YokaiTaskContext,
  BaselineTrafficOutput,
} from "../types.js";
import { createLogger } from "../logger.js";
import { loadInteractions } from "../store/checkpoint.js";
import { summarizeInteractionsForBaseline } from "../detection/baseline.js";

const log = createLogger({ stage: "s5" });

export const s5BaselineTraffic: YokaiTask<unknown, BaselineTrafficOutput> = {
  id: "s5-baseline-traffic" as StageId,
  displayName: "Baseline Traffic",
  outputKind: "baseline",
  dependsOn: ["s4-configure-monitoring" as StageId],

  async run(_input: unknown, context: YokaiTaskContext): Promise<BaselineTrafficOutput> {
    const { abortSignal, config, db, runId } = context;
    const startMs = Date.now();
    const windowStartIso = new Date(startMs).toISOString();

    if (config.baselineWindowMs > 0) {
      log.info(`Collecting baseline traffic for ${config.baselineWindowMs}ms`);
      await waitForBaselineWindow(config.baselineWindowMs, abortSignal);
    }

    const readyAt = new Date().toISOString();
    const interactions = loadInteractions(db, runId).filter((interaction) => {
      return interaction.createdAt >= windowStartIso && interaction.createdAt <= readyAt;
    });
    const signatures = summarizeInteractionsForBaseline(interactions, config);

    log.info("Baseline stage complete — registry is live and monitoring");
    log.info(`Captured ${interactions.length} interaction(s) across ${signatures.length} signature(s)`);
    log.info("Run `npm install <pkg> --registry http://localhost:<port>` to test canary detection");

    return {
      baselineInteractions: interactions.length,
      baselineDurationMs: Date.now() - startMs,
      readyAt,
      baselineWindowMs: config.baselineWindowMs,
      signatures,
      costUsd: 0,
    };
  },
};

async function waitForBaselineWindow(durationMs: number, abortSignal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, durationMs);
    if (abortSignal) {
      abortSignal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}
