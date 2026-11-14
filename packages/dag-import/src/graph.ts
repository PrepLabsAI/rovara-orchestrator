import type { GraphEdge, GraphNode } from "./schema.js";

/** One cycle as [a, b, ..., a], over edges whose ends both exist; [] when there is none. */
export function findCycle(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const ids = new Set(nodes.map((n) => n.id));
  const succ = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (ids.has(e.from) && ids.has(e.to)) succ.get(e.from)!.push(e.to);
  const state = new Map<string, 1 | 2>();
  for (const root of ids) {
    if (state.has(root)) continue;
    const path: string[] = [root];
    const stack: Array<Iterator<string>> = [succ.get(root)![Symbol.iterator]()];
    state.set(root, 1);
    while (stack.length) {
      const next = stack.at(-1)!.next();
      if (next.done) {
        state.set(path.pop()!, 2);
        stack.pop();
      } else if (state.get(next.value) === 1) {
        return [...path.slice(path.indexOf(next.value)), next.value];
      } else if (!state.has(next.value)) {
        state.set(next.value, 1);
        path.push(next.value);
        stack.push(succ.get(next.value)![Symbol.iterator]());
      }
    }
  }
  return [];
}

/** Edges naming a node that is not in the graph. */
export function unknownEdgeEnds(nodes: GraphNode[], edges: GraphEdge[]): Array<{ edge: GraphEdge; missing: string }> {
  const ids = new Set(nodes.map((n) => n.id));
  const out: Array<{ edge: GraphEdge; missing: string }> = [];
  for (const e of edges) {
    if (!ids.has(e.from)) out.push({ edge: e, missing: e.from });
    else if (!ids.has(e.to)) out.push({ edge: e, missing: e.to });
  }
  return out;
}
