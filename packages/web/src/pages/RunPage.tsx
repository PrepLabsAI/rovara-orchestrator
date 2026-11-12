import { useMemo, useState } from "react";
import type { RunNode, StatusApi } from "../api.js";
import { money, nodeHref } from "../format.js";
import { REFRESH_MS } from "../format.js";
import { useLoad } from "../useLoad.js";

const STATE_ORDER = ["running", "checks_failed", "pr_open", "in_merge_queue", "eligible", "waiting", "escalated", "merged", "skipped", "cancelled"];

function matches(n: RunNode, q: string, state: string): boolean {
  if (state && n.state !== state) return false;
  if (!q) return true;
  const s = q.toLowerCase();
  return n.nodeId.toLowerCase().includes(s) || n.title.toLowerCase().includes(s);
}

/** One run: counts per node state, cost, and every node, found by id, title or state (SC-008). Read-only. */
export function RunPage({ api, runId }: { api: StatusApi; runId: string }) {
  const run = useLoad(() => api.getRun(runId), [api, runId], REFRESH_MS);
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const nodes = run.state === "ready" ? run.value.nodes : [];
  const shown = useMemo(() => nodes.filter((n) => matches(n, q.trim(), state)), [nodes, q, state]);

  if (run.state === "loading") return <p className="muted">Loading {runId}…</p>;
  if (run.state === "failed") return <p className="error">Could not load {runId}: {run.message}</p>;
  const r = run.value;
  const states = STATE_ORDER.filter((s) => (r.counts[s] ?? 0) > 0);
  return (
    <main>
      <p className="crumbs"><a href="#/">Runs</a> / {r.runId}</p>
      <h1>{r.runId}</h1>
      <section aria-label="Run summary" className="summary">
        <p>
          <span className={`state state-${r.state}`}>{r.state}{r.pausedFor ? ` (${r.pausedFor})` : ""}</span> · {r.repo} · acting for {r.actingFor}
        </p>
        <p className="cost">{`${money(r.costUsd)} of $${r.costLimitUsd}`}</p>
        <dl className="counts">
          {states.map((s) => (
            <div key={s}>
              <dt>{s}</dt>
              <dd>{r.counts[s]}</dd>
            </div>
          ))}
        </dl>
        {r.notifications.length > 0 && (
          <p className="warn">
            {r.notifications.length} notification{r.notifications.length === 1 ? "" : "s"} not yet delivered to Slack
            {r.notifications[0]!.lastError ? `: ${r.notifications[0]!.lastError}` : ""}.
          </p>
        )}
      </section>

      <div className="filters">
        <label>
          Find a node
          <input type="search" aria-label="Find a node" placeholder="Node id or title" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          State
          <select aria-label="State" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All states</option>
            {states.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <span className="muted">{shown.length} of {nodes.length} nodes</span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Node</th><th>Title</th><th>State</th><th>Waiting for</th><th>Pull requests</th></tr>
          </thead>
          <tbody>
            {shown.map((n) => (
              <tr key={n.nodeId}>
                <td><a href={nodeHref(r.runId, n.nodeId)}>{n.nodeId}</a></td>
                <td>{n.title}</td>
                <td><span className={`state state-${n.state}`}>{n.state}</span></td>
                <td>{n.waitingFor ? `${n.waitingFor.reason}${n.waitingFor.detail ? `: ${n.waitingFor.detail}` : ""}` : ""}</td>
                <td>
                  {n.pullRequests.map((p) => (
                    <span key={p.number} className="pr">
                      <a href={p.url} target="_blank" rel="noreferrer">#{p.number}</a> {p.state}
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
