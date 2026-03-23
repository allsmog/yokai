import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/store/db.js";
import {
  saveAlert,
  saveCanaryToken,
  saveCheckpoint,
  saveInteraction,
  savePipelineRun,
  updatePipelineStatus,
} from "../src/store/checkpoint.js";
import { normalizeConfig } from "../src/config.js";
import type { StageId } from "../src/types.js";

const cliPath = join(process.cwd(), "src", "cli.ts");
const tsxPath = join(process.cwd(), "node_modules", ".bin", "tsx");

describe("CLI", () => {
  let testDir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    testDir = join(tmpdir(), `yokai-cli-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = openDatabase(join(testDir, ".yokai", "yokai.sqlite3"));
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("monitor --run-id reads the requested run instead of the latest run", () => {
    savePipelineRun(db, "run-latest", JSON.stringify(normalizeConfig({ repoPath: "/tmp/latest" })));
    saveAlert(db, {
      id: "alert-latest",
      runId: "run-latest",
      alertType: "namespace-probe",
      severity: "medium",
      title: "Latest alert",
      description: "latest",
      mitre: { techniqueId: "T1592", techniqueName: "Recon", tactic: "Reconnaissance" },
      metadata: {},
      createdAt: new Date().toISOString(),
    });

    savePipelineRun(db, "run-target", JSON.stringify(normalizeConfig({ repoPath: "/tmp/target" })));
    saveAlert(db, {
      id: "alert-target",
      runId: "run-target",
      alertType: "canary-download",
      severity: "high",
      title: "Target alert",
      description: "target",
      mitre: { techniqueId: "T1195.002", techniqueName: "Supply Chain", tactic: "Initial Access" },
      metadata: {},
      createdAt: new Date().toISOString(),
    });
    saveInteraction(db, {
      id: "int-target",
      runId: "run-target",
      method: "GET",
      path: "/@myorg/utils",
      sourceIp: "1.2.3.4",
      userAgent: "npm/9",
      packageName: "@myorg/utils",
      createdAt: new Date().toISOString(),
    });

    const output = runCli(testDir, ["monitor", "--run-id", "run-target"]);
    expect(output).toContain("Run: run-target");
    expect(output).toContain("Target alert");
    expect(output).not.toContain("Latest alert");
  });

  it("report reconstructs persisted run metadata and checkpoints", () => {
    const config = normalizeConfig({ repoPath: "/repo", port: 4873 });
    savePipelineRun(db, "run-report", JSON.stringify(config));
    updatePipelineStatus(db, "run-report", "complete", 12.34);

    saveCheckpoint(db, "run-report", "s1-discover-namespaces" as StageId, {
      namespaces: [{ name: "@myorg/utils", source: "package.json", isScoped: true }],
      costUsd: 0,
    });
    saveCheckpoint(db, "run-report", "s2-generate-canaries" as StageId, {
      packages: [{ name: "@myorg/utils", version: "0.0.1-canary", description: "pkg", tokenId: "tok-1", createdAt: new Date().toISOString() }],
      tokens: [{ id: "tok-1", packageName: "@myorg/utils", callbackUrl: "http://localhost/_yokai/callback/tok-1", createdAt: new Date().toISOString(), type: "postinstall" }],
      costUsd: 0,
    });
    saveCanaryToken(db, {
      id: "tok-1",
      runId: "run-report",
      packageName: "@myorg/utils",
      callbackUrl: "http://localhost/_yokai/callback/tok-1",
      type: "postinstall",
      createdAt: new Date().toISOString(),
    });
    saveAlert(db, {
      id: "alert-report",
      runId: "run-report",
      alertType: "namespace-probe",
      severity: "medium",
      title: "Report alert",
      description: "desc",
      packageName: "@myorg/utils",
      mitre: { techniqueId: "T1592", techniqueName: "Recon", tactic: "Reconnaissance" },
      metadata: {},
      createdAt: new Date().toISOString(),
    });
    saveInteraction(db, {
      id: "int-report",
      runId: "run-report",
      method: "GET",
      path: "/@myorg/utils",
      sourceIp: "1.2.3.4",
      userAgent: "npm/9",
      packageName: "@myorg/utils",
      createdAt: new Date().toISOString(),
    });

    const output = runCli(testDir, ["report", "--run-id", "run-report", "--format", "json"]);
    const parsed = JSON.parse(output);

    expect(parsed.repoPath).toBe("/repo");
    expect(parsed.totalCostUsd).toBe(12.34);
    expect(parsed.namespaces[0].name).toBe("@myorg/utils");
    expect(parsed.canaryPackages[0].name).toBe("@myorg/utils");
  });

  it("resume restores the stored run configuration and completes when checkpoints exist", () => {
    const config = normalizeConfig({ repoPath: "/repo", port: 4873, stages: [
      "s1-discover-namespaces",
      "s2-generate-canaries",
      "s3-deploy-registries",
      "s4-configure-monitoring",
      "s5-baseline-traffic",
    ] });
    savePipelineRun(db, "run-resume", JSON.stringify(config), "paused");
    saveCheckpoint(db, "run-resume", "s1-discover-namespaces" as StageId, { namespaces: [], costUsd: 0 });
    saveCheckpoint(db, "run-resume", "s2-generate-canaries" as StageId, { packages: [], tokens: [], costUsd: 0 });
    saveCheckpoint(db, "run-resume", "s3-deploy-registries" as StageId, { registryUrl: "http://localhost:4873", port: 4873, packages: [], costUsd: 0 });
    saveCheckpoint(db, "run-resume", "s4-configure-monitoring" as StageId, { alertRules: [], callbackUrl: "http://localhost:4873/_yokai/callback", costUsd: 0 });
    saveCheckpoint(db, "run-resume", "s5-baseline-traffic" as StageId, {
      baselineInteractions: 0,
      baselineDurationMs: 0,
      readyAt: new Date().toISOString(),
      baselineWindowMs: 0,
      signatures: [],
      costUsd: 0,
    });

    const output = runCli(testDir, ["resume", "run-resume"]);
    expect(output).toContain("Run run-resume resumed and complete.");
  });
});

function runCli(cwd: string, args: string[]): string {
  return execFileSync(tsxPath, [cliPath, ...args], {
    cwd,
    encoding: "utf-8",
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
  });
}
