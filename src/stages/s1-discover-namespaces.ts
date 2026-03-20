import type { YokaiTask } from "../dag/types.js";
import type { StageId, YokaiTaskContext, DiscoverNamespacesOutput } from "../types.js";
import { scanForNamespaces } from "../discovery/scanner.js";
import { createLogger } from "../logger.js";

const log = createLogger({ stage: "s1" });

export const s1DiscoverNamespaces: YokaiTask<unknown, DiscoverNamespacesOutput> = {
  id: "s1-discover-namespaces" as StageId,
  displayName: "Discover Namespaces",
  outputKind: "discovery",
  dependsOn: [],

  async run(_input: unknown, context: YokaiTaskContext): Promise<DiscoverNamespacesOutput> {
    const { config } = context;
    const repoPath = config.repoPath ?? process.cwd();

    log.info(`Scanning repository for internal namespaces: ${repoPath}`);
    const namespaces = scanForNamespaces(repoPath);

    log.info(`Found ${namespaces.length} namespaces`);
    for (const ns of namespaces) {
      log.debug(`  ${ns.name} (source: ${ns.source}${ns.registry ? `, registry: ${ns.registry}` : ""})`);
    }

    return {
      namespaces,
      costUsd: 0,
    };
  },
};
