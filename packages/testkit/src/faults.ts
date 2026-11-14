/**
 * Seeded fault injection for deliveries (Rovara callbacks, GitHub webhooks, queue messages).
 * A delivery may be duplicated, delayed, dropped (the sender retries it later, as Rovara and GitHub
 * do when they see no 2xx) or reordered with its neighbours. Every injected fault is counted, so a
 * test can assert the faults actually happened (a quiet injector would make fault tests vacuous).
 */

export interface FaultRates {
  duplicate: number;
  delay: number;
  drop: number;
  reorder: number;
}

export const NO_FAULTS: FaultRates = { duplicate: 0, delay: 0, drop: 0, reorder: 0 };
export const SOME_FAULTS: FaultRates = { duplicate: 0.15, delay: 0.15, drop: 0.1, reorder: 0.2 };

export type FaultKind = keyof FaultRates | "restart";

export class FaultCounts {
  readonly counts: Record<FaultKind, number> = { duplicate: 0, delay: 0, drop: 0, reorder: 0, restart: 0 };
  add(kind: FaultKind) {
    this.counts[kind]++;
  }
}

/** mulberry32: a small, seeded, deterministic random source. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A pipe of deliveries. `push` adds one; `take` returns the next batch to deliver, after faults.
 * A dropped delivery comes back in a later batch; a delayed one skips a batch.
 */
export class FaultyPipe<T> {
  private queue: Array<{ item: T; holdFor: number }> = [];

  constructor(
    private readonly rng: () => number,
    private readonly rates: FaultRates,
    private readonly counts: FaultCounts,
  ) {}

  push(item: T): void {
    this.queue.push({ item, holdFor: 0 });
    if (this.rng() < this.rates.duplicate) {
      this.counts.add("duplicate");
      this.queue.push({ item, holdFor: 1 });
    }
  }

  get size(): number {
    return this.queue.length;
  }

  /** The deliveries due now, in delivery order. */
  take(): T[] {
    const due: T[] = [];
    const later: Array<{ item: T; holdFor: number }> = [];
    for (const d of this.queue) {
      if (d.holdFor > 0) {
        later.push({ ...d, holdFor: d.holdFor - 1 });
      } else if (this.rng() < this.rates.delay) {
        this.counts.add("delay");
        later.push({ ...d, holdFor: 1 });
      } else {
        due.push(d.item);
      }
    }
    this.queue = later;
    for (let i = due.length - 1; i > 0; i--) {
      if (this.rng() < this.rates.reorder) {
        this.counts.add("reorder");
        const j = Math.floor(this.rng() * (i + 1));
        [due[i], due[j]] = [due[j]!, due[i]!];
      }
    }
    return due;
  }

  /** The sender saw no 2xx (a drop or a crash before the answer) and will retry this delivery. */
  retryLater(item: T): void {
    this.queue.push({ item, holdFor: 1 });
  }

  /** Whether this delivery is dropped on the way (to be retried later). */
  dropped(): boolean {
    if (this.rng() < this.rates.drop) {
      this.counts.add("drop");
      return true;
    }
    return false;
  }
}
