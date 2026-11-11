/** Injectable time source, so tests and the fault harness control "now". */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function isoNow(clock: Clock): string {
  return clock.now().toISOString();
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(Date.parse(iso) + minutes * 60_000).toISOString();
}
