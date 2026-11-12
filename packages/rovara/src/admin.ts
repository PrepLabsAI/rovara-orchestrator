/**
 * Rovara's admin change path for project workspace limits (FR-061). Rovara has no such path yet:
 * PrepLabsAI/Rovara#430 asks for it. Until it lands there is no client, and every caller treats
 * the request as "not available": the API answers 501, and runs start at the current limit.
 * When #430 lands, this returns a client for the documented route, and nothing else changes.
 */
export interface RovaraAdminClient {
  requestWorkspaceLimit(input: { project: string; openWorkspaces: number; openWorkspacesPerPerson: number; by: string; key?: string }): Promise<void>;
}

export const ROVARA_ADMIN_ISSUE = "PrepLabsAI/Rovara#430";

export function rovaraAdminClient(_opts: { baseUrl: string; secret: string }): RovaraAdminClient | undefined {
  return undefined;
}
