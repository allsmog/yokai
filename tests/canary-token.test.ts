import { describe, it, expect } from "vitest";
import { createCanaryToken, generatePostinstallScript, createCanaryTokenBatch } from "../src/canary/token.js";

describe("createCanaryToken", () => {
  it("creates a token with correct fields", () => {
    const token = createCanaryToken("@myorg/utils", "http://localhost:4873");

    expect(token.id).toBeTruthy();
    expect(token.packageName).toBe("@myorg/utils");
    expect(token.callbackUrl).toContain("http://localhost:4873/_yokai/callback/");
    expect(token.callbackUrl).toContain(token.id);
    expect(token.type).toBe("postinstall");
    expect(token.createdAt).toBeTruthy();
  });

  it("creates token with custom type", () => {
    const token = createCanaryToken("@myorg/utils", "http://localhost:4873", "preinstall");
    expect(token.type).toBe("preinstall");
  });
});

describe("generatePostinstallScript", () => {
  it("generates a valid Node.js script", () => {
    const token = createCanaryToken("@myorg/utils", "http://localhost:4873");
    const script = generatePostinstallScript(token);

    expect(script).toContain("#!/usr/bin/env node");
    expect(script).toContain(token.id);
    expect(script).toContain(token.packageName);
    expect(script).toContain(token.callbackUrl);
    expect(script).toContain("os.hostname()");
    expect(script).toContain("process.env.CI");
    expect(script).toContain("process.env.GITHUB_ACTIONS");
    expect(script).toContain("npm_config_registry");
  });
});

describe("createCanaryTokenBatch", () => {
  it("creates tokens for all names", () => {
    const names = ["@myorg/a", "@myorg/b", "@myorg/c"];
    const tokens = createCanaryTokenBatch(names, "http://localhost:4873");

    expect(tokens.length).toBe(3);
    expect(tokens[0].packageName).toBe("@myorg/a");
    expect(tokens[1].packageName).toBe("@myorg/b");
    expect(tokens[2].packageName).toBe("@myorg/c");

    // All IDs should be unique
    const ids = new Set(tokens.map((t) => t.id));
    expect(ids.size).toBe(3);
  });
});
