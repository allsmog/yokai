import type { Alert } from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ stage: "webhooks" });

export type WebhookProvider = "slack" | "teams" | "pagerduty" | "generic";

export interface WebhookConfig {
  provider: WebhookProvider;
  url: string;
  /** Optional secret for HMAC signing (generic webhooks). */
  secret?: string;
  /** Only dispatch alerts at or above this severity. */
  minSeverity?: "critical" | "high" | "medium" | "low" | "info";
}

const SEVERITY_ORDER: Record<string, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Dispatch an alert to a webhook endpoint.
 */
export async function dispatchWebhook(config: WebhookConfig, alert: Alert): Promise<boolean> {
  // Filter by minimum severity
  if (config.minSeverity) {
    const alertLevel = SEVERITY_ORDER[alert.severity] ?? 0;
    const minLevel = SEVERITY_ORDER[config.minSeverity] ?? 0;
    if (alertLevel < minLevel) {
      log.debug(`Skipping webhook for ${alert.alertType} (${alert.severity} < ${config.minSeverity})`);
      return false;
    }
  }

  try {
    const payload = buildPayload(config.provider, alert);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "yokai/0.1.0",
    };

    // HMAC signing for generic webhooks
    if (config.secret && config.provider === "generic") {
      const signature = await hmacSign(config.secret, JSON.stringify(payload));
      headers["X-Yokai-Signature"] = `sha256=${signature}`;
    }

    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      log.warn(`Webhook ${config.provider} returned ${response.status}: ${await response.text()}`);
      return false;
    }

    log.info(`Webhook dispatched to ${config.provider}: ${alert.alertType} (${alert.severity})`);
    return true;
  } catch (err) {
    log.error(`Webhook dispatch failed for ${config.provider}: ${err}`);
    return false;
  }
}

/**
 * Dispatch an alert to multiple webhook endpoints.
 */
export async function dispatchToAll(configs: WebhookConfig[], alert: Alert): Promise<Map<string, boolean>> {
  const results = new Map<string, boolean>();

  await Promise.all(
    configs.map(async (config) => {
      const ok = await dispatchWebhook(config, alert);
      results.set(`${config.provider}:${config.url}`, ok);
    }),
  );

  return results;
}

function buildPayload(provider: WebhookProvider, alert: Alert): Record<string, unknown> {
  switch (provider) {
    case "slack":
      return buildSlackPayload(alert);
    case "teams":
      return buildTeamsPayload(alert);
    case "pagerduty":
      return buildPagerDutyPayload(alert);
    case "generic":
    default:
      return buildGenericPayload(alert);
  }
}

function buildSlackPayload(alert: Alert): Record<string, unknown> {
  const severityEmoji: Record<string, string> = {
    critical: ":rotating_light:",
    high: ":warning:",
    medium: ":large_yellow_circle:",
    low: ":information_source:",
    info: ":speech_balloon:",
  };

  const emoji = severityEmoji[alert.severity] ?? ":question:";

  return {
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${emoji} Yokai Alert: ${alert.alertType}`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Severity:*\n${alert.severity.toUpperCase()}` },
          { type: "mrkdwn", text: `*Type:*\n${alert.alertType}` },
          { type: "mrkdwn", text: `*Package:*\n${alert.packageName ?? "N/A"}` },
          { type: "mrkdwn", text: `*Source IP:*\n${alert.sourceIp ?? "N/A"}` },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${alert.title}*\n${alert.description}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `MITRE ATT&CK: ${alert.mitre.techniqueId} — ${alert.mitre.techniqueName} | ${alert.createdAt}`,
          },
        ],
      },
    ],
  };
}

function buildTeamsPayload(alert: Alert): Record<string, unknown> {
  const themeColor: Record<string, string> = {
    critical: "FF0000",
    high: "FF6600",
    medium: "FFCC00",
    low: "0099FF",
    info: "999999",
  };

  return {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: themeColor[alert.severity] ?? "999999",
    summary: `Yokai Alert: ${alert.alertType} (${alert.severity})`,
    sections: [
      {
        activityTitle: `Yokai Alert: ${alert.alertType}`,
        activitySubtitle: alert.title,
        facts: [
          { name: "Severity", value: alert.severity.toUpperCase() },
          { name: "Alert Type", value: alert.alertType },
          { name: "Package", value: alert.packageName ?? "N/A" },
          { name: "Source IP", value: alert.sourceIp ?? "N/A" },
          { name: "MITRE", value: `${alert.mitre.techniqueId} — ${alert.mitre.techniqueName}` },
        ],
        text: alert.description,
      },
    ],
  };
}

function buildPagerDutyPayload(alert: Alert): Record<string, unknown> {
  const pdSeverity: Record<string, string> = {
    critical: "critical",
    high: "error",
    medium: "warning",
    low: "info",
    info: "info",
  };

  return {
    routing_key: "", // Must be set by the user in the webhook URL or config
    event_action: "trigger",
    payload: {
      summary: `[Yokai] ${alert.title}`,
      severity: pdSeverity[alert.severity] ?? "info",
      source: "yokai",
      component: alert.packageName ?? "unknown",
      custom_details: {
        alert_type: alert.alertType,
        description: alert.description,
        source_ip: alert.sourceIp,
        user_agent: alert.userAgent,
        mitre_technique: alert.mitre.techniqueId,
        mitre_tactic: alert.mitre.tactic,
        metadata: alert.metadata,
      },
    },
  };
}

function buildGenericPayload(alert: Alert): Record<string, unknown> {
  return {
    event: "yokai:alert",
    version: "1.0",
    alert: {
      id: alert.id,
      runId: alert.runId,
      type: alert.alertType,
      severity: alert.severity,
      title: alert.title,
      description: alert.description,
      packageName: alert.packageName,
      sourceIp: alert.sourceIp,
      userAgent: alert.userAgent,
      mitre: alert.mitre,
      metadata: alert.metadata,
      createdAt: alert.createdAt,
    },
  };
}

async function hmacSign(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
