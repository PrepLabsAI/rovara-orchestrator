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
