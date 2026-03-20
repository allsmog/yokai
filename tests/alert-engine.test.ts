import { describe, it, expect } from "vitest";
import { classifyAlert } from "../src/detection/alert-engine.js";

describe("classifyAlert", () => {
  it("classifies canary callback as canary-download", () => {
    const alert = classifyAlert({
      runId: "test-run",
      tokenId: "tok-123",
      packageName: "@myorg/utils",
      sourceIp: "1.2.3.4",
      userAgent: "node/18",
      method: "POST",
      path: "/_yokai/callback/tok-123",
      metadata: {},
    });

    expect(alert.alertType).toBe("canary-download");
    expect(alert.packageName).toBe("@myorg/utils");
    expect(alert.sourceIp).toBe("1.2.3.4");
    expect(alert.mitre.techniqueId).toBe("T1195.002");
  });

  it("classifies CI callback as dependency-confusion", () => {
    const alert = classifyAlert({
      runId: "test-run",
      tokenId: "tok-123",
      packageName: "@myorg/utils",
      sourceIp: "1.2.3.4",
      userAgent: "npm/9",
      method: "POST",
      path: "/_yokai/callback/tok-123",
      metadata: { ci: "true", githubActions: "true" },
    });

    expect(alert.alertType).toBe("dependency-confusion");
    expect(alert.severity).toBe("critical");
  });

  it("classifies PUT as unauthorized-publish", () => {
    const alert = classifyAlert({
      runId: "test-run",
      packageName: "@myorg/utils",
      sourceIp: "1.2.3.4",
      userAgent: "npm/9",
      method: "PUT",
      path: "/@myorg/utils",
      metadata: {},
    });

    expect(alert.alertType).toBe("unauthorized-publish");
    expect(alert.severity).toBe("critical");
    expect(alert.mitre.techniqueId).toBe("T1078");
  });

  it("classifies GET metadata as namespace-probe", () => {
    const alert = classifyAlert({
      runId: "test-run",
      packageName: "@myorg/utils",
      sourceIp: "1.2.3.4",
      userAgent: "npm/9",
      method: "GET",
      path: "/@myorg/utils",
      metadata: { action: "metadata-resolve" },
    });

    expect(alert.alertType).toBe("namespace-probe");
    expect(alert.mitre.techniqueId).toBe("T1592");
  });

  it("classifies tarball download as canary-download", () => {
    const alert = classifyAlert({
      runId: "test-run",
      packageName: "@myorg/utils",
      sourceIp: "1.2.3.4",
      userAgent: "npm/9",
      method: "GET",
      path: "/@myorg/utils/-/utils-1.0.0.tgz",
      metadata: { action: "tarball-download" },
    });

    expect(alert.alertType).toBe("canary-download");
  });

  it("includes proper MITRE mappings", () => {
    const alert = classifyAlert({
      runId: "test-run",
      method: "GET",
      path: "/test",
      metadata: {},
    });

    expect(alert.mitre).toHaveProperty("techniqueId");
    expect(alert.mitre).toHaveProperty("techniqueName");
    expect(alert.mitre).toHaveProperty("tactic");
  });
});
