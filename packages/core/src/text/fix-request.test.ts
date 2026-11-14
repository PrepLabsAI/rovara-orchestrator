import { describe, expect, test } from "vitest";
import { fixRequest } from "./fix-request.js";

const failed = [
  "Not done: unit tests passed before and fails now.",
  "Fails now, with no earlier result: lint.",
  "FAIL src/signup.test.ts > rejects a short password",
  "  expected 400, got 200",
].join("\n");

describe("the fix request (FR-031)", () => {
  test("quotes the failing report in full, as Rovara sent it", () => {
    const text = fixRequest([{ status: "failed", at: "t1", text: failed }]);
    for (const line of failed.split("\n")) expect(text).toContain(line);
    expect(text).toMatch(/fix/i);
    expect(text).toMatch(/run the checks again/i);
  });

  test("uses only the latest report: nothing from an earlier, passing one", () => {
    const text = fixRequest([
      { status: "passed", at: "t0", text: "Checks passed (12 project checks)." },
      { status: "failed", at: "t1", text: failed },
    ]);
    expect(text).not.toContain("Checks passed (12 project checks).");
  });

  test("an unknown result asks for the checks to be run and reported", () => {
    const text = fixRequest([{ status: "unknown", at: "t1", text: "Not verified: the task stopped before AgentX could check it." }]);
    expect(text).toContain("Not verified: the task stopped before AgentX could check it.");
    expect(text).toMatch(/could not be confirmed/i);
  });
});
