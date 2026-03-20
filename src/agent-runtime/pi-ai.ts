import {
  complete,
  getModel,
  type AssistantMessage as PiAiAssistantMessage,
  type Context as PiAiContext,
  type KnownProvider,
  type ToolCall as PiAiToolCall,
  validateToolCall,
} from "@mariozechner/pi-ai";
import { isRecord, normalizeCostUsd, toErrorMessage } from "../utils.js";
import { parsePiAiModelSpec } from "./model-spec.js";
import { executeTool, PI_AI_TOOL_DEFINITIONS, KNOWN_TOOL_NAMES } from "./tools.js";
import type { AgentMessage, AgentQueryRequest, AgentRuntime } from "./types.js";

process.env.PI_CACHE_RETENTION ??= "long";

const TRANSIENT_RETRY_MAX = 3;
const TRANSIENT_RETRY_BASE_MS = 5_000;

const TRANSIENT_STATUS_CODES = [500, 502, 503, 529, 429];
const TRANSIENT_NETWORK_TOKENS = ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "socket hang up", "fetch failed", "Request timed out"];
const TRANSIENT_API_TOKENS = ["overloaded", "temporarily unavailable", "Service Temporarily Unavailable"];

export function isTransientError(error: unknown): boolean {
  const message = toErrorMessage(error);
  for (const code of TRANSIENT_STATUS_CODES) {
    if (message.includes(String(code))) return true;
  }
  for (const token of TRANSIENT_NETWORK_TOKENS) {
    if (message.includes(token)) return true;
  }
  for (const token of TRANSIENT_API_TOKENS) {
    if (message.toLowerCase().includes(token.toLowerCase())) return true;
  }
  return false;
}

async function retryTransient<T>(
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
  maxRetries = TRANSIENT_RETRY_MAX,
  backoffMs = TRANSIENT_RETRY_BASE_MS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === maxRetries) throw error;
      if (signal?.aborted) throw error;

      const isRateLimit = toErrorMessage(error).includes("429");
      const factor = isRateLimit ? 3 : 1;
      const delay = backoffMs * factor * 2 ** attempt;
      console.error(`[pi-ai] Transient error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay / 1000}s`);

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        if (signal) {
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        }
      });
      if (signal?.aborted) throw error;
    }
  }
  throw lastError;
}

export class PiAiAgentRuntime implements AgentRuntime {
  readonly id = "pi-ai";

  async *query(request: AgentQueryRequest): AsyncIterable<AgentMessage> {
    const startedAtMs = Date.now();
    const maxTurns = normalizeMaxTurns(request.options.maxTurns);
    const signal = request.options.abortController?.signal;
    const maxBudgetUsd = normalizeBudget(request.options.maxBudgetUsd);
    const outputFormat = request.options.outputFormat;
    const strictStructuredOutput = outputFormat?.strict === true;
    let invalidStructuredOutputRetriesRemaining = normalizeRetryCount(outputFormat?.retryInvalidStructuredOutput);
    let totalCostUsd = 0;
    let generatedToolCallCounter = 0;
    const truncatedTextParts: string[] = [];

    try {
      const modelSpec = request.options.model;
      const model = resolveModel(modelSpec);
      const enabledTools = resolveEnabledTools(request.options.allowedTools, request.options.disallowedTools);
      const context: PiAiContext = {
        systemPrompt: buildSystemPrompt(outputFormat?.schema, request.options.systemPromptPrefix),
        messages: [{ role: "user", content: request.prompt, timestamp: Date.now() }],
        ...(enabledTools.length > 0 ? { tools: enabledTools } : {}),
      };

      const toolsByName = new Map(enabledTools.map((tool) => [tool.name, tool]));

      for (let turn = 1; maxTurns == null || turn <= maxTurns; turn++) {
        if (signal?.aborted) {
          yield errorResult("error_aborted", "Agent run aborted", startedAtMs, turn - 1, totalCostUsd);
          return;
        }

        let assistant = await retryTransient(
          () => complete(model, context, { signal }),
          signal,
        );

        if (assistant.stopReason === "error" && assistant.errorMessage && isTransientError(new Error(assistant.errorMessage))) {
          let retried = false;
          for (let softRetry = 0; softRetry < TRANSIENT_RETRY_MAX; softRetry++) {
            if (signal?.aborted) break;
            const isRateLimit = /\b429\b|rate.?limit/i.test(assistant.errorMessage ?? "");
            const rateFactor = isRateLimit ? 3 : 1;
            const delay = TRANSIENT_RETRY_BASE_MS * rateFactor * 2 ** softRetry;
            console.error(`[pi-ai] Soft error (attempt ${softRetry + 1}/${TRANSIENT_RETRY_MAX}), retrying in ${delay / 1000}s`);
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, delay);
              if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
            });
            if (signal?.aborted) break;
            assistant = await complete(model, context, { signal });
            if (assistant.stopReason !== "error" || !assistant.errorMessage || !isTransientError(new Error(assistant.errorMessage))) {
              retried = true;
              break;
            }
          }
          if (!retried && assistant.stopReason === "error") {
            yield errorResult("error_runtime", assistant.errorMessage ?? "Transient error retries exhausted", startedAtMs, turn, totalCostUsd);
            return;
          }
        }

