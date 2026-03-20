import type { CanaryToken } from "../types.js";

/**
 * Generate a canary token for a package.
 */
export function createCanaryToken(
  packageName: string,
  callbackBaseUrl: string,
  type: CanaryToken["type"] = "postinstall",
): CanaryToken {
  const id = crypto.randomUUID();
  return {
    id,
    packageName,
    callbackUrl: `${callbackBaseUrl}/_yokai/callback/${id}`,
    createdAt: new Date().toISOString(),
    type,
  };
}

/**
 * Generate a postinstall script that phones home with system metadata.
 */
export function generatePostinstallScript(token: CanaryToken): string {
  return `#!/usr/bin/env node
// Yokai canary token — this script reports when the package is installed
const http = require("http");
const https = require("https");
const os = require("os");

const data = JSON.stringify({
  tokenId: ${JSON.stringify(token.id)},
  packageName: ${JSON.stringify(token.packageName)},
  hostname: os.hostname(),
  platform: os.platform(),
  arch: os.arch(),
  username: os.userInfo().username,
  ci: process.env.CI || null,
  githubActions: process.env.GITHUB_ACTIONS || null,
  jenkinsUrl: process.env.JENKINS_URL || null,
  gitlabCi: process.env.GITLAB_CI || null,
  circleci: process.env.CIRCLECI || null,
  registryUrl: process.env.npm_config_registry || null,
  timestamp: new Date().toISOString(),
});

const url = new URL(${JSON.stringify(token.callbackUrl)});
const transport = url.protocol === "https:" ? https : http;

const req = transport.request({
  hostname: url.hostname,
  port: url.port,
  path: url.pathname,
  method: "POST",
  headers: { "Content-Type": "application/json", "Content-Length": data.length },
  timeout: 5000,
}, () => {});

req.on("error", () => {});
req.write(data);
req.end();
`;
}

/**
 * Generate a preinstall script variant.
 */
export function generatePreinstallScript(token: CanaryToken): string {
  return generatePostinstallScript({ ...token, type: "preinstall" });
}

/**
 * Generate multiple canary tokens for a list of package names.
 */
export function createCanaryTokenBatch(
  packageNames: string[],
  callbackBaseUrl: string,
): CanaryToken[] {
  return packageNames.map((name) => createCanaryToken(name, callbackBaseUrl));
}
