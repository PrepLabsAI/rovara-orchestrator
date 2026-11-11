import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { routeGithubEvent, type Deps } from "@rovara-orch/workers";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/github-main/${name}.json`, import.meta.url), "utf8"));
const head = "2".repeat(40);
const group = "repo:acme/mono";

/** Main-health inputs are built from a fresh read of main's required checks, never from one payload. */
function depsWith(status: "passed" | "failed" | "pending") {
  const reads: string[] = [];
  const deps = {
    github: {
      requiredChecksOnMain: async (repo: string) => (reads.push(repo), { headSha: head, status, failing: status === "failed" ? ["ci/test"] : [] }),
    },
  } as unknown as Deps;
  return { deps, reads };
}

async function map(event: string, name: string, status: "passed" | "failed" | "pending" = "failed") {
  const { deps, reads } = depsWith(status);
  const payload = fixture(name);
  const handler = routeGithubEvent(event, payload);
  return { messages: handler ? await handler(deps, payload, "d1") : [], reads };
}

describe("GitHub events on main map to repository inputs", () => {
  test("a push to main records the new head", async () => {
    expect((await map("push", "push.main")).messages).toEqual([{ group, input: { kind: "main_push", headSha: head } }]);
  });

  test("a push to another branch is ignored", async () => {
    expect((await map("push", "push.branch")).messages).toEqual([]);
  });

  test.each([
    ["check_suite", "check_suite.completed.main", "failed"],
    ["check_run", "check_run.completed.main", "passed"],
    ["status", "status.main", "pending"],
  ] as const)("%s on main reads main's required checks afresh", async (event, name, status) => {
    const { messages, reads } = await map(event, name, status);
    expect(reads).toEqual(["acme/mono"]);
    expect(messages).toEqual([
      { group, input: { kind: "main_checks", headSha: head, status, failing: status === "failed" ? ["ci/test"] : [], confirmed: true } },
    ]);
  });
});
