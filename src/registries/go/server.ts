import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { MessageBus } from "../../bus/types.js";
import type { CanaryPackage, CanaryToken } from "../../types.js";
import { saveInteraction, saveAlert } from "../../store/checkpoint.js";
import { classifyAlert } from "../../detection/alert-engine.js";
import { withBaselineMetadata } from "../../detection/baseline.js";
import { maybeEmitCredentialProbe } from "../../detection/emit.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ stage: "go-registry" });

export interface GoRegistryOptions {
  db: Database.Database;
  bus: MessageBus;
  runId: string;
  /** Map of module path → CanaryPackage (e.g., "github.com/myorg/internal-lib") */
  modules: Map<string, CanaryPackage>;
  tokens: Map<string, CanaryToken>;
  callbackBaseUrl: string;
}

/**
 * Hono app implementing Go Module Proxy protocol (GOPROXY) for canary modules.
 *
 * Endpoints (per https://go.dev/ref/mod#goproxy-protocol):
 * - GET /<module>/@v/list           — list available versions
 * - GET /<module>/@v/<version>.info — version metadata JSON
 * - GET /<module>/@v/<version>.mod  — go.mod file
 * - GET /<module>/@v/<version>.zip  — module source zip
 * - GET /<module>/@latest           — latest version info
 */
