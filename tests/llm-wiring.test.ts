import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/store/db.js";
import { InProcessBus } from "../src/bus/in-process.js";
import { normalizeConfig } from "../src/config.js";
import { s2GenerateCanaries } from "../src/stages/s2-generate-canaries.js";
import { scanForTyposquats } from "../src/typosquat/monitor.js";
import { setAgentRuntime } from "../src/agent-runtime/index.js";
import type { AgentRuntime, AgentResultSuccessMessage } from "../src/agent-runtime/types.js";

function mockRuntime(output: unknown): AgentRuntime {
  return {
    id: "mock",
    async *query() {
      yield {
        type: "result",
        subtype: "success",
        result: JSON.stringify(output),
        structuredOutput: output,
      } as AgentResultSuccessMessage;
    },
  };
}

describe("LLM wiring", () => {
  let testDir: string;
  let db: ReturnType<typeof openDatabase>;
  let previousCwd: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    previousCwd = process.cwd();
    testDir = join(tmpdir(), `yokai-llm-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);
    db = openDatabase(join(testDir, "llm.sqlite3"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.chdir(previousCwd);
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("uses the LLM canary builder only when the model is explicitly configured", async () => {
    setAgentRuntime(mockRuntime({
      description: "LLM-generated description",
      indexJs: "module.exports = { ok: true };",
      readmeContent: "# Mock README\n",
    }));

    const bus = new InProcessBus();
    const result = await s2GenerateCanaries.run(undefined, {
      runId: "llm-run",
      config: normalizeConfig({
        model: "mock:model",
        modelExplicitlyConfigured: true,
      }),
      bus,
      db,
      upstreamOutputs: new Map([
        ["s1-discover-namespaces", {
          namespaces: [{ name: "@myorg/utils", source: "package.json", isScoped: true }],
          costUsd: 0,
        }],
      ]),
    });

    const pkgDir = join(testDir, ".yokai", "canaries", "myorg-utils");
    const readme = readFileSync(join(pkgDir, "README.md"), "utf-8");

    expect(result.packages[0].description).toBe("LLM-generated description");
    expect(readme).toContain("Mock README");

    await bus.close();
  });

  it("merges LLM typosquat variants when a model is provided", async () => {
    setAgentRuntime(mockRuntime([
      { variant: "lodasb", technique: "mock-variant" },
    ]));

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("lodasb")) {
        return new Response(JSON.stringify({
          "dist-tags": { latest: "1.0.0" },
          maintainers: [{ name: "attacker" }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const results = await scanForTyposquats({
      packageNames: ["lodash"],
      maxVariantsPerPackage: 5,
      model: "mock:model",
    });

    expect(results.some((result) => result.variant === "lodasb")).toBe(true);
  });
});
