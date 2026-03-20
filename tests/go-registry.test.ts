import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { openDatabase } from "../src/store/db.js";
import { InProcessBus } from "../src/bus/in-process.js";
import { createGoRegistryApp } from "../src/registries/go/server.js";
import { loadAlerts, loadInteractions } from "../src/store/checkpoint.js";
import type { CanaryPackage, CanaryToken } from "../src/types.js";

describe("Go module proxy canary", () => {
  let testDir: string;
  let db: ReturnType<typeof openDatabase>;
  let bus: InstanceType<typeof InProcessBus>;
  let server: ReturnType<typeof serve>;
  let port: number;
  const runId = "go-test-run";

  beforeAll(async () => {
    testDir = join(tmpdir(), `yokai-go-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = openDatabase(join(testDir, "go.sqlite3"));
    bus = new InProcessBus();
    port = 19600 + Math.floor(Math.random() * 1000);

    const pkg: CanaryPackage = {
      name: "github.com/myorg/internal-lib",
      version: "v0.0.1-canary",
      description: "Internal Go canary",
      tokenId: "tok-go-1",
      createdAt: new Date().toISOString(),
    };

    const token: CanaryToken = {
      id: "tok-go-1",
      packageName: "github.com/myorg/internal-lib",
      callbackUrl: `http://localhost:${port}/_yokai/callback/tok-go-1`,
      createdAt: new Date().toISOString(),
      type: "postinstall",
    };

    const modules = new Map<string, CanaryPackage>();
    modules.set("github.com/myorg/internal-lib", pkg);

    const tokens = new Map<string, CanaryToken>();
    tokens.set("tok-go-1", token);

    const app = createGoRegistryApp({
      db, bus, runId,
      modules,
      tokens,
      callbackBaseUrl: `http://localhost:${port}`,
    });

    server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
    for (let i = 0; i < 20; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/_yokai/health`); if (r.ok) break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
  });

  afterAll(async () => {
    server?.close();
    await bus.close();
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("health check returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/_yokai/health`);
    const body = await res.json();
    expect(body.protocol).toBe("go");
    expect(body.modules).toBe(1);
  });

  it("GET /@v/list returns version list", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/github.com/myorg/internal-lib/@v/list`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.trim()).toBe("v0.0.1-canary");
  });

  it("GET /@v/<version>.info returns version metadata", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/github.com/myorg/internal-lib/@v/v0.0.1-canary.info`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.Version).toBe("v0.0.1-canary");
    expect(body.Time).toBeDefined();
  });

  it("GET /@v/<version>.mod returns go.mod", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/github.com/myorg/internal-lib/@v/v0.0.1-canary.mod`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("module github.com/myorg/internal-lib");
    expect(text).toContain("go 1.21");
  });

  it("GET /@v/<version>.zip records download alert", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/github.com/myorg/internal-lib/@v/v0.0.1-canary.zip`);
    expect(res.status).toBe(200);

    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.alertType === "canary-download")).toBe(true);
  });

  it("GET /@latest returns latest version", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/github.com/myorg/internal-lib/@latest`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.Version).toBe("v0.0.1-canary");
  });

  it("returns 404 for unknown modules", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/github.com/unknown/lib/@v/list`);
    expect(res.status).toBe(404);
  });
});
