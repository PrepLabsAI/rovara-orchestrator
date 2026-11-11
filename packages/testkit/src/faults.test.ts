import { describe, expect, test } from "vitest";
import { FaultCounts, FaultyPipe, NO_FAULTS, seeded } from "./faults.js";

describe("FaultyPipe", () => {
  test("without faults, delivers everything once and in order", () => {
    const counts = new FaultCounts();
    const p = new FaultyPipe<number>(seeded(1), NO_FAULTS, counts);
    for (let i = 0; i < 10; i++) p.push(i);
    expect(p.take()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Object.values(counts.counts).every((n) => n === 0)).toBe(true);
  });

  test("with faults, everything still arrives at least once, and the faults are counted", () => {
    const counts = new FaultCounts();
    const p = new FaultyPipe<number>(seeded(7), { duplicate: 0.3, delay: 0.3, drop: 0, reorder: 0.5 }, counts);
    for (let i = 0; i < 50; i++) p.push(i);
    const seen: number[] = [];
    for (let round = 0; round < 20 && p.size; round++) seen.push(...p.take());
    expect(new Set(seen).size).toBe(50);
    expect(seen.length).toBeGreaterThan(50);
    expect(counts.counts.duplicate).toBeGreaterThan(0);
    expect(counts.counts.delay).toBeGreaterThan(0);
    expect(counts.counts.reorder).toBeGreaterThan(0);
  });

  test("is deterministic for a seed", () => {
    const run = () => {
      const p = new FaultyPipe<number>(seeded(42), { duplicate: 0.2, delay: 0.2, drop: 0, reorder: 0.2 }, new FaultCounts());
      for (let i = 0; i < 20; i++) p.push(i);
      return [p.take(), p.take()];
    };
    expect(run()).toEqual(run());
  });
});
