import { createHash } from "node:crypto";

/**
 * Port of speckit-dag's `identity.content_hash`: sha256 over the canonical JSON of `version`,
 * `unit`, `groups`, `nodes` and `edges`, leaving out where the graph came from (`ref`), positions
 * (`line`, `end_line`) and progress (`status`, and the [x] marks inside `text`).
 */
const LEFT_OUT = new Set(["ref", "line", "end_line", "status"]);
const CHECKBOX_RE = /^(\s*[-*+]\s+)\[[xX]\]/gm;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function strip(item: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(item)) if (!LEFT_OUT.has(k)) out[k] = v;
  if (typeof out.text === "string") out.text = out.text.replace(CHECKBOX_RE, "$1[ ]");
  if (Array.isArray(out.tasks)) out.tasks = out.tasks.map((t) => strip(t as Record<string, Json>));
  return out;
}

/** Python's json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False). */
export function canonicalJson(v: Json): string {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error("non-integer numbers are not expected in a speckit-dag graph");
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k]!)}`).join(",")}}`;
}

export function contentHash(graph: Record<string, unknown>): string {
  const payload: Json = {
    version: graph.version as Json,
    unit: graph.unit as Json,
    groups: ((graph.groups ?? []) as Array<Record<string, Json>>).map(strip),
    nodes: ((graph.nodes ?? []) as Array<Record<string, Json>>).map(strip),
    edges: (graph.edges ?? []) as Json,
  };
  return `sha256:${createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex")}`;
}
