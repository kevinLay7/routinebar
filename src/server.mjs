import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as store from "./store.mjs";
import { parseCron, matches, nextRuns, describe } from "./cron.mjs";
import { AGENTS, startRun, isRunning, failInterrupted } from "./runner.mjs";
import { seeds } from "./seeds.mjs";
import { SOURCES, listSource } from "./importers.mjs";

const PORT = Number(process.env.ROUTINEBAR_PORT || 4141);
const INDEX = new URL("../public/index.html", import.meta.url);
// The dashboard imports the same cron module in the browser so the schedule builder and the server agree.
const CRON_MODULE = new URL("./cron.mjs", import.meta.url);
const MANIFEST = join(homedir(), ".t3", "userdata", "model-manifest.json");
const FALLBACK_MODELS = { claudeAgent: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], codex: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"] };
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
  const from = b.importedFrom;
  if (from !== undefined && (typeof from?.source !== "string" || typeof from.sourceId !== "string" || ![undefined, true].includes(from.needsSchedule)))
    throw new HttpError(400, "importedFrom must be { source, sourceId, needsSchedule?: true }");
  return {
    id,
    name: str("name"),
    enabled: b.enabled,
    schedule: b.schedule
      .split(";")
      .map((e) => e.trim().split(/\s+/).join(" "))
      .filter(Boolean)
      .join("; "),
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
    ...(from && { importedFrom: { source: from.source, sourceId: from.sourceId, ...(from.needsSchedule && { needsSchedule: true }) } }),
  };
}

// Same slug rule as the dashboard editor.
const slug = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "routine";
const importKey = (source, sourceId) => `${source}\n${sourceId}`;
const importedKeys = () => new Set(store.routines().filter((r) => r.importedFrom).map((r) => importKey(r.importedFrom.source, r.importedFrom.sourceId)));

async function importList(only) {
  const sources = await Promise.all(SOURCES.filter((s) => !only || s.id === only).map(listSource));
  const done = importedKeys();
  return { sources: sources.map((s) => ({ ...s, candidates: s.candidates.map((c) => ({ ...c, imported: done.has(importKey(c.source, c.sourceId)) })) })) };
}

// Re-lists the sources server side so a client can only choose what to import, never what gets saved.
async function importItems(body) {
  const items = body?.items;
  if (!Array.isArray(items) || items.some((i) => typeof i?.source !== "string" || typeof i?.sourceId !== "string")) throw new HttpError(400, "items must be [{ source, sourceId }]");
  const wanted = new Set(items.map((i) => importKey(i.source, i.sourceId)));
  const listed = await Promise.all(SOURCES.filter((s) => items.some((i) => i.source === s.id)).map(listSource));
  const candidates = listed.flatMap((s) => s.candidates).filter((c) => wanted.has(importKey(c.source, c.sourceId)));
  // Read and write after the awaits, in one synchronous step, so overlapping imports can't both add the same routine.
  const list = store.routines();
  const done = importedKeys();
  const taken = new Set(["new", ...list.map((r) => r.id)]);
  const t3 = { provider: "claudeAgent", model: models().t3.claudeAgent[0], runtimeMode: "approval-required" };
  const created = [];
  for (const c of candidates) {
    const key = importKey(c.source, c.sourceId);
    if (done.has(key)) continue;
    done.add(key);
    let id = slug(c.name);
    for (let n = 2; taken.has(id); n++) id = `${slug(c.name)}-${n}`;
    taken.add(id);
    created.push({
      id, name: c.name, enabled: false, schedule: c.schedule ?? "0 9 * * 1-5", agent: c.agent, model: c.model, cwd: c.cwd, prompt: c.prompt, t3,
      importedFrom: { source: c.source, sourceId: c.sourceId, ...(!c.schedule && { needsSchedule: true }) },
    });
  }
  if (created.length) store.saveRoutines([...list, ...created]);
  return created;
}

function cronPreview(expr) {
  try {
    const c = parseCron(expr);
    return { valid: true, description: describe(c), next: nextRuns(c, new Date(), 5).map((d) => d.toISOString()) };
  } catch (e) {
    return { valid: false, error: e.message };
  }
}

// Items the inbox shows for a run: needs_you and code, minus the ones marked done one by one.
const openItems = (run) => run.items.filter((i) => i.kind !== "fyi" && !run.doneKeys?.includes(i.key));

function models() {
  let current = {};
  try {
    current = JSON.parse(readFileSync(MANIFEST, "utf8")).manifest.currentModels;
  } catch {}
  const t3 = Object.fromEntries(PROVIDERS.map((p) => [p, current[p]?.length ? current[p] : FALLBACK_MODELS[p]]));
  return { agents: { claude: ["opus", "sonnet", "haiku", ...t3.claudeAgent], codex: t3.codex, custom: [] }, t3 };
}

function routinesWithStatus() {
  const runs = store.runs();
  const now = new Date();
  return store.routines().map((r) => {
    const last = runs.find((x) => x.routineId === r.id);
    let nextRun = null;
    try {
      if (r.enabled) nextRun = nextRuns(parseCron(r.schedule), now, 1)[0]?.toISOString() ?? null;
    } catch {}
    return { ...r, lastRun: last ? { id: last.id, state: last.state, startedAt: last.startedAt, finishedAt: last.finishedAt ?? null } : null, nextRun };
  });
}

function inbox() {
  const routineNames = Object.fromEntries(store.routines().map((r) => [r.id, r.name]));
  const entries = store
    .runs()
    .filter((r) => !r.ackedAt)
    .map((r) => ({ run: r, items: openItems(r) }))
    .filter(({ run, items }) => run.state === "needs_input" || run.state === "failed" || (run.state === "done" && items.length))
    .map(({ run, items }) => ({
      runId: run.id,
      routineId: run.routineId,
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
  ["GET", /^\/api\/routines$/, () => routinesWithStatus()],
  ["GET", /^\/api\/models$/, () => models()],
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
    ([id], body) => {
      const run = store.run(id);
      if (!run) throw new HttpError(404, "no such run");
      const key = body?.key;
      if (key !== undefined) {
        if (!run.items.some((i) => i.key === key)) throw new HttpError(400, "no such item in this run");
        run.doneKeys = [...new Set([...(run.doneKeys ?? []), key])];
      }
      if (key === undefined || (run.state !== "failed" && !openItems(run).length)) run.ackedAt ??= new Date().toISOString();
      store.saveRun(run);
      return run;
    },
  ],
  ["GET", /^\/api\/inbox$/, () => inbox()],
  ["GET", /^\/api\/import$/, (_, __, q) => importList(q.get("source"))],
  ["POST", /^\/api\/import$/, (_, body) => importItems(body)],
  ["GET", /^\/api\/import$/, (_, __, q) => importList(q.get("source"))],
  ["POST", /^\/api\/import$/, (_, body) => importItems(body)],
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
    if (req.method === "GET" && url.pathname === "/cron.mjs") return send(200, readFileSync(CRON_MODULE), "text/javascript; charset=utf-8");
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
