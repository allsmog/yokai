import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { MessageBus } from "../../bus/types.js";
import type { CanaryPackage, CanaryToken } from "../../types.js";
import { saveInteraction, saveAlert } from "../../store/checkpoint.js";
import { classifyAlert } from "../../detection/alert-engine.js";
import { withBaselineMetadata } from "../../detection/baseline.js";
import { maybeEmitCredentialProbe } from "../../detection/emit.js";
import { createLogger } from "../../logger.js";
import { createProxyAdapter, type ProxyResponseSpec } from "./adapters.js";

const log = createLogger({ stage: "registry-proxy" });

export interface TransparentProxyOptions {
  db: Database.Database;
  bus: MessageBus;
  runId: string;
  protocol: "npm" | "pypi" | "maven" | "go" | "cargo";
  /** Package names to intercept (serve canary instead of forwarding). */
  interceptedPackages: Map<string, CanaryPackage>;
  tokens: Map<string, CanaryToken>;
  /** Upstream registry URL (e.g., https://registry.npmjs.org). */
  upstreamUrl: string;
  upstreamApiUrl?: string;
  upstreamIndexUrl?: string;
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
    protocol,
    interceptedPackages, tokens,
    upstreamUrl, upstreamApiUrl, upstreamIndexUrl, callbackBaseUrl,
    upstreamTimeoutMs = 15_000,
  } = opts;
  const adapter = createProxyAdapter({ protocol, upstreamUrl, upstreamApiUrl, upstreamIndexUrl });

  const app = new Hono();

  // Health check
  app.get("/_yokai/health", (c) => {
    return c.json({
      status: "ok",
      mode: "proxy",
      protocol,
      upstream: adapter.describeUpstream(),
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
    const authorizationHeader = c.req.header("authorization");

    // Extract package name from path
    const match = adapter.match(path, method);
    const canary = match ? adapter.resolveCanary(match, interceptedPackages) : undefined;
    const packageName = canary?.name ?? match?.packageName;

    // Record all interactions
    recordInteraction(db, runId, method, path, sourceIp, userAgent, packageName);
    maybeEmitCredentialProbe({
      db,
      bus,
      runId,
      method,
      path,
      sourceIp,
      userAgent,
      packageName,
      authorizationHeader,
      metadata: { protocol },
    });

    // Check if this is an intercepted package
    if (match && (match.requiresCanary === false || canary)) {
      log.warn(`Intercepted request for monitored package: ${packageName} from ${sourceIp}`);

      const action = match.kind === "publish"
        ? "publish-attempt"
        : match.kind === "download"
          ? "tarball-download"
          : match.kind === "config"
            ? "config-access"
            : "metadata-resolve";
      const alert = classifyAlert({
        runId,
        packageName,
        sourceIp,
        userAgent,
        method,
        path,
        metadata: withBaselineMetadata(db, runId, {
          protocol,
          method,
          path,
          packageName,
        }, { action, proxy: true, upstream: adapter.describeUpstream() }),
      });
      saveAlert(db, alert);
      emitAlert(bus, runId, alert);

      return sendProxyResponse(c, adapter.buildInterceptResponse(match, canary, callbackBaseUrl));
    }

    // Passthrough: forward to upstream
    try {
      const upstreamPath = adapter.resolveUpstreamUrl(path);
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

function sendProxyResponse(c: any, response: ProxyResponseSpec) {
  switch (response.kind) {
    case "json":
      return c.json(response.body, response.status ?? 200, response.headers);
    case "html":
      return c.html(String(response.body), response.status ?? 200, response.headers);
    case "text":
      return c.text(String(response.body), response.status ?? 200, response.headers);
    case "body":
    default:
      return c.body(response.body as never, response.status ?? 200, response.headers);
  }
}
