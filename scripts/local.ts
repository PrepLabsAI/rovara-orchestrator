/**
 * The orchestrator on this machine, against the fake Rovara, GitHub, Slack and model, on DynamoDB
 * Local (`npm run db:up` first). The operator API listens on http://localhost:3000, for the CLI and
 * the status page (`VITE_API_URL=http://localhost:3000 npm run -w packages/web dev`). Simulated
 * time runs faster than real time: each tick moves the fakes' clock forward.
 *
 *   npx tsx scripts/local.ts                     # an empty orchestrator: import and start with the CLI
 *   npx tsx scripts/local.ts --demo              # also seeds a 6-node DAG and starts a run
 *   npx tsx scripts/local.ts --repo owner/name   # the monorepo the fake GitHub plays (default acme/mono)
 *   npx tsx scripts/local.ts --demo --pace 700   # slower, to watch it (ms between steps; default 150)
 *
 * The status page (built with `npm run -w packages/web build`) is served at http://localhost:3000/,
 * already signed in.
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { handle, type ApiDeps } from "@rovara-orch/api";
import { DevIdentity } from "@rovara-orch/identity";
import { createHarness } from "@rovara-orch/testkit";

const flag = (name: string) => process.argv.includes(`--${name}`);
const value = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const port = Number(value("port") ?? 3000);
const pace = Number(value("pace") ?? 150);
const pageDir = join(import.meta.dirname, "../packages/web/dist");

const h = await createHarness({ name: "local", seed: Date.now() % 100_000, github: { repo: value("repo") ?? "acme/mono" } });
const identity = new DevIdentity({ stage: "local", signingKey: "local-signing-key", operators: [{ id: "dev_op", name: "Local operator", admin: true }] });
const { token } = await identity.login("dev_op");
const deps: ApiDeps = {
  table: h.table,
  repos: h.repos,
  identity,
  clock: h.clock,
  // The fake GitHub cannot see a real repository, so locally every commit counts as pushed.
  github: { commitOnRemote: async () => true },
  rovara: { linkUrl: async () => null, isLinked: async () => true },
  config: { statusPageUrl: "http://localhost:5173" },
};

const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, idempotency-key", "access-control-allow-methods": "GET, POST, PUT" };
createServer(async (req, res) => {
  if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
  const path = new URL(req.url ?? "/", `http://localhost:${port}`).pathname;
  if (!path.startsWith("/v1/") && req.method === "GET") return servePage(path, res);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    return void res.writeHead(422, { "content-type": "application/json", ...cors }).end(JSON.stringify({ error: { code: "INVALID", message: "body is not JSON" } }));
  }
  const r = await handle(deps, { method: req.method ?? "GET", path: url.pathname, headers: req.headers as Record<string, string>, query: Object.fromEntries(url.searchParams), body });
  res.writeHead(r.status, { "content-type": "application/json", ...cors }).end(JSON.stringify(r.body));
}).listen(port);

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

/** The built status page, with the local token put in the tab so it opens signed in. */
function servePage(path: string, res: import("node:http").ServerResponse) {
  if (!existsSync(pageDir)) return void res.writeHead(404, { "content-type": "text/plain" }).end("Build the page first: npm run -w packages/web build");
  const file = path === "/" ? "index.html" : normalize(path).replace(/^([/\\]|\.\.)+/, "");
  const full = join(pageDir, file);
  if (!full.startsWith(pageDir) || !existsSync(full)) return void res.writeHead(404).end();
  let body: string | Buffer = readFileSync(full);
  if (file === "index.html") body = body.toString("utf8").replace("<head>", `<head><script>sessionStorage.setItem("rovara-orch-token", ${JSON.stringify(token)})</script>`);
  res.writeHead(200, { "content-type": TYPES[extname(full)] ?? "application/octet-stream" }).end(body);
}

if (flag("demo")) {
  const dagId = await h.seedDag([
    { nodeId: "setup", kind: "setup", files: ["package.json"] },
    { nodeId: "foundational", kind: "foundational", dependsOn: ["setup"], files: ["src/db.ts"] },
    { nodeId: "US1", dependsOn: ["foundational"], files: ["src/signup.ts"], title: "Sign up" },
    { nodeId: "US2", dependsOn: ["foundational"], files: ["src/login.ts"], title: "Log in" },
    { nodeId: "US3", dependsOn: ["foundational"], files: ["src/reset.ts"], title: "Reset a password" },
    { nodeId: "polish", kind: "polish", dependsOn: ["US1", "US2", "US3"], files: ["README.md"] },
  ]);
  h.rovara.setBehaviour("US2", { checks: ["failed"], questions: [{ text: "Lock the account after 5 or 10 failed logins?", choices: ["5", "10"] }] });
  const runId = await h.startRun(dagId, { concurrency: 3, operator: "dev_op" });
  console.log(`Demo run ${runId} started.`);
}

console.log(`Status page: http://localhost:${port}/`);
console.log(`Operator API on http://localhost:${port}`);
console.log(`Token: ${token}`);
console.log(`  rovara-orch --url http://localhost:${port} login --token ${token}`);

// Drive the fakes and the workers: deliver, run intents, consume; a sweep when nothing happened.
for (;;) {
  h.clock.advance(1000);
  if (!(await h.step())) await h.idle();
  await new Promise((r) => setTimeout(r, pace));
}
