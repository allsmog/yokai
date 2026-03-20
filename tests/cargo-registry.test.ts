import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { openDatabase } from "../src/store/db.js";
import { InProcessBus } from "../src/bus/in-process.js";
import { createCargoRegistryApp } from "../src/registries/cargo/server.js";
import { loadAlerts } from "../src/store/checkpoint.js";
import type { CanaryPackage, CanaryToken } from "../src/types.js";

describe("Cargo canary registry", () => {
  let testDir: string;
  let db: ReturnType<typeof openDatabase>;
  let bus: InstanceType<typeof InProcessBus>;
  let server: ReturnType<typeof serve>;
  let port: number;
  const runId = "cargo-test-run";

  beforeAll(async () => {
    testDir = join(tmpdir(), `yokai-cargo-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = openDatabase(join(testDir, "cargo.sqlite3"));
    bus = new InProcessBus();
    port = 19400 + Math.floor(Math.random() * 1000);

    const pkg: CanaryPackage = {
      name: "internal-utils",
      version: "0.0.1-canary",
      description: "Internal Rust canary crate",
      tokenId: "tok-cargo-1",
      createdAt: new Date().toISOString(),
    };

    const token: CanaryToken = {
      id: "tok-cargo-1",
      packageName: "internal-utils",
      callbackUrl: `http://localhost:${port}/_yokai/callback/tok-cargo-1`,
      createdAt: new Date().toISOString(),
      type: "postinstall",
    };

    const crates = new Map<string, CanaryPackage>();
    crates.set("internal-utils", pkg);

    const tokens = new Map<string, CanaryToken>();
    tokens.set("tok-cargo-1", token);

    const app = createCargoRegistryApp({
      db, bus, runId, crates, tokens,
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
    expect(body.protocol).toBe("cargo");
    expect(body.crates).toBe(1);
  });

  it("GET /config.json returns registry config", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/config.json`);
    const body = await res.json() as Record<string, string>;
    expect(body.dl).toContain("/api/v1/crates");
    expect(body.api).toBeDefined();
  });

  it("GET /api/v1/crates/<name> returns crate metadata", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/crates/internal-utils`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const crate = body.crate as Record<string, unknown>;
    expect(crate.name).toBe("internal-utils");
    expect(crate.max_version).toBe("0.0.1-canary");

    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.packageName === "internal-utils")).toBe(true);
  });

  it("GET /api/v1/crates/<name>/<version>/download records download alert", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/crates/internal-utils/0.0.1-canary/download`);
    expect(res.status).toBe(200);

    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.alertType === "canary-download")).toBe(true);
  });

  it("PUT /api/v1/crates/new returns 403", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/crates/new`, {
      method: "PUT",
      body: "fake-crate",
    });
    expect(res.status).toBe(403);

    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.alertType === "unauthorized-publish")).toBe(true);
  });

  it("sparse index lookup returns index line JSON", async () => {
    // 4+ char crate: /in/te/internal-utils
    const res = await fetch(`http://127.0.0.1:${port}/in/te/internal-utils`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const parsed = JSON.parse(text.trim());
    expect(parsed.name).toBe("internal-utils");
    expect(parsed.vers).toBe("0.0.1-canary");
  });

  it("returns 404 for unknown crates", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/crates/nonexistent`);
    expect(res.status).toBe(404);
  });
});
