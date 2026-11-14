import type { StatusApi } from "../api.js";
import { money, runHref } from "../format.js";
import { REFRESH_MS } from "../format.js";
import { useLoad } from "../useLoad.js";

const summary = (counts: Record<string, number>) =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s} ${n}`)
    .join(" · ");

/** Every run, newest first. Read-only. */
export function RunsPage({ api }: { api: StatusApi }) {
  const runs = useLoad(() => api.listRuns(), [api], REFRESH_MS);
  if (runs.state === "loading") return <p className="muted">Loading runs…</p>;
  if (runs.state === "failed") return <p className="error">Could not load the runs: {runs.message}</p>;
  if (!runs.value.length) return <p className="muted">No runs yet. Start one with rovara-orch run start.</p>;
  return (
    <main>
      <h1>Runs</h1>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Run</th><th>State</th><th>Nodes</th><th>Cost</th><th>Acting for</th><th>Started</th></tr>
          </thead>
          <tbody>
            {runs.value.map((r) => (
              <tr key={r.runId}>
                <td><a href={runHref(r.runId)}>{r.runId}</a></td>
                <td><span className={`state state-${r.state}`}>{r.state}</span></td>
                <td>{summary(r.counts)}</td>
                <td className="num">{money(r.costUsd)}</td>
                <td>{r.actingFor}</td>
                <td><time dateTime={r.startedAt}>{new Date(r.startedAt).toLocaleString()}</time></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
