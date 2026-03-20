import type { AlertType, Severity } from "../types.js";
import type { AlertInput } from "./alert-engine.js";

/**
 * Score the severity of an alert based on type and context.
 */
export function scoreSeverity(alertType: AlertType, input: AlertInput): Severity {
  const baseSeverity = BASE_SEVERITY[alertType] ?? "medium";
  let score = SEVERITY_SCORES[baseSeverity];

  // Boost if from CI/CD
  if (input.metadata?.["ci"] || input.metadata?.["githubActions"] || input.metadata?.["jenkinsUrl"]) {
    score += 2;
  }

  // Boost if package name matches a known pattern
  if (input.packageName && isHighValueTarget(input.packageName)) {
    score += 1;
  }

  // Boost if user agent suggests automation
  if (input.userAgent && isAutomatedAgent(input.userAgent)) {
    score += 1;
  }

  return scoreToSeverity(score);
}

const BASE_SEVERITY: Record<AlertType, Severity> = {
  "dependency-confusion": "critical",
  "credential-probe": "high",
  "unauthorized-publish": "critical",
  "canary-download": "high",
  "namespace-probe": "medium",
  "typosquat-claim": "high",
  "config-tamper": "high",
  unknown: "low",
};

const SEVERITY_SCORES: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function scoreToSeverity(score: number): Severity {
  if (score >= 4) return "critical";
  if (score >= 3) return "high";
  if (score >= 2) return "medium";
  if (score >= 1) return "low";
  return "info";
}

function isHighValueTarget(packageName: string): boolean {
  const highValuePatterns = [
    /auth/i, /login/i, /token/i, /secret/i, /credential/i,
    /payment/i, /billing/i, /crypto/i, /key/i, /session/i,
    /admin/i, /config/i, /deploy/i, /ci/i, /build/i,
  ];
  return highValuePatterns.some((p) => p.test(packageName));
}

function isAutomatedAgent(userAgent: string): boolean {
  const automationPatterns = [
    /npm\//i, /yarn\//i, /pnpm\//i, /pip\//i, /node\//i,
    /curl/i, /wget/i, /python-requests/i, /go-http-client/i,
  ];
  return automationPatterns.some((p) => p.test(userAgent));
}
