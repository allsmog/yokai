import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { dispatchWebhook, dispatchToAll, type WebhookConfig } from "../src/integrations/webhooks.js";
import type { Alert } from "../src/types.js";

const mockAlert: Alert = {
  id: "alert-wh-1",
  runId: "run-1",
  tokenId: "tok-1",
  alertType: "dependency-confusion",
  severity: "critical",
  title: "Dependency confusion detected: @myorg/utils",
  description: "A canary package was installed in CI/CD",
  sourceIp: "1.2.3.4",
  userAgent: "npm/9",
  packageName: "@myorg/utils",
  mitre: {
    techniqueId: "T1195.002",
    techniqueName: "Supply Chain Compromise",
    tactic: "Initial Access",
  },
  metadata: { ci: true },
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("webhooks", () => {
  let port: number;
  let mockServer: ReturnType<typeof serve>;
  let receivedPayloads: Array<{ headers: Record<string, string>; body: unknown }>;

  beforeAll(async () => {
    port = 19950 + Math.floor(Math.random() * 1000);
    receivedPayloads = [];

    const app = new Hono();
    app.post("/webhook", async (c) => {
      const body = await c.req.json();
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((v, k) => { headers[k] = v; });
      receivedPayloads.push({ headers, body });
      return c.json({ ok: true });
    });

    app.post("/webhook-fail", (c) => {
      return c.json({ error: "bad" }, 500);
    });

    mockServer = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });

    // Wait for ready
    for (let i = 0; i < 20; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/webhook`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    receivedPayloads = []; // Clear startup probe
  });

  afterAll(() => {
    mockServer?.close();
  });

  it("dispatches generic webhook", async () => {
    const config: WebhookConfig = {
      provider: "generic",
      url: `http://127.0.0.1:${port}/webhook`,
    };

    const ok = await dispatchWebhook(config, mockAlert);
    expect(ok).toBe(true);
    expect(receivedPayloads.length).toBe(1);

    const payload = receivedPayloads[0].body as Record<string, unknown>;
    expect(payload.event).toBe("yokai:alert");
    expect((payload.alert as Record<string, unknown>).type).toBe("dependency-confusion");
  });

  it("dispatches slack-formatted webhook", async () => {
    receivedPayloads = [];
    const config: WebhookConfig = {
      provider: "slack",
      url: `http://127.0.0.1:${port}/webhook`,
    };

    const ok = await dispatchWebhook(config, mockAlert);
    expect(ok).toBe(true);

    const payload = receivedPayloads[0].body as Record<string, unknown>;
    expect(payload.blocks).toBeDefined();
    expect(Array.isArray(payload.blocks)).toBe(true);
  });

  it("dispatches teams-formatted webhook", async () => {
    receivedPayloads = [];
    const config: WebhookConfig = {
      provider: "teams",
      url: `http://127.0.0.1:${port}/webhook`,
    };

    const ok = await dispatchWebhook(config, mockAlert);
    expect(ok).toBe(true);

    const payload = receivedPayloads[0].body as Record<string, unknown>;
    expect(payload["@type"]).toBe("MessageCard");
  });

  it("dispatches pagerduty-formatted webhook", async () => {
    receivedPayloads = [];
    const config: WebhookConfig = {
      provider: "pagerduty",
      url: `http://127.0.0.1:${port}/webhook`,
    };

    const ok = await dispatchWebhook(config, mockAlert);
    expect(ok).toBe(true);

    const payload = receivedPayloads[0].body as Record<string, unknown>;
    expect(payload.event_action).toBe("trigger");
    expect((payload.payload as Record<string, unknown>).severity).toBe("critical");
  });

  it("filters by minSeverity", async () => {
    receivedPayloads = [];
    const config: WebhookConfig = {
      provider: "generic",
      url: `http://127.0.0.1:${port}/webhook`,
      minSeverity: "critical",
    };

    const lowAlert = { ...mockAlert, severity: "low" as const };
    const ok = await dispatchWebhook(config, lowAlert);
    expect(ok).toBe(false);
    expect(receivedPayloads.length).toBe(0);

    // Critical should pass
    const ok2 = await dispatchWebhook(config, mockAlert);
    expect(ok2).toBe(true);
    expect(receivedPayloads.length).toBe(1);
  });

  it("adds HMAC signature for generic webhooks with secret", async () => {
    receivedPayloads = [];
    const config: WebhookConfig = {
      provider: "generic",
      url: `http://127.0.0.1:${port}/webhook`,
      secret: "my-secret-key",
    };

    const ok = await dispatchWebhook(config, mockAlert);
    expect(ok).toBe(true);

    const sig = receivedPayloads[0].headers["x-yokai-signature"];
    expect(sig).toBeDefined();
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("returns false on failed webhook", async () => {
    const config: WebhookConfig = {
      provider: "generic",
      url: `http://127.0.0.1:${port}/webhook-fail`,
    };

    const ok = await dispatchWebhook(config, mockAlert);
    expect(ok).toBe(false);
  });

  it("dispatches to multiple webhooks", async () => {
    receivedPayloads = [];
    const configs: WebhookConfig[] = [
      { provider: "generic", url: `http://127.0.0.1:${port}/webhook` },
      { provider: "slack", url: `http://127.0.0.1:${port}/webhook` },
    ];

    const results = await dispatchToAll(configs, mockAlert);
    expect(results.size).toBe(2);
    for (const ok of results.values()) {
      expect(ok).toBe(true);
    }
    expect(receivedPayloads.length).toBe(2);
  });
});
