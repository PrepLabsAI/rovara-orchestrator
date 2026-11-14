import { keys } from "./keys.js";
import { ConditionFailed, type Table } from "./table.js";

export const LEASE_MS = 60_000;

/** Take the repository's scheduler lease, or return false when another pass holds an unexpired one. */
export async function acquireLease(table: Table, repo: string, owner: string, now: Date): Promise<boolean> {
  try {
    await table.transact([
      {
        kind: "put",
        item: { ...keys.repoLease(repo), entityType: "LEASE", owner, leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString() },
        condition: {
          expression: "attribute_not_exists(pk) OR #u < :now OR #o = :owner",
          names: { "#u": "leaseUntil", "#o": "owner" },
          values: { ":now": now.toISOString(), ":owner": owner },
        },
      },
    ]);
    return true;
  } catch (e) {
    if (e instanceof ConditionFailed) return false;
    throw e;
  }
}

export async function releaseLease(table: Table, repo: string, owner: string): Promise<void> {
  try {
    await table.transact([
      {
        kind: "put",
        item: { ...keys.repoLease(repo), entityType: "LEASE", owner: null, leaseUntil: "1970-01-01T00:00:00.000Z" },
        condition: { expression: "#o = :owner", names: { "#o": "owner" }, values: { ":owner": owner } },
      },
    ]);
  } catch (e) {
    if (!(e instanceof ConditionFailed)) throw e;
  }
}
