import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { MessageBus } from "../../bus/types.js";
import type { CanaryPackage, CanaryToken } from "../../types.js";
import { saveInteraction, saveAlert } from "../../store/checkpoint.js";
import { classifyAlert } from "../../detection/alert-engine.js";
import { withBaselineMetadata } from "../../detection/baseline.js";
import { maybeEmitCredentialProbe, persistAndEmitAlert } from "../../detection/emit.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ stage: "cargo-registry" });

export interface CargoRegistryOptions {
  db: Database.Database;
  bus: MessageBus;
  runId: string;
  /** Map of crate name → CanaryPackage */
  crates: Map<string, CanaryPackage>;
  tokens: Map<string, CanaryToken>;
  callbackBaseUrl: string;
}

/**
 * Hono app implementing the Cargo registry API for canary crates.
 *
 * Cargo registries use a Git index + HTTP API. This implements the HTTP API portion:
 * - GET /api/v1/crates/<name>                    — crate metadata
 * - GET /api/v1/crates/<name>/<version>/download  — crate download
 * - PUT /api/v1/crates/new                        — publish detection
 * - GET /config.json                              — registry config (dl + api URLs)
 *
 * Index paths (for sparse registries, RFC 2789):
 * - GET /1/<name>           — single-char crate names
 * - GET /2/<name>           — two-char crate names
 * - GET /3/<first-char>/<name>  — three-char crate names
 * - GET /<first-two>/<second-two>/<name> — four+ char crate names
 */
export function createCargoRegistryApp(opts: CargoRegistryOptions): Hono {
  const { db, bus, runId, crates, tokens, callbackBaseUrl } = opts;
  const app = new Hono();

  app.get("/_yokai/health", (c) => {
    return c.json({ status: "ok", protocol: "cargo", crates: crates.size });
  });

  // Canary callback
  app.post("/_yokai/callback/:tokenId", async (c) => {
    const tokenId = c.req.param("tokenId");
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    let body: Record<string, unknown> = {};
    try { body = await c.req.json(); } catch {}

    const token = tokens.get(tokenId);
    if (!token) return c.json({ error: "Unknown token" }, 404);

    record(db, runId, "POST", `/_yokai/callback/${tokenId}`, sourceIp, userAgent, token.packageName, tokenId);
    const alert = classifyAlert({ runId, tokenId, packageName: token.packageName, sourceIp, userAgent, method: "POST", path: `/_yokai/callback/${tokenId}`, metadata: body });
    saveAlert(db, alert);
    emit(bus, runId, alert);
    return c.json({ status: "recorded", alertId: alert.id });
  });

  // GET /config.json — registry configuration
  app.get("/config.json", (c) => {
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    const authorizationHeader = c.req.header("authorization");

    record(db, runId, "GET", c.req.path, sourceIp, userAgent);
    maybeEmitCredentialProbe({
      db,
      bus,
      runId,
      method: "GET",
      path: c.req.path,
      sourceIp,
      userAgent,
      authorizationHeader,
      metadata: { protocol: "cargo" },
    });
    persistAndEmitAlert(db, bus, runId, classifyAlert({
      runId,
      sourceIp,
      userAgent,
      method: "GET",
      path: c.req.path,
      metadata: withBaselineMetadata(db, runId, {
        protocol: "cargo",
        method: "GET",
        path: c.req.path,
      }, { action: "config-access", protocol: "cargo" }),
    }));

    return c.json({
      dl: `${callbackBaseUrl}/api/v1/crates`,
      api: callbackBaseUrl,
    });
  });

  // GET /api/v1/crates/<name> — crate metadata
  app.get("/api/v1/crates/:name", (c) => {
    const name = c.req.param("name");
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    const authorizationHeader = c.req.header("authorization");

    log.info(`Cargo crate metadata: ${name} from ${sourceIp}`);
    record(db, runId, "GET", c.req.path, sourceIp, userAgent, name);
    maybeEmitCredentialProbe({
      db,
      bus,
      runId,
      method: "GET",
      path: c.req.path,
      sourceIp,
      userAgent,
      packageName: name,
      authorizationHeader,
      metadata: { protocol: "cargo" },
    });

    const canary = crates.get(name);
    if (!canary) return c.json({ errors: [{ detail: "Not found" }] }, 404);

    const alert = classifyAlert({
      runId,
      packageName: name,
      sourceIp,
      userAgent,
      method: "GET",
      path: c.req.path,
      metadata: withBaselineMetadata(db, runId, {
        protocol: "cargo",
        method: "GET",
        path: c.req.path,
        packageName: name,
      }, { action: "metadata-resolve", protocol: "cargo" }),
    });
    saveAlert(db, alert);
    emit(bus, runId, alert);

    return c.json({
      crate: {
        id: name,
        name,
        description: canary.description,
        max_version: canary.version,
        max_stable_version: canary.version,
        created_at: canary.createdAt,
        updated_at: canary.createdAt,
        downloads: 0,
      },
      versions: [
        {
          id: 1,
          crate: name,
          num: canary.version,
          dl_path: `/api/v1/crates/${name}/${canary.version}/download`,
          created_at: canary.createdAt,
          updated_at: canary.createdAt,
          yanked: false,
          license: "MIT",
        },
      ],
    });
  });

  // GET /api/v1/crates/<name>/<version>/download — crate download
  app.get("/api/v1/crates/:name/:version/download", (c) => {
    const name = c.req.param("name");
    const version = c.req.param("version");
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    const authorizationHeader = c.req.header("authorization");

    log.warn(`Cargo crate download: ${name}@${version} from ${sourceIp}`);
    record(db, runId, "GET", c.req.path, sourceIp, userAgent, name);
    maybeEmitCredentialProbe({
      db,
      bus,
      runId,
      method: "GET",
      path: c.req.path,
      sourceIp,
      userAgent,
      packageName: name,
      authorizationHeader,
      metadata: { protocol: "cargo" },
    });

    const alert = classifyAlert({
      runId,
      packageName: name,
      sourceIp,
      userAgent,
      method: "GET",
      path: c.req.path,
      metadata: withBaselineMetadata(db, runId, {
        protocol: "cargo",
        method: "GET",
        path: c.req.path,
        packageName: name,
      }, { action: "tarball-download", protocol: "cargo", version }),
    });
    saveAlert(db, alert);
    emit(bus, runId, alert);

    return c.body("", 200, { "Content-Type": "application/x-tar" });
  });

  // PUT /api/v1/crates/new — publish detection
  app.put("/api/v1/crates/new", (c) => {
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    const authorizationHeader = c.req.header("authorization");

    log.warn(`Cargo publish attempt from ${sourceIp}`);
    record(db, runId, "PUT", c.req.path, sourceIp, userAgent);
    maybeEmitCredentialProbe({
      db,
      bus,
      runId,
      method: "PUT",
      path: c.req.path,
      sourceIp,
      userAgent,
      authorizationHeader,
      metadata: { protocol: "cargo" },
    });

    const alert = classifyAlert({
      runId,
      sourceIp,
      userAgent,
      method: "PUT",
      path: c.req.path,
      metadata: withBaselineMetadata(db, runId, {
        protocol: "cargo",
        method: "PUT",
        path: c.req.path,
      }, { action: "publish-attempt", protocol: "cargo" }),
    });
    saveAlert(db, alert);
    emit(bus, runId, alert);

    return c.json({ errors: [{ detail: "Forbidden" }] }, 403);
  });

  // Sparse index: catch-all for index lookups
  app.get("/*", (c) => {
    const path = c.req.path;
    if (path.startsWith("/_yokai/") || path.startsWith("/api/") || path === "/config.json") {
      return undefined as any;
    }

    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    const authorizationHeader = c.req.header("authorization");

    // Extract crate name from sparse index path
    const crateName = extractCrateFromIndexPath(path);

    log.info(`Cargo sparse index lookup: ${crateName ?? path} from ${sourceIp}`);
    record(db, runId, "GET", path, sourceIp, userAgent, crateName);
    maybeEmitCredentialProbe({
      db,
      bus,
      runId,
      method: "GET",
      path,
      sourceIp,
      userAgent,
      packageName: crateName,
      authorizationHeader,
      metadata: { protocol: "cargo" },
    });

    if (!crateName) return c.text("", 404);

    const canary = crates.get(crateName);
    if (!canary) return c.text("", 404);

    const alert = classifyAlert({
      runId,
      packageName: crateName,
      sourceIp,
      userAgent,
      method: "GET",
      path,
      metadata: withBaselineMetadata(db, runId, {
        protocol: "cargo",
        method: "GET",
        path,
        packageName: crateName,
      }, { action: "metadata-resolve", protocol: "cargo", indexPath: true }),
    });
    saveAlert(db, alert);
    emit(bus, runId, alert);

    // Return sparse index JSON line format
    const indexLine = JSON.stringify({
      name: crateName,
      vers: canary.version,
      deps: [],
      cksum: "0".repeat(64),
      features: {},
      yanked: false,
    });
    return c.text(indexLine + "\n");
  });

  return app;
}

