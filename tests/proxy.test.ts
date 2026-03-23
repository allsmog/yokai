import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { openDatabase } from "../src/store/db.js";
import { InProcessBus } from "../src/bus/in-process.js";
import { createTransparentProxy } from "../src/registries/proxy/transparent.js";
import { loadAlerts, loadInteractions } from "../src/store/checkpoint.js";
import type { CanaryPackage, CanaryToken } from "../src/types.js";

describe("Transparent registry proxy", () => {
  let testDir: string;
  let db: ReturnType<typeof openDatabase>;
  let bus: InstanceType<typeof InProcessBus>;
  let proxyServer: ReturnType<typeof serve>;
  let upstreamServer: ReturnType<typeof serve>;
  let proxyPort: number;
  let upstreamPort: number;
  const runId = "proxy-test-run";

  beforeAll(async () => {
    testDir = join(tmpdir(), `yokai-proxy-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = openDatabase(join(testDir, "proxy.sqlite3"));
    bus = new InProcessBus();

    // Start a mock upstream registry
    upstreamPort = 19800 + Math.floor(Math.random() * 1000);
    const upstreamApp = new Hono();
    upstreamApp.get("/lodash", (c) => {
      return c.json({
        name: "lodash",
        "dist-tags": { latest: "4.17.21" },
        versions: { "4.17.21": { name: "lodash", version: "4.17.21" } },
      });
    });
    upstreamApp.get("/nonexistent", (c) => c.json({ error: "Not found" }, 404));

    upstreamServer = serve({ fetch: upstreamApp.fetch, port: upstreamPort, hostname: "127.0.0.1" });

    // Intercepted package
    const canary: CanaryPackage = {
      name: "@internal/secret-lib",
      version: "0.0.1-canary",
      description: "Internal canary",
      tokenId: "tok-proxy-1",
      createdAt: new Date().toISOString(),
    };

    const token: CanaryToken = {
      id: "tok-proxy-1",
      packageName: "@internal/secret-lib",
      callbackUrl: "",
      createdAt: new Date().toISOString(),
      type: "postinstall",
    };

    const intercepted = new Map<string, CanaryPackage>();
    intercepted.set("@internal/secret-lib", canary);

    const tokens = new Map<string, CanaryToken>();
    tokens.set("tok-proxy-1", token);

    proxyPort = upstreamPort + 100;

    const proxyApp = createTransparentProxy({
      db, bus, runId,
      protocol: "npm",
      interceptedPackages: intercepted,
      tokens,
      upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
      callbackBaseUrl: `http://127.0.0.1:${proxyPort}`,
    });

    proxyServer = serve({ fetch: proxyApp.fetch, port: proxyPort, hostname: "127.0.0.1" });

    // Wait for both servers
    for (let i = 0; i < 20; i++) {
      try {
        const [r1, r2] = await Promise.all([
          fetch(`http://127.0.0.1:${upstreamPort}/lodash`),
          fetch(`http://127.0.0.1:${proxyPort}/_yokai/health`),
        ]);
        if (r1.ok && r2.ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  afterAll(async () => {
    proxyServer?.close();
    upstreamServer?.close();
    await bus.close();
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("health check reports proxy mode", async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/_yokai/health`);
    const body = await res.json();
    expect(body.mode).toBe("proxy");
    expect(body.intercepted).toBe(1);
  });

  it("forwards non-intercepted requests to upstream", async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/lodash`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe("lodash");

    // Should still record the interaction
    const interactions = loadInteractions(db, runId);
    expect(interactions.some((i) => i.path === "/lodash")).toBe(true);
  });

  it("intercepts monitored package and serves canary", async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/@internal/secret-lib`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe("@internal/secret-lib");
    expect((body["dist-tags"] as Record<string, string>).latest).toBe("0.0.1-canary");

    // Should create alert
    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.packageName === "@internal/secret-lib")).toBe(true);
  });

  it("blocks publish to intercepted package", async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/@internal/secret-lib`, {
      method: "PUT",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(403);

    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.alertType === "unauthorized-publish")).toBe(true);
  });

  it("returns 502 when upstream is unreachable for unknown packages", async () => {
    // Create a proxy pointing to a dead upstream
    const deadPort = proxyPort + 200;
    const deadApp = createTransparentProxy({
      db, bus, runId: "dead-run",
      protocol: "npm",
      interceptedPackages: new Map(),
      tokens: new Map(),
      upstreamUrl: "http://127.0.0.1:1",
      callbackBaseUrl: `http://127.0.0.1:${deadPort}`,
      upstreamTimeoutMs: 1000,
    });

    const deadServer = serve({ fetch: deadApp.fetch, port: deadPort, hostname: "127.0.0.1" });
    await new Promise((r) => setTimeout(r, 200));

    try {
      const res = await fetch(`http://127.0.0.1:${deadPort}/some-package`);
      expect(res.status).toBe(502);
    } finally {
      deadServer.close();
    }
  });
});
