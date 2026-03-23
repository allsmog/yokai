import type { Alert, AlertType, Severity, MitreMapping } from "../types.js";
import { MITRE_MAPPINGS } from "../types.js";
import { scoreSeverity } from "./severity-scorer.js";

export interface AlertInput {
  runId: string;
  tokenId?: string;
  packageName?: string;
  sourceIp?: string;
  userAgent?: string;
  method: string;
  path: string;
  metadata?: Record<string, unknown>;
}

/**
 * Classify an event into an alert with type, severity, and MITRE mapping.
 */
export function classifyAlert(input: AlertInput): Alert {
  const alertType = classifyAlertType(input);
  const severity = scoreSeverity(alertType, input);
  const mitre = MITRE_MAPPINGS[alertType];

  const title = buildTitle(alertType, input);
  const description = buildDescription(alertType, input);

  return {
    id: crypto.randomUUID(),
    runId: input.runId,
    tokenId: input.tokenId,
    alertType,
    severity,
    title,
    description,
    sourceIp: input.sourceIp,
    userAgent: input.userAgent,
    packageName: input.packageName,
    mitre,
    metadata: input.metadata ?? {},
    createdAt: new Date().toISOString(),
  };
}

/**
 * Classify the type of alert based on the request.
 */
function classifyAlertType(input: AlertInput): AlertType {
  const { method, path, metadata } = input;
  const action = metadata?.["action"] as string | undefined;

  if (action === "typosquat-claim") {
    return "typosquat-claim";
  }

  if (action === "config-access") {
    return "config-tamper";
  }

  // Canary callback from postinstall
  if (path.includes("/_yokai/callback/")) {
    // Check if it came from CI
    if (metadata?.["ci"] || metadata?.["githubActions"] || metadata?.["jenkinsUrl"]) {
      return "dependency-confusion";
    }
    return "canary-download";
  }

  // Publish attempt
  if (method === "PUT") {
    return "unauthorized-publish";
  }

  if (metadata?.["authorizationPresent"] === true) {
    return "credential-probe";
  }

  // Tarball download
  if (action === "tarball-download" || path.includes("/-/")) {
    return "canary-download";
  }

  // Metadata resolve
  if (action === "metadata-resolve" || method === "GET") {
    return "namespace-probe";
  }

  return "unknown";
}

function buildTitle(alertType: AlertType, input: AlertInput): string {
  const pkg = input.packageName ?? "unknown";
  const ip = input.sourceIp ?? "unknown";

  switch (alertType) {
    case "dependency-confusion":
      return `Dependency confusion detected: ${pkg} installed from CI/CD (${ip})`;
    case "credential-probe":
      return `Credential probe detected for ${pkg} from ${ip}`;
    case "unauthorized-publish":
      return `Unauthorized publish attempt for ${pkg} from ${ip}`;
    case "canary-download":
      return `Canary package ${pkg} downloaded from ${ip}`;
    case "namespace-probe":
      return `Namespace probe: ${pkg} resolved from ${ip}`;
    case "typosquat-claim":
      return `Typosquat package claimed: ${pkg}`;
    case "config-tamper":
      return `Configuration tamper detected for ${pkg}`;
    default:
      return `Unknown activity detected for ${pkg} from ${ip}`;
  }
}

function buildDescription(alertType: AlertType, input: AlertInput): string {
  const pkg = input.packageName ?? "unknown";
  const ip = input.sourceIp ?? "unknown";
  const ua = input.userAgent ?? "unknown";
  const baselineSuffix = input.metadata?.["baselineDeviation"] === true
    ? " This request was not observed during the baseline window."
    : "";

  switch (alertType) {
    case "dependency-confusion":
      return `A canary package "${pkg}" was installed in a CI/CD environment, indicating a potential dependency confusion attack. ` +
        `Source IP: ${ip}, User-Agent: ${ua}. ` +
        `This suggests an attacker may have published a package with the same name as an internal dependency.` +
        baselineSuffix;

    case "unauthorized-publish":
      return `An attempt was made to publish to package "${pkg}" on the canary registry from ${ip}. ` +
        `This may indicate stolen developer credentials or an attempt to inject malicious code.` +
        baselineSuffix;

    case "canary-download":
      return `Canary package "${pkg}" was downloaded/installed from ${ip} (${ua}). ` +
        `This indicates someone is resolving packages from this canary registry.` +
        baselineSuffix;

    case "namespace-probe":
      return `Package metadata for "${pkg}" was requested from ${ip} (${ua}). ` +
        `This may indicate reconnaissance of internal package namespaces.` +
        baselineSuffix;

    case "credential-probe":
      return `Credential-bearing request detected for "${pkg}" from ${ip}.` + baselineSuffix;

    case "typosquat-claim":
      return `A typosquat variant of an internal package was claimed: "${pkg}".` + baselineSuffix;

    case "config-tamper":
      return `Registry configuration was accessed from an unexpected source: ${ip}.` + baselineSuffix;

    default:
      return `Unclassified registry activity detected for "${pkg}" from ${ip}.` + baselineSuffix;
  }
}
