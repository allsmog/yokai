import type { CanaryPackage } from "../../types.js";

export interface ProxyResponseSpec {
  kind: "json" | "text" | "body" | "html";
  body: unknown;
  status?: number;
  headers?: Record<string, string>;
}

export interface InterceptMatch {
  kind: "metadata" | "download" | "publish" | "config" | "index" | "latest" | "info" | "mod" | "list";
  packageName?: string;
  fileName?: string;
  version?: string;
  requiresCanary?: boolean;
}

export interface ProxyAdapter {
  readonly protocol: "npm" | "pypi" | "maven" | "go" | "cargo";
  describeUpstream(): string;
  match(path: string, method: string): InterceptMatch | null;
  resolveCanary(match: InterceptMatch, interceptedPackages: Map<string, CanaryPackage>): CanaryPackage | undefined;
  buildInterceptResponse(match: InterceptMatch, canary: CanaryPackage | undefined, callbackBaseUrl: string): ProxyResponseSpec;
  resolveUpstreamUrl(path: string): string;
}

export interface ProxyAdapterOptions {
  protocol: ProxyAdapter["protocol"];
  upstreamUrl: string;
  upstreamApiUrl?: string;
  upstreamIndexUrl?: string;
}

export function createProxyAdapter(opts: ProxyAdapterOptions): ProxyAdapter {
  switch (opts.protocol) {
    case "pypi":
      return createPyPIAdapter(opts.upstreamUrl);
    case "maven":
      return createMavenAdapter(opts.upstreamUrl);
    case "go":
      return createGoAdapter(opts.upstreamUrl);
    case "cargo":
      return createCargoAdapter(opts.upstreamApiUrl ?? opts.upstreamUrl, opts.upstreamIndexUrl ?? opts.upstreamUrl);
    case "npm":
    default:
      return createNpmAdapter(opts.upstreamUrl);
  }
}

function createNpmAdapter(upstreamUrl: string): ProxyAdapter {
  return {
    protocol: "npm",
    describeUpstream: () => upstreamUrl,
    match(path, method) {
      const packageName = extractNpmPackageName(path);
      if (!packageName) return null;
      if (method === "PUT") return { kind: "publish", packageName, requiresCanary: true };
      if (method === "GET" && path.includes("/-/")) return { kind: "download", packageName, fileName: path.split("/").pop(), requiresCanary: true };
      if (method === "GET") return { kind: "metadata", packageName, requiresCanary: true };
      return null;
    },
    resolveCanary(match, interceptedPackages) {
      return match.packageName ? interceptedPackages.get(match.packageName) : undefined;
    },
    buildInterceptResponse(match, canary, callbackBaseUrl) {
      if (match.kind === "publish") {
        return { kind: "json", status: 403, body: { error: "Forbidden" } };
      }
      if (match.kind === "download" && canary) {
        return {
          kind: "body",
          status: 200,
          body: "",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${match.fileName ?? `${canary.name}-${canary.version}.tgz`}"`,
          },
        };
      }
      return { kind: "json", status: 200, body: buildNpmMetadata(canary!, callbackBaseUrl) };
    },
    resolveUpstreamUrl(path) {
      return new URL(path, upstreamUrl).toString();
    },
  };
}

function createPyPIAdapter(upstreamUrl: string): ProxyAdapter {
  return {
    protocol: "pypi",
    describeUpstream: () => upstreamUrl,
    match(path, method) {
      if (method === "POST" && path === "/") return { kind: "publish", requiresCanary: false };
      const simpleMatch = path.match(/^\/simple\/([^/]+)\/$/);
      if (method === "GET" && simpleMatch) return { kind: "metadata", packageName: simpleMatch[1], requiresCanary: true };
      const packageMatch = path.match(/^\/packages\/([^/]+)\/([^/]+)$/);
      if (method === "GET" && packageMatch) {
        return { kind: "download", packageName: packageMatch[1], fileName: packageMatch[2], requiresCanary: true };
      }
      return null;
    },
    resolveCanary(match, interceptedPackages) {
      if (!match.packageName) return undefined;
      const direct = interceptedPackages.get(match.packageName);
      if (direct) return direct;
      const normalizedQuery = normalizePyPIName(match.packageName);
      for (const [name, pkg] of interceptedPackages) {
        if (normalizePyPIName(name) === normalizedQuery) return pkg;
      }
      return undefined;
    },
    buildInterceptResponse(match, canary, callbackBaseUrl) {
      if (match.kind === "publish") {
        return { kind: "json", status: 403, body: { error: "Forbidden" } };
      }
      if (match.kind === "download") {
        return {
          kind: "body",
          status: 200,
          body: "",
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${match.fileName ?? "package.tar.gz"}"`,
          },
        };
      }
      const normalized = normalizePyPIName(canary!.name);
      const filename = `${normalized}-${canary!.version}.tar.gz`;
      const downloadUrl = `${callbackBaseUrl}/packages/${normalized}/${filename}`;
      return {
        kind: "html",
        status: 200,
        body: `<!DOCTYPE html>
<html>
<head><title>Links for ${normalized}</title></head>
<body>
<h1>Links for ${normalized}</h1>
    <a href="${downloadUrl}#sha256=0000000000000000000000000000000000000000000000000000000000000000">${filename}</a><br/>
</body>
</html>`,
      };
    },
    resolveUpstreamUrl(path) {
      return new URL(path, upstreamUrl).toString();
    },
  };
}

