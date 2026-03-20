import type { YokaiTask } from "../dag/types.js";
import type {
  StageId, YokaiTaskContext, DeployRegistriesOutput,
  ConfigureMonitoringOutput, AlertType,
} from "../types.js";
import { createLogger } from "../logger.js";

const log = createLogger({ stage: "s4" });

const ALL_ALERT_TYPES: AlertType[] = [
  "dependency-confusion",
  "credential-probe",
  "unauthorized-publish",
  "canary-download",
  "namespace-probe",
  "typosquat-claim",
  "config-tamper",
];

export const s4ConfigureMonitoring: YokaiTask<unknown, ConfigureMonitoringOutput> = {
  id: "s4-configure-monitoring" as StageId,
  displayName: "Configure Monitoring",
  outputKind: "monitoring",
  dependsOn: ["s3-deploy-registries" as StageId],

  async run(_input: unknown, context: YokaiTaskContext): Promise<ConfigureMonitoringOutput> {
    const { config, upstreamOutputs } = context;

    const s3 = upstreamOutputs.get("s3-deploy-registries") as DeployRegistriesOutput | undefined;

    // Configure alert rules
    const alertRules = ALL_ALERT_TYPES.map((type) => ({
      type,
      enabled: true,
    }));

    const callbackUrl = s3?.registryUrl
      ? `${s3.registryUrl}/_yokai/callback`
      : `${config.callbackBaseUrl}/_yokai/callback`;

    log.info(`Monitoring configured with ${alertRules.length} alert rules`);
    log.info(`Callback URL: ${callbackUrl}`);

    return {
      alertRules,
      callbackUrl,
      costUsd: 0,
    };
  },
};
