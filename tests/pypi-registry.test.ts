import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { openDatabase } from "../src/store/db.js";
import { InProcessBus } from "../src/bus/in-process.js";
import { createPyPIRegistryApp } from "../src/registries/pypi/server.js";
import { loadAlerts, loadInteractions } from "../src/store/checkpoint.js";
import type { CanaryPackage, CanaryToken } from "../src/types.js";

describe("PyPI canary registry", () => {
  let testDir: string;
  let db: ReturnType<typeof openDatabase>;
  let bus: InstanceType<typeof InProcessBus>;
  let server: ReturnType<typeof serve>;
  let port: number;
  const runId = "pypi-test-run";

  beforeAll(async () => {
    testDir = join(tmpdir(), `yokai-pypi-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = openDatabase(join(testDir, "pypi.sqlite3"));
    bus = new InProcessBus();
    port = 19900 + Math.floor(Math.random() * 1000);

    const pkg: CanaryPackage = {
      name: "internal-utils",
      version: "0.0.1-canary",
      description: "Internal utility",
      tokenId: "tok-pypi-1",
      createdAt: new Date().toISOString(),
    };

    const token: CanaryToken = {
      id: "tok-pypi-1",
      packageName: "internal-utils",
      callbackUrl: `http://localhost:${port}/_yokai/callback/tok-pypi-1`,
      createdAt: new Date().toISOString(),
      type: "postinstall",
    };

    const packagesMap = new Map<string, CanaryPackage>();
    packagesMap.set("internal-utils", pkg);

    const tokensMap = new Map<string, CanaryToken>();
    tokensMap.set("tok-pypi-1", token);

    const app = createPyPIRegistryApp({
      db, bus, runId,
      packages: packagesMap,
      tokens: tokensMap,
      callbackBaseUrl: `http://localhost:${port}`,
    });

    server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/_yokai/health`);
        if (res.ok) break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  afterAll(async () => {
    server?.close();
    await bus.close();
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("health check returns ok with pypi protocol", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/_yokai/health`);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.protocol).toBe("pypi");
  });

  it("GET /simple/ returns package index", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/simple/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("internal-utils");
    expect(html).toContain("Simple Index");
  });

  it("GET /simple/<pkg>/ returns version page with download link", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/simple/internal-utils/`, {
      headers: { "User-Agent": "pip/23.0" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("internal-utils-0.0.1-canary.tar.gz");
    expect(html).toContain("sha256=");

    // Should create an alert
    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.packageName === "internal-utils")).toBe(true);
  });

  it("GET /simple/<unknown>/ returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/simple/nonexistent/`);
    expect(res.status).toBe(404);
  });

  it("GET /packages/<pkg>/<file> records download alert", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/packages/internal-utils/internal-utils-0.0.1-canary.tar.gz`, {
      headers: { "User-Agent": "pip/23.0" },
    });
    expect(res.status).toBe(200);

    const alerts = loadAlerts(db, runId);
    const dlAlert = alerts.find((a) => a.alertType === "canary-download");
    expect(dlAlert).toBeDefined();
  });

  it("POST / (twine upload) creates unauthorized-publish alert", async () => {
    const formData = new FormData();
    formData.set("name", "internal-utils");
    formData.set("version", "1.0.0");

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      body: formData,
      headers: { "User-Agent": "twine/4.0" },
    });
    expect(res.status).toBe(403);

    const alerts = loadAlerts(db, runId);
    const pubAlert = alerts.find((a) => a.alertType === "unauthorized-publish");
    expect(pubAlert).toBeDefined();
  });
});
