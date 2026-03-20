import { createLogger } from "../logger.js";

const log = createLogger({ stage: "pipeline-tokens" });

export interface PipelineTokenConfig {
  /** Canary registry URL that will trigger alerts when accessed. */
  registryUrl: string;
  /** Scope to configure (e.g., @myorg). Omit for global registry. */
  scope?: string;
  /** Token to embed for auth-based canary. */
  authToken?: string;
}

/**
 * Generate a canary .npmrc file content.
 *
 * When placed in a CI/CD pipeline, any `npm install` that reads this
 * config will hit the canary registry, triggering an alert.
 */
export function generateNpmrcCanary(config: PipelineTokenConfig): string {
  const lines: string[] = [
    "# Yokai canary — alerts fire when this config is read by npm/yarn/pnpm",
  ];

  if (config.scope) {
    lines.push(`${config.scope}:registry=${config.registryUrl}`);
  } else {
    lines.push(`registry=${config.registryUrl}`);
  }

  if (config.authToken) {
    const url = new URL(config.registryUrl);
    lines.push(`//${url.host}/:_authToken=${config.authToken}`);
  }

  lines.push(""); // trailing newline
  log.info(`Generated .npmrc canary${config.scope ? ` for scope ${config.scope}` : ""}`);
  return lines.join("\n");
}

/**
 * Generate a canary pip.conf file content.
 *
 * When placed in a CI/CD pipeline, any `pip install` that reads this
 * config will hit the canary registry, triggering an alert.
 */
export function generatePipConfCanary(config: PipelineTokenConfig): string {
  const lines: string[] = [
    "# Yokai canary — alerts fire when this config is read by pip",
    "[global]",
    `index-url = ${config.registryUrl}/simple/`,
  ];

  if (config.authToken) {
    // Embed creds in URL for pip
    const url = new URL(config.registryUrl);
    url.username = "__token__";
    url.password = config.authToken;
    lines[2] = `index-url = ${url.toString()}/simple/`;
  }

  lines.push(""); // trailing newline
  log.info("Generated pip.conf canary");
  return lines.join("\n");
}

/**
 * Generate a canary Maven settings.xml snippet.
 *
 * Insert into CI/CD's ~/.m2/settings.xml to detect Maven resolution
 * against the canary registry.
 */
export function generateMavenSettingsCanary(config: PipelineTokenConfig): string {
  const repoId = config.scope?.replace(/^@/, "") ?? "yokai-canary";

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Yokai canary — alerts fire when Maven resolves from this registry -->
<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.2.0
                              https://maven.apache.org/xsd/settings-1.2.0.xsd">
  <profiles>
    <profile>
      <id>yokai-canary</id>
      <repositories>
        <repository>
          <id>${repoId}</id>
          <url>${config.registryUrl}</url>
          <releases><enabled>true</enabled></releases>
          <snapshots><enabled>true</enabled></snapshots>
        </repository>
      </repositories>
    </profile>
  </profiles>
  <activeProfiles>
    <activeProfile>yokai-canary</activeProfile>
  </activeProfiles>${config.authToken ? `
  <servers>
    <server>
      <id>${repoId}</id>
      <username>__token__</username>
      <password>${escapeXml(config.authToken)}</password>
    </server>
  </servers>` : ""}
</settings>
`;

  log.info("Generated Maven settings.xml canary");
  return xml;
}

/**
 * Generate a GOPROXY environment variable value pointing to the canary registry.
 */
export function generateGoProxyCanary(config: PipelineTokenConfig): string {
  log.info("Generated GOPROXY canary");
  // GOPROXY is a comma-separated list; put canary first, then fallback to direct
  return `${config.registryUrl},direct`;
}

/**
 * Generate a canary .yarnrc.yml file content (Yarn Berry / v2+).
 */
export function generateYarnrcCanary(config: PipelineTokenConfig): string {
  const lines: string[] = [
    "# Yokai canary — alerts fire when Yarn reads this config",
  ];

  if (config.scope) {
    lines.push(`npmScopes:`);
    lines.push(`  "${config.scope.replace("@", "")}":`);
    lines.push(`    npmRegistryServer: "${config.registryUrl}"`);
    if (config.authToken) {
      lines.push(`    npmAuthToken: "${config.authToken}"`);
    }
  } else {
    lines.push(`npmRegistryServer: "${config.registryUrl}"`);
    if (config.authToken) {
      lines.push(`npmAuthToken: "${config.authToken}"`);
    }
  }

  lines.push(""); // trailing newline
  log.info("Generated .yarnrc.yml canary");
  return lines.join("\n");
}

/**
 * Generate all CI/CD canary configs for a given registry URL.
 */
export function generateAllPipelineCanaries(config: PipelineTokenConfig): Record<string, string> {
  return {
    ".npmrc": generateNpmrcCanary(config),
    "pip.conf": generatePipConfCanary(config),
    "settings.xml": generateMavenSettingsCanary(config),
    "GOPROXY": generateGoProxyCanary(config),
    ".yarnrc.yml": generateYarnrcCanary(config),
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
