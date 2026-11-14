import { describe, expect, test } from "vitest";
import { updateRequest } from "./update-request.js";

describe("the update request (FR-042)", () => {
  test("names main's head and asks for an update from main that resolves the conflicts", () => {
    const text = updateRequest({ reason: "conflict", mainCommit: "c".repeat(40) });
    expect(text).toContain("c".repeat(40));
    expect(text).toMatch(/update the pull request from main/i);
    expect(text).toMatch(/resolve the conflicts/i);
  });

  test("a PR that failed its checks in the merge queue is asked to update and fix them", () => {
    const text = updateRequest({ reason: "failed_checks", mainCommit: null, failing: ["ci/test"] });
    expect(text).toMatch(/update the pull request from main/i);
    expect(text).toContain("ci/test");
    expect(text).toContain("the current main");
  });
});
