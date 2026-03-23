import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { MessageBus } from "../../bus/types.js";
import type { CanaryPackage, CanaryToken, RegistryInteraction } from "../../types.js";
import { saveInteraction, saveAlert } from "../../store/checkpoint.js";
import { classifyAlert } from "../../detection/alert-engine.js";
import { withBaselineMetadata } from "../../detection/baseline.js";
import { maybeEmitCredentialProbe } from "../../detection/emit.js";
import { createLogger } from "../../logger.js";

const log = createLogger({ stage: "maven-registry" });

export interface MavenRegistryOptions {
  db: Database.Database;
  bus: MessageBus;
  runId: string;
  /** Map of "groupId:artifactId" → CanaryPackage */
  artifacts: Map<string, CanaryPackage>;
  tokens: Map<string, CanaryToken>;
  callbackBaseUrl: string;
}

/**
 * Hono app implementing Maven repository protocol for canary artifacts.
 *
 * Endpoints:
 * - GET /<group-path>/<artifact>/maven-metadata.xml   — artifact metadata
 * - GET /<group-path>/<artifact>/<version>/<file>      — artifact download
 * - PUT /<group-path>/<artifact>/<version>/<file>      — deploy detection
 */
export function createMavenRegistryApp(opts: MavenRegistryOptions): Hono {
  const { db, bus, runId, artifacts, tokens, callbackBaseUrl } = opts;
  const app = new Hono();

  app.get("/_yokai/health", (c) => {
    return c.json({ status: "ok", protocol: "maven", artifacts: artifacts.size });
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

  // Catch-all GET handler for Maven paths
  app.get("/*", (c) => {
    const path = c.req.path;
    if (path.startsWith("/_yokai/")) return undefined as any; // Skip internal routes
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    const authorizationHeader = c.req.header("authorization");

    const { groupId, artifactId } = parseMavenPath(path);
    const key = `${groupId}:${artifactId}`;

    record(db, runId, "GET", path, sourceIp, userAgent, key);
    maybeEmitCredentialProbe({
      db,
      bus,
      runId,
      method: "GET",
      path,
      sourceIp,
      userAgent,
      packageName: key,
      authorizationHeader,
      metadata: { protocol: "maven" },
    });

    // maven-metadata.xml
    if (path.endsWith("/maven-metadata.xml")) {
      log.info(`Maven metadata request: ${key} from ${sourceIp}`);
      const canary = artifacts.get(key);
      if (!canary) return c.text("Not found", 404);

      const alert = classifyAlert({
        runId,
        packageName: key,
        sourceIp,
        userAgent,
        method: "GET",
        path,
        metadata: withBaselineMetadata(db, runId, {
          protocol: "maven",
          method: "GET",
          path,
          packageName: key,
        }, { action: "metadata-resolve", protocol: "maven" }),
      });
      saveAlert(db, alert);
      emit(bus, runId, alert);

      return c.text(buildMavenMetadata(groupId, artifactId, canary.version), 200, { "Content-Type": "application/xml" });
    }

    // Artifact files (.jar, .pom, .sha1, .md5)
    const file = path.split("/").pop() ?? "";
    if (/\.(jar|pom|sha1|md5)$/.test(file)) {
      log.warn(`Maven artifact download: ${key} / ${file} from ${sourceIp}`);

      const alert = classifyAlert({
        runId,
        packageName: key,
        sourceIp,
        userAgent,
        method: "GET",
        path,
        metadata: withBaselineMetadata(db, runId, {
          protocol: "maven",
          method: "GET",
          path,
          packageName: key,
        }, { action: "tarball-download", protocol: "maven", file }),
      });
      saveAlert(db, alert);
      emit(bus, runId, alert);

      if (file.endsWith(".sha1")) return c.text("0000000000000000000000000000000000000000");
      if (file.endsWith(".md5")) return c.text("00000000000000000000000000000000");
      if (file.endsWith(".pom")) {
        const canary = artifacts.get(key);
        return c.text(buildPom(groupId, artifactId, canary?.version ?? "0.0.1-canary"), 200, { "Content-Type": "application/xml" });
      }
      return c.body("", 200, { "Content-Type": "application/java-archive" });
    }

    return c.text("Not found", 404);
  });

  // PUT — deploy detection
  app.put("/*", (c) => {
    const path = c.req.path;
    const sourceIp = c.req.header("x-forwarded-for") ?? "unknown";
    const userAgent = c.req.header("user-agent") ?? "";
    const authorizationHeader = c.req.header("authorization");

    const { groupId, artifactId } = parseMavenPath(path);
    const key = `${groupId}:${artifactId}`;

    log.warn(`Maven deploy attempt: ${key} from ${sourceIp}`);
    record(db, runId, "PUT", path, sourceIp, userAgent, key);
    maybeEmitCredentialProbe({
      db,
      bus,
      runId,
      method: "PUT",
      path,
      sourceIp,
      userAgent,
      packageName: key,
      authorizationHeader,
      metadata: { protocol: "maven" },
    });

    const alert = classifyAlert({
      runId,
      packageName: key,
      sourceIp,
      userAgent,
      method: "PUT",
      path,
      metadata: withBaselineMetadata(db, runId, {
        protocol: "maven",
        method: "PUT",
        path,
        packageName: key,
      }, { action: "publish-attempt", protocol: "maven" }),
    });
    saveAlert(db, alert);
    emit(bus, runId, alert);

    return c.text("Forbidden", 403);
  });

  return app;
}

function parseMavenPath(path: string): { groupId: string; artifactId: string } {
  // Maven paths: /com/example/mylib/maven-metadata.xml → groupId=com.example, artifactId=mylib
  // Or: /com/example/mylib/1.0/mylib-1.0.jar
  const parts = path.replace(/^\//, "").split("/").filter(Boolean);

  // Remove known trailing files
  const cleaned = parts.filter((p) =>
    !p.includes("maven-metadata") && !p.match(/\.(jar|pom|sha1|md5|xml)$/),
  );

  // Last segment that looks like a version? Remove it
  const noVersion = cleaned.filter((p) => !/^\d+(\.\d+)*(-[a-zA-Z0-9]+)?$/.test(p));

  if (noVersion.length >= 2) {
    const artifactId = noVersion[noVersion.length - 1];
    const groupId = noVersion.slice(0, -1).join(".");
    return { groupId, artifactId };
  }

  return { groupId: "unknown", artifactId: noVersion[0] ?? "unknown" };
}

function buildMavenMetadata(groupId: string, artifactId: string, version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>${escapeXml(groupId)}</groupId>
  <artifactId>${escapeXml(artifactId)}</artifactId>
  <versioning>
    <latest>${escapeXml(version)}</latest>
    <release>${escapeXml(version)}</release>
    <versions>
      <version>${escapeXml(version)}</version>
    </versions>
    <lastUpdated>${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}</lastUpdated>
  </versioning>
</metadata>`;
}

function buildPom(groupId: string, artifactId: string, version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>${escapeXml(groupId)}</groupId>
  <artifactId>${escapeXml(artifactId)}</artifactId>
  <version>${escapeXml(version)}</version>
</project>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function record(db: Database.Database, runId: string, method: string, path: string, sourceIp: string, userAgent: string, packageName?: string, tokenId?: string) {
  saveInteraction(db, { id: crypto.randomUUID(), runId, method, path, sourceIp, userAgent, packageName, tokenId, createdAt: new Date().toISOString() });
}

function emit(bus: MessageBus, runId: string, alert: { id: string; alertType: string; severity: string; packageName?: string; sourceIp?: string }) {
  bus.publish({ type: "alert:triggered", meta: { id: crypto.randomUUID(), timestamp: new Date().toISOString(), runId }, payload: { alertId: alert.id, alertType: alert.alertType, severity: alert.severity, packageName: alert.packageName, sourceIp: alert.sourceIp } }).catch(() => {});
}
