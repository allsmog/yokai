import { describe, it, expect } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { openDatabase } from "../src/store/db.js";
import { InProcessBus } from "../src/bus/in-process.js";
import { createTransparentProxy } from "../src/registries/proxy/transparent.js";
import type { CanaryPackage, CanaryToken } from "../src/types.js";

describe("Transparent registry proxy adapters", () => {
  it("intercepts and forwards for PyPI", async () => {
    await withProxyServer("pypi", "internal-utils", async ({ proxyPort, upstreamPort }) => {
      const interceptedRes = await fetch(`http://127.0.0.1:${proxyPort}/simple/internal-utils/`);
      const interceptedBody = await interceptedRes.text();
      expect(interceptedRes.status).toBe(200);
      expect(interceptedBody).toContain("internal-utils-0.0.1-canary.tar.gz");

      const passthroughRes = await fetch(`http://127.0.0.1:${proxyPort}/simple/requests/`);
      const passthroughBody = await passthroughRes.text();
      expect(passthroughRes.status).toBe(200);
      expect(passthroughBody).toContain("requests");

      expect(upstreamPort).toBeGreaterThan(0);
    }, (upstreamApp) => {
      upstreamApp.get("/simple/requests/", (c) => c.html("<html><body>requests</body></html>"));
    });
  });

  it("intercepts and forwards for Maven", async () => {
    await withProxyServer("maven", "com.myorg:internal-lib", async ({ proxyPort }) => {
      const interceptedRes = await fetch(`http://127.0.0.1:${proxyPort}/com/myorg/internal-lib/maven-metadata.xml`);
      const interceptedBody = await interceptedRes.text();
      expect(interceptedRes.status).toBe(200);
      expect(interceptedBody).toContain("<artifactId>internal-lib</artifactId>");

      const passthroughRes = await fetch(`http://127.0.0.1:${proxyPort}/org/apache/commons/maven-metadata.xml`);
      const passthroughBody = await passthroughRes.text();
      expect(passthroughRes.status).toBe(200);
      expect(passthroughBody).toContain("<artifactId>commons</artifactId>");
    }, (upstreamApp) => {
      upstreamApp.get("/org/apache/commons/maven-metadata.xml", (c) =>
        c.text("<metadata><artifactId>commons</artifactId></metadata>", 200, { "Content-Type": "application/xml" }),
      );
    });
  });

  it("intercepts and forwards for Go", async () => {
    await withProxyServer("go", "github.com/myorg/internal-lib", async ({ proxyPort }) => {
      const interceptedRes = await fetch(`http://127.0.0.1:${proxyPort}/github.com/myorg/internal-lib/@latest`);
      const interceptedBody = await interceptedRes.json() as Record<string, string>;
      expect(interceptedRes.status).toBe(200);
      expect(interceptedBody.Version).toBe("0.0.1-canary");

      const passthroughRes = await fetch(`http://127.0.0.1:${proxyPort}/github.com/pkg/errors/@latest`);
      const passthroughBody = await passthroughRes.json() as Record<string, string>;
      expect(passthroughRes.status).toBe(200);
      expect(passthroughBody.Version).toBe("v1.0.0");
    }, (upstreamApp) => {
      upstreamApp.get("/github.com/pkg/errors/@latest", (c) =>
        c.json({ Version: "v1.0.0", Time: "2024-01-01T00:00:00.000Z" }),
      );
    });
  });

  it("intercepts API and forwards passthrough for Cargo", async () => {
    await withCargoProxyServer(async ({ proxyPort }) => {
      const interceptedRes = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/crates/internal-utils`);
      const interceptedBody = await interceptedRes.json() as Record<string, unknown>;
      expect(interceptedRes.status).toBe(200);
      expect((interceptedBody.crate as Record<string, unknown>).name).toBe("internal-utils");

      const passthroughRes = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/crates/serde`);
      const passthroughBody = await passthroughRes.json() as Record<string, unknown>;
      expect(passthroughRes.status).toBe(200);
      expect((passthroughBody.crate as Record<string, unknown>).name).toBe("serde");

      const indexRes = await fetch(`http://127.0.0.1:${proxyPort}/in/te/internal-utils`);
      const indexText = await indexRes.text();
      expect(indexRes.status).toBe(200);
      expect(indexText).toContain("\"name\":\"internal-utils\"");
    });
  });
});

