import { describe, expect, test } from "vitest";
import { attemptThread, newId, parseAttemptThread, THREAD_RE } from "./ids.js";

describe("ids", () => {
  test("prefixed ids", () => {
    for (const prefix of ["dag", "run", "att", "dec"] as const) {
      expect(newId(prefix)).toMatch(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
    }
  });

  test("attempt thread id round-trips", () => {
    const thread = attemptThread("run_01J0000000000000000000000A", "US1", 2);
    expect(thread).toBe("run_01J0000000000000000000000A.US1.a2");
    expect(thread).toMatch(THREAD_RE);
    expect(parseAttemptThread(thread)).toEqual({ runId: "run_01J0000000000000000000000A", nodeId: "US1", n: 2 });
  });

  test("refuses characters Rovara does not allow, and threads over 128 characters", () => {
    expect(() => attemptThread("run_x", "US 1", 1)).toThrow(/thread/);
    expect(() => attemptThread("run_x", "US/1", 1)).toThrow(/thread/);
    expect(() => attemptThread("run_" + "x".repeat(120), "US1", 1)).toThrow(/128/);
    expect(() => attemptThread("run_x", "US1", 0)).toThrow(/attempt number/);
  });

  test("parseAttemptThread returns undefined for foreign threads", () => {
    expect(parseAttemptThread("1700000000.123456")).toBeUndefined();
  });
});
