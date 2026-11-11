import { useEffect, useState } from "react";
import type { StatusApi, TraceStep } from "../api.js";
import { runHref, stepText } from "../format.js";
import { useLoad } from "../useLoad.js";

export const TRACE_POLL_MS = 2000;

/** The node's trace: loaded once, then polled every 2 seconds while the attempt is live (FR-055). */
function useTrace(api: StatusApi, runId: string, nodeId: string) {
  const [steps, setSteps] = useState<TraceStep[]>([]);
  const [live, setLive] = useState(false);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: number | null = null;
    const poll = async () => {
      try {
        let page = await api.getTrace(runId, nodeId, last);
        const fresh = [...page.steps];
        while (page.next !== null && alive) {
          page = await api.getTrace(runId, nodeId, page.next);
          fresh.push(...page.steps);
        }
        if (!alive) return;
        if (fresh.length) {
          last = fresh.at(-1)!.sequence;
          setSteps((s) => [...s, ...fresh]);
        }
        setLive(page.live);
        if (page.live) timer = setTimeout(poll, TRACE_POLL_MS);
      } catch {
        if (alive) timer = setTimeout(poll, TRACE_POLL_MS * 5);
      }
    };
    void poll();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, runId, nodeId]);
  return { steps, live };
}

/** One node: attempts, PRs, questions and answers, review comments, decisions and the live trace. Read-only. */
export function NodePage({ api, runId, nodeId }: { api: StatusApi; runId: string; nodeId: string }) {
  const node = useLoad(() => api.getNode(runId, nodeId), [api, runId, nodeId]);
  const trace = useTrace(api, runId, nodeId);
  if (node.state === "loading") return <p className="muted">Loading {nodeId}…</p>;
  if (node.state === "failed") return <p className="error">Could not load {nodeId}: {node.message}</p>;
  const n = node.value;
  return (
    <main>
      <p className="crumbs"><a href="#/">Runs</a> / <a href={runHref(runId)}>{runId}</a> / {n.nodeId}</p>
      <h1>{n.title}</h1>
      <p>
        {n.nodeId}{n.kind ? ` · ${n.kind}` : ""} · <span className={`state state-${n.state}`}>{n.state}</span>
        {n.waitingFor ? ` · waiting for ${n.waitingFor.reason}${n.waitingFor.detail ? `: ${n.waitingFor.detail}` : ""}` : ""}
      </p>
      {n.unblockedBySkip.length > 0 && <p className="note">Unblocked by a skipped dependency: {n.unblockedBySkip.join(", ")}. It was not merged.</p>}

      <section aria-label="Attempts">
        <h2>Attempts</h2>
        {n.attempts.map((a) => (
          <article key={a.attemptId} className="attempt">
            <h3>{`Attempt ${a.n} · ${a.phase}`}</h3>
            {a.outcomeReason && <p className="muted">{a.outcomeReason}</p>}
            {a.rovaraTaskUrl && <p><a href={a.rovaraTaskUrl} target="_blank" rel="noreferrer">Rovara task</a></p>}
            {a.checkReports.length > 0 && <p>Checks: {a.checkReports.at(-1)!.status}</p>}
            {a.pullRequests.length > 0 && (
              <ul className="prs">
                {a.pullRequests.map((p) => (
                  <li key={p.number}><a href={p.url} target="_blank" rel="noreferrer">#{p.number}</a> {p.state}</li>
                ))}
              </ul>
            )}
            {a.questions.length > 0 && (
              <dl className="questions">
                {a.questions.map((q) => (
                  <div key={q.eventId}>
                    <dt>{q.question}</dt>
                    <dd>{q.answer}</dd>
                    <dd className="muted">answered by {q.answeredBy}</dd>
                  </div>
                ))}
              </dl>
            )}
            {a.reviewComments.length > 0 && (
              <ul className="comments">
                {a.reviewComments.map((c) => (
                  <li key={c.threadId}>
                    <code>{`${c.path ?? "?"}:${c.line ?? "?"}`}</code> <span>{c.body}</span>{" "}
                    {c.resolution && <span className="muted">{c.resolution}</span>}
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </section>

      <section aria-label="Trace">
        <h2>Trace {trace.live && <span className="live">live</span>}</h2>
        <p className="muted">Showing only conversation-level events (progress, messages, check reports, PRs) until Rovara streams the agent's own trace.</p>
        <ol className="trace">
          {trace.steps.map((s) => (
            <li key={s.sequence}>
              <time dateTime={s.at}>{new Date(s.at).toLocaleTimeString()}</time> <span className="kind">{s.kind}</span> <span>{stepText(s.payload)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section aria-label="Decisions">
        <h2>Decisions</h2>
        <ul className="decisions">
          {n.decisions.map((d, i) => (
            <li key={i}>
              <time dateTime={d.at}>{new Date(d.at).toLocaleString()}</time> {d.actor} {d.action}: <span>{d.reason}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
