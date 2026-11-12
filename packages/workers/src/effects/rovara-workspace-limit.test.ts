import { describe, expect, test } from "vitest";
import type { Intent } from "@rovara-orch/core";
import type { Deps } from "../ports.js";
import { rovaraWorkspaceLimit } from "./rovara-workspace-limit.js";

const intent = { effect: "rovara.workspace_limit", key: "wl:acme/mono:run_1", payload: { repo: "acme/mono", openWorkspaces: 1000, openWorkspacesPerPerson: 1000, by: "dev_admin" } } as unknown as Intent;

describe("rovara.workspace_limit", () => {
  test("answers 'not available' until Rovara#430, without failing", async () => {
    expect(await rovaraWorkspaceLimit(intent, { rovaraAdmin: undefined } as unknown as Deps)).toEqual({ notAvailable: "PrepLabsAI/Rovara#430" });
  });

  test("goes through Rovara's admin change path when it is available", async () => {
    const asked: unknown[] = [];
    const deps = { rovaraAdmin: { requestWorkspaceLimit: async (r: unknown) => void asked.push(r) } } as unknown as Deps;
    expect(await rovaraWorkspaceLimit(intent, deps)).toEqual({ requested: { openWorkspaces: 1000, openWorkspacesPerPerson: 1000 } });
    expect(asked).toEqual([{ project: "acme/mono", openWorkspaces: 1000, openWorkspacesPerPerson: 1000, by: "dev_admin", key: "wl:acme/mono:run_1" }]);
  });
});
