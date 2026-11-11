import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { normalizeRepo, validateDag, type Problem } from "./import.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../tests/contract/fixtures/speckit-dag/${name}.json`, import.meta.url), "utf8"));

const onRemote = { commitOnRemote: async () => true };
const notOnRemote = { commitOnRemote: async () => false };

async function problemOf(name: string, github = onRemote): Promise<Problem | undefined> {
  const r = await validateDag(fixture(name), github);
  return r.ok ? undefined : r.problem;
}

describe("validateDag", () => {
  test("accepts the published example", async () => {
    const r = await validateDag(fixture("units"), onRemote);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph.repo).toBe("ps06756/speckit-dag");
      expect(r.graph.nodes.map((n) => n.id)).toEqual(["setup", "foundational", "US1", "US2", "US3", "polish"]);
    }
  });

  // One fixture per refusal, in the order the checks run.
  test.each<[string, Problem, typeof onRemote?]>([
    ["schema", "schema"],
    ["version", "version"],
    ["unit-task", "unit"],
    ["hash-mismatch", "hash_mismatch"],
    ["cycle", "cycle"],
    ["unknown-node", "unknown_node"],
    ["dirty-edited", "spec_dirty"],
    ["unpushed", "spec_not_pushed"],
    ["units", "commit_not_on_remote", notOnRemote],
  ])("%s.json is refused with %s", async (name, problem, github) => {
    expect(await problemOf(name, github)).toBe(problem);
  });

  test("a cycle names the nodes in it", async () => {
    const r = await validateDag(fixture("cycle"), onRemote);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/polish -> setup|setup ->/);
  });

  test("normalizes git remotes to owner/name", () => {
    expect(normalizeRepo("git@github.com:ps06756/speckit-dag.git")).toBe("ps06756/speckit-dag");
    expect(normalizeRepo("https://github.com/acme/mono.git")).toBe("acme/mono");
    expect(normalizeRepo("https://github.com/acme/mono")).toBe("acme/mono");
    expect(normalizeRepo("acme/mono")).toBe("acme/mono");
    expect(normalizeRepo("not a repo")).toBeNull();
  });
});
