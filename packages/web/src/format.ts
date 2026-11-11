export const money = (usd: number) => `$${usd.toFixed(2)}`;
export const runHref = (runId: string) => `#/runs/${encodeURIComponent(runId)}`;
export const nodeHref = (runId: string, nodeId: string) => `#/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(nodeId)}`;

/** Show a trace payload as Rovara sent it: its text where it has one. */
export function stepText(payload: unknown): string {
  if (payload && typeof payload === "object") {
    const p = payload as { text?: unknown; url?: unknown };
    if (typeof p.text === "string") return p.text;
    if (typeof p.url === "string") return p.url;
  }
  return JSON.stringify(payload);
}

/** Load once; the page shows "Loading" until then and the error if it fails. */
export type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "failed"; message: string };
