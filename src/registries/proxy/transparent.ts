import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { MessageBus } from "../../bus/types.js";
import type { CanaryPackage, CanaryToken, RegistryInteraction } from "../../types.js";
import { saveInteraction, saveAlert } from "../../store/checkpoint.js";
import { classifyAlert } from "../../detection/alert-engine.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ stage: "registry-proxy" });

export interface TransparentProxyOptions {
  db: Database.Database;
  bus: MessageBus;
  runId: string;
  /** Package names to intercept (serve canary instead of forwarding). */
  interceptedPackages: Map<string, CanaryPackage>;
  tokens: Map<string, CanaryToken>;
  /** Upstream registry URL (e.g., https://registry.npmjs.org). */
  upstreamUrl: string;
  callbackBaseUrl: string;
  /** Timeout for upstream requests in ms. */
  upstreamTimeoutMs?: number;
}

/**
 * Transparent registry proxy that sits between CI/CD and a public registry.
 *
 * Modes:
 * - **Passthrough**: forwards legitimate requests upstream and returns the response
 * - **Interception**: serves canary metadata for monitored internal names
 * - **Alerting**: logs all resolution attempts and alerts on intercepted names
 */
export function createTransparentProxy(opts: TransparentProxyOptions): Hono {
  const {
    db, bus, runId,
    interceptedPackages, tokens,
    upstreamUrl, callbackBaseUrl,
    upstreamTimeoutMs = 15_000,
  } = opts;

  const app = new Hono();

  // Health check
  app.get("/_yokai/health", (c) => {
    return c.json({
      status: "ok",
      mode: "proxy",
      upstream: upstreamUrl,
      intercepted: interceptedPackages.size,
    });
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

    recordInteraction(db, runId, "POST", `/_yokai/callback/${tokenId}`, sourceIp, userAgent, token.packageName, tokenId);

    const alert = classifyAlert({
      runId, tokenId,
      packageName: token.packageName,
      sourceIp, userAgent,
      method: "POST",
      path: `/_yokai/callback/${tokenId}`,
      metadata: body,
    });
    saveAlert(db, alert);
    emitAlert(bus, runId, alert);

    return c.json({ status: "recorded", alertId: alert.id });
  });

  // Catch-all: proxy or intercept
  app.all("/*", async (c) => {
    const path = c.req.path;
    const method = c.req.method;
    const sourceIp = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";

    // Extract package name from path
    const packageName = extractPackageName(path);

    // Record all interactions
    recordInteraction(db, runId, method, path, sourceIp, userAgent, packageName);

    // Check if this is an intercepted package
    if (packageName && interceptedPackages.has(packageName)) {
      log.warn(`Intercepted request for monitored package: ${packageName} from ${sourceIp}`);

      const canary = interceptedPackages.get(packageName)!;

      // Alert on interception
      const alert = classifyAlert({
        runId,
        packageName,
        sourceIp,
        userAgent,
        method,
        path,
        metadata: { action: "proxy-intercept", upstream: upstreamUrl },
      });
      saveAlert(db, alert);
      emitAlert(bus, runId, alert);

      // Serve canary metadata instead of forwarding
      if (method === "GET" && !path.includes("/-/")) {
        return c.json(buildNpmMetadata(canary, callbackBaseUrl));
      }

      // Publish attempt on intercepted package
      if (method === "PUT") {
        const pubAlert = classifyAlert({
          runId,
          packageName,
          sourceIp,
          userAgent,
          method: "PUT",
          path,
          metadata: { action: "publish-attempt", proxy: true },
        });
        saveAlert(db, pubAlert);
        emitAlert(bus, runId, pubAlert);
        return c.json({ error: "Forbidden" }, 403);
      }
    }

    // Passthrough: forward to upstream
    try {
      const upstreamPath = new URL(path, upstreamUrl).toString();
      log.debug(`Proxying ${method} ${path} → ${upstreamPath}`);

      const headers = new Headers();
      // Forward select headers
      const acceptHeader = c.req.header("accept");
      if (acceptHeader) headers.set("accept", acceptHeader);
      const authHeader = c.req.header("authorization");
      if (authHeader) headers.set("authorization", authHeader);

      const upstreamResponse = await fetch(upstreamPath, {
        method,
        headers,
        body: method !== "GET" && method !== "HEAD" ? c.req.raw.body : undefined,
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      });

      // Forward the upstream response
      const responseHeaders: Record<string, string> = {};
      upstreamResponse.headers.forEach((value, key) => {
        if (!["transfer-encoding", "connection"].includes(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      });

      const body = await upstreamResponse.arrayBuffer();
      return c.body(body, upstreamResponse.status as any, responseHeaders);
    } catch (err) {
      log.warn(`Upstream request failed for ${path}: ${err}`);
      return c.json({ error: "Upstream unavailable" }, 502);
    }
  });

  return app;
}

function extractPackageName(path: string): string | undefined {
  // npm: /@scope/name or /name
  const cleaned = path.replace(/^\/?/, "");
  if (!cleaned || cleaned.startsWith("_yokai")) return undefined;

  // Scoped: @scope/name or @scope/name/-/tarball
  const scopedMatch = cleaned.match(/^(@[^/]+\/[^/]+)/);
  if (scopedMatch) return scopedMatch[1];

  // Unscoped: name or name/-/tarball
  const unscopedMatch = cleaned.match(/^([^/]+)/);
  if (unscopedMatch && !unscopedMatch[1].startsWith("-")) return unscopedMatch[1];

  return undefined;
}

function buildNpmMetadata(canary: CanaryPackage, callbackBaseUrl: string): Record<string, unknown> {
  return {
    _id: canary.name,
    _rev: "1-0",
    name: canary.name,
    description: canary.description,
    "dist-tags": { latest: canary.version },
    versions: {
      [canary.version]: {
        name: canary.name,
        version: canary.version,
        description: canary.description,
        main: "index.js",
        scripts: { postinstall: "node .yokai-canary.js" },
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
}

function recordInteraction(
  db: Database.Database,
  runId: string,
  method: string,
  path: string,
  sourceIp: string,
  userAgent: string,
  packageName?: string,
  tokenId?: string,
): void {
  saveInteraction(db, {
    id: crypto.randomUUID(),
    runId,
    method,
    path,
    sourceIp,
    userAgent,
    packageName,
    tokenId,
    createdAt: new Date().toISOString(),
  });
}

function emitAlert(bus: MessageBus, runId: string, alert: { id: string; alertType: string; severity: string; packageName?: string; sourceIp?: string }) {
  bus.publish({
    type: "alert:triggered",
    meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId },
    payload: {
      alertId: alert.id,
      alertType: alert.alertType,
      severity: alert.severity,
      packageName: alert.packageName,
      sourceIp: alert.sourceIp,
    },
  }).catch(() => {});
}
