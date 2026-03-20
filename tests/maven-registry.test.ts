import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { openDatabase } from "../src/store/db.js";
import { InProcessBus } from "../src/bus/in-process.js";
import { createMavenRegistryApp } from "../src/registries/maven/server.js";
import { loadAlerts, loadInteractions } from "../src/store/checkpoint.js";
import type { CanaryPackage, CanaryToken } from "../src/types.js";

describe("Maven canary registry", () => {
  let testDir: string;
  let db: ReturnType<typeof openDatabase>;
  let bus: InstanceType<typeof InProcessBus>;
  let server: ReturnType<typeof serve>;
  let port: number;
  const runId = "maven-test-run";

  beforeAll(async () => {
    testDir = join(tmpdir(), `yokai-maven-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = openDatabase(join(testDir, "maven.sqlite3"));
    bus = new InProcessBus();
    port = 19700 + Math.floor(Math.random() * 1000);

    const pkg: CanaryPackage = {
      name: "com.myorg:internal-lib",
      version: "0.0.1-canary",
      description: "Internal Maven canary",
      tokenId: "tok-mvn-1",
      createdAt: new Date().toISOString(),
    };

    const token: CanaryToken = {
      id: "tok-mvn-1",
      packageName: "com.myorg:internal-lib",
      callbackUrl: `http://localhost:${port}/_yokai/callback/tok-mvn-1`,
      createdAt: new Date().toISOString(),
      type: "postinstall",
    };

    const artifacts = new Map<string, CanaryPackage>();
    artifacts.set("com.myorg:internal-lib", pkg);

    const tokens = new Map<string, CanaryToken>();
    tokens.set("tok-mvn-1", token);

    const app = createMavenRegistryApp({
      db, bus, runId,
      artifacts,
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
    expect(body.protocol).toBe("maven");
    expect(body.artifacts).toBe(1);
  });

  it("GET maven-metadata.xml returns metadata and creates alert", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/com/myorg/internal-lib/maven-metadata.xml`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<groupId>com.myorg</groupId>");
    expect(xml).toContain("<artifactId>internal-lib</artifactId>");
    expect(xml).toContain("0.0.1-canary");

    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.packageName === "com.myorg:internal-lib")).toBe(true);
  });

  it("GET .pom returns POM XML", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/com/myorg/internal-lib/0.0.1-canary/internal-lib-0.0.1-canary.pom`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<groupId>com.myorg</groupId>");
  });

  it("GET .jar returns empty jar and creates download alert", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/com/myorg/internal-lib/0.0.1-canary/internal-lib-0.0.1-canary.jar`);
    expect(res.status).toBe(200);

    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.alertType === "canary-download")).toBe(true);
  });

  it("PUT creates unauthorized-publish alert", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/com/myorg/internal-lib/0.0.1/internal-lib-0.0.1.jar`, {
      method: "PUT",
      body: "fake-jar",
    });
    expect(res.status).toBe(403);

    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.alertType === "unauthorized-publish")).toBe(true);
  });
});
