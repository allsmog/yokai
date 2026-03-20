import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { MessageBus } from "../../bus/types.js";
import type { CanaryPackage, CanaryToken, RegistryInteraction } from "../../types.js";
import { saveInteraction, findCanaryTokenById, saveAlert } from "../../store/checkpoint.js";
import { classifyAlert } from "../../detection/alert-engine.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ stage: "npm-registry" });

export interface NpmRegistryOptions {
  db: Database.Database;
  bus: MessageBus;
  runId: string;
  packages: Map<string, CanaryPackage>;
  tokens: Map<string, CanaryToken>;
  callbackBaseUrl: string;
}

/**
 * Create a Hono app implementing the npm registry protocol for canary packages.
 *
 * Supported endpoints:
 * - GET /:pkg          — Package metadata (triggers canary on resolve)
 * - GET /:pkg/-/:file  — Tarball download (triggers canary on download)
 * - PUT /:pkg          — Publish detection (unauthorized publish alert)
 * - POST /_yokai/callback/:tokenId — Canary callback endpoint
 */
export function createNpmRegistryApp(opts: NpmRegistryOptions): Hono {
  const { db, bus, runId, packages, tokens, callbackBaseUrl } = opts;
  const app = new Hono();

  // Health check
  app.get("/_yokai/health", (c) => {
    return c.json({ status: "ok", packages: packages.size, tokens: tokens.size });
  });

  // Canary callback endpoint
  app.post("/_yokai/callback/:tokenId", async (c) => {
    const tokenId = c.req.param("tokenId");
    const sourceIp = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body is fine
    }

    log.info(`Canary callback received: token=${tokenId} ip=${sourceIp}`);

    const token = tokens.get(tokenId) ?? findCanaryTokenById(db, tokenId);
    if (!token) {
      return c.json({ error: "Unknown token" }, 404);
    }

    // Record interaction
    const interaction: RegistryInteraction = {
      id: crypto.randomUUID(),
      runId,
      method: "POST",
      path: `/_yokai/callback/${tokenId}`,
      sourceIp,
      userAgent,
      packageName: token.packageName,
      tokenId,
      createdAt: new Date().toISOString(),
    };
    saveInteraction(db, interaction);

    // Create alert
    const alert = classifyAlert({
      runId,
      tokenId,
      packageName: token.packageName,
      sourceIp,
      userAgent,
      method: "POST",
      path: `/_yokai/callback/${tokenId}`,
      metadata: body,
    });
    saveAlert(db, alert);

    try {
      await bus.publish({
        type: "alert:triggered",
        meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId },
        payload: {
          alertId: alert.id,
          alertType: alert.alertType,
          severity: alert.severity,
          packageName: token.packageName,
          sourceIp,
        },
      });
    } catch {
      // Non-fatal
    }

    log.warn(`ALERT [${alert.severity}] ${alert.alertType}: ${alert.title} (ip=${sourceIp})`);

    return c.json({ status: "recorded", alertId: alert.id });
  });

  // GET /:pkg — Package metadata
  app.get("/:pkg{@[^/]+/[^/]+}", (c) => {
    const pkgName = c.req.param("pkg");
    return handleMetadataRequest(c, pkgName, db, bus, runId, packages, callbackBaseUrl);
  });

  app.get("/:pkg{[^@][^/]*}", (c) => {
    const pkgName = c.req.param("pkg");
    return handleMetadataRequest(c, pkgName, db, bus, runId, packages, callbackBaseUrl);
  });

  // GET /:pkg/-/:file — Tarball download
  app.get("/:pkg{@[^/]+/[^/]+}/-/:file", (c) => {
    const pkgName = c.req.param("pkg");
    return handleTarballRequest(c, pkgName, db, bus, runId, packages);
  });

  app.get("/:pkg{[^@][^/]*}/-/:file", (c) => {
    const pkgName = c.req.param("pkg");
    return handleTarballRequest(c, pkgName, db, bus, runId, packages);
  });

  // PUT /:pkg — Publish detection
  app.put("/:pkg{@[^/]+/[^/]+}", (c) => {
    return handlePublishRequest(c, c.req.param("pkg"), db, bus, runId);
  });

  app.put("/:pkg{[^@][^/]*}", (c) => {
    return handlePublishRequest(c, c.req.param("pkg"), db, bus, runId);
  });

  return app;
}

