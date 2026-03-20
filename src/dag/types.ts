import type { YokaiTaskContext, StageId } from "../types.js";

export type TaskOutputKind = "discovery" | "generation" | "deployment" | "monitoring" | "baseline";

export interface YokaiTask<TInput = unknown, TOutput = unknown> {
  readonly id: StageId;
  readonly displayName: string;
  readonly outputKind: TaskOutputKind;
  readonly dependsOn: StageId[];
  run(input: TInput, context: YokaiTaskContext): Promise<TOutput>;
}

export interface TaskInfo {
  id: StageId;
  displayName: string;
  outputKind: TaskOutputKind;
  dependsOn: StageId[];
}
