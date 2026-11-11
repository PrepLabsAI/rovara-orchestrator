/**
 * Sent when a PR conflicts with main, is out of date, or failed its checks in the merge queue
 * against the latest main (FR-042).
 */
export function updateRequest(p: { reason: "conflict" | "out_of_date" | "failed_checks" | "other"; mainCommit: string | null; failing?: string[] }): string {
  const main = p.mainCommit ? `main at ${p.mainCommit}` : "the current main";
  const why =
    p.reason === "failed_checks"
      ? `The pull request failed its checks in the merge queue against ${main}${p.failing?.length ? ` (${p.failing.join(", ")})` : ""}.`
      : p.reason === "conflict"
        ? `The pull request conflicts with ${main}.`
        : `The pull request is out of date with ${main}.`;
  const ask =
    p.reason === "failed_checks"
      ? "Update the pull request from main, fix the failing checks, run the checks again and push."
      : "Update the pull request from main and resolve the conflicts, run the checks again and push.";
  return `${why}\n${ask}`;
}
