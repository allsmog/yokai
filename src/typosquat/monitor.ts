import { createLogger } from "../logger.js";
import { checkNpmRegistry, type RegistryCheckResult } from "../discovery/public-registry.js";
import { generateTyposquatVariants, type TyposquatVariant } from "./generator.js";
import { generateLlmTyposquatVariants } from "./llm-generator.js";

const log = createLogger({ stage: "typosquat-monitor" });

export interface MonitorResult {
  packageName: string;
  variant: string;
  technique: string;
  editDistance: number;
  registryStatus: RegistryCheckResult;
}

export interface MonitorOptions {
  /** Package names to generate and monitor typosquat variants for. */
  packageNames: string[];
  /** Optional model for LLM-generated variants. */
  model?: string;
  /** Max variants per package to check. */
  maxVariantsPerPackage?: number;
  /** Concurrency for registry checks. */
  concurrency?: number;
  /** Callback for each newly discovered claim. */
  onClaim?: (result: MonitorResult) => void | Promise<void>;
}

/**
 * One-shot scan: generate typosquat variants for all packages and check
 * which ones are claimed on the public npm registry.
 */
export async function scanForTyposquats(opts: MonitorOptions): Promise<MonitorResult[]> {
  const {
    packageNames,
    model,
    maxVariantsPerPackage = 20,
    concurrency = 5,
    onClaim,
  } = opts;

  const allVariants: TyposquatVariant[] = [];

  for (const name of packageNames) {
    const algorithmicVariants = generateTyposquatVariants(name, maxVariantsPerPackage);
    const llmVariants = model
      ? await generateLlmTyposquatVariants(name, model, maxVariantsPerPackage)
      : [];
    allVariants.push(...mergeVariants(algorithmicVariants, llmVariants, maxVariantsPerPackage));
  }

  log.info(`Checking ${allVariants.length} typosquat variants across ${packageNames.length} packages`);

  const results: MonitorResult[] = [];
  const queue = [...allVariants];

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const variant = queue.shift()!;
      try {
        const status = await checkNpmRegistry(variant.variant);
        if (status.exists) {
          const result: MonitorResult = {
            packageName: variant.original,
            variant: variant.variant,
            technique: variant.technique,
            editDistance: variant.editDistance,
            registryStatus: status,
          };
          results.push(result);
          log.warn(`Typosquat claimed: ${variant.variant} (variant of ${variant.original}, technique: ${variant.technique})`);
          if (onClaim) await onClaim(result);
        }
      } catch (err) {
        log.debug(`Failed to check ${variant.variant}: ${err}`);
      }
    }
  });

  await Promise.all(workers);

  log.info(`Found ${results.length} claimed typosquat variants`);
  return results;
}

export interface ContinuousMonitorOptions extends MonitorOptions {
  /** Polling interval in ms. Default: 1 hour. */
  intervalMs?: number;
  /** Abort signal to stop monitoring. */
  signal?: AbortSignal;
}

/**
 * Continuous monitoring loop: periodically re-scans for newly claimed
 * typosquat variants on public registries.
 */
export async function startContinuousMonitor(opts: ContinuousMonitorOptions): Promise<void> {
  const { intervalMs = 3_600_000, signal } = opts;

  const seen = new Set<string>();

  log.info(`Starting continuous typosquat monitor (interval: ${intervalMs / 1000}s)`);

  while (!signal?.aborted) {
    const results = await scanForTyposquats({
      ...opts,
      onClaim: async (result) => {
        if (!seen.has(result.variant)) {
          seen.add(result.variant);
          log.warn(`NEW typosquat claim detected: ${result.variant} (variant of ${result.packageName})`);
          if (opts.onClaim) await opts.onClaim(result);
        }
      },
    });

    log.info(`Monitor scan complete: ${results.length} claimed variants (${seen.size} total unique)`);

    // Wait for next interval or abort
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      if (signal) {
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }
    });
  }

  log.info("Continuous typosquat monitor stopped");
}

function mergeVariants(
  algorithmicVariants: TyposquatVariant[],
  llmVariants: TyposquatVariant[],
  maxVariants: number,
): TyposquatVariant[] {
  const merged = new Map<string, TyposquatVariant>();

  for (const variant of [...algorithmicVariants, ...llmVariants]) {
    const existing = merged.get(variant.variant);
    if (!existing || variant.editDistance < existing.editDistance) {
      merged.set(variant.variant, variant);
    }
  }

  return [...merged.values()]
    .sort((a, b) => a.editDistance - b.editDistance || a.variant.localeCompare(b.variant))
    .slice(0, maxVariants);
}
