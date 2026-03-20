import { readFileSync, existsSync, globSync } from "node:fs";
import { resolve, join } from "node:path";
import { createLogger } from "../logger.js";
import type { DiscoveredNamespace } from "../types.js";

const log = createLogger({ stage: "discovery" });

/**
 * Scan a repository for internal package names by parsing:
 * - package.json (name, dependencies, devDependencies, peerDependencies)
 * - .npmrc (registry config, scopes)
 * - package-lock.json / pnpm-lock.yaml / yarn.lock for scoped packages
 */
export function scanForNamespaces(repoPath: string): DiscoveredNamespace[] {
  const absPath = resolve(repoPath);
  const namespaces: DiscoveredNamespace[] = [];
  const seen = new Set<string>();

  const add = (ns: DiscoveredNamespace) => {
    if (seen.has(ns.name)) return;
    seen.add(ns.name);
    namespaces.push(ns);
  };

  // Parse package.json
  const pkgJsonPath = join(absPath, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      const pkgNamespaces = extractFromPackageJson(pkg, pkgJsonPath);
      for (const ns of pkgNamespaces) add(ns);
    } catch (err) {
      log.warn(`Failed to parse ${pkgJsonPath}: ${err}`);
    }
  }

  // Parse .npmrc
  const npmrcPath = join(absPath, ".npmrc");
  if (existsSync(npmrcPath)) {
    try {
      const npmrcNamespaces = extractFromNpmrc(npmrcPath);
      for (const ns of npmrcNamespaces) add(ns);
    } catch (err) {
      log.warn(`Failed to parse ${npmrcPath}: ${err}`);
    }
  }

  // Scan for workspace packages (monorepo)
  const workspacePackages = scanWorkspacePackages(absPath);
  for (const ns of workspacePackages) add(ns);

  log.info(`Discovered ${namespaces.length} namespaces in ${repoPath}`);
  return namespaces;
}

function extractFromPackageJson(pkg: Record<string, unknown>, source: string): DiscoveredNamespace[] {
  const namespaces: DiscoveredNamespace[] = [];

  // The package's own name
  if (typeof pkg.name === "string" && pkg.name.startsWith("@")) {
    const scope = pkg.name.split("/")[0];
    namespaces.push({
      name: pkg.name,
      source,
      scope,
      isScoped: true,
    });
  }

  // Scan all dependency fields for scoped packages
  const depFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  for (const field of depFields) {
    const deps = pkg[field];
    if (!deps || typeof deps !== "object") continue;
    for (const depName of Object.keys(deps as Record<string, unknown>)) {
      if (depName.startsWith("@")) {
        const scope = depName.split("/")[0];
        namespaces.push({
          name: depName,
          source: `${source}:${field}`,
          scope,
          isScoped: true,
        });
      }
    }
  }

  return namespaces;
}

function extractFromNpmrc(npmrcPath: string): DiscoveredNamespace[] {
  const content = readFileSync(npmrcPath, "utf-8");
  const namespaces: DiscoveredNamespace[] = [];

  // Match lines like @scope:registry=https://...
  const scopeRegistryPattern = /^(@[a-zA-Z0-9_-]+):registry\s*=\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = scopeRegistryPattern.exec(content)) !== null) {
    const scope = match[1];
    const registry = match[2].trim();
    namespaces.push({
      name: `${scope}/*`,
      source: npmrcPath,
      registry,
      scope,
      isScoped: true,
    });
  }

  return namespaces;
}

function scanWorkspacePackages(absPath: string): DiscoveredNamespace[] {
  const namespaces: DiscoveredNamespace[] = [];

  // Check for pnpm workspaces
  const pnpmWorkspacePath = join(absPath, "pnpm-workspace.yaml");
  if (existsSync(pnpmWorkspacePath)) {
    const content = readFileSync(pnpmWorkspacePath, "utf-8");
    const packagePatterns = content.match(/- ['"]?([^'"]+)['"]?/g);
    if (packagePatterns) {
      for (const pattern of packagePatterns) {
        const cleaned = pattern.replace(/^- ['"]?/, "").replace(/['"]?$/, "");
        scanGlobForPackages(absPath, cleaned, namespaces);
      }
    }
  }

  // Check for npm/yarn workspaces in package.json
  const pkgJsonPath = join(absPath, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      if (Array.isArray(pkg.workspaces)) {
        for (const pattern of pkg.workspaces) {
          scanGlobForPackages(absPath, pattern, namespaces);
        }
      } else if (pkg.workspaces?.packages && Array.isArray(pkg.workspaces.packages)) {
        for (const pattern of pkg.workspaces.packages) {
          scanGlobForPackages(absPath, pattern, namespaces);
        }
      }
    } catch {
      // Skip on parse error
    }
  }

  return namespaces;
}

function scanGlobForPackages(basePath: string, pattern: string, namespaces: DiscoveredNamespace[]): void {
  try {
    const dirs = globSync(pattern, { cwd: basePath });
    for (const dir of dirs) {
      const subPkgPath = join(basePath, dir, "package.json");
      if (existsSync(subPkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(subPkgPath, "utf-8"));
          if (typeof pkg.name === "string" && pkg.name.startsWith("@")) {
            const scope = pkg.name.split("/")[0];
            namespaces.push({
              name: pkg.name,
              source: subPkgPath,
              scope,
              isScoped: true,
            });
          }
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // globSync may not find matches
  }
}

/**
 * Extract unique scopes from discovered namespaces.
 */
export function extractScopes(namespaces: DiscoveredNamespace[]): string[] {
  const scopes = new Set<string>();
  for (const ns of namespaces) {
    if (ns.scope) scopes.add(ns.scope);
  }
  return [...scopes].sort();
}

/**
 * Filter namespaces that are likely internal (not on public npm).
 */
export function filterInternalNamespaces(namespaces: DiscoveredNamespace[]): DiscoveredNamespace[] {
  return namespaces.filter((ns) => {
    if (ns.registry && !ns.registry.includes("registry.npmjs.org")) {
      return true;
    }
    return false;
  });
}
