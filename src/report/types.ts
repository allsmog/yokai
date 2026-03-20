import type { Alert, CanaryPackage, CanaryToken, DiscoveredNamespace, RegistryInteraction } from "../types.js";

export interface YokaiReport {
  version: string;
  runId: string;
  generatedAt: string;
  totalCostUsd: number;
  durationMs: number;
  repoPath?: string;
  namespaces: DiscoveredNamespace[];
  canaryPackages: CanaryPackage[];
  tokens: CanaryToken[];
  alerts: Alert[];
  interactions: RegistryInteraction[];
  summary: ReportSummary;
}

export interface ReportSummary {
  totalNamespaces: number;
  totalCanaryPackages: number;
  totalAlerts: number;
  totalInteractions: number;
  criticalAlerts: number;
  highAlerts: number;
  mediumAlerts: number;
  lowAlerts: number;
  alertsByType: Record<string, number>;
}
