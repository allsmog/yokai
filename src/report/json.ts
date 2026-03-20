import type { YokaiReport, ReportSummary } from "./types.js";
import type {
  Alert, CanaryPackage, CanaryToken,
  DiscoveredNamespace, RegistryInteraction,
} from "../types.js";

export function generateJsonReport(
  runId: string,
  repoPath: string | undefined,
  namespaces: DiscoveredNamespace[],
  packages: CanaryPackage[],
  tokens: CanaryToken[],
  alerts: Alert[],
  interactions: RegistryInteraction[],
  totalCostUsd: number,
  durationMs: number,
): string {
  const report: YokaiReport = {
    version: "1.0",
    runId,
    generatedAt: new Date().toISOString(),
    totalCostUsd,
    durationMs,
    repoPath,
    namespaces,
    canaryPackages: packages,
    tokens,
    alerts,
    interactions,
    summary: buildSummary(namespaces, packages, alerts, interactions),
  };

  return JSON.stringify(report, null, 2) + "\n";
}

function buildSummary(
  namespaces: DiscoveredNamespace[],
  packages: CanaryPackage[],
  alerts: Alert[],
  interactions: RegistryInteraction[],
): ReportSummary {
  const alertsByType: Record<string, number> = {};
  for (const alert of alerts) {
    alertsByType[alert.alertType] = (alertsByType[alert.alertType] ?? 0) + 1;
  }

  return {
    totalNamespaces: namespaces.length,
    totalCanaryPackages: packages.length,
    totalAlerts: alerts.length,
    totalInteractions: interactions.length,
    criticalAlerts: alerts.filter((a) => a.severity === "critical").length,
    highAlerts: alerts.filter((a) => a.severity === "high").length,
    mediumAlerts: alerts.filter((a) => a.severity === "medium").length,
    lowAlerts: alerts.filter((a) => a.severity === "low").length,
    alertsByType,
  };
}
