import type { CheckReportRecord } from "../model.js";

/**
 * Sent when the checks did not pass (FR-031). Rovara's check report already names the failing
 * checks with their output; it is quoted whole, never parsed (constitution IV: Rovara's wording is
 * not read). Only the latest report is used, so nothing from an earlier passing one is repeated.
 */
export function fixRequest(reports: readonly CheckReportRecord[]): string {
  const last = reports.at(-1);
  const head =
    last?.status === "unknown"
      ? "The checks could not be confirmed. Fix whatever stops them running, run the checks again, and report back."
      : "The checks failed. Fix the failures below, run the checks again, and report back.";
  return [head, "", "Check report:", last?.text ?? "(no report text)"].join("\n");
}
