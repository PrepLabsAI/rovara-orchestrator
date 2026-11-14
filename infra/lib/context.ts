import type { App } from "aws-cdk-lib";

/**
 * A context value that may hold an object or a list. Values given with `-c key='{...}'` on the
 * command line arrive as strings, so they are parsed here; values from cdk.json are already objects.
 */
export function jsonContext<T = unknown>(app: App, key: string): T | undefined {
  const value: unknown = app.node.tryGetContext(key);
  if (typeof value !== "string") return value as T | undefined;
  try {
    return JSON.parse(value) as T;
  } catch (e) {
    throw new Error(`context "${key}" is not valid JSON: ${(e as Error).message}`);
  }
}

/**
 * A deploy setting for one stage: a `-c key=...` value on the command line if given, otherwise the
 * value under `stages.<stage>.<key>` in cdk.json. Keeping each stage's settings in cdk.json lets the
 * deploy pipeline run `npm run deploy` with no settings typed in.
 */
export function stageContext<T = unknown>(app: App, stage: string, key: string): T | undefined {
  const given = jsonContext<T>(app, key);
  if (given !== undefined) return given;
  const stages = jsonContext<Record<string, Record<string, unknown> | undefined>>(app, "stages");
  return stages?.[stage]?.[key] as T | undefined;
}