export function createGoRegistryApp(opts: GoRegistryOptions): Hono {
  const { db, bus, runId, modules, tokens, callbackBaseUrl } = opts;
  const app = new Hono();

  app.get("/_yokai/health", (c) => {
    return c.json({ status: "ok", protocol: "go", modules: modules.size });
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

  // Catch-all GET for Go module proxy paths
  app.get("/*", (c) => {
    const path = c.req.path;
    if (path.startsWith("/_yokai/")) return undefined as any;
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    const authorizationHeader = c.req.header("authorization");

    // /@v/list
    if (path.endsWith("/@v/list")) {
      const modulePath = extractModulePath(path, "/@v/list");
      log.info(`Go version list: ${modulePath} from ${sourceIp}`);
      record(db, runId, "GET", path, sourceIp, userAgent, modulePath);
      maybeEmitCredentialProbe({
        db,
        bus,
        runId,
        method: "GET",
        path,
        sourceIp,
        userAgent,
        packageName: modulePath,
        authorizationHeader,
        metadata: { protocol: "go" },
      });
      const canary = findModule(modules, modulePath);
      if (!canary) return c.text("not found", 404);
      alertAndEmit(db, bus, runId, modulePath, sourceIp, userAgent, path, "metadata-resolve");
      return c.text(canary.version + "\n");
    }

    // /@v/<version>.info
    const infoMatch = path.match(/\/@v\/(.+)\.info$/);
    if (infoMatch) {
      const version = infoMatch[1];
      const modulePath = extractModulePath(path, `/@v/${version}.info`);
      log.info(`Go version info: ${modulePath}@${version} from ${sourceIp}`);
      record(db, runId, "GET", path, sourceIp, userAgent, modulePath);
      maybeEmitCredentialProbe({
        db,
        bus,
        runId,
        method: "GET",
        path,
        sourceIp,
        userAgent,
        packageName: modulePath,
        authorizationHeader,
        metadata: { protocol: "go" },
      });
      const canary = findModule(modules, modulePath);
      if (!canary) return c.text("not found", 404);
      alertAndEmit(db, bus, runId, modulePath, sourceIp, userAgent, path, "metadata-resolve");
      return c.json({ Version: canary.version, Time: canary.createdAt });
    }

    // /@v/<version>.mod
    const modMatch = path.match(/\/@v\/(.+)\.mod$/);
    if (modMatch) {
      const version = modMatch[1];
      const modulePath = extractModulePath(path, `/@v/${version}.mod`);
      log.info(`Go mod request: ${modulePath}@${version} from ${sourceIp}`);
      record(db, runId, "GET", path, sourceIp, userAgent, modulePath);
      maybeEmitCredentialProbe({
        db,
        bus,
        runId,
        method: "GET",
        path,
        sourceIp,
        userAgent,
        packageName: modulePath,
        authorizationHeader,
        metadata: { protocol: "go" },
      });
      const canary = findModule(modules, modulePath);
      if (!canary) return c.text("not found", 404);
      alertAndEmit(db, bus, runId, modulePath, sourceIp, userAgent, path, "metadata-resolve");
      return c.text(`module ${modulePath}\n\ngo 1.21\n`);
    }

    // /@v/<version>.zip
    const zipMatch = path.match(/\/@v\/(.+)\.zip$/);
    if (zipMatch) {
      const version = zipMatch[1];
      const modulePath = extractModulePath(path, `/@v/${version}.zip`);
      log.warn(`Go module download: ${modulePath}@${version} from ${sourceIp}`);
      record(db, runId, "GET", path, sourceIp, userAgent, modulePath);
      maybeEmitCredentialProbe({
        db,
        bus,
        runId,
        method: "GET",
        path,
        sourceIp,
        userAgent,
        packageName: modulePath,
        authorizationHeader,
        metadata: { protocol: "go" },
      });
      alertAndEmit(db, bus, runId, modulePath, sourceIp, userAgent, path, "tarball-download");
      return c.body("", 200, { "Content-Type": "application/zip" });
    }

    // /@latest
    if (path.endsWith("/@latest")) {
      const modulePath = extractModulePath(path, "/@latest");
      log.info(`Go latest request: ${modulePath} from ${sourceIp}`);
      record(db, runId, "GET", path, sourceIp, userAgent, modulePath);
      maybeEmitCredentialProbe({
        db,
        bus,
        runId,
        method: "GET",
        path,
        sourceIp,
        userAgent,
        packageName: modulePath,
        authorizationHeader,
        metadata: { protocol: "go" },
      });
      const canary = findModule(modules, modulePath);
      if (!canary) return c.text("not found", 404);
      alertAndEmit(db, bus, runId, modulePath, sourceIp, userAgent, path, "metadata-resolve");
      return c.json({ Version: canary.version, Time: canary.createdAt });
    }

    return c.text("not found", 404);
  });

  return app;
}

function extractModulePath(fullPath: string, suffix: string): string {
  const idx = fullPath.indexOf(suffix);
  if (idx === -1) return fullPath.replace(/^\//, "");
  return fullPath.slice(1, idx); // Remove leading /
}

function findModule(modules: Map<string, CanaryPackage>, query: string): CanaryPackage | undefined {
  // Direct lookup
  const direct = modules.get(query);
  if (direct) return direct;

  // Case-insensitive (Go module paths are case-sensitive but proxies may uppercase-encode)
  const decoded = query.replace(/![a-z]/g, (m) => m[1].toUpperCase());
  return modules.get(decoded);
}

function alertAndEmit(db: Database.Database, bus: MessageBus, runId: string, packageName: string, sourceIp: string, userAgent: string, path: string, action: string) {
  const alert = classifyAlert({
    runId,
    packageName,
    sourceIp,
    userAgent,
    method: "GET",
    path,
    metadata: withBaselineMetadata(db, runId, {
      protocol: "go",
      method: "GET",
      path,
      packageName,
    }, { action, protocol: "go" }),
  });
  saveAlert(db, alert);
  emit(bus, runId, alert);
}

function record(db: Database.Database, runId: string, method: string, path: string, sourceIp: string, userAgent: string, packageName?: string, tokenId?: string) {
  saveInteraction(db, { id: crypto.randomUUID(), runId, method, path, sourceIp, userAgent, packageName, tokenId, createdAt: new Date().toISOString() });
}

function emit(bus: MessageBus, runId: string, alert: { id: string; alertType: string; severity: string; packageName?: string; sourceIp?: string }) {
  bus.publish({ type: "alert:triggered", meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId }, payload: { alertId: alert.id, alertType: alert.alertType, severity: alert.severity, packageName: alert.packageName, sourceIp: alert.sourceIp } }).catch(() => {});
}
