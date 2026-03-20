import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/store/db.js";
import {
  saveCheckpoint, loadCheckpoint, listCheckpoints,
  savePipelineRun, updatePipelineStatus,
  saveCanaryToken, loadCanaryTokens, findCanaryTokenById,
  saveAlert, loadAlerts,
  saveInteraction, loadInteractions,
} from "../src/store/checkpoint.js";
import type { StageId, Alert, RegistryInteraction } from "../src/types.js";

describe("store", () => {
  let dbPath: string;
  let testDir: string;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    testDir = join(tmpdir(), `yokai-store-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    dbPath = join(testDir, "test.sqlite3");
    db = openDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe("checkpoints", () => {
    it("saves and loads checkpoint", () => {
      const output = { namespaces: ["@myorg/a"], costUsd: 0.01 };
      saveCheckpoint(db, "run-1", "s1-discover-namespaces" as StageId, output);

      const loaded = loadCheckpoint(db, "run-1", "s1-discover-namespaces" as StageId);
      expect(loaded).toEqual(output);
    });

    it("returns null for missing checkpoint", () => {
      const loaded = loadCheckpoint(db, "run-1", "s1-discover-namespaces" as StageId);
      expect(loaded).toBeNull();
    });

    it("lists checkpoints", () => {
      saveCheckpoint(db, "run-1", "s1-discover-namespaces" as StageId, { test: 1 });
      saveCheckpoint(db, "run-1", "s2-generate-canaries" as StageId, { test: 2 });

      const checkpoints = listCheckpoints(db, "run-1");
      expect(checkpoints.length).toBe(2);
      expect(checkpoints[0].stageId).toBe("s1-discover-namespaces");
    });
  });

  describe("pipeline runs", () => {
    it("saves and updates pipeline run", () => {
      savePipelineRun(db, "run-1", '{"test": true}');
      updatePipelineStatus(db, "run-1", "complete", 0.05);

      const row = db.prepare("SELECT * FROM pipeline_runs WHERE run_id = ?").get("run-1") as Record<string, unknown>;
      expect(row["status"]).toBe("complete");
      expect(row["total_cost_usd"]).toBe(0.05);
    });
  });

  describe("canary tokens", () => {
    it("saves and loads tokens", () => {
      saveCanaryToken(db, {
        id: "tok-1",
        runId: "run-1",
        packageName: "@myorg/utils",
        callbackUrl: "http://localhost:4873/_yokai/callback/tok-1",
        type: "postinstall",
        createdAt: new Date().toISOString(),
      });

      const tokens = loadCanaryTokens(db, "run-1");
      expect(tokens.length).toBe(1);
      expect(tokens[0].packageName).toBe("@myorg/utils");
    });

    it("finds token by id", () => {
      saveCanaryToken(db, {
        id: "tok-abc",
        runId: "run-1",
        packageName: "@myorg/auth",
        callbackUrl: "http://localhost:4873/_yokai/callback/tok-abc",
        type: "postinstall",
        createdAt: new Date().toISOString(),
      });

      const token = findCanaryTokenById(db, "tok-abc");
      expect(token).not.toBeNull();
      expect(token!.packageName).toBe("@myorg/auth");
    });
  });

  describe("alerts", () => {
    it("saves and loads alerts", () => {
      const alert: Alert = {
        id: "alert-1",
        runId: "run-1",
        tokenId: "tok-1",
        alertType: "dependency-confusion",
        severity: "critical",
        title: "Test alert",
        description: "Test description",
        sourceIp: "1.2.3.4",
        userAgent: "npm/9",
        packageName: "@myorg/utils",
        mitre: { techniqueId: "T1195.002", techniqueName: "Supply Chain Compromise", tactic: "Initial Access" },
        metadata: { ci: true },
        createdAt: new Date().toISOString(),
      };

      saveAlert(db, alert);
      const loaded = loadAlerts(db, "run-1");

      expect(loaded.length).toBe(1);
      expect(loaded[0].alertType).toBe("dependency-confusion");
      expect(loaded[0].severity).toBe("critical");
      expect(loaded[0].mitre.techniqueId).toBe("T1195.002");
    });
  });

  describe("interactions", () => {
    it("saves and loads interactions", () => {
      const interaction: RegistryInteraction = {
        id: "int-1",
        runId: "run-1",
        method: "GET",
        path: "/@myorg/utils",
        sourceIp: "1.2.3.4",
        userAgent: "npm/9",
        packageName: "@myorg/utils",
        createdAt: new Date().toISOString(),
      };

      saveInteraction(db, interaction);
      const loaded = loadInteractions(db, "run-1");

      expect(loaded.length).toBe(1);
      expect(loaded[0].method).toBe("GET");
      expect(loaded[0].packageName).toBe("@myorg/utils");
    });
  });
});
