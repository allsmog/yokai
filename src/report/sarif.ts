import type { Alert } from "../types.js";

type SarifLevel = "error" | "warning" | "note";

export function generateSarifReport(
  runId: string,
  alerts: Alert[],
  repoPath?: string,
): string {
  const rulesById = new Map<string, { id: string; level: SarifLevel; tags: Set<string> }>();
  const results: Array<Record<string, unknown>> = [];

  for (const alert of alerts) {
    const level = severityToSarifLevel(alert.severity);
    const ruleId = `yokai/${alert.alertType}`;
    upsertRule(rulesById, ruleId, level, [
      alert.mitre.techniqueId,
      alert.mitre.tactic,
    ]);

    results.push({
      ruleId,
      level,
      message: { text: `${alert.title}\n\n${alert.description}` },
      locations: [buildLocation(repoPath ?? ".", 1)],
      properties: {
        alertId: alert.id,
        alertType: alert.alertType,
        severity: alert.severity,
        sourceIp: alert.sourceIp,
        userAgent: alert.userAgent,
        packageName: alert.packageName,
        mitre: {
          techniqueId: alert.mitre.techniqueId,
          techniqueName: alert.mitre.techniqueName,
          tactic: alert.mitre.tactic,
        },
        metadata: alert.metadata,
        createdAt: alert.createdAt,
      },
    });
  }

  const rules = [...rulesById.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((rule) => ({
      id: rule.id,
      shortDescription: { text: ruleIdToDescription(rule.id) },
      defaultConfiguration: { level: rule.level },
      ...(rule.tags.size > 0 ? { properties: { tags: [...rule.tags].sort() } } : {}),
    }));

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "yokai",
          version: "0.1.0",
          informationUri: "https://github.com/allsmog/yokai",
          rules,
        },
      },
      automationDetails: { id: runId },
      results,
      properties: {
        repoPath,
      },
    }],
  };

  return JSON.stringify(sarif, null, 2) + "\n";
}

function severityToSarifLevel(severity: string): SarifLevel {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "note";
}

function buildLocation(filePath: string, startLine: number): Record<string, unknown> {
  const uri = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return {
    physicalLocation: {
      artifactLocation: { uri: uri || "." },
      region: { startLine: Math.max(1, startLine) },
    },
  };
}

function upsertRule(
  rules: Map<string, { id: string; level: SarifLevel; tags: Set<string> }>,
  id: string,
  level: SarifLevel,
  tags: string[],
): void {
  const existing = rules.get(id);
  if (!existing) {
    rules.set(id, { id, level, tags: new Set(tags) });
    return;
  }
  if (severityRank(level) > severityRank(existing.level)) existing.level = level;
  for (const tag of tags) existing.tags.add(tag);
}

function severityRank(level: SarifLevel): number {
  if (level === "error") return 3;
  if (level === "warning") return 2;
  return 1;
}

function ruleIdToDescription(ruleId: string): string {
  const type = ruleId.replace("yokai/", "");
  const descriptions: Record<string, string> = {
    "dependency-confusion": "Dependency confusion attack detected",
    "credential-probe": "Credential probe detected on canary registry",
    "unauthorized-publish": "Unauthorized package publish attempt",
    "canary-download": "Canary package download detected",
    "namespace-probe": "Internal namespace reconnaissance detected",
    "typosquat-claim": "Typosquat package name claimed",
    "config-tamper": "Registry configuration tamper detected",
    unknown: "Unknown supply chain activity",
  };
  return descriptions[type] ?? `Supply chain alert: ${type}`;
}
