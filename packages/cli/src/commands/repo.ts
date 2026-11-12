import { Option, type Command } from "commander";
import { CliFailure, EXIT, expectOk, print, type CliContext } from "../context.js";

interface RepoView {
  repo: string;
  paused: boolean;
  pausedSince: string | null;
  mainCommit: string | null;
  startRate: number | null;
  rovaraFreeWorkspaces: number | null;
}

const count = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new CliFailure(EXIT.usage, "limits are whole numbers of at least 1");
  return n;
};
const path = (repo: string) => {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new CliFailure(EXIT.usage, "name the repository as owner/name");
  return `/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
};

/** repo status | workspace-limit (FR-044, FR-061, FR-063). */
export function register(program: Command, ctx: () => CliContext): void {
  const repo = program.command("repo").description("Repository pause state and capacity");
  repo
    .command("status <repo>")
    .description("Show whether main is red, the start rate and Rovara's free workspaces")
    .action(async (name: string) => {
      const c = ctx();
      const r = expectOk(await c.api.request("GET", path(name))) as RepoView;
      print(c, r, () => [
        `${r.repo}: ${r.paused ? `paused since ${r.pausedSince} (main is red)` : "running"}${r.mainCommit ? `, main at ${r.mainCommit.slice(0, 12)}` : ""}`,
        `Start rate: ${r.startRate === null ? "no limit" : `${r.startRate} starts a minute`}`,
        `Rovara: ${r.rovaraFreeWorkspaces === null ? "free workspaces unknown" : `${r.rovaraFreeWorkspaces} free workspaces`}`,
      ]);
    });
  repo
    .command("workspace-limit <repo>")
    .description("Ask Rovara to set the project's workspace limit (Rovara administrators only)")
    .addOption(new Option("--open <n>", "open workspaces for the project").argParser(count).makeOptionMandatory())
    .addOption(new Option("--per-person <n>", "open workspaces per person").argParser(count).makeOptionMandatory())
    .action(async (name: string, o: { open: number; perPerson: number }) => {
      const c = ctx();
      const r = expectOk(await c.api.request("POST", `${path(name)}/workspace-limit`, { openWorkspaces: o.open, openWorkspacesPerPerson: o.perPerson }));
      print(c, r, () => [`Asked Rovara to set ${name}'s workspace limit to ${o.open} (${o.perPerson} per person).`]);
    });
}
