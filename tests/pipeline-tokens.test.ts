import { describe, it, expect } from "vitest";
import {
  generateNpmrcCanary,
  generatePipConfCanary,
  generateMavenSettingsCanary,
  generateGoProxyCanary,
  generateYarnrcCanary,
  generateAllPipelineCanaries,
} from "../src/canary/pipeline-tokens.js";

describe("pipeline-tokens", () => {
  const config = {
    registryUrl: "http://canary.internal:4873",
    scope: "@myorg",
    authToken: "tok-secret-123",
  };

  describe("generateNpmrcCanary", () => {
    it("generates scoped registry config", () => {
      const npmrc = generateNpmrcCanary(config);
      expect(npmrc).toContain("@myorg:registry=http://canary.internal:4873");
      expect(npmrc).toContain("_authToken=tok-secret-123");
      expect(npmrc).toContain("Yokai canary");
    });

    it("generates global registry without scope", () => {
      const npmrc = generateNpmrcCanary({ registryUrl: "http://canary:4873" });
      expect(npmrc).toContain("registry=http://canary:4873");
      expect(npmrc).not.toContain("@");
    });
  });

  describe("generatePipConfCanary", () => {
    it("generates pip.conf with index-url", () => {
      const pipConf = generatePipConfCanary(config);
      expect(pipConf).toContain("[global]");
      expect(pipConf).toContain("index-url");
      expect(pipConf).toContain("canary.internal");
      expect(pipConf).toContain("/simple/");
    });

    it("embeds auth token in URL", () => {
      const pipConf = generatePipConfCanary(config);
      expect(pipConf).toContain("__token__");
      expect(pipConf).toContain("tok-secret-123");
    });
  });

  describe("generateMavenSettingsCanary", () => {
    it("generates valid Maven settings.xml", () => {
      const xml = generateMavenSettingsCanary(config);
      expect(xml).toContain('<?xml version="1.0"');
      expect(xml).toContain("<repository>");
      expect(xml).toContain("http://canary.internal:4873");
      expect(xml).toContain("<activeProfile>yokai-canary</activeProfile>");
      expect(xml).toContain("<password>tok-secret-123</password>");
    });

    it("uses scope as repo ID", () => {
      const xml = generateMavenSettingsCanary(config);
      expect(xml).toContain("<id>myorg</id>");
    });
  });

  describe("generateGoProxyCanary", () => {
    it("generates GOPROXY value with fallback", () => {
      const goproxy = generateGoProxyCanary(config);
      expect(goproxy).toBe("http://canary.internal:4873,direct");
    });
  });

  describe("generateYarnrcCanary", () => {
    it("generates scoped .yarnrc.yml", () => {
      const yarnrc = generateYarnrcCanary(config);
      expect(yarnrc).toContain("npmScopes:");
      expect(yarnrc).toContain('"myorg"');
      expect(yarnrc).toContain("npmRegistryServer");
      expect(yarnrc).toContain("npmAuthToken");
    });

    it("generates global .yarnrc.yml without scope", () => {
      const yarnrc = generateYarnrcCanary({ registryUrl: "http://canary:4873" });
      expect(yarnrc).toContain("npmRegistryServer");
      expect(yarnrc).not.toContain("npmScopes");
    });
  });

  describe("generateAllPipelineCanaries", () => {
    it("generates all config types", () => {
      const all = generateAllPipelineCanaries(config);
      expect(Object.keys(all)).toEqual([".npmrc", "pip.conf", "settings.xml", "GOPROXY", ".yarnrc.yml"]);
      for (const content of Object.values(all)) {
        expect(content.length).toBeGreaterThan(0);
      }
    });
  });
});
