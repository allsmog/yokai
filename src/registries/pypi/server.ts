import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { MessageBus } from "../../bus/types.js";
import type { CanaryPackage, CanaryToken, RegistryInteraction } from "../../types.js";
import { saveInteraction, findCanaryTokenById, saveAlert } from "../../store/checkpoint.js";
import { classifyAlert } from "../../detection/alert-engine.js";
import { withBaselineMetadata } from "../../detection/baseline.js";
import { maybeEmitCredentialProbe } from "../../detection/emit.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ stage: "pypi-registry" });

export interface PyPIRegistryOptions {
  db: Database.Database;
  bus: MessageBus;
  runId: string;
  packages: Map<string, CanaryPackage>;
  tokens: Map<string, CanaryToken>;
  callbackBaseUrl: string;
}

/**
 * Create a Hono app implementing the PyPI Simple Repository API for canary packages.
 *
 * Supported endpoints:
 * - GET /simple/                — Package index listing
 * - GET /simple/<pkg>/          — Package version listing with download links
 * - GET /packages/<pkg>/<file>  — Package file download
 * - POST /                      — Upload endpoint (twine publish detection)
 */
export function createPyPIRegistryApp(opts: PyPIRegistryOptions): Hono {
  const { db, bus, runId, packages, tokens, callbackBaseUrl } = opts;
  const app = new Hono();

  // Health check
  app.get("/_yokai/health", (c) => {
    return c.json({ status: "ok", protocol: "pypi", packages: packages.size });
  });

  // Canary callback (shared with npm)
  app.post("/_yokai/callback/:tokenId", async (c) => {
    const tokenId = c.req.param("tokenId");
    const sourceIp = c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";

    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json();
    } catch {
      // Empty body ok
    }

    log.info(`PyPI canary callback: token=${tokenId} ip=${sourceIp}`);

    const token = tokens.get(tokenId) ?? findCanaryTokenById(db, tokenId);
    if (!token) {
      return c.json({ error: "Unknown token" }, 404);
    }

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

    bus.publish({
      type: "alert:triggered",
      meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId },
      payload: {
        alertId: alert.id,
        alertType: alert.alertType,
        severity: alert.severity,
        packageName: token.packageName,
        sourceIp,
      },
    }).catch(() => {});

    return c.json({ status: "recorded", alertId: alert.id });
  });

  // GET /simple/ — Package index
  app.get("/simple/", (c) => {
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    const authorizationHeader = c.req.header("authorization");

    log.info(`PyPI simple index request from ${sourceIp}`);

    recordInteraction(db, runId, "GET", "/simple/", sourceIp, userAgent);
    maybeEmitCredentialProbe({
      db,
      bus,
      runId,
      method: "GET",
      path: "/simple/",
      sourceIp,
      userAgent,
      authorizationHeader,
      metadata: { protocol: "pypi" },
    });

    const links = [...packages.keys()]
      .map((name) => {
        const normalized = normalizePyPIName(name);
        return `    <a href="/simple/${normalized}/">${normalized}</a>`;
      })
      .join("\n");

    const html = `<!DOCTYPE html>
<html>
<head><title>Simple Index</title></head>
<body>
<h1>Simple Index</h1>
${links}
</body>
</html>`;

    return c.html(html);
  });

  // GET /simple/<pkg>/ — Package version page
  app.get("/simple/:pkg/", (c) => {
    const pkgParam = c.req.param("pkg");
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    const authorizationHeader = c.req.header("authorization");

    log.info(`PyPI package request: ${pkgParam} from ${sourceIp}`);

    // Try both normalized and original name lookups
    const canary = findPackage(packages, pkgParam);

    recordInteraction(db, runId, "GET", `/simple/${pkgParam}/`, sourceIp, userAgent, canary?.name);
    maybeEmitCredentialProbe({
      db,
      bus,
      runId,
      method: "GET",
      path: `/simple/${pkgParam}/`,
      sourceIp,
      userAgent,
      packageName: canary?.name ?? pkgParam,
      authorizationHeader,
      metadata: { protocol: "pypi" },
    });

    if (!canary) {
      return c.html(`<!DOCTYPE html>
<html><head><title>Links for ${pkgParam}</title></head>
<body><h1>Links for ${pkgParam}</h1></body></html>`, 404);
    }

    // Generate alert for namespace probe
    const alert = classifyAlert({
      runId,
      packageName: canary.name,
      sourceIp,
      userAgent,
      method: "GET",
      path: `/simple/${pkgParam}/`,
      metadata: withBaselineMetadata(db, runId, {
        protocol: "pypi",
        method: "GET",
        path: `/simple/${pkgParam}/`,
        packageName: canary.name,
      }, { action: "metadata-resolve", protocol: "pypi" }),
    });
    saveAlert(db, alert);

    bus.publish({
      type: "registry:request",
      meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId },
      payload: { method: "GET", path: `/simple/${pkgParam}/`, sourceIp, userAgent },
    }).catch(() => {});

    const normalized = normalizePyPIName(canary.name);
    const filename = `${normalized}-${canary.version}.tar.gz`;
    const downloadUrl = `${callbackBaseUrl}/packages/${normalized}/${filename}`;

    const html = `<!DOCTYPE html>
<html>
<head><title>Links for ${normalized}</title></head>
<body>
<h1>Links for ${normalized}</h1>
    <a href="${downloadUrl}#sha256=0000000000000000000000000000000000000000000000000000000000000000">${filename}</a><br/>
</body>
</html>`;

    return c.html(html);
  });

  // GET /packages/<pkg>/<file> — Package file download
  app.get("/packages/:pkg/:file", (c) => {
    const pkgParam = c.req.param("pkg");
    const fileParam = c.req.param("file");
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    const authorizationHeader = c.req.header("authorization");

    log.warn(`PyPI package download: ${pkgParam}/${fileParam} from ${sourceIp}`);

    const canary = findPackage(packages, pkgParam);

    recordInteraction(db, runId, "GET", `/packages/${pkgParam}/${fileParam}`, sourceIp, userAgent, canary?.name);
    maybeEmitCredentialProbe({
      db,
      bus,
      runId,
      method: "GET",
      path: `/packages/${pkgParam}/${fileParam}`,
      sourceIp,
      userAgent,
      packageName: canary?.name ?? pkgParam,
      authorizationHeader,
      metadata: { protocol: "pypi" },
    });

    const alert = classifyAlert({
      runId,
      packageName: canary?.name ?? pkgParam,
      sourceIp,
      userAgent,
      method: "GET",
      path: `/packages/${pkgParam}/${fileParam}`,
      metadata: withBaselineMetadata(db, runId, {
        protocol: "pypi",
        method: "GET",
        path: `/packages/${pkgParam}/${fileParam}`,
        packageName: canary?.name ?? pkgParam,
      }, { action: "tarball-download", protocol: "pypi" }),
    });
    saveAlert(db, alert);

    bus.publish({
      type: "alert:triggered",
      meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId },
      payload: {
        alertId: alert.id,
        alertType: alert.alertType,
        severity: alert.severity,
        packageName: canary?.name ?? pkgParam,
        sourceIp,
      },
    }).catch(() => {});

    // Return empty tarball placeholder
    return c.body("", 200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileParam}"`,
    });
  });

  // POST / — Upload detection (twine upload)
  app.post("/", async (c) => {
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    const authorizationHeader = c.req.header("authorization");

    log.warn(`PyPI upload attempt from ${sourceIp}`);

    // Try to extract package name from multipart form
    let packageName = "unknown";
    try {
      const formData = await c.req.formData();
      packageName = (formData.get("name") as string) ?? "unknown";
    } catch {
      // Not multipart, try to read body
    }

    recordInteraction(db, runId, "POST", "/", sourceIp, userAgent, packageName);
    maybeEmitCredentialProbe({
      db,
      bus,
      runId,
      method: "POST",
      path: "/",
      sourceIp,
      userAgent,
      packageName,
      authorizationHeader,
      metadata: { protocol: "pypi" },
    });

    const alert = classifyAlert({
      runId,
      packageName,
      sourceIp,
      userAgent,
      method: "PUT",
      path: "/upload",
      metadata: withBaselineMetadata(db, runId, {
        protocol: "pypi",
        method: "PUT",
        path: "/upload",
        packageName,
      }, { action: "publish-attempt", protocol: "pypi" }),
    });
    saveAlert(db, alert);

    bus.publish({
      type: "alert:triggered",
      meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId },
      payload: {
        alertId: alert.id,
        alertType: alert.alertType,
        severity: alert.severity,
        packageName,
        sourceIp,
      },
    }).catch(() => {});

    return c.json({ error: "Forbidden" }, 403);
  });

  return app;
}

/**
 * Normalize a package name per PEP 503.
 * Replace any run of non-alphanumeric characters with a single hyphen, lowercase.
 */
function normalizePyPIName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Find a package by normalized or original name.
 */
function findPackage(packages: Map<string, CanaryPackage>, query: string): CanaryPackage | undefined {
  // Direct lookup
  const direct = packages.get(query);
  if (direct) return direct;

  // Normalized lookup
  const normalizedQuery = normalizePyPIName(query);
  for (const [name, pkg] of packages) {
    if (normalizePyPIName(name) === normalizedQuery) return pkg;
  }

  return undefined;
}

function recordInteraction(
  db: Database.Database,
  runId: string,
  method: string,
  path: string,
  sourceIp: string,
  userAgent: string,
  packageName?: string,
): void {
  saveInteraction(db, {
    id: crypto.randomUUID(),
    runId,
    method,
    path,
    sourceIp,
    userAgent,
    packageName,
    createdAt: new Date().toISOString(),
  });
}
