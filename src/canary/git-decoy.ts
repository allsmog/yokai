import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { MessageBus } from "../bus/types.js";
import { saveInteraction, saveAlert } from "../store/checkpoint.js";
import { classifyAlert } from "../detection/alert-engine.js";
import { createLogger } from "../logger.js";

const log = createLogger({ stage: "git-decoy" });

export interface GitDecoyOptions {
  db: Database.Database;
  bus: MessageBus;
  runId: string;
  /** Fake repository names to serve (e.g., "internal-deploy-scripts") */
  repoNames: string[];
  callbackBaseUrl: string;
}

/**
 * Fake Git smart HTTP endpoints that look like internal repos but log all
 * clone/fetch attempts.
 *
 * Implements enough of the Git smart HTTP protocol to be discovered:
 * - GET /<repo>.git/info/refs?service=git-upload-pack  — ref advertisement
 * - POST /<repo>.git/git-upload-pack                    — pack negotiation
 * - GET /<repo>.git/HEAD                                — HEAD reference
 * - GET /<repo>.git/info/refs (dumb protocol)           — ref listing
 */
export function createGitDecoyApp(opts: GitDecoyOptions): Hono {
  const { db, bus, runId, repoNames, callbackBaseUrl } = opts;
  const repoSet = new Set(repoNames);
  const app = new Hono();

  app.get("/_yokai/health", (c) => {
    return c.json({ status: "ok", protocol: "git", repos: repoNames.length });
  });

  // Canary callback
  app.post("/_yokai/callback/:tokenId", async (c) => {
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    let body: Record<string, unknown> = {};
    try { body = await c.req.json(); } catch {}

    record(db, runId, "POST", c.req.path, sourceIp, userAgent);
    const alert = classifyAlert({ runId, sourceIp, userAgent, method: "POST", path: c.req.path, metadata: body });
    saveAlert(db, alert);
    emit(bus, runId, alert);
    return c.json({ status: "recorded" });
  });

  // GET /<repo>.git/info/refs?service=git-upload-pack — Smart HTTP ref advertisement
  app.get("/:repo{.+\\.git}/info/refs", (c) => {
    const repoParam = c.req.param("repo").replace(/\.git$/, "");
    const service = c.req.query("service");
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";

    log.warn(`Git ref discovery: ${repoParam} from ${sourceIp} (service: ${service})`);
    record(db, runId, "GET", c.req.path, sourceIp, userAgent, repoParam);

    const alert = classifyAlert({
      runId,
      packageName: repoParam,
      sourceIp,
      userAgent,
      method: "GET",
      path: c.req.path,
      metadata: { action: "metadata-resolve", protocol: "git", service },
    });
    saveAlert(db, alert);
    emit(bus, runId, alert);

    if (!repoSet.has(repoParam)) {
      return c.text("Repository not found", 404);
    }

    if (service === "git-upload-pack") {
      // Smart HTTP response: advertise a fake ref
      const fakeCommit = "0000000000000000000000000000000000000001";
      const refLine = `${fakeCommit} refs/heads/main\n`;
      const capabilities = "multi_ack thin-pack side-band side-band-64k ofs-delta shallow deepen-since deepen-not deepen-relative";
      const firstLine = `${fakeCommit} HEAD\0${capabilities}\n`;

      const body = pktLine(`# service=git-upload-pack\n`) +
        "0000" +
        pktLine(firstLine) +
        pktLine(refLine) +
        "0000";

      return c.body(body, 200, {
        "Content-Type": "application/x-git-upload-pack-advertisement",
        "Cache-Control": "no-cache",
      });
    }

    // Dumb protocol fallback
    const fakeCommit = "0000000000000000000000000000000000000001";
    return c.text(`${fakeCommit}\trefs/heads/main\n`, 200, {
      "Content-Type": "text/plain",
    });
  });

  // POST /<repo>.git/git-upload-pack — Pack negotiation (clone/fetch)
  app.post("/:repo{.+\\.git}/git-upload-pack", (c) => {
    const repoParam = c.req.param("repo").replace(/\.git$/, "");
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";

    log.warn(`Git clone/fetch attempt: ${repoParam} from ${sourceIp}`);
    record(db, runId, "POST", c.req.path, sourceIp, userAgent, repoParam);

    const alert = classifyAlert({
      runId,
      packageName: repoParam,
      sourceIp,
      userAgent,
      method: "POST",
      path: c.req.path,
      metadata: { action: "tarball-download", protocol: "git", operation: "clone-or-fetch" },
    });
    saveAlert(db, alert);
    emit(bus, runId, alert);

    // Return an empty packfile response (client will get an error but we've logged the attempt)
    return c.body("0000", 200, {
      "Content-Type": "application/x-git-upload-pack-result",
    });
  });

  // GET /<repo>.git/HEAD
  app.get("/:repo{.+\\.git}/HEAD", (c) => {
    const repoParam = c.req.param("repo").replace(/\.git$/, "");
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";

    log.info(`Git HEAD request: ${repoParam} from ${sourceIp}`);
    record(db, runId, "GET", c.req.path, sourceIp, userAgent, repoParam);

    alertAndEmit(db, bus, runId, repoParam, sourceIp, userAgent, c.req.path, "metadata-resolve");

    if (!repoSet.has(repoParam)) {
      return c.text("Not found", 404);
    }

    return c.text("ref: refs/heads/main\n");
  });

  // GET /<repo>.git/objects/* — Object requests (dumb protocol)
  app.get("/:repo{.+\\.git}/objects/*", (c) => {
    const repoParam = c.req.param("repo").replace(/\.git$/, "");
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";

    log.warn(`Git object request: ${repoParam} from ${sourceIp} path=${c.req.path}`);
    record(db, runId, "GET", c.req.path, sourceIp, userAgent, repoParam);

    alertAndEmit(db, bus, runId, repoParam, sourceIp, userAgent, c.req.path, "tarball-download");

    return c.text("Not found", 404);
  });

  // POST /<repo>.git/git-receive-pack — Push detection
  app.post("/:repo{.+\\.git}/git-receive-pack", (c) => {
    const repoParam = c.req.param("repo").replace(/\.git$/, "");
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";

    log.warn(`Git push attempt: ${repoParam} from ${sourceIp}`);
    record(db, runId, "POST", c.req.path, sourceIp, userAgent, repoParam);

    const alert = classifyAlert({
      runId,
      packageName: repoParam,
      sourceIp,
      userAgent,
      method: "PUT",
      path: c.req.path,
      metadata: { action: "publish-attempt", protocol: "git", operation: "push" },
    });
    saveAlert(db, alert);
    emit(bus, runId, alert);

    return c.text("Forbidden", 403);
  });

  return app;
}

/**
 * Format a Git pkt-line.
 */
function pktLine(data: string): string {
  const len = (data.length + 4).toString(16).padStart(4, "0");
  return len + data;
}

function alertAndEmit(db: Database.Database, bus: MessageBus, runId: string, packageName: string, sourceIp: string, userAgent: string, path: string, action: string) {
  const alert = classifyAlert({ runId, packageName, sourceIp, userAgent, method: "GET", path, metadata: { action, protocol: "git" } });
  saveAlert(db, alert);
  emit(bus, runId, alert);
}

function record(db: Database.Database, runId: string, method: string, path: string, sourceIp: string, userAgent: string, packageName?: string, tokenId?: string) {
  saveInteraction(db, { id: crypto.randomUUID(), runId, method, path, sourceIp, userAgent, packageName, tokenId, createdAt: new Date().toISOString() });
}

function emit(bus: MessageBus, runId: string, alert: { id: string; alertType: string; severity: string; packageName?: string; sourceIp?: string }) {
  bus.publish({ type: "alert:triggered", meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId }, payload: { alertId: alert.id, alertType: alert.alertType, severity: alert.severity, packageName: alert.packageName, sourceIp: alert.sourceIp } }).catch(() => {});
}
