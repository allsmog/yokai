import { createLogger } from "../logger.js";

const log = createLogger({ stage: "public-registry" });

export interface RegistryCheckResult {
  packageName: string;
  exists: boolean;
  latestVersion?: string;
  publishedAt?: string;
  maintainers?: string[];
}

/**
 * Check if a package name exists on the public npm registry.
 */
export async function checkNpmRegistry(packageName: string): Promise<RegistryCheckResult> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 404) {
      return { packageName, exists: false };
    }

    if (!response.ok) {
      log.warn(`npm registry returned ${response.status} for ${packageName}`);
      return { packageName, exists: false };
    }

    const data = await response.json() as Record<string, unknown>;
    const distTags = data["dist-tags"] as Record<string, string> | undefined;
    const time = data["time"] as Record<string, string> | undefined;
    const maintainers = data["maintainers"] as Array<{ name: string }> | undefined;

    return {
      packageName,
      exists: true,
      latestVersion: distTags?.latest,
      publishedAt: time?.created,
      maintainers: maintainers?.map((m) => m.name),
    };
  } catch (err) {
    log.warn(`Failed to check npm registry for ${packageName}: ${err}`);
    return { packageName, exists: false };
  }
}

/**
 * Check multiple package names against the public npm registry.
 */
export async function checkNpmRegistryBatch(
  packageNames: string[],
  concurrency = 5,
): Promise<RegistryCheckResult[]> {
  const results: RegistryCheckResult[] = [];
  const queue = [...packageNames];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const name = queue.shift()!;
      const result = await checkNpmRegistry(name);
      results.push(result);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Find package names that are NOT registered on public npm (potential confusion targets).
 */
export async function findUnclaimedPackages(packageNames: string[]): Promise<string[]> {
  const results = await checkNpmRegistryBatch(packageNames);
  return results.filter((r) => !r.exists).map((r) => r.packageName);
}
