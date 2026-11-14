import type { Dag, DagNode } from "../model.js";

/** The first message of every attempt (FR-021). */
export function nodeBrief(p: { dag: Dag; node: DagNode; baseCommit: string | null }): string {
  const docs = Object.entries(p.dag.docs)
    .map(([name, path]) => `- ${name}: ${path}`)
    .join("\n");
  const tasks = p.node.tasks.map((t) => t.text).join("\n");
  const files = p.node.files.filter((f) => !f.endsWith("/"));
  return [
    `Node: ${p.node.title} (${p.node.kind})`,
    "",
    `Spec folder: ${p.dag.specDir} at commit ${p.dag.commit}`,
    ...(docs ? ["Documents:", docs] : []),
    `Base commit (start from main at this commit or later): ${p.baseCommit ?? "the current main"}`,
    "",
    "Tasks, in order:",
    tasks,
    "",
    "Instructions:",
    "1. Implement the tasks in order.",
    `2. Keep to the listed files where possible${files.length ? `: ${files.join(", ")}` : ""}.`,
    "3. Run the project's checks.",
    "4. Do not open a pull request until asked.",
  ].join("\n");
}

/** Sent when the checks passed and there is no pull request yet (FR-024). */
export const CREATE_PR = "Checks passed. Create the pull request.";

export interface ReviewCommentRef {
  path: string | null;
  line: number | null;
  url: string | null;
  body: string;
}

/** One review round: every unresolved review-tool comment (FR-045). */
export function reviewRound(comments: ReviewCommentRef[]): string {
  const items = comments.map((c, i) => {
    const where = c.path ? `${c.path}${c.line ? `:${c.line}` : ""}` : "general";
    return `${i + 1}. ${where}${c.url ? ` (${c.url})` : ""}\n   ${c.body.replace(/\n/g, "\n   ")}`;
  });
  return [
    `Address the review comments on the pull request (${comments.length}).`,
    "For each one, fix it with a commit or reply on the thread with the reason it should stand.",
    "",
    ...items,
  ].join("\n");
}
