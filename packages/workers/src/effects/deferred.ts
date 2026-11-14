/**
 * Thrown by an executor whose effect cannot be carried out yet for a reason that is not a failure
 * (the run is paused for its operator's Rovara access). Tried again later; tries are not counted.
 */
export class Deferred extends Error {
  constructor(reason: string, readonly retryInMs = 60_000) {
    super(reason);
    this.name = "Deferred";
  }
}
