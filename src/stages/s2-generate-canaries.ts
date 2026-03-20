import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { YokaiTask } from "../dag/types.js";
import type {
  StageId, YokaiTaskContext, DiscoverNamespacesOutput,
  GenerateCanariesOutput, CanaryToken,
} from "../types.js";
import { createCanaryToken } from "../canary/token.js";
import { buildCanaryPackage } from "../canary/package-builder.js";
import { saveCanaryToken } from "../store/checkpoint.js";
import { createLogger } from "../logger.js";

const log = createLogger({ stage: "s2" });

export const s2GenerateCanaries: YokaiTask<unknown, GenerateCanariesOutput> = {
  id: "s2-generate-canaries" as StageId,
  displayName: "Generate Canaries",
  outputKind: "generation",
  dependsOn: ["s1-discover-namespaces" as StageId],

  async run(_input: unknown, context: YokaiTaskContext): Promise<GenerateCanariesOutput> {
    const { config, db, runId, upstreamOutputs } = context;

    const s1 = upstreamOutputs.get("s1-discover-namespaces") as DiscoverNamespacesOutput | undefined;
    if (!s1 || s1.namespaces.length === 0) {
      log.warn("No namespaces discovered — generating empty canary set");
      return { packages: [], tokens: [], costUsd: 0 };
    }

    const outputDir = join(process.cwd(), ".yokai", "canaries");
    mkdirSync(outputDir, { recursive: true });

    const tokens: CanaryToken[] = [];
    const packages = [];

    // Generate canary packages for each scoped namespace
    const scopedNames = s1.namespaces
      .filter((ns) => ns.isScoped && !ns.name.endsWith("/*"))
      .map((ns) => ns.name);

    // Deduplicate
    const uniqueNames = [...new Set(scopedNames)];
    log.info(`Generating canary packages for ${uniqueNames.length} namespaces`);

    for (const name of uniqueNames) {
      const token = createCanaryToken(name, config.callbackBaseUrl);
      tokens.push(token);
      saveCanaryToken(db, { ...token, runId });

      const pkg = buildCanaryPackage(token, outputDir);
      packages.push(pkg);

      log.info(`Created canary: ${name} (token: ${token.id.slice(0, 8)}...)`);
    }

    return {
      packages,
      tokens,
      costUsd: 0,
    };
  },
};
