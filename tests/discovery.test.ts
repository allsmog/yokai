import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanForNamespaces, extractScopes } from "../src/discovery/scanner.js";

describe("scanForNamespaces", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `yokai-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("discovers scoped package name from package.json", () => {
    writeFileSync(join(testDir, "package.json"), JSON.stringify({
      name: "@mycompany/web-app",
      dependencies: {
        "@mycompany/shared-utils": "^1.0.0",
        "lodash": "^4.17.21",
      },
    }));

    const namespaces = scanForNamespaces(testDir);
    const names = namespaces.map((ns) => ns.name);

    expect(names).toContain("@mycompany/web-app");
    expect(names).toContain("@mycompany/shared-utils");
    // Should NOT include unscoped packages
    expect(names).not.toContain("lodash");
  });

  it("discovers scoped registry from .npmrc", () => {
    writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }));
    writeFileSync(join(testDir, ".npmrc"),
      "@internal:registry=https://npm.internal.corp/\n",
    );

    const namespaces = scanForNamespaces(testDir);
    const internal = namespaces.find((ns) => ns.scope === "@internal");

    expect(internal).toBeDefined();
    expect(internal!.registry).toBe("https://npm.internal.corp/");
  });

  it("discovers packages from devDependencies", () => {
    writeFileSync(join(testDir, "package.json"), JSON.stringify({
      name: "test",
      devDependencies: {
        "@myorg/test-helpers": "^1.0.0",
      },
    }));

    const namespaces = scanForNamespaces(testDir);
    expect(namespaces.some((ns) => ns.name === "@myorg/test-helpers")).toBe(true);
  });

  it("deduplicates package names", () => {
    writeFileSync(join(testDir, "package.json"), JSON.stringify({
      name: "@myorg/app",
      dependencies: { "@myorg/app": "^1.0.0" },
    }));

    const namespaces = scanForNamespaces(testDir);
    const appNamespaces = namespaces.filter((ns) => ns.name === "@myorg/app");
    expect(appNamespaces.length).toBe(1);
  });

  it("returns empty for repo without scoped packages", () => {
    writeFileSync(join(testDir, "package.json"), JSON.stringify({
      name: "my-app",
      dependencies: { lodash: "^4.17.21" },
    }));

    const namespaces = scanForNamespaces(testDir);
    expect(namespaces.length).toBe(0);
  });
});

describe("extractScopes", () => {
  it("extracts unique scopes", () => {
    const scopes = extractScopes([
      { name: "@myorg/a", source: "", scope: "@myorg", isScoped: true },
      { name: "@myorg/b", source: "", scope: "@myorg", isScoped: true },
      { name: "@other/c", source: "", scope: "@other", isScoped: true },
    ]);

    expect(scopes).toEqual(["@myorg", "@other"]);
  });
});
