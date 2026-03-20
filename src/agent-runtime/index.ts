import type { AgentRuntime } from "./types.js";
import { PiAiAgentRuntime } from "./pi-ai.js";

export type { AgentRuntime, AgentMessage, AgentQueryRequest, AgentQueryOptions, AgentResultSuccessMessage, AgentResultErrorMessage } from "./types.js";
export { PiAiAgentRuntime } from "./pi-ai.js";

let runtimeInstance: AgentRuntime | undefined;

export function getAgentRuntime(): AgentRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new PiAiAgentRuntime();
  }
  return runtimeInstance;
}

export function setAgentRuntime(runtime: AgentRuntime): void {
  runtimeInstance = runtime;
}
