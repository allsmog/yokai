import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/store/db.js";
import { saveCheckpoint, saveInteraction } from "../src/store/checkpoint.js";
import { InProcessBus } from "../src/bus/in-process.js";
import { normalizeConfig } from "../src/config.js";
import { s5BaselineTraffic } from "../src/stages/s5-baseline-traffic.js";
import { getBaselineMetadata } from "../src/detection/baseline.js";
import type { StageId } from "../src/types.js";

describe("baseline", () => {
  let testDir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00.000Z"));
    testDir = join(tmpdir(), `yokai-baseline-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = openDatabase(join(testDir, "baseline.sqlite3"));
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("captures interactions during a configured baseline window", async () => {
    const bus = new InProcessBus();
    const runId = "baseline-run";

    setTimeout(() => {
      saveInteraction(db, {
        id: "int-1",
        runId,
        method: "GET",
        path: "/@myorg/utils",
        sourceIp: "1.2.3.4",
        userAgent: "npm/9",
        packageName: "@myorg/utils",
        createdAt: new Date().toISOString(),
      });
    }, 50);

    const resultPromise = s5BaselineTraffic.run(undefined, {
      runId,
      config: normalizeConfig({ protocol: "npm", baselineWindowMs: 100 }),
      bus,
      db,
      upstreamOutputs: new Map(),
    });

    await vi.advanceTimersByTimeAsync(100);
    const result = await resultPromise;

    expect(result.baselineInteractions).toBe(1);
    expect(result.baselineWindowMs).toBe(100);
    expect(result.signatures).toEqual([
      {
        protocol: "npm",
        method: "GET",
        path: "/@myorg/utils",
        packageName: "@myorg/utils",
        count: 1,
      },
    ]);

    await bus.close();
  });

  it("marks unseen signatures as baseline deviations", () => {
    saveCheckpoint(db, "run-1", "s5-baseline-traffic" as StageId, {
      baselineInteractions: 1,
      baselineDurationMs: 100,
      readyAt: "2024-01-01T00:00:00.000Z",
      baselineWindowMs: 100,
      signatures: [
        {
          protocol: "npm",
          method: "GET",
          path: "/@myorg/utils",
          packageName: "@myorg/utils",
          count: 1,
        },
      ],
      costUsd: 0,
    });

    const known = getBaselineMetadata(db, "run-1", {
      protocol: "npm",
      method: "GET",
      path: "/@myorg/utils",
      packageName: "@myorg/utils",
    });
    const unknown = getBaselineMetadata(db, "run-1", {
      protocol: "npm",
      method: "GET",
      path: "/@myorg/new-utils",
      packageName: "@myorg/new-utils",
    });

    expect(known).toEqual({});
    expect(unknown).toMatchObject({ baselineDeviation: true });
  });

  it("does not emit deviation metadata for zero-window baselines", () => {
    saveCheckpoint(db, "run-2", "s5-baseline-traffic" as StageId, {
      baselineInteractions: 0,
      baselineDurationMs: 0,
      readyAt: "2024-01-01T00:00:00.000Z",
      baselineWindowMs: 0,
      signatures: [],
      costUsd: 0,
    });

    const metadata = getBaselineMetadata(db, "run-2", {
      protocol: "npm",
      method: "GET",
      path: "/@myorg/utils",
      packageName: "@myorg/utils",
    });

    expect(metadata).toEqual({});
  });
});
