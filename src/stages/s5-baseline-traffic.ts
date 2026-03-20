import type { YokaiTask } from "../dag/types.js";
import type {
  StageId, YokaiTaskContext, ConfigureMonitoringOutput,
  BaselineTrafficOutput,
} from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ stage: "s5" });

export const s5BaselineTraffic: YokaiTask<unknown, BaselineTrafficOutput> = {
  id: "s5-baseline-traffic" as StageId,
  displayName: "Baseline Traffic",
  outputKind: "baseline",
  dependsOn: ["s4-configure-monitoring" as StageId],

  async run(_input: unknown, context: YokaiTaskContext): Promise<BaselineTrafficOutput> {
    const startMs = Date.now();

    // In the MVP, we skip the baselining wait period and just mark the pipeline as ready.
    // In a production deployment, this stage would:
    // 1. Wait for a configurable baseline window (e.g., 1 hour)
    // 2. Record all registry interactions during the window
    // 3. Establish a normal traffic baseline for deviation detection

    log.info("Baseline stage complete — registry is live and monitoring");
    log.info("Run `npm install <pkg> --registry http://localhost:<port>` to test canary detection");

    return {
      baselineInteractions: 0,
      baselineDurationMs: Date.now() - startMs,
      costUsd: 0,
    };
  },
};