/**
 * Extract crate name from sparse index path.
 * Patterns: /1/a, /2/ab, /3/a/abc, /ab/cd/abcd-lib
 */
function extractCrateFromIndexPath(path: string): string | undefined {
  const parts = path.replace(/^\//, "").split("/").filter(Boolean);
  if (parts.length === 0) return undefined;

  // /1/<name> or /2/<name>
  if ((parts[0] === "1" || parts[0] === "2") && parts.length === 2) {
    return parts[1];
  }

  // /3/<first-char>/<name>
  if (parts[0] === "3" && parts.length === 3) {
    return parts[2];
  }

  // /<first-two>/<second-two>/<name>
  if (parts.length === 3 && parts[0].length === 2 && parts[1].length === 2) {
    return parts[2];
  }

  // Fallback: last segment
  return parts[parts.length - 1];
}

function record(db: Database.Database, runId: string, method: string, path: string, sourceIp: string, userAgent: string, packageName?: string, tokenId?: string) {
  saveInteraction(db, { id: crypto.randomUUID(), runId, method, path, sourceIp, userAgent, packageName, tokenId, createdAt: new Date().toISOString() });
}

function emit(bus: MessageBus, runId: string, alert: { id: string; alertType: string; severity: string; packageName?: string; sourceIp?: string }) {
  bus.publish({ type: "alert:triggered", meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId }, payload: { alertId: alert.id, alertType: alert.alertType, severity: alert.severity, packageName: alert.packageName, sourceIp: alert.sourceIp } }).catch(() => {});
}