        context.messages.push(assistant);
        const turnCostUsd = extractCostUsd(assistant);
        totalCostUsd += turnCostUsd;

        const assistantContent = mapAssistantContent(assistant);
        if (assistantContent.length > 0) {
          yield { type: "assistant", content: assistantContent };
        }

        if (assistant.stopReason === "aborted" || signal?.aborted) {
          yield errorResult("error_aborted", assistant.errorMessage ?? "Aborted", startedAtMs, turn, totalCostUsd);
          return;
        }

        if (assistant.stopReason === "error") {
          yield errorResult("error_runtime", assistant.errorMessage ?? "Request failed", startedAtMs, turn, totalCostUsd);
          return;
        }

        if (assistant.stopReason === "length") {
          const hasToolCalls = assistant.content.some((block) => block.type === "toolCall");
          if (!hasToolCalls && outputFormat) {
            truncatedTextParts.push(extractText(assistant));
            context.messages.push(assistant as unknown as PiAiContext["messages"][number]);
            context.messages.push({
              role: "user",
              content: "Your response was truncated. Continue your JSON output exactly where you left off.",
              timestamp: Date.now(),
            });
            continue;
          }
        }

        const toolCalls = assistant.content.filter((block): block is PiAiToolCall => block.type === "toolCall");

        if (toolCalls.length === 0) {
          const currentText = extractText(assistant);
          const resultText = truncatedTextParts.length > 0 ? truncatedTextParts.join("") + currentText : currentText;
          const structuredResult = outputFormat ? parseStructuredOutput(resultText) : { structuredOutput: undefined, parseError: null };

          if (outputFormat && strictStructuredOutput && structuredResult.structuredOutput === undefined) {
            if (invalidStructuredOutputRetriesRemaining > 0) {
              invalidStructuredOutputRetriesRemaining -= 1;
              context.messages.push({
                role: "user",
                content: `Return JSON only matching schema; no prose/code fences.\nSchema:\n${JSON.stringify(outputFormat.schema)}`,
                timestamp: Date.now(),
              });
              continue;
            }
            yield errorResult("error_output_format", `Structured output parsing failed: ${structuredResult.parseError ?? "invalid JSON"}`, startedAtMs, turn, totalCostUsd);
            return;
          }

          yield {
            type: "result",
            subtype: "success",
            result: resultText,
            structuredOutput: structuredResult.structuredOutput,
            durationMs: Date.now() - startedAtMs,
            numTurns: turn,
            totalCostUsd: normalizeCostUsd(totalCostUsd),
          };
          return;
        }

        if (maxBudgetUsd != null && totalCostUsd > maxBudgetUsd) {
          yield errorResult("error_budget_exceeded", `Budget exceeded: $${normalizeCostUsd(totalCostUsd).toFixed(4)} > max $${maxBudgetUsd.toFixed(4)}`, startedAtMs, turn, totalCostUsd);
          return;
        }

        if (maxTurns != null && turn >= maxTurns) {
          yield errorResult("error_max_turns", `Exceeded max turns (${maxTurns})`, startedAtMs, turn, totalCostUsd);
          return;
        }

