import type { StageId } from "../types.js";
import type { YokaiTask, TaskInfo } from "./types.js";

export class TaskRegistry {
  private readonly tasks = new Map<StageId, YokaiTask>();

  register(task: YokaiTask): void {
    this.tasks.set(task.id, task);
  }

  get(id: StageId): YokaiTask {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  has(id: StageId): boolean {
    return this.tasks.has(id);
  }

  ids(): StageId[] {
    return [...this.tasks.keys()];
  }

  list(): TaskInfo[] {
    return [...this.tasks.values()].map((task) => ({
      id: task.id,
      displayName: task.displayName,
      outputKind: task.outputKind,
      dependsOn: [...task.dependsOn],
    }));
  }

  validate(): void {
    for (const task of this.tasks.values()) {
      for (const dep of task.dependsOn) {
        if (!this.tasks.has(dep)) {
          throw new Error(`Task "${task.id}" depends on unknown task "${dep}"`);
        }
      }
    }
  }

  resolveOrder(enabledIds: StageId[]): StageId[][] {
    const enabled = [...new Set(enabledIds)];
    if (enabled.length === 0) return [];

    for (const id of enabled) {
      if (!this.has(id)) throw new Error(`Unknown enabled task: ${id}`);
    }

    const enabledSet = new Set(enabled);
    const priority = new Map(enabled.map((id, idx) => [id, idx]));
    const indegree = new Map<StageId, number>();
    const edges = new Map<StageId, StageId[]>();

    for (const id of enabled) {
      indegree.set(id, 0);
      edges.set(id, []);
    }

    for (const id of enabled) {
      const task = this.get(id);
      for (const dep of task.dependsOn) {
        if (!enabledSet.has(dep)) {
          throw new Error(`Task "${id}" depends on "${dep}" but it is not enabled`);
        }
        indegree.set(id, (indegree.get(id) ?? 0) + 1);
        edges.get(dep)?.push(id);
      }
    }

    const groups: StageId[][] = [];
    const processed = new Set<StageId>();

    while (processed.size < enabled.length) {
      const group = enabled
        .filter((id) => !processed.has(id) && (indegree.get(id) ?? 0) === 0)
        .sort((a, b) => (priority.get(a) ?? 0) - (priority.get(b) ?? 0));

      if (group.length === 0) {
        const stuck = enabled.filter((id) => !processed.has(id));
        throw new Error(`Task dependency cycle detected among: ${stuck.join(", ")}`);
      }

      groups.push(group);

      for (const id of group) {
        processed.add(id);
        for (const dependent of edges.get(id) ?? []) {
          indegree.set(dependent, (indegree.get(dependent) ?? 0) - 1);
        }
      }
    }

    return groups;
  }
}
