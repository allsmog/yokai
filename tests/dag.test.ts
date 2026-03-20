import { describe, it, expect } from "vitest";
import { TaskRegistry } from "../src/dag/registry.js";
import type { StageId } from "../src/types.js";
import type { YokaiTask } from "../src/dag/types.js";

function makeTask(id: StageId, dependsOn: StageId[] = []): YokaiTask {
  return {
    id,
    displayName: id,
    outputKind: "discovery",
    dependsOn,
    async run() { return {}; },
  };
}

describe("TaskRegistry", () => {
  it("registers and retrieves tasks", () => {
    const registry = new TaskRegistry();
    const task = makeTask("s1-discover-namespaces" as StageId);
    registry.register(task);

    expect(registry.has("s1-discover-namespaces" as StageId)).toBe(true);
    expect(registry.get("s1-discover-namespaces" as StageId)).toBe(task);
  });

  it("throws on unknown task", () => {
    const registry = new TaskRegistry();
    expect(() => registry.get("s1-discover-namespaces" as StageId)).toThrow("Unknown task");
  });

  it("validates dependencies", () => {
    const registry = new TaskRegistry();
    registry.register(makeTask("s2-generate-canaries" as StageId, ["s1-discover-namespaces" as StageId]));

    expect(() => registry.validate()).toThrow("depends on unknown task");
  });

  it("resolves linear execution order", () => {
    const registry = new TaskRegistry();
    registry.register(makeTask("s1-discover-namespaces" as StageId));
    registry.register(makeTask("s2-generate-canaries" as StageId, ["s1-discover-namespaces" as StageId]));
    registry.register(makeTask("s3-deploy-registries" as StageId, ["s2-generate-canaries" as StageId]));

    const groups = registry.resolveOrder([
      "s1-discover-namespaces" as StageId,
      "s2-generate-canaries" as StageId,
      "s3-deploy-registries" as StageId,
    ]);

    expect(groups.length).toBe(3);
    expect(groups[0]).toEqual(["s1-discover-namespaces"]);
    expect(groups[1]).toEqual(["s2-generate-canaries"]);
    expect(groups[2]).toEqual(["s3-deploy-registries"]);
  });

  it("detects cycles", () => {
    const registry = new TaskRegistry();
    registry.register(makeTask("s1-discover-namespaces" as StageId, ["s2-generate-canaries" as StageId]));
    registry.register(makeTask("s2-generate-canaries" as StageId, ["s1-discover-namespaces" as StageId]));

    expect(() => registry.resolveOrder([
      "s1-discover-namespaces" as StageId,
      "s2-generate-canaries" as StageId,
    ])).toThrow("cycle");
  });
});
