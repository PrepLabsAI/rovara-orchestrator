import { describe, expect, test } from "vitest";
import { messages, replies } from "./messages.js";
import { SlackNotifier, type SlackWebLike } from "./notify.js";

function fakeWeb() {
  const posted: Array<Record<string, unknown> & { ts: string }> = [];
  let n = 0;
  const web: SlackWebLike = {
    chat: {
      postMessage: async (args) => {
        const ts = `1700000000.${String(++n).padStart(6, "0")}`;
        posted.push({ ...args, ts });
        return { ok: true, ts };
      },
    },
    conversations: {
      history: async ({ channel }) => ({ messages: posted.filter((p) => p.channel === channel && !p.thread_ts) as never }),
      replies: async ({ ts }) => ({ messages: posted.filter((p) => p.thread_ts === ts) as never }),
    },
  };
  return { web, posted };
}

describe("SlackNotifier", () => {
  test("posts once per key, even when retried", async () => {
    const { web, posted } = fakeWeb();
    const s = new SlackNotifier(web);
    const a = await s.post({ channel: "C1", text: "hello", key: "k1" });
    const b = await s.post({ channel: "C1", text: "hello", key: "k1" });
    expect(a.ts).toBe(b.ts);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.metadata).toEqual({ event_type: "rovara_orch_notification", event_payload: { key: "k1" } });
  });

  test("replies in the original message's thread, once per key", async () => {
    const { web, posted } = fakeWeb();
    const s = new SlackNotifier(web);
    const root = await s.post({ channel: "C1", text: "escalated", key: "k1" });
    await s.reply({ channel: "C1", threadTs: root.ts, text: "retried", key: "k2" });
    await s.reply({ channel: "C1", threadTs: root.ts, text: "retried", key: "k2" });
    expect(posted.filter((p) => p.thread_ts === root.ts)).toHaveLength(1);
  });
});

describe("notification texts", () => {
  test("name what happened, why, and link to the run, node, Rovara task and PR", () => {
    const text = messages.nodeEscalated({
      runId: "run_1",
      nodeId: "US1",
      reason: "out of attempts",
      links: { run: "https://s/run_1", node: "https://s/run_1/US1", rovaraTask: "https://r/t", pullRequest: "https://g/pull/1" },
    });
    expect(text).toContain("run_1 / US1 escalated: out of attempts.");
    expect(text).toContain("<https://r/t|Rovara task>");
    expect(text).toContain("<https://g/pull/1|PR>");
    expect(messages.repoPaused({ repo: "acme/mono", checks: ["ci/test"], commit: "abcdef1234567890", runs: 2 })).toBe(
      ":octagonal_sign: acme/mono main is failing ci/test at abcdef123456. Dispatch and merges paused for 2 runs.",
    );
    expect(replies.nodeResolved({ action: "skipped", operator: "Pratik", reason: "not needed" })).toBe("Skipped by Pratik: not needed.");
  });
});
