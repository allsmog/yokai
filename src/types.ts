// ── Stage IDs ──

export type StageId =
  | "s1-discover-namespaces"
  | "s2-generate-canaries"
  | "s3-deploy-registries"
  | "s4-configure-monitoring"
  | "s5-baseline-traffic";

export const ALL_STAGE_IDS: StageId[] = [
  "s1-discover-namespaces",
  "s2-generate-canaries",
  "s3-deploy-registries",
  "s4-configure-monitoring",
  "s5-baseline-traffic",
];

// ── Severity & Risk ──

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type AlertType =
  | "dependency-confusion"
  | "credential-probe"
  | "unauthorized-publish"
  | "canary-download"
  | "namespace-probe"
  | "typosquat-claim"
  | "config-tamper"
  | "unknown";

// ── MITRE ATT&CK ──

export interface MitreMapping {
  techniqueId: string;
  techniqueName: string;
  tactic: string;
}

export const MITRE_MAPPINGS: Record<AlertType, MitreMapping> = {
  "dependency-confusion": {
    techniqueId: "T1195.002",
    techniqueName: "Supply Chain Compromise: Compromise Software Supply Chain",
    tactic: "Initial Access",
  },
  "credential-probe": {
    techniqueId: "T1078",
    techniqueName: "Valid Accounts",
    tactic: "Persistence",
  },
  "unauthorized-publish": {
    techniqueId: "T1078",
    techniqueName: "Valid Accounts",
    tactic: "Persistence",
  },
  "canary-download": {
    techniqueId: "T1195.002",
    techniqueName: "Supply Chain Compromise: Compromise Software Supply Chain",
    tactic: "Initial Access",
  },
  "namespace-probe": {
    techniqueId: "T1592",
    techniqueName: "Gather Victim Host Information",
    tactic: "Reconnaissance",
  },
  "typosquat-claim": {
    techniqueId: "T1195.002",
    techniqueName: "Supply Chain Compromise: Compromise Software Supply Chain",
    tactic: "Initial Access",
  },
  "config-tamper": {
    techniqueId: "T1195.001",
    techniqueName: "Supply Chain Compromise: Compromise Software Dependencies and Development Tools",
    tactic: "Initial Access",
  },
  unknown: {
    techniqueId: "T1195",
    techniqueName: "Supply Chain Compromise",
    tactic: "Initial Access",
  },
};

// ── Canary Package ──

export interface CanaryPackage {
  name: string;
  version: string;
  description: string;
  tarballPath?: string;
  tokenId: string;
  createdAt: string;
}

// ── Canary Token ──

export interface CanaryToken {
  id: string;
  packageName: string;
  callbackUrl: string;
  createdAt: string;
  type: "postinstall" | "preinstall" | "resolve" | "download" | "publish";
}

// ── Alert ──

export interface Alert {
  id: string;
  runId: string;
  tokenId?: string;
  alertType: AlertType;
  severity: Severity;
  title: string;
  description: string;
  sourceIp?: string;
  userAgent?: string;
  packageName?: string;
  mitre: MitreMapping;
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ── Interaction (registry access log) ──

export interface RegistryInteraction {
  id: string;
  runId: string;
  method: string;
  path: string;
  sourceIp: string;
  userAgent: string;
  packageName?: string;
  tokenId?: string;
  createdAt: string;
}

// ── Namespace Discovery ──

export interface DiscoveredNamespace {
  name: string;
  source: string;
  registry?: string;
  scope?: string;
  isScoped: boolean;
}

// ── Config ──

export interface YokaiConfig {
  mode: "standalone" | "proxy" | "git-decoy";
  protocol: "npm" | "pypi" | "maven" | "go" | "cargo";
  upstreamUrl?: string;
  upstreamApiUrl?: string;
  upstreamIndexUrl?: string;
  model: string;
  modelExplicitlyConfigured: boolean;
  stageModels: Partial<Record<StageId, string>>;
  stages: StageId[];
  resumeRunId?: string;
  jsonOutput?: string;
  sarifOutput?: string;
  port: number;
  host: string;
  callbackBaseUrl: string;
  repoPath?: string;
  maxBudgetUsd?: number;
  baselineWindowMs: number;
  verbose: boolean;
}

// ── Pipeline Context ──

export interface YokaiTaskContext {
  runId: string;
  config: YokaiConfig;
  bus: import("./bus/types.js").MessageBus;
  db: import("better-sqlite3").Database;
  upstreamOutputs: Map<string, unknown>;
  abortSignal?: AbortSignal;
}

// ── Input Summary ──

export interface InputSummary {
  repoPath: string;
  namespaces: DiscoveredNamespace[];
}

// ── Stage Outputs ──

export interface DiscoverNamespacesOutput {
  namespaces: DiscoveredNamespace[];
  costUsd: number;
}

export interface GenerateCanariesOutput {
  packages: CanaryPackage[];
  tokens: CanaryToken[];
  costUsd: number;
}

export interface DeployRegistriesOutput {
  registryUrl: string;
  port: number;
  packages: string[];
  costUsd: number;
}

export interface ConfigureMonitoringOutput {
  alertRules: Array<{ type: AlertType; enabled: boolean }>;
  callbackUrl: string;
  costUsd: number;
}

export interface BaselineTrafficOutput {
  baselineInteractions: number;
  baselineDurationMs: number;
  readyAt: string;
  baselineWindowMs: number;
  signatures: Array<{
    protocol: string;
    method: string;
    path: string;
    packageName?: string;
    count: number;
  }>;
  costUsd: number;
}
