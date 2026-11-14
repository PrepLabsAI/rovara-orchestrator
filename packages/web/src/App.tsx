import { useEffect, useMemo, useState } from "react";
import { httpStatusApi, type StatusApi } from "./api.js";
import { NodePage } from "./pages/NodePage.js";
import { RunPage } from "./pages/RunPage.js";
import { RunsPage } from "./pages/RunsPage.js";

const TOKEN_KEY = "rovara-orch-token";

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** `#/`, `#/runs/<runId>`, `#/runs/<runId>/nodes/<nodeId>`. */
export function parseRoute(hash: string): { page: "runs" } | { page: "run"; runId: string } | { page: "node"; runId: string; nodeId: string } {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "runs" && parts[1] && parts[2] === "nodes" && parts[3]) return { page: "node", runId: parts[1], nodeId: parts[3] };
  if (parts[0] === "runs" && parts[1]) return { page: "run", runId: parts[1] };
  return { page: "runs" };
}

/**
 * Sign-in is the operator identity (FR-056). Until Rovara can sign operators in to other services
 * (Rovara#442), the page takes the token `rovara-orch login` stored, for this browser tab only.
 */
function SignIn({ onToken }: { onToken: (t: string) => void }) {
  return (
    <main className="signin">
      <h1>Rovara orchestrator</h1>
      <p>Paste your operator token to view runs. It stays in this tab only.</p>
      <label>
        Operator token
        <input
          type="password"
          aria-label="Operator token"
          onKeyDown={(e) => {
            const v = (e.target as HTMLInputElement).value.trim();
            if (e.key === "Enter" && v) onToken(v);
          }}
        />
      </label>
      <p className="muted">Press Enter to continue.</p>
    </main>
  );
}

export function App({ apiUrl, api: given }: { apiUrl: string; api?: StatusApi }) {
  const [hash, setHash] = useState(() => location.hash);
  const [token, setToken] = useState(readToken);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const api = useMemo(() => given ?? httpStatusApi(apiUrl, () => token), [given, apiUrl, token]);
  if (!given && !token) {
    return (
      <SignIn
        onToken={(t) => {
          try {
            sessionStorage.setItem(TOKEN_KEY, t);
          } catch {
            // private mode: keep it in memory only
          }
          setToken(t);
        }}
      />
    );
  }
  const route = parseRoute(hash);
  if (route.page === "node") return <NodePage api={api} runId={route.runId} nodeId={route.nodeId} />;
  if (route.page === "run") return <RunPage api={api} runId={route.runId} />;
  return <RunsPage api={api} />;
}
