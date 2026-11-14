import type { Clock } from "@rovara-orch/core";

/** A clock tests move by hand. */
export class FakeClock implements Clock {
  private t: number;
  constructor(start = "2026-11-11T00:00:00.000Z") {
    this.t = Date.parse(start);
  }
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(iso: string): void {
    this.t = Date.parse(iso);
  }
}