function createMavenAdapter(upstreamUrl: string): ProxyAdapter {
  return {
    protocol: "maven",
    describeUpstream: () => upstreamUrl,
    match(path, method) {
      const parsed = parseMavenPath(path);
      const packageName = `${parsed.groupId}:${parsed.artifactId}`;
      if (method === "PUT") return { kind: "publish", packageName, requiresCanary: true };
      if (method === "GET" && path.endsWith("/maven-metadata.xml")) return { kind: "metadata", packageName, requiresCanary: true };
      if (method === "GET" && /\.(jar|pom|sha1|md5)$/.test(path)) {
        return { kind: "download", packageName, fileName: path.split("/").pop(), requiresCanary: true };
      }
      return null;
    },
    resolveCanary(match, interceptedPackages) {
      return match.packageName ? interceptedPackages.get(match.packageName) : undefined;
    },
    buildInterceptResponse(match, canary) {
      if (match.kind === "publish") {
        return { kind: "text", status: 403, body: "Forbidden" };
      }
      const { groupId, artifactId } = parsePackageKey(canary?.name ?? match.packageName ?? "unknown:unknown");
      if (match.kind === "metadata") {
        return {
          kind: "text",
          status: 200,
          body: buildMavenMetadata(groupId, artifactId, canary?.version ?? "0.0.1-canary"),
          headers: { "Content-Type": "application/xml" },
        };
      }
      const fileName = match.fileName ?? "";
      if (fileName.endsWith(".sha1")) return { kind: "text", status: 200, body: "0000000000000000000000000000000000000000" };
      if (fileName.endsWith(".md5")) return { kind: "text", status: 200, body: "00000000000000000000000000000000" };
      if (fileName.endsWith(".pom")) {
        return {
          kind: "text",
          status: 200,
          body: buildPom(groupId, artifactId, canary?.version ?? "0.0.1-canary"),
          headers: { "Content-Type": "application/xml" },
        };
      }
      return { kind: "body", status: 200, body: "", headers: { "Content-Type": "application/java-archive" } };
    },
    resolveUpstreamUrl(path) {
      return new URL(path, upstreamUrl).toString();
    },
  };
}

function createGoAdapter(upstreamUrl: string): ProxyAdapter {
  return {
    protocol: "go",
    describeUpstream: () => upstreamUrl,
    match(path, method) {
      if (method !== "GET") return null;
      if (path.endsWith("/@v/list")) return { kind: "list", packageName: extractModulePath(path, "/@v/list"), requiresCanary: true };
      if (path.endsWith("/@latest")) return { kind: "latest", packageName: extractModulePath(path, "/@latest"), requiresCanary: true };
      const infoMatch = path.match(/\/@v\/(.+)\.info$/);
      if (infoMatch) return { kind: "info", packageName: extractModulePath(path, `/@v/${infoMatch[1]}.info`), version: infoMatch[1], requiresCanary: true };
      const modMatch = path.match(/\/@v\/(.+)\.mod$/);
      if (modMatch) return { kind: "mod", packageName: extractModulePath(path, `/@v/${modMatch[1]}.mod`), version: modMatch[1], requiresCanary: true };
      const zipMatch = path.match(/\/@v\/(.+)\.zip$/);
      if (zipMatch) return { kind: "download", packageName: extractModulePath(path, `/@v/${zipMatch[1]}.zip`), version: zipMatch[1], requiresCanary: true };
      return null;
    },
    resolveCanary(match, interceptedPackages) {
      if (!match.packageName) return undefined;
      const direct = interceptedPackages.get(match.packageName);
      if (direct) return direct;
      const decoded = match.packageName.replace(/![a-z]/g, (segment) => segment[1].toUpperCase());
      return interceptedPackages.get(decoded);
    },
    buildInterceptResponse(match, canary) {
      switch (match.kind) {
        case "list":
          return { kind: "text", status: 200, body: `${canary!.version}\n` };
        case "info":
        case "latest":
          return { kind: "json", status: 200, body: { Version: canary!.version, Time: canary!.createdAt } };
        case "mod":
          return { kind: "text", status: 200, body: `module ${match.packageName}\n\ngo 1.21\n` };
        case "download":
          return { kind: "body", status: 200, body: "", headers: { "Content-Type": "application/zip" } };
        default:
          return { kind: "text", status: 404, body: "not found" };
      }
    },
    resolveUpstreamUrl(path) {
      return new URL(path, upstreamUrl).toString();
    },
  };
}

