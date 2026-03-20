import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger({ stage: "namespace-analyzer" });

export interface RegistryConfig {
  scope: string;
  registryUrl: string;
  source: string;
}

/**
 * Parse .npmrc for scope → registry mappings.
 */
export function parseNpmrc(repoPath: string): RegistryConfig[] {
  const configs: RegistryConfig[] = [];
  const npmrcPaths = [
    join(repoPath, ".npmrc"),
    join(repoPath, ".yarnrc"),
  ];

  for (const npmrcPath of npmrcPaths) {
    if (!existsSync(npmrcPath)) continue;

    try {
      const content = readFileSync(npmrcPath, "utf-8");
      const lines = content.split(/\r?\n/);

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("#") || !trimmed) continue;

        // @scope:registry=url
        const scopeMatch = trimmed.match(/^(@[a-zA-Z0-9_-]+):registry\s*=\s*(.+)$/);
        if (scopeMatch) {
          configs.push({
            scope: scopeMatch[1],
            registryUrl: scopeMatch[2].trim(),
            source: npmrcPath,
          });
        }

        // registry=url (global)
        const globalMatch = trimmed.match(/^registry\s*=\s*(.+)$/);
        if (globalMatch) {
          configs.push({
            scope: "*",
            registryUrl: globalMatch[1].trim(),
            source: npmrcPath,
          });
        }
      }
    } catch (err) {
      log.warn(`Failed to parse ${npmrcPath}: ${err}`);
    }
  }

  return configs;
}

/**
 * Parse pip.conf for index-url and extra-index-url settings.
 */
export function parsePipConf(repoPath: string): RegistryConfig[] {
  const configs: RegistryConfig[] = [];
  const pipConfPaths = [
    join(repoPath, "pip.conf"),
    join(repoPath, ".pip", "pip.conf"),
  ];

  for (const confPath of pipConfPaths) {
    if (!existsSync(confPath)) continue;

    try {
      const content = readFileSync(confPath, "utf-8");
      const indexMatch = content.match(/index-url\s*=\s*(.+)/);
      if (indexMatch) {
        configs.push({
          scope: "*",
          registryUrl: indexMatch[1].trim(),
          source: confPath,
        });
      }

      const extraMatch = content.match(/extra-index-url\s*=\s*(.+)/);
      if (extraMatch) {
        configs.push({
          scope: "*:extra",
          registryUrl: extraMatch[1].trim(),
          source: confPath,
        });
      }
    } catch (err) {
      log.warn(`Failed to parse ${confPath}: ${err}`);
    }
  }

  return configs;
}

/**
 * Detect all registry configurations in the repo.
 */
export function detectRegistryConfigs(repoPath: string): RegistryConfig[] {
  return [
    ...parseNpmrc(repoPath),
    ...parsePipConf(repoPath),
  ];
}
