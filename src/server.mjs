import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import * as store from "./store.mjs";
import { parseCron, matches, nextRuns, describe } from "./cron.mjs";
import { AGENTS, startRun, isRunning, failInterrupted } from "./runner.mjs";
import { seeds } from "./seeds.mjs";

const PORT = Number(process.env.ROUTINEBAR_PORT || 4141);
const INDEX = new URL("../public/index.html", import.meta.url);
const PROVIDERS = ["claudeAgent", "codex"];
const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "full-access"];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validateRoutine(id, b) {
  const str = (k, v = b?.[k]) => {
    if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `${k} must be a non-empty string`);
    return v;
  };
  const oneOf = (k, v, list) => {
    if (!list.includes(v)) throw new HttpError(400, `${k} must be one of ${list.join(", ")}`);
    return v;
  };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new HttpError(400, "id must be a lowercase slug");
  if (typeof b?.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
  try {
    parseCron(b.schedule);
  } catch (e) {
    throw new HttpError(400, `schedule: ${e.message}`);
  }
  const agent = oneOf("agent", b.agent, Object.keys(AGENTS));
  const cwd = str("cwd");
  if (!cwd.startsWith("/")) throw new HttpError(400, "cwd must be an absolute path");
  const t3 = b.t3 ?? {};
  return {
    id,
    name: str("name"),
    enabled: b.enabled,
    schedule: b.schedule.trim(),
    agent,
    model: str("model"),
    ...(agent === "custom" && { command: str("command") }),
    cwd,
    prompt: agent === "custom" ? String(b.prompt ?? "") : str("prompt"),
    t3: {
      provider: oneOf("t3.provider", t3.provider, PROVIDERS),
      model: str("t3.model", t3.model),
      runtimeMode: oneOf("t3.runtimeMode", t3.runtimeMode, RUNTIME_MODES),
    },
  };
}

function cronPreview(expr) {
  try {
    const c = parseCron(expr);
    return { valid: true, description: describe(c), next: nextRuns(c, new Date(), 5).map((d) => d.toISOString()) };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

function inbox() {
  const routineNames = Object.fromEntries(store.routines().map((r) => [r.id, r.name]));
  const entries = store
    .runs()
    .filter((r) => !r.ackedAt)
    .map((r) => ({ run: r, items: r.items.filter((i) => i.kind !== "fyi") }))
    .filter(({ run, items }) => run.state === "needs_input" || run.state === "failed" || (run.state === "done" && items.length))
    .map(({ run, items }) => ({
      runId: run.id,
      routineName: routineNames[run.routineId] ?? run.routineId,
      state: run.state,
      summary: run.summary ?? run.error,
      finishedAt: run.finishedAt,
      items,
      threads: run.threads,
    }));
  return { count: entries.length, entries };
}

function mustRoutine(id) {
  const r = store.routine(id);
  if (!r) throw new HttpError(404, "no such routine");
  return r;
}

const routes = [
  ["GET", /^\/api\/routines$/, () => store.routines()],
  ["PUT", /^\/api\/routines\/([^/]+)$/, ([id], body) => (store.upsertRoutine(validateRoutine(id, body)), store.routine(id))],
  ["DELETE", /^\/api\/routines\/([^/]+)$/, ([id]) => (store.deleteRoutine(id), { ok: true })],
  [
    "POST",
    /^\/api\/routines\/([^/]+)\/run$/,
    ([id]) => {
      const r = mustRoutine(id);
      if (isRunning(id)) throw new HttpError(409, "already running");
      return startRun(r, "manual");
    },
  ],
  [
    "GET",
    /^\/api\/runs$/,
    (_, __, q) => {
      const id = q.get("routineId");
      return store
        .runs()
        .filter((r) => !id || r.routineId === id)
        .slice(0, Number(q.get("limit")) || 50);
    },
  ],
  [
    "GET",
    /^\/api\/runs\/([^/]+)$/,
    ([id]) => {
      const run = store.run(id);
      if (!run) throw new HttpError(404, "no such run");
      return { ...run, log: store.log(id) };
    },
  ],
  [
    "POST",
    /^\/api\/runs\/([^/]+)\/ack$/,
    ([id]) => {
      const run = store.run(id);
      if (!run) throw new HttpError(404, "no such run");
      run.ackedAt ??= new Date().toISOString();
      store.saveRun(run);
      return run;
    },
  ],
  ["GET", /^\/api\/inbox$/, () => inbox()],
  ["GET", /^\/api\/cron\/preview$/, (_, __, q) => cronPreview(q.get("expr") ?? "")],
];

async function readBody(req) {
  let text = "";
  for await (const c of req) text += c;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(body) : body);
  };
  try {
    if (req.method === "GET" && url.pathname === "/") return send(200, readFileSync(INDEX), "text/html; charset=utf-8");
    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname);
      if (m && req.method === method) return send(200, await handler(m.slice(1).map(decodeURIComponent), await readBody(req), url.searchParams));
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(e.status ?? 500, { error: e.message });
  }
});

let lastTick = 0;
const scheduleTick = () => setTimeout(tick, 60e3 - (Date.now() % 60e3));
function tick() {
  scheduleTick();
  const minute = Math.round(Date.now() / 60e3) * 60e3;
  // Timers can fire slightly early or late; rounding plus this guard runs each minute at most once.
  if (minute === lastTick) return;
  lastTick = minute;
  const now = new Date(minute);
  for (const r of store.routines()) {
    if (r.enabled && matches(parseCron(r.schedule), now) && !isRunning(r.id)) startRun(r, "schedule");
  }
}

if (!store.hasRoutines()) store.saveRoutines(seeds);
failInterrupted();
server.listen(PORT, "127.0.0.1", () => console.log(`routinebar on http://127.0.0.1:${PORT} (home ${store.HOME})`));
scheduleTick();
