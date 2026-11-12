import { ApiError } from "../errors.js";
import type { Route } from "../types.js";

const repoOf = (p: Record<string, string>) => `${p.owner}/${p.name}`;

const positive = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ApiError("INVALID", `${name} must be a whole number of at least 1`, { problem: name });
  return v;
};

export const routes: Route[] = [
  {
    method: "GET",
    pattern: "/v1/repos/:owner/:name",
    handler: async ({ deps, params }) => {
      const r = await deps.repos.getRepo(repoOf(params));
      return { status: 200, body: { repo: r.repo, paused: r.paused, pausedSince: r.pausedSince, mainCommit: r.mainCommit, startRate: r.startRate, rovaraFreeWorkspaces: r.rovaraFreeWorkspaces } };
    },
  },
  {
    // FR-061: only a Rovara administrator may change a project's workspace limit, through Rovara's admin change path.
    method: "POST",
    pattern: "/v1/repos/:owner/:name/workspace-limit",
    handler: async ({ deps, params, req, operator, access }) => {
      if (!access.isAdmin) throw new ApiError("NOT_OPERATOR", "only a Rovara administrator can change the project's workspace limit", { problem: "not_rovara_admin" });
      const body = (req.body ?? {}) as { openWorkspaces?: unknown; openWorkspacesPerPerson?: unknown };
      const openWorkspaces = positive(body.openWorkspaces, "openWorkspaces");
      const openWorkspacesPerPerson = positive(body.openWorkspacesPerPerson, "openWorkspacesPerPerson");
      if (!deps.rovara.requestWorkspaceLimit) throw new ApiError("NOT_IMPLEMENTED", "Rovara cannot change a project's workspace limit yet (PrepLabsAI/Rovara#430)");
      await deps.rovara.requestWorkspaceLimit({ project: repoOf(params), openWorkspaces, openWorkspacesPerPerson, by: operator.id });
      return { status: 202, body: { requested: { openWorkspaces, openWorkspacesPerPerson } } };
    },
  },
];
