import { describe, it, expect } from "vitest";
import { generateJsonReport } from "../src/report/json.js";
import { generateSarifReport } from "../src/report/sarif.js";
import type { Alert } from "../src/types.js";

const sampleAlert: Alert = {
  id: "alert-1",
  runId: "run-1",
  tokenId: "tok-1",
  alertType: "dependency-confusion",
  severity: "critical",
  title: "Dependency confusion detected",
  description: "Package @myorg/utils was installed in CI/CD",
  sourceIp: "1.2.3.4",
  userAgent: "npm/9",
  packageName: "@myorg/utils",
  mitre: {
    techniqueId: "T1195.002",
    techniqueName: "Supply Chain Compromise: Compromise Software Supply Chain",
    tactic: "Initial Access",
  },
  metadata: { ci: true },
  createdAt: "2024-01-01T00:00:00.000Z",
};

describe("generateJsonReport", () => {
  it("generates valid JSON report", () => {
    const report = generateJsonReport(
      "run-1", "/path/to/repo",
      [{ name: "@myorg/utils", source: "package.json", isScoped: true }],
      [{ name: "@myorg/utils", version: "0.0.1-canary", description: "test", tokenId: "tok-1", createdAt: "2024-01-01T00:00:00.000Z" }],
      [{ id: "tok-1", packageName: "@myorg/utils", callbackUrl: "http://localhost:4873/_yokai/callback/tok-1", createdAt: "2024-01-01T00:00:00.000Z", type: "postinstall" }],
      [sampleAlert],
      [],
      0.01,
      1000,
    );

    const parsed = JSON.parse(report);
    expect(parsed.version).toBe("1.0");
    expect(parsed.runId).toBe("run-1");
    expect(parsed.summary.totalAlerts).toBe(1);
    expect(parsed.summary.criticalAlerts).toBe(1);
    expect(parsed.summary.alertsByType["dependency-confusion"]).toBe(1);
  });
});

describe("generateSarifReport", () => {
  it("generates valid SARIF 2.1.0", () => {
    const report = generateSarifReport("run-1", [sampleAlert], "/path/to/repo");
    const parsed = JSON.parse(report);

    expect(parsed.version).toBe("2.1.0");
    expect(parsed.$schema).toContain("sarif-2.1.0");
    expect(parsed.runs.length).toBe(1);
    expect(parsed.runs[0].tool.driver.name).toBe("yokai");
    expect(parsed.runs[0].results.length).toBe(1);
    expect(parsed.runs[0].results[0].level).toBe("error");
    expect(parsed.runs[0].results[0].properties.mitre.techniqueId).toBe("T1195.002");
  });

  it("maps severity to SARIF levels correctly", () => {
    const alerts: Alert[] = [
      { ...sampleAlert, id: "a1", severity: "critical", alertType: "dependency-confusion" },
      { ...sampleAlert, id: "a2", severity: "high", alertType: "canary-download" },
      { ...sampleAlert, id: "a3", severity: "medium", alertType: "namespace-probe" },
      { ...sampleAlert, id: "a4", severity: "low", alertType: "unknown" },
    ];

    const report = generateSarifReport("run-1", alerts);
    const parsed = JSON.parse(report);

    const levels = parsed.runs[0].results.map((r: { level: string }) => r.level);
    expect(levels).toContain("error");   // critical + high
    expect(levels).toContain("warning"); // medium
    expect(levels).toContain("note");    // low
  });
});
