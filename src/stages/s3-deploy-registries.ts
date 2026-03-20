import { serve } from "@hono/node-server";
import type { YokaiTask } from "../dag/types.js";
import type {
  StageId, YokaiTaskContext, GenerateCanariesOutput,
  DeployRegistriesOutput, CanaryPackage, CanaryToken,
} from "../types.js";
import { createNpmRegistryApp } from "../registries/npm/server.js";
import { createLogger } from "../logger.js";

const log = createLogger({ stage: "s3" });

// Store the server reference globally so monitor/CLI can access it
let activeServer: ReturnType<typeof serve> | null = null;

export function getActiveServer() {
  return activeServer;
}

export const s3DeployRegistries: YokaiTask<unknown, DeployRegistriesOutput> = {
  id: "s3-deploy-registries" as StageId,
  displayName: "Deploy Registries",
  outputKind: "deployment",
  dependsOn: ["s2-generate-canaries" as StageId],

  async run(_input: unknown, context: YokaiTaskContext): Promise<DeployRegistriesOutput> {
    const { config, db, bus, runId, upstreamOutputs } = context;

    const s2 = upstreamOutputs.get("s2-generate-canaries") as GenerateCanariesOutput | undefined;
    if (!s2 || s2.packages.length === 0) {
      log.warn("No canary packages to deploy");
      return { registryUrl: "", port: 0, packages: [], costUsd: 0 };
    }

    // Build lookup maps
    const packagesMap = new Map<string, CanaryPackage>();
    for (const pkg of s2.packages) {
      packagesMap.set(pkg.name, pkg);
    }

    const tokensMap = new Map<string, CanaryToken>();
    for (const token of s2.tokens) {
      tokensMap.set(token.id, token);
    }

    const app = createNpmRegistryApp({
      db,
      bus,
      runId,
      packages: packagesMap,
      tokens: tokensMap,
      callbackBaseUrl: config.callbackBaseUrl,
    });

    const port = config.port;
    const host = config.host;

    // Start the server
    activeServer = serve({
      fetch: app.fetch,
      port,
      hostname: host,
    });

    const registryUrl = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
    log.info(`Canary npm registry deployed at ${registryUrl}`);
    log.info(`Serving ${s2.packages.length} canary packages`);
    log.info(`Callback URL: ${config.callbackBaseUrl}/_yokai/callback/<tokenId>`);

    return {
      registryUrl,
      port,
      packages: s2.packages.map((p) => p.name),
      costUsd: 0,
    };
  },
};