async function withProxyServer(
  protocol: "pypi" | "maven" | "go",
  canaryName: string,
  runTest: (ports: { proxyPort: number; upstreamPort: number }) => Promise<void>,
  configureUpstream: (app: Hono) => void,
) {
  const testDir = join(tmpdir(), `yokai-proxy-${protocol}-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const db = openDatabase(join(testDir, `${protocol}.sqlite3`));
  const bus = new InProcessBus();
  const upstreamPort = 19000 + Math.floor(Math.random() * 1000);
  const proxyPort = upstreamPort + 1000;
  const upstreamApp = new Hono();
  configureUpstream(upstreamApp);
  const upstreamServer = serve({ fetch: upstreamApp.fetch, port: upstreamPort, hostname: "127.0.0.1" });

  const canary: CanaryPackage = {
    name: canaryName,
    version: "0.0.1-canary",
    description: "proxy canary",
    tokenId: `tok-${protocol}`,
    createdAt: new Date().toISOString(),
  };
  const token: CanaryToken = {
    id: `tok-${protocol}`,
    packageName: canaryName,
    callbackUrl: `http://127.0.0.1:${proxyPort}/_yokai/callback/tok-${protocol}`,
    createdAt: new Date().toISOString(),
    type: "postinstall",
  };

  const interceptedPackages = new Map<string, CanaryPackage>();
  interceptedPackages.set(canaryName, canary);
  const tokens = new Map<string, CanaryToken>();
  tokens.set(token.id, token);

  const proxyApp = createTransparentProxy({
    db,
    bus,
    runId: `${protocol}-proxy-run`,
    protocol,
    interceptedPackages,
    tokens,
    upstreamUrl: `http://127.0.0.1:${upstreamPort}`,
    callbackBaseUrl: `http://127.0.0.1:${proxyPort}`,
  });
  const proxyServer = serve({ fetch: proxyApp.fetch, port: proxyPort, hostname: "127.0.0.1" });

  try {
    await waitForServer(`http://127.0.0.1:${proxyPort}/_yokai/health`);
    await runTest({ proxyPort, upstreamPort });
  } finally {
    proxyServer.close();
    upstreamServer.close();
    await bus.close();
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  }
}

async function withCargoProxyServer(runTest: (ports: { proxyPort: number }) => Promise<void>) {
  const testDir = join(tmpdir(), `yokai-proxy-cargo-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const db = openDatabase(join(testDir, "cargo.sqlite3"));
  const bus = new InProcessBus();
  const apiPort = 20000 + Math.floor(Math.random() * 1000);
  const indexPort = apiPort + 1000;
  const proxyPort = indexPort + 1000;

  const apiApp = new Hono();
  apiApp.get("/api/v1/crates/serde", (c) => c.json({
    crate: { name: "serde", max_version: "1.0.0" },
    versions: [],
  }));
  const indexApp = new Hono();
  indexApp.get("/se/rd/serde", (c) => c.text("{\"name\":\"serde\",\"vers\":\"1.0.0\"}\n"));

  const apiServer = serve({ fetch: apiApp.fetch, port: apiPort, hostname: "127.0.0.1" });
  const indexServer = serve({ fetch: indexApp.fetch, port: indexPort, hostname: "127.0.0.1" });

  const interceptedPackages = new Map<string, CanaryPackage>();
  interceptedPackages.set("internal-utils", {
    name: "internal-utils",
    version: "0.0.1-canary",
    description: "cargo canary",
    tokenId: "tok-cargo",
    createdAt: new Date().toISOString(),
  });
  const tokens = new Map<string, CanaryToken>();
  tokens.set("tok-cargo", {
    id: "tok-cargo",
    packageName: "internal-utils",
    callbackUrl: `http://127.0.0.1:${proxyPort}/_yokai/callback/tok-cargo`,
    createdAt: new Date().toISOString(),
    type: "postinstall",
  });

  const proxyApp = createTransparentProxy({
    db,
    bus,
    runId: "cargo-proxy-run",
    protocol: "cargo",
    interceptedPackages,
    tokens,
    upstreamUrl: `http://127.0.0.1:${apiPort}`,
    upstreamApiUrl: `http://127.0.0.1:${apiPort}`,
    upstreamIndexUrl: `http://127.0.0.1:${indexPort}`,
    callbackBaseUrl: `http://127.0.0.1:${proxyPort}`,
  });
  const proxyServer = serve({ fetch: proxyApp.fetch, port: proxyPort, hostname: "127.0.0.1" });

  try {
    await waitForServer(`http://127.0.0.1:${proxyPort}/_yokai/health`);
    await runTest({ proxyPort });
  } finally {
    proxyServer.close();
    apiServer.close();
    indexServer.close();
    await bus.close();
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  }
}

async function waitForServer(url: string) {
  for (let i = 0; i < 20; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${url}`);
}