        for (const toolCall of toolCalls) {
          const toolUseId = toolCall.id || `${toolCall.name}_${Date.now()}_${++generatedToolCallCounter}`;

          const tool = toolsByName.get(toolCall.name);
          if (!tool) {
            context.messages.push({
              role: "toolResult",
              toolCallId: toolUseId,
              toolName: toolCall.name,
              content: [{ type: "text", text: `Tool "${toolCall.name}" is not enabled` }],
              isError: true,
              timestamp: Date.now(),
            });
            continue;
          }

          let validatedArgs: Record<string, unknown>;
          try {
            validatedArgs = validateToolCall(enabledTools, toolCall) as Record<string, unknown>;
          } catch (error) {
            context.messages.push({
              role: "toolResult",
              toolCallId: toolUseId,
              toolName: toolCall.name,
              content: [{ type: "text", text: toErrorMessage(error) }],
              isError: true,
              timestamp: Date.now(),
            });
            continue;
          }

          let isToolError = false;
          let toolResultText = "";
          try {
            toolResultText = await executeTool(toolCall.name, validatedArgs, request.options.cwd);
          } catch (error) {
            isToolError = true;
            toolResultText = toErrorMessage(error);
          }

          const elapsedSeconds = Math.max(0, (Date.now() - startedAtMs) / 1000);
          yield { type: "tool-progress", toolUseId, toolName: toolCall.name, elapsedSeconds };

          context.messages.push({
            role: "toolResult",
            toolCallId: toolUseId,
            toolName: toolCall.name,
            content: [{ type: "text", text: toolResultText }],
            isError: isToolError,
            timestamp: Date.now(),
          });
        }
      }

      yield errorResult("error_max_turns", `Exceeded max turns (${maxTurns ?? "unlimited"})`, startedAtMs, maxTurns ?? 0, totalCostUsd);
    } catch (error) {
      const aborted = signal?.aborted === true;
      yield errorResult(aborted ? "error_aborted" : "error_runtime", toErrorMessage(error), startedAtMs, 0, totalCostUsd);
    }
  }
}

function resolveModel(modelSpec: string) {
  const { provider, modelId } = parsePiAiModelSpec(modelSpec);
  try {
    const model = getModel(provider as KnownProvider, modelId as never);
    if (model) return model;
  } catch {
    // Fall through
  }
  throw new Error(`Unable to resolve pi-ai model "${modelSpec}"`);
}

function resolveEnabledTools(
  allowedTools: string[] | undefined,
  disallowedTools: string[] | undefined,
) {
  const allowSet = new Set<string>();
  if (Array.isArray(allowedTools)) {
    for (const name of allowedTools) {
      if (KNOWN_TOOL_NAMES.has(name)) allowSet.add(name);
    }
  } else {
    for (const name of KNOWN_TOOL_NAMES) allowSet.add(name);
  }
  if (Array.isArray(disallowedTools)) {
    for (const name of disallowedTools) allowSet.delete(name);
  }
  return PI_AI_TOOL_DEFINITIONS.filter((tool) => allowSet.has(tool.name));
}

function buildSystemPrompt(schema: Record<string, unknown> | undefined, prefix?: string): string {
  const lines: string[] = [];
  if (prefix) lines.push(prefix, "");
  lines.push(
    "You are a supply chain security agent performing deception infrastructure analysis for the Yokai platform.",
    "Use available tools (Read, Glob, Grep, Bash) when code inspection or analysis is required.",
    "When you call tools, pass valid JSON arguments.",
  );
  if (schema) {
    lines.push("", "Return the final answer as JSON only (no markdown fences).", "The JSON must match this schema exactly:", JSON.stringify(schema));
  }
  return lines.join("\n");
}

function mapAssistantContent(assistant: PiAiAssistantMessage): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = [];
  for (const block of assistant.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "thinking") content.push({ type: "text", text: block.thinking });
    else if (block.type === "toolCall") content.push({ type: "tool_use", id: block.id, name: block.name, input: isRecord(block.arguments) ? block.arguments : {} });
  }
  return content;
}

function extractText(assistant: PiAiAssistantMessage): string {
  return assistant.content
    .filter((block): block is Extract<PiAiAssistantMessage["content"][number], { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

function parseStructuredOutput(resultText: string): { structuredOutput: unknown | undefined; parseError: string | null } {
  const extracted = extractJsonObject(resultText);
  if (!extracted) return { structuredOutput: undefined, parseError: "response was empty" };
  try {
    return { structuredOutput: JSON.parse(extracted), parseError: null };
  } catch (error) {
    return { structuredOutput: undefined, parseError: toErrorMessage(error) };
  }
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function extractCostUsd(message: PiAiAssistantMessage): number {
  return normalizeCostUsd(message.usage?.cost?.total);
}

function normalizeMaxTurns(value: number | null | undefined): number | undefined {
  if (value == null) return undefined;
  if (!Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

function normalizeBudget(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value == null || value < 0) return undefined;
  return value;
}

function normalizeRetryCount(value: number | undefined): number {
  if (!Number.isFinite(value) || value == null || value < 0) return 0;
  return Math.floor(value);
}

function errorResult(subtype: string, error: string, startedAtMs: number, numTurns: number, totalCostUsd: number): AgentMessage {
  return { type: "result", subtype, errors: [error], durationMs: Date.now() - startedAtMs, numTurns, totalCostUsd: normalizeCostUsd(totalCostUsd) };
}
