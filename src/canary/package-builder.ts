import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CanaryPackage, CanaryToken } from "../types.js";
import { generatePostinstallScript } from "./token.js";
import { createLogger } from "../logger.js";
import { getAgentRuntime, type AgentResultSuccessMessage } from "../agent-runtime/index.js";

const log = createLogger({ stage: "package-builder" });

/**
 * Build a canary npm package on disk.
 */
export function buildCanaryPackage(
  token: CanaryToken,
  outputDir: string,
  opts?: { description?: string; version?: string },
): CanaryPackage {
  const pkgName = token.packageName;
  const version = opts?.version ?? "0.0.1-canary";
  const description = opts?.description ?? `Internal package: ${pkgName}`;

  const pkgDir = join(outputDir, pkgName.replace("/", "-").replace("@", ""));
  mkdirSync(pkgDir, { recursive: true });

  // package.json
  const packageJson = {
    name: pkgName,
    version,
    description,
    main: "index.js",
    scripts: {
      postinstall: "node .yokai-canary.js",
    },
    license: "UNLICENSED",
    private: true,
  };
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(packageJson, null, 2));

  // index.js — plausible entry point
  writeFileSync(join(pkgDir, "index.js"), `"use strict";\nmodule.exports = {};\n`);

  // Canary postinstall script
  const script = generatePostinstallScript(token);
  writeFileSync(join(pkgDir, ".yokai-canary.js"), script);

  log.info(`Built canary package: ${pkgName}@${version} at ${pkgDir}`);

  return {
    name: pkgName,
    version,
    description,
    tarballPath: pkgDir,
    tokenId: token.id,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Use LLM to generate a more realistic canary package with plausible code.
 */
export async function buildLlmCanaryPackage(
  token: CanaryToken,
  outputDir: string,
  model: string,
): Promise<CanaryPackage> {
  const runtime = getAgentRuntime();

  const prompt = `Generate a realistic-looking npm package named "${token.packageName}" that would
be plausible as an internal utility. The package should:
1. Have a reasonable description
2. Export a few simple utility functions that match what the package name suggests
3. Include a README.md with basic usage

Return JSON matching this schema:
{
  "description": "string — package description",
  "indexJs": "string — content of index.js",
  "readmeContent": "string — content of README.md"
}`;

  let description = `Internal package: ${token.packageName}`;
  let indexJs = `"use strict";\nmodule.exports = {};\n`;

  try {
    for await (const msg of runtime.query({
      prompt,
      options: {
        cwd: process.cwd(),
        model,
        maxTurns: 1,
        disallowedTools: ["Bash", "Read", "Glob", "Grep"],
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              description: { type: "string" },
              indexJs: { type: "string" },
              readmeContent: { type: "string" },
            },
            required: ["description", "indexJs"],
          },
          strict: true,
          retryInvalidStructuredOutput: 1,
        },
      },
    })) {
      if (msg.type === "result" && msg.subtype === "success") {
        const output = (msg as AgentResultSuccessMessage).structuredOutput as {
          description?: string;
          indexJs?: string;
          readmeContent?: string;
        } | undefined;
        if (output) {
          description = output.description ?? description;
          indexJs = output.indexJs ?? indexJs;
        }
      }
    }
  } catch (err) {
    log.warn(`LLM canary generation failed, using default: ${err}`);
  }

  const version = "0.0.1-canary";
  const pkgDir = join(outputDir, token.packageName.replace("/", "-").replace("@", ""));
  mkdirSync(pkgDir, { recursive: true });

  const packageJson = {
    name: token.packageName,
    version,
    description,
    main: "index.js",
    scripts: {
      postinstall: "node .yokai-canary.js",
    },
    license: "UNLICENSED",
    private: true,
  };
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify(packageJson, null, 2));
  writeFileSync(join(pkgDir, "index.js"), indexJs);

  const script = generatePostinstallScript(token);
  writeFileSync(join(pkgDir, ".yokai-canary.js"), script);

  log.info(`Built LLM canary package: ${token.packageName}@${version} at ${pkgDir}`);

  return {
    name: token.packageName,
    version,
    description,
    tarballPath: pkgDir,
    tokenId: token.id,
    createdAt: new Date().toISOString(),
  };
}
