import { TaskRegistry } from "../dag/registry.js";
import { s1DiscoverNamespaces } from "./s1-discover-namespaces.js";
import { s2GenerateCanaries } from "./s2-generate-canaries.js";
import { s3DeployRegistries } from "./s3-deploy-registries.js";
import { s4ConfigureMonitoring } from "./s4-configure-monitoring.js";
import { s5BaselineTraffic } from "./s5-baseline-traffic.js";

export function createYokaiTaskRegistry(): TaskRegistry {
  const registry = new TaskRegistry();
  registry.register(s1DiscoverNamespaces);
  registry.register(s2GenerateCanaries);
  registry.register(s3DeployRegistries);
  registry.register(s4ConfigureMonitoring);
  registry.register(s5BaselineTraffic);
  return registry;
}
