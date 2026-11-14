/** Key builders for every item in the single table (data-model.md). */
export interface Key {
  pk: string;
  sk: string;
}

const k = (pk: string, sk: string): Key => ({ pk, sk });

export const keys = {
  dag: (dagId: string) => k(`DAG#${dagId}`, "META"),
  dagNode: (dagId: string, nodeId: string) => k(`DAG#${dagId}`, `NODE#${nodeId}`),
  dagNodesPrefix: (dagId: string) => ({ pk: `DAG#${dagId}`, skPrefix: "NODE#" }),
  dagHash: (repo: string, hash: string) => k(`DAGHASH#${repo}#${hash}`, "META"),
  dagActiveRun: (dagId: string) => k(`DAGRUN#${dagId}`, "ACTIVE"),
  run: (runId: string) => k(`RUN#${runId}`, "META"),
  runNode: (runId: string, nodeId: string) => k(`RUN#${runId}`, `NODE#${nodeId}`),
  runNodesPrefix: (runId: string) => ({ pk: `RUN#${runId}`, skPrefix: "NODE#" }),
  decision: (runId: string, at: string, id: string) => k(`RUN#${runId}`, `DEC#${at}#${id}`),
  decisionsPrefix: (runId: string) => ({ pk: `RUN#${runId}`, skPrefix: "DEC#" }),
  attempt: (attemptId: string) => k(`ATT#${attemptId}`, "META"),
  question: (attemptId: string, eventId: string) => k(`ATT#${attemptId}`, `Q#${eventId}`),
  reviewComment: (attemptId: string, prNumber: number, threadId: string) =>
    k(`ATT#${attemptId}`, `RC#${prNumber}#${threadId}`),
  event: (attemptId: string, receivedAt: string, eventId: string) => k(`ATT#${attemptId}`, `EV#${receivedAt}#${eventId}`),
  intent: (ownerPk: string, seq: string) => k(ownerPk, `INTENT#${seq}`),
  /** Marks an input as processed, written in the same transaction as its transition. */
  input: (ownerPk: string, inputId: string) => k(ownerPk, `INPUT#${inputId}`),
  eventId: (eventId: string) => k(`EVID#${eventId}`, "META"),
  delivery: (deliveryId: string) => k(`GHDELIVERY#${deliveryId}`, "META"),
  trace: (attemptId: string, sequence: number) => k(`TRACE#${attemptId}`, String(sequence).padStart(12, "0")),
  tracePrefix: (attemptId: string) => ({ pk: `TRACE#${attemptId}`, skPrefix: "" }),
  repo: (repo: string) => k(`REPO#${repo}`, "META"),
  repoLease: (repo: string) => k(`REPO#${repo}`, "LEASE"),
  repoFile: (repo: string, path: string) => k(`REPO#${repo}`, `FILE#${path}`),
  repoFilesPrefix: (repo: string) => ({ pk: `REPO#${repo}`, skPrefix: "FILE#" }),
  settings: () => k("SETTINGS", "GLOBAL"),
  runListItem: (startedAt: string, runId: string) => k("RUNS", `${startedAt}#${runId}`),
  idempotency: (scope: string, key: string) => k(`IDEMP#${scope}`, key),
} as const;

/** Values of the single overloaded secondary index `gsi1`. */
export const gsi = {
  pendingIntent: (nextTryAt: string, pk: string, sk: string) => ({ gsi1pk: "PENDING_INTENT", gsi1sk: `${nextTryAt}#${pk}#${sk}` }),
  due: (dueAt: string, attemptId: string) => ({ gsi1pk: "DUE", gsi1sk: `${dueAt}#${attemptId}` }),
  activeRun: (repo: string, runId: string) => ({ gsi1pk: "ACTIVE_RUNS", gsi1sk: `${repo}#${runId}` }),
  dagList: (importedAt: string, dagId: string) => ({ gsi1pk: "DAGS", gsi1sk: `${importedAt}#${dagId}` }),
  runList: (startedAt: string, runId: string) => ({ gsi1pk: "RUNS", gsi1sk: `${startedAt}#${runId}` }),
} as const;

export const ownerPk = {
  attempt: (attemptId: string) => `ATT#${attemptId}`,
  run: (runId: string) => `RUN#${runId}`,
  repo: (repo: string) => `REPO#${repo}`,
} as const;
