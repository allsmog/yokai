import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { openDatabase } from "../src/store/db.js";
import { InProcessBus } from "../src/bus/in-process.js";
import { createGitDecoyApp } from "../src/canary/git-decoy.js";
import { loadAlerts, loadInteractions } from "../src/store/checkpoint.js";

describe("Git server decoy", () => {
  let testDir: string;
  let db: ReturnType<typeof openDatabase>;
  let bus: InstanceType<typeof InProcessBus>;
  let server: ReturnType<typeof serve>;
  let port: number;
  const runId = "git-test-run";

  beforeAll(async () => {
    testDir = join(tmpdir(), `yokai-git-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    db = openDatabase(join(testDir, "git.sqlite3"));
    bus = new InProcessBus();
    port = 19500 + Math.floor(Math.random() * 1000);

    const app = createGitDecoyApp({
      db, bus, runId,
      repoNames: ["internal-deploy-scripts", "infra-secrets"],
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
    expect(body.protocol).toBe("git");
    expect(body.repos).toBe(2);
  });

  it("GET info/refs with git-upload-pack returns smart HTTP response", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal-deploy-scripts.git/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");

    const body = await res.text();
    expect(body).toContain("git-upload-pack");
    expect(body).toContain("refs/heads/main");

    // Should create an alert
    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.packageName === "internal-deploy-scripts")).toBe(true);
  });

  it("GET HEAD returns ref to main", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/infra-secrets.git/HEAD`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("ref: refs/heads/main");
  });

  it("POST git-upload-pack logs clone attempt", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal-deploy-scripts.git/git-upload-pack`, {
      method: "POST",
      body: "0000",
      headers: { "Content-Type": "application/x-git-upload-pack-request", "User-Agent": "git/2.40" },
    });
    expect(res.status).toBe(200);

    const alerts = loadAlerts(db, runId);
    const cloneAlert = alerts.find((a) =>
      a.metadata?.["operation"] === "clone-or-fetch" && a.packageName === "internal-deploy-scripts",
    );
    expect(cloneAlert).toBeDefined();
  });

  it("POST git-receive-pack returns 403 (push detection)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal-deploy-scripts.git/git-receive-pack`, {
      method: "POST",
      body: "0000",
    });
    expect(res.status).toBe(403);

    const alerts = loadAlerts(db, runId);
    expect(alerts.some((a) => a.alertType === "unauthorized-publish")).toBe(true);
  });

  it("returns 404 for unknown repos", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/nonexistent.git/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(404);
  });

  it("records interactions for all requests", async () => {
    const interactions = loadInteractions(db, runId);
    expect(interactions.length).toBeGreaterThan(0);
    expect(interactions.some((i) => i.path.includes("git-upload-pack"))).toBe(true);
  });
});
