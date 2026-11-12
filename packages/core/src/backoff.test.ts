import { describe, expect, test } from "vitest";
import { nextStartRate, RATE_WINDOW_MINUTES } from "./backoff.js";

describe("start-rate back-off (FR-063)", () => {
  test("windows are 5 minutes", () => expect(RATE_WINDOW_MINUTES).toBe(5));

  test("more than 10% of start requests refused for throttling halves the rate", () => {
    expect(nextStartRate({ current: null, requests: 100, throttled: 11, concurrencyLimit: 1000 })).toBe(500);
    expect(nextStartRate({ current: 300, requests: 50, throttled: 20, concurrencyLimit: 1000 })).toBe(150);
    expect(nextStartRate({ current: 1, requests: 10, throttled: 9, concurrencyLimit: 1000 })).toBe(1);
  });

  test("10% or less refused keeps the rate", () => {
    expect(nextStartRate({ current: 300, requests: 100, throttled: 10, concurrencyLimit: 1000 })).toBe(300);
  });

  test("a window with no throttling adds 10% of the concurrency limit, up to the limit (then no cap)", () => {
    expect(nextStartRate({ current: 150, requests: 40, throttled: 0, concurrencyLimit: 1000 })).toBe(250);
    expect(nextStartRate({ current: 950, requests: 40, throttled: 0, concurrencyLimit: 1000 })).toBeNull();
    expect(nextStartRate({ current: null, requests: 0, throttled: 0, concurrencyLimit: 1000 })).toBeNull();
    expect(nextStartRate({ current: 5, requests: 0, throttled: 0, concurrencyLimit: 30 })).toBe(8);
  });
});
