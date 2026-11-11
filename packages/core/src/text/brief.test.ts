import { describe, expect, test } from "vitest";
import { aDag, aDagNode } from "../testing/fixtures.js";
import { CREATE_PR, nodeBrief, reviewRound } from "./brief.js";

describe("node brief", () => {
  const dag = aDag({ specDir: "specs/001-auth", docs: { spec: "specs/001-auth/spec.md", plan: "specs/001-auth/plan.md" }, commit: "c".repeat(40) });
  const node = aDagNode({
    title: "User Story 1 - Sign up",
    kind: "story",
    tasks: [
      { id: "T010", title: "Create User model", text: "- [ ] T010 [P] [US1] Create User model in src/models/user.py", ref: "x#T010", files: ["src/models/user.py"] },
      { id: "T011", title: "Implement signup", text: "- [ ] T011 [US1] Implement SignupService in src/services/signup.py\n  - hash the password", ref: "x#T011", files: [] },
    ],
  });
  const text = nodeBrief({ dag, node, baseCommit: "b".repeat(40) });

  test("names the node and its kind", () => {
    expect(text).toContain("User Story 1 - Sign up");
    expect(text).toContain("story");
  });

  test("includes every task's full text, in DAG order", () => {
    const a = text.indexOf("- [ ] T010 [P] [US1] Create User model in src/models/user.py");
    const b = text.indexOf("- [ ] T011 [US1] Implement SignupService in src/services/signup.py\n  - hash the password");
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
  });

  test("points to the spec folder and every document at the DAG's commit, and names the base commit", () => {
    expect(text).toContain("specs/001-auth");
    expect(text).toContain("specs/001-auth/spec.md");
    expect(text).toContain("specs/001-auth/plan.md");
    expect(text).toContain("c".repeat(40));
    expect(text).toContain("b".repeat(40));
  });

  test("gives all four instructions", () => {
    expect(text).toMatch(/implement the tasks in order/i);
    expect(text).toMatch(/keep to the listed files/i);
    expect(text).toMatch(/run the project's checks/i);
    expect(text).toMatch(/do not open a pull request until asked/i);
  });

  test("the create-PR message is fixed", () => {
    expect(CREATE_PR).toBe("Checks passed. Create the pull request.");
  });

  test("a review round lists each comment's file, line and link", () => {
    const m = reviewRound([
      { path: "src/a.ts", line: 12, url: "https://github.com/o/r/pull/1#c1", body: "Handle null" },
      { path: null, line: null, url: "https://github.com/o/r/pull/1#c2", body: "General remark" },
    ]);
    expect(m).toMatch(/review comment/i);
    expect(m).toContain("src/a.ts:12");
    expect(m).toContain("https://github.com/o/r/pull/1#c1");
    expect(m).toContain("Handle null");
    expect(m).toContain("https://github.com/o/r/pull/1#c2");
    expect(m).toMatch(/fix it with a commit or reply/i);
  });
});
