import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { contentHash } from "./hash.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../tests/contract/fixtures/speckit-dag/${name}.json`, import.meta.url), "utf8"));

/** Fixtures whose recorded hash speckit-dag computed itself. */
const HASHED = ["units", "edited", "dirty-edited", "ticked", "unpushed", "unit-task", "cycle", "unknown-node"];

describe("contentHash (port of speckit-dag's identity.content_hash)", () => {
  test.each(HASHED)("equals speckit-dag's recorded hash for %s.json", (name) => {
    const g = fixture(name);
    expect(contentHash(g)).toBe(g.hash);
  });

  test("an edited task gives a new hash; a ticked checkbox does not", () => {
    const units = fixture("units");
    expect(contentHash(fixture("edited"))).not.toBe(contentHash(units));
    expect(contentHash(fixture("ticked"))).toBe(contentHash(units));
  });

  test("ignores where the graph came from and line numbers", () => {
    const g = fixture("units");
    const moved = { ...g, source: "elsewhere/tasks.md", spec: { ...g.spec, dir: "x", commit: "f".repeat(40) } };
    moved.nodes = g.nodes.map((n: Record<string, unknown>) => ({ ...n, line: 999, end_line: 1000 }));
    expect(contentHash(moved)).toBe(g.hash);
  });
});
