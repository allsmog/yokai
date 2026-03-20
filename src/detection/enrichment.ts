import { createLogger } from "../logger.js";

const log = createLogger({ stage: "enrichment" });

export interface EnrichmentResult {
  ip: string;
  geo?: {
    country?: string;
    city?: string;
    region?: string;
  };
  asn?: {
    number?: number;
    org?: string;
  };
  isTor?: boolean;
  isProxy?: boolean;
  isCloudProvider?: boolean;
}

// Common cloud provider CIDR ranges (simplified prefixes for fast matching)
const CLOUD_PROVIDER_PREFIXES = [
  "13.", "34.", "35.", "52.", "54.", "3.",     // AWS
  "20.", "40.", "52.", "104.", "168.",         // Azure
  "34.", "35.", "104.", "130.", "142.",        // GCP
  "162.158.", "172.64.", "198.41.",            // Cloudflare
];

const KNOWN_CI_IPS = new Set<string>();

/**
 * Enrich an IP address with geo and ASN information.
 * Uses ip-api.com (free tier, 45 requests/minute).
 */
export async function enrichIp(ip: string): Promise<EnrichmentResult> {
  if (!ip || ip === "unknown" || ip === "127.0.0.1" || ip === "::1") {
    return { ip, isCloudProvider: false, isTor: false, isProxy: false };
  }

  try {
    const response = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,city,regionName,as,proxy,hosting`, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      log.warn(`IP enrichment failed for ${ip}: HTTP ${response.status}`);
      return { ip };
    }

    const data = await response.json() as Record<string, unknown>;
    if (data.status !== "success") {
      return { ip };
    }

    return {
      ip,
      geo: {
        country: data.country as string | undefined,
        city: data.city as string | undefined,
        region: data.regionName as string | undefined,
      },
      asn: {
        org: data.as as string | undefined,
      },
      isProxy: data.proxy as boolean | undefined,
      isCloudProvider: data.hosting as boolean | undefined,
    };
  } catch (err) {
    log.warn(`IP enrichment error for ${ip}: ${err}`);
    return { ip };
  }
}

/**
 * Quick check if an IP belongs to a cloud provider (no API call).
 */
export function isLikelyCloudIp(ip: string): boolean {
  return CLOUD_PROVIDER_PREFIXES.some((prefix) => ip.startsWith(prefix));
}

/**
 * Check if an IP is known to be used for CI/CD.
 */
export function isKnownCiIp(ip: string): boolean {
  return KNOWN_CI_IPS.has(ip);
}
