import { describe, expect, test } from "vitest";
import { gsi, keys } from "./keys.js";

describe("keys", () => {
  test("follow the data model", () => {
    expect(keys.dag("dag_1")).toEqual({ pk: "DAG#dag_1", sk: "META" });
    expect(keys.dagNode("dag_1", "US1")).toEqual({ pk: "DAG#dag_1", sk: "NODE#US1" });
    expect(keys.dagHash("o/r", "sha256:ab")).toEqual({ pk: "DAGHASH#o/r#sha256:ab", sk: "META" });
    expect(keys.dagActiveRun("dag_1")).toEqual({ pk: "DAGRUN#dag_1", sk: "ACTIVE" });
    expect(keys.runNode("run_1", "US1")).toEqual({ pk: "RUN#run_1", sk: "NODE#US1" });
    expect(keys.decision("run_1", "2026-11-11T00:00:00.000Z", "dec_1").sk).toBe("DEC#2026-11-11T00:00:00.000Z#dec_1");
    expect(keys.question("att_1", "evt_1")).toEqual({ pk: "ATT#att_1", sk: "Q#evt_1" });
    expect(keys.reviewComment("att_1", 7, "T1")).toEqual({ pk: "ATT#att_1", sk: "RC#7#T1" });
    expect(keys.event("att_1", "t", "evt_1").sk).toBe("EV#t#evt_1");
    expect(keys.intent("ATT#att_1", "01J").sk).toBe("INTENT#01J");
    expect(keys.eventId("evt_1")).toEqual({ pk: "EVID#evt_1", sk: "META" });
    expect(keys.repoLease("o/r")).toEqual({ pk: "REPO#o/r", sk: "LEASE" });
    expect(keys.repoFile("o/r", "src/a.ts")).toEqual({ pk: "REPO#o/r", sk: "FILE#src/a.ts" });
    expect(keys.settings()).toEqual({ pk: "SETTINGS", sk: "GLOBAL" });
  });

  test("trace sequence is zero-padded to 12 so keys sort numerically", () => {
    expect(keys.trace("att_1", 42).sk).toBe("000000000042");
    expect(keys.trace("att_1", 9).sk < keys.trace("att_1", 10).sk).toBe(true);
  });

  test("index values sort by time", () => {
    expect(gsi.pendingIntent("2026-01-01T00:00:00.000Z", "ATT#a", "INTENT#1").gsi1sk).toBe(
      "2026-01-01T00:00:00.000Z#ATT#a#INTENT#1",
    );
    expect(gsi.due("t1", "att_1")).toEqual({ gsi1pk: "DUE", gsi1sk: "t1#att_1" });
  });
});
