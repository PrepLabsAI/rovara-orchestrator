import type { Executor } from "./types.js";

/**
 * rovara.workspace_limit: ask Rovara to raise the project's workspace limit through its admin
 * change path (FR-061). Until PrepLabsAI/Rovara#430 adds that path, it answers "not available"
 * without failing, and the run starts at the current limit.
 */
export const rovaraWorkspaceLimit: Executor = async (intent, deps) => {
  const p = intent.payload as { repo: string; openWorkspaces: number; openWorkspacesPerPerson: number; by: string };
  if (!deps.rovaraAdmin) return { notAvailable: "PrepLabsAI/Rovara#430" };
  await deps.rovaraAdmin.requestWorkspaceLimit({ project: p.repo, openWorkspaces: p.openWorkspaces, openWorkspacesPerPerson: p.openWorkspacesPerPerson, by: p.by, key: intent.key });
  return { requested: { openWorkspaces: p.openWorkspaces, openWorkspacesPerPerson: p.openWorkspacesPerPerson } };
};
