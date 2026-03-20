import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { openDatabase } from "../src/store/db.js";
import { InProcessBus } from "../src/bus/in-process.js";
import { createNpmRegistryApp } from "../src/registries/npm/server.js";
import { createCanaryToken } from "../src/canary/token.js";
import { buildCanaryPackage } from "../src/canary/package-builder.js";
import { saveCanaryToken, loadAlerts, loadInteractions } from "../src/store/checkpoint.js";
import type { CanaryPackage, CanaryToken } from "../src/types.js";

describe("E2E: npm canary registry", () => {
  let testDir: string;
  let db: ReturnType<typeof openDatabase>;
  let bus: InstanceType<typeof InProcessBus>;
  let server: ReturnType<typeof serve>;
  let port: number;
  const runId = "e2e-test-run";

  beforeAll(async () => {
    testDir = join(tmpdir(), `yokai-e2e-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = openDatabase(join(testDir, "e2e.sqlite3"));
    bus = new InProcessBus();

    // Create canary packages
    const token = createCanaryToken("@testorg/internal-utils", "http://localhost:0");
    const canaryDir = join(testDir, "canaries");
    mkdirSync(canaryDir, { recursive: true });
    const pkg = buildCanaryPackage(token, canaryDir);

    // Use a random port
    port = 19873 + Math.floor(Math.random() * 1000);
    const callbackBaseUrl = `http://localhost:${port}`;

    // Update token with actual port
    const finalToken: CanaryToken = { ...token, callbackUrl: `${callbackBaseUrl}/_yokai/callback/${token.id}` };
    saveCanaryToken(db, { ...finalToken, runId });

    const packagesMap = new Map<string, CanaryPackage>();
    packagesMap.set(pkg.name, pkg);

    const tokensMap = new Map<string, CanaryToken>();
    tokensMap.set(finalToken.id, finalToken);

    const app = createNpmRegistryApp({
      db, bus, runId,
      packages: packagesMap,
      tokens: tokensMap,
      callbackBaseUrl,
    });

    server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

    // Wait for server to be ready
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

  it("health check returns ok", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/_yokai/health`);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.packages).toBe(1);
  });

  it("GET /<package> returns metadata and creates interaction + alert", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/@testorg/internal-utils`, {
      headers: { "User-Agent": "npm/9.0.0" },
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.name).toBe("@testorg/internal-utils");
    expect(body["dist-tags"]).toBeDefined();

    // Verify interaction was recorded
    const interactions = loadInteractions(db, runId);
    expect(interactions.some((i) => i.path === "/@testorg/internal-utils")).toBe(true);

    // Verify alert was created
    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.packageName === "@testorg/internal-utils")).toBe(true);
  });

  it("tarball URL from metadata is fetchable", async () => {
    const metaRes = await fetch(`http://127.0.0.1:${port}/@testorg/internal-utils`);
    const meta = await metaRes.json() as any;
    const tarballUrl = meta.versions["0.0.1-canary"].dist.tarball;

    // Tarball filename should NOT include the scope for scoped packages
    expect(tarballUrl).toContain("/internal-utils-0.0.1-canary.tgz");
    expect(tarballUrl).not.toContain("/@testorg/internal-utils-0.0.1-canary.tgz");

    // Replace host since metadata uses callbackBaseUrl
    const fixedUrl = tarballUrl.replace(/http:\/\/localhost:\d+/, `http://127.0.0.1:${port}`);
    const res = await fetch(fixedUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("GET unknown package returns 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nonexistent-pkg`);
    expect(res.status).toBe(404);
  });

  it("PUT /<package> creates unauthorized-publish alert", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/@testorg/internal-utils`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "User-Agent": "npm/9.0.0" },
      body: JSON.stringify({ name: "@testorg/internal-utils" }),
    });

    expect(res.status).toBe(403);

    const alerts = loadAlerts(db, runId);
    const publishAlert = alerts.find((a) => a.alertType === "unauthorized-publish");
    expect(publishAlert).toBeDefined();
    expect(publishAlert!.severity).toBe("critical");
  });

  it("POST callback creates canary-download alert", async () => {
    // Find the token ID
    const interactions = loadInteractions(db, runId);
    const tokens = db.prepare("SELECT id FROM canary_tokens WHERE run_id = ?").all(runId) as Array<{ id: string }>;
    const tokenId = tokens[0]?.id;
    expect(tokenId).toBeDefined();

    const res = await fetch(`http://127.0.0.1:${port}/_yokai/callback/${tokenId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "node/18" },
      body: JSON.stringify({
        tokenId,
        hostname: "build-server-01",
        platform: "linux",
        ci: "true",
        githubActions: "true",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.alertId).toBeDefined();

    // Since CI env vars are present, this should be dependency-confusion
    const alerts = loadAlerts(db, runId);
    const dcAlert = alerts.find((a) => a.alertType === "dependency-confusion");
    expect(dcAlert).toBeDefined();
    expect(dcAlert!.severity).toBe("critical");
    expect(dcAlert!.mitre.techniqueId).toBe("T1195.002");
  });

  it("alerts have MITRE ATT&CK mappings", async () => {
    const alerts = loadAlerts(db, runId);
    for (const alert of alerts) {
      expect(alert.mitre).toBeDefined();
      expect(alert.mitre.techniqueId).toBeTruthy();
      expect(alert.mitre.techniqueName).toBeTruthy();
      expect(alert.mitre.tactic).toBeTruthy();
    }
  });
});
