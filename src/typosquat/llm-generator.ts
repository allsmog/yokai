import { getAgentRuntime, type AgentResultSuccessMessage } from "../agent-runtime/index.js";
import { createLogger } from "../logger.js";
import type { TyposquatVariant } from "./generator.js";

const log = createLogger({ stage: "typosquat-llm" });

/**
 * Use LLM to generate creative typosquat variants that go beyond
 * simple algorithmic mutations.
 *
 * LLM can identify:
 * - Semantic confusions (e.g., "lodash" → "underscore-utils")
 * - Common abbreviations and expansions
 * - Homoglyph attacks using unicode
 * - Cultural/language-specific confusions
 */
export async function generateLlmTyposquatVariants(
  packageName: string,
  model: string,
  maxVariants = 20,
): Promise<TyposquatVariant[]> {
  const runtime = getAgentRuntime();

  const prompt = `You are a supply chain security analyst. Generate typosquat variants for the npm package "${packageName}".

Think about:
1. Common typos a developer might make when typing the name
2. Visual confusions (l/1, O/0, rn/m)
3. Semantic confusions (similar meaning, different name)
4. Abbreviated or expanded forms
5. Common misspellings
6. Scope confusion variants (if scoped)

Return JSON array of variants:
[
  { "variant": "string", "technique": "string — what technique was used" }
]

Generate up to ${maxVariants} plausible variants. Only return variants that could trick a developer.`;

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
            type: "array",
            items: {
              type: "object",
              properties: {
                variant: { type: "string" },
                technique: { type: "string" },
              },
              required: ["variant", "technique"],
            },
          },
          strict: true,
          retryInvalidStructuredOutput: 1,
        },
      },
    })) {
      if (msg.type === "result" && msg.subtype === "success") {
        const output = (msg as AgentResultSuccessMessage).structuredOutput as
          Array<{ variant: string; technique: string }> | undefined;

        if (Array.isArray(output)) {
          return output
            .filter((v) => v.variant !== packageName)
            .map((v) => ({
              original: packageName,
              variant: v.variant,
              technique: `llm:${v.technique}`,
              editDistance: levenshteinSimple(packageName, v.variant),
            }));
        }
      }
    }
  } catch (err) {
    log.warn(`LLM typosquat generation failed for ${packageName}: ${err}`);
  }

  return [];
}

function levenshteinSimple(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}
