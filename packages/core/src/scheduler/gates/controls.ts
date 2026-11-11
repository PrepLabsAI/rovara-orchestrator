import type { Gate, Hold } from "../types.js";

/** Nothing starts while the stop switch is on, the run is paused, or the run is at its cost limit (FR-050 to FR-052). */
export const controlsGate: Gate = (snapshot, candidates) => {
  const pass = [];
  const hold: Hold[] = [];
  for (const c of candidates) {
    if (snapshot.settings.stopSwitch.on) hold.push({ candidate: c, waitingFor: { reason: "paused", detail: "the stop switch is on" } });
    else if (c.run.state === "paused") hold.push({ candidate: c, waitingFor: { reason: "paused", detail: "the run is paused" } });
    else if (c.run.costUsd >= c.run.costLimitUsd) hold.push({ candidate: c, waitingFor: { reason: "cost", detail: `cost limit $${c.run.costLimitUsd} reached` } });
    else pass.push(c);
  }
  return { pass, hold };
};