function handleMetadataRequest(
  c: any,
  pkgName: string,
  db: Database.Database,
  bus: MessageBus,
  runId: string,
  packages: Map<string, CanaryPackage>,
  callbackBaseUrl: string,
) {
  const sourceIp = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
  const userAgent = c.req.header("user-agent") ?? "";

  log.info(`Metadata request: ${pkgName} from ${sourceIp}`);

  // Record interaction
  const interaction: RegistryInteraction = {
    id: crypto.randomUUID(),
    runId,
    method: "GET",
    path: `/${pkgName}`,
    sourceIp,
    userAgent,
    packageName: pkgName,
    createdAt: new Date().toISOString(),
  };
  saveInteraction(db, interaction);

  const canary = packages.get(pkgName);
  if (!canary) {
    // Return a synthetic 404 that still looks like npm
    return c.json({ error: "Not found" }, 404);
  }

  // Return npm-compatible metadata
  const metadata = {
    _id: canary.name,
    _rev: "1-0",
    name: canary.name,
    description: canary.description,
    "dist-tags": {
      latest: canary.version,
    },
    versions: {
      [canary.version]: {
        name: canary.name,
        version: canary.version,
        description: canary.description,
        main: "index.js",
        scripts: {
          postinstall: "node .yokai-canary.js",
        },
        dist: {
          tarball: `${callbackBaseUrl}/${canary.name}/-/${canary.name}-${canary.version}.tgz`,
          shasum: "0000000000000000000000000000000000000000",
        },
      },
    },
    time: {
      created: canary.createdAt,
      modified: canary.createdAt,
      [canary.version]: canary.createdAt,
    },
  };

  // Trigger namespace probe alert
  const alert = classifyAlert({
    runId,
    packageName: pkgName,
    sourceIp,
    userAgent,
    method: "GET",
    path: `/${pkgName}`,
    metadata: { action: "metadata-resolve" },
  });
  saveAlert(db, alert);

  bus.publish({
    type: "registry:request",
    meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId },
    payload: { method: "GET", path: `/${pkgName}`, sourceIp, userAgent },
  }).catch(() => {});

  return c.json(metadata);
}

function handleTarballRequest(
  c: any,
  pkgName: string,
  db: Database.Database,
  bus: MessageBus,
  runId: string,
  packages: Map<string, CanaryPackage>,
) {
  const sourceIp = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
  const userAgent = c.req.header("user-agent") ?? "";

  log.warn(`Tarball download: ${pkgName} from ${sourceIp}`);

  const interaction: RegistryInteraction = {
    id: crypto.randomUUID(),
    runId,
    method: "GET",
    path: c.req.path,
    sourceIp,
    userAgent,
    packageName: pkgName,
    createdAt: new Date().toISOString(),
  };
  saveInteraction(db, interaction);

  const alert = classifyAlert({
    runId,
    packageName: pkgName,
    sourceIp,
    userAgent,
    method: "GET",
    path: c.req.path,
    metadata: { action: "tarball-download" },
  });
  saveAlert(db, alert);

  bus.publish({
    type: "alert:triggered",
    meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId },
    payload: {
      alertId: alert.id,
      alertType: alert.alertType,
      severity: alert.severity,
      packageName: pkgName,
      sourceIp,
    },
  }).catch(() => {});

  const canary = packages.get(pkgName);
  if (!canary) {
    return c.json({ error: "Not found" }, 404);
  }

  // Return a minimal valid tarball placeholder (real impl would pack the dir)
  return c.body("", 200, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${pkgName}-${canary.version}.tgz"`,
  });
}

function handlePublishRequest(
  c: any,
  pkgName: string,
  db: Database.Database,
  bus: MessageBus,
  runId: string,
) {
  const sourceIp = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
  const userAgent = c.req.header("user-agent") ?? "";

  log.warn(`Publish attempt detected: ${pkgName} from ${sourceIp}`);

  const interaction: RegistryInteraction = {
    id: crypto.randomUUID(),
    runId,
    method: "PUT",
    path: `/${pkgName}`,
    sourceIp,
    userAgent,
    packageName: pkgName,
    createdAt: new Date().toISOString(),
  };
  saveInteraction(db, interaction);

  const alert = classifyAlert({
    runId,
    packageName: pkgName,
    sourceIp,
    userAgent,
    method: "PUT",
    path: `/${pkgName}`,
    metadata: { action: "publish-attempt" },
  });
  saveAlert(db, alert);

  bus.publish({
    type: "alert:triggered",
    meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId },
    payload: {
      alertId: alert.id,
      alertType: alert.alertType,
      severity: alert.severity,
      packageName: pkgName,
      sourceIp,
    },
  }).catch(() => {});

  return c.json({ error: "Forbidden" }, 403);
}
