/** Back-off windows are 5 minutes (FR-063). */
export const RATE_WINDOW_MINUTES = 5;
/** More than this share of start requests refused for throttling in a window halves the start rate. */
export const THROTTLE_SHARE = 0.1;
/** A window with no throttling raises the start rate by this share of the run's concurrency limit. */
export const RAISE_SHARE = 0.1;

/**
 * The start rate (starts a minute) for the next window, from the last one. `null` means no cap.
 * More than 10% of start requests refused for throttling halves it; a window with none adds 10% of
 * the concurrency limit, and reaching the limit removes the cap (FR-063).
 */
export function nextStartRate(w: { current: number | null; requests: number; throttled: number; concurrencyLimit: number }): number | null {
  const current = w.current ?? w.concurrencyLimit;
  if (w.requests > 0 && w.throttled / w.requests > THROTTLE_SHARE) return Math.max(1, Math.floor(current / 2));
  if (w.throttled > 0) return w.current;
  if (w.current === null) return null;
  const next = w.current + Math.ceil(RAISE_SHARE * w.concurrencyLimit);
  return next >= w.concurrencyLimit ? null : next;
}

/** The window a moment falls in, counted in whole windows since the epoch. */
export const rateWindowOf = (at: Date | string): number => Math.floor(new Date(at).getTime() / (RATE_WINDOW_MINUTES * 60_000));
export const minuteOf = (at: Date | string): number => Math.floor(new Date(at).getTime() / 60_000);

/** After a workspace-limit refusal, starts on the repository wait this long before Rovara is tried again (FR-062). */
export const WORKSPACE_LIMIT_HOLD_MS = 60_000;
