/** Deployment stages. `prod` is the only stage where development-only pieces are refused. */
export const STAGES = ["test", "load", "prod"] as const;
export type StageName = (typeof STAGES)[number];

export interface StageConfig {
  name: StageName;
  /** True only for `prod`. The identity package refuses its development identity when this is set. */
  prod: boolean;
}

export function stageConfig(name: string): StageConfig {
  if (!(STAGES as readonly string[]).includes(name)) {
    throw new Error(`unknown stage "${name}"; expected one of ${STAGES.join(", ")}`);
  }
  const stage = name as StageName;
  return { name: stage, prod: stage === "prod" };
}
