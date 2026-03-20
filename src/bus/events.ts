import type { EventEnvelope } from "./types.js";
import type { StageId, Severity, AlertType } from "../types.js";

// ── Pipeline Events ──

export type PipelineStartEvent = EventEnvelope<"pipeline:start", {
  runId: string;
  stages: StageId[];
}>;

export type PipelineCompleteEvent = EventEnvelope<"pipeline:complete", {
  runId: string;
  durationMs: number;
  totalCostUsd: number;
}>;

export type PipelineErrorEvent = EventEnvelope<"pipeline:error", {
  runId: string;
  error: string;
}>;

// ── Stage Events ──

export type StageStartEvent = EventEnvelope<"stage:start", {
  stageId: StageId;
  runId: string;
}>;

export type StageProgressEvent = EventEnvelope<"stage:progress", {
  stageId: StageId;
  runId: string;
  message: string;
}>;

export type StageCompleteEvent = EventEnvelope<"stage:complete", {
  stageId: StageId;
  runId: string;
  durationMs: number;
  costUsd: number;
}>;

export type StageErrorEvent = EventEnvelope<"stage:error", {
  stageId: StageId;
  runId: string;
  error: string;
}>;

export type StageSkippedEvent = EventEnvelope<"stage:skipped", {
  stageId: StageId;
  runId: string;
  reason: string;
}>;

// ── Alert Events ──

export type AlertTriggeredEvent = EventEnvelope<"alert:triggered", {
  alertId: string;
  alertType: AlertType;
  severity: Severity;
  packageName?: string;
  sourceIp?: string;
}>;

// ── Registry Events ──

export type RegistryRequestEvent = EventEnvelope<"registry:request", {
  method: string;
  path: string;
  sourceIp: string;
  userAgent: string;
}>;

export type RegistryCanaryHitEvent = EventEnvelope<"registry:canary-hit", {
  tokenId: string;
  packageName: string;
  sourceIp: string;
}>;

// ── Report Events ──

export type ReportCompleteEvent = EventEnvelope<"report:complete", {
  format: "json" | "sarif";
  path: string;
}>;

export type YokaiEvent =
  | PipelineStartEvent
  | PipelineCompleteEvent
  | PipelineErrorEvent
  | StageStartEvent
  | StageProgressEvent
  | StageCompleteEvent
  | StageErrorEvent
  | StageSkippedEvent
  | AlertTriggeredEvent
  | RegistryRequestEvent
  | RegistryCanaryHitEvent
  | ReportCompleteEvent;