function createCargoAdapter(upstreamApiUrl: string, upstreamIndexUrl: string): ProxyAdapter {
  return {
    protocol: "cargo",
    describeUpstream: () => `${upstreamApiUrl} | ${upstreamIndexUrl}`,
    match(path, method) {
      if (method === "GET" && path === "/config.json") return { kind: "config", requiresCanary: false };
      const metadataMatch = path.match(/^\/api\/v1\/crates\/([^/]+)$/);
      if (method === "GET" && metadataMatch) return { kind: "metadata", packageName: metadataMatch[1], requiresCanary: true };
      const downloadMatch = path.match(/^\/api\/v1\/crates\/([^/]+)\/([^/]+)\/download$/);
      if (method === "GET" && downloadMatch) {
        return { kind: "download", packageName: downloadMatch[1], version: downloadMatch[2], requiresCanary: true };
      }
      if (method === "PUT" && path === "/api/v1/crates/new") return { kind: "publish", requiresCanary: false };
      const crateName = extractCrateFromIndexPath(path);
      if (method === "GET" && crateName && !path.startsWith("/_yokai/")) {
        return { kind: "index", packageName: crateName, requiresCanary: true };
      }
      return null;
    },
    resolveCanary(match, interceptedPackages) {
      return match.packageName ? interceptedPackages.get(match.packageName) : undefined;
    },
    buildInterceptResponse(match, canary, callbackBaseUrl) {
      if (match.kind === "config") {
        return {
          kind: "json",
          status: 200,
          body: {
            dl: `${callbackBaseUrl}/api/v1/crates`,
            api: callbackBaseUrl,
          },
        };
      }
      if (match.kind === "publish") {
        return { kind: "json", status: 403, body: { errors: [{ detail: "Forbidden" }] } };
      }
      if (match.kind === "download") {
        return { kind: "body", status: 200, body: "", headers: { "Content-Type": "application/x-tar" } };
      }
      if (match.kind === "index") {
        return {
          kind: "text",
          status: 200,
          body: `${JSON.stringify({
            name: canary!.name,
            vers: canary!.version,
            deps: [],
            cksum: "0".repeat(64),
            features: {},
            yanked: false,
          })}\n`,
        };
      }
      return {
        kind: "json",
        status: 200,
        body: {
          crate: {
            id: canary!.name,
            name: canary!.name,
            description: canary!.description,
            max_version: canary!.version,
            max_stable_version: canary!.version,
            created_at: canary!.createdAt,
            updated_at: canary!.createdAt,
            downloads: 0,
          },
          versions: [
            {
              id: 1,
              crate: canary!.name,
              num: canary!.version,
              dl_path: `/api/v1/crates/${canary!.name}/${canary!.version}/download`,
              created_at: canary!.createdAt,
              updated_at: canary!.createdAt,
              yanked: false,
              license: "MIT",
            },
          ],
        },
      };
    },
    resolveUpstreamUrl(path) {
      const base = path === "/config.json" || path.startsWith("/api/") ? upstreamApiUrl : upstreamIndexUrl;
      return new URL(path, base).toString();
    },
  };
}

function extractNpmPackageName(path: string): string | undefined {
  const cleaned = path.replace(/^\/?/, "");
  if (!cleaned || cleaned.startsWith("_yokai")) return undefined;
  const scopedMatch = cleaned.match(/^(@[^/]+\/[^/]+)/);
  if (scopedMatch) return scopedMatch[1];
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
          tarball: `${callbackBaseUrl}/${canary.name}/-/${canary.name.replace(/^@[^/]+\//, "")}-${canary.version}.tgz`,
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

function normalizePyPIName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function parseMavenPath(path: string): { groupId: string; artifactId: string } {
  const parts = path.replace(/^\//, "").split("/").filter(Boolean);
  const cleaned = parts.filter((part) => !part.includes("maven-metadata") && !part.match(/\.(jar|pom|sha1|md5|xml)$/));
  const noVersion = cleaned.filter((part) => !/^\d+(\.\d+)*(-[a-zA-Z0-9]+)?$/.test(part));
  if (noVersion.length >= 2) {
    return {
      groupId: noVersion.slice(0, -1).join("."),
      artifactId: noVersion[noVersion.length - 1],
    };
  }
  return { groupId: "unknown", artifactId: noVersion[0] ?? "unknown" };
}

function parsePackageKey(key: string): { groupId: string; artifactId: string } {
  const [groupId = "unknown", artifactId = "unknown"] = key.split(":");
  return { groupId, artifactId };
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

function extractModulePath(fullPath: string, suffix: string): string {
  const index = fullPath.indexOf(suffix);
  if (index === -1) return fullPath.replace(/^\//, "");
  return fullPath.slice(1, index);
}

function extractCrateFromIndexPath(path: string): string | undefined {
  const parts = path.replace(/^\//, "").split("/").filter(Boolean);
  if (parts.length === 0) return undefined;
  if ((parts[0] === "1" || parts[0] === "2") && parts.length === 2) return parts[1];
  if (parts[0] === "3" && parts.length === 3) return parts[2];
  if (parts.length === 3 && parts[0].length === 2 && parts[1].length === 2) return parts[2];
  return undefined;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
