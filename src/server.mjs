import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as store from "./store.mjs";
import { parseCron, matches, nextRuns, describe } from "./cron.mjs";
import { AGENTS, startRun, runningRun, adoptRuns } from "./runner.mjs";
import { validateTeams, checkTeamsAccess } from "./teams.mjs";
import { seeds } from "./seeds.mjs";
import { SOURCES, listSource } from "./importers.mjs";
import { ACTIONS, contextFor, listActions, parseInput } from "./actions.mjs";
import { inboxRuns, isDismissed, itemId, fingerprint, failedId, runRowId } from "./inbox.mjs";
import { inboxModel, summaryLine } from "../public/inbox-model.mjs";
import { settings, saveSettings, taskConfig, resolveT3App } from "./settings.mjs";
import { checkT3 } from "./t3.mjs";
import { session, openSession } from "./editor.mjs";
import { notify } from "./notifications.mjs";

const PORT = Number(process.env.ROUTINEBAR_PORT || 4141);
const INDEX = new URL("../public/index.html", import.meta.url);
// The dashboard imports the same cron module in the browser so the schedule builder and the server agree.
const CRON_MODULE = new URL("./cron.mjs", import.meta.url);
const MANIFEST = join(homedir(), ".t3", "userdata", "model-manifest.json");
const FALLBACK_MODELS = { claudeAgent: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], codex: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"] };
const PROVIDERS = ["claudeAgent", "codex"];
const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "full-access"];

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// A manual start never touches a running run; the 409 points the dashboard at it instead.
function startManual(routine) {
  const running = runningRun(routine.id);
  if (running) throw new HttpError(409, "already running", { runId: running.id });
  return startRun(routine, "manual");
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
  let teams;
  if (b.teams !== undefined) {
    if (agent === "custom") throw new HttpError(400, "Teams monitors require Claude Code or Codex");
    try { teams = validateTeams(b.teams); } catch (e) { throw new HttpError(400, e.message); }
  }
  const cwd = str("cwd");
  if (!cwd.startsWith("/")) throw new HttpError(400, "cwd must be an absolute path");
  const t3 = b.t3 ?? {};
  if (t3.useDefaults !== undefined && typeof t3.useDefaults !== "boolean") throw new HttpError(400, "t3.useDefaults must be a boolean");
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
    prompt: agent === "custom" || teams ? String(b.prompt ?? "") : str("prompt"),
    ...(teams && { teams }),
    t3: {
      provider: oneOf("t3.provider", t3.provider, PROVIDERS),
      model: str("t3.model", t3.model),
      runtimeMode: oneOf("t3.runtimeMode", t3.runtimeMode, RUNTIME_MODES),
      useDefaults: t3.useDefaults === true,
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
  const t3 = { ...taskConfig(), useDefaults: true };
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

function models() {
  let current = {};
  try {
    current = JSON.parse(readFileSync(MANIFEST, "utf8")).manifest.currentModels;
  } catch {}
  const t3 = Object.fromEntries(PROVIDERS.map((p) => [p, current[p]?.length ? current[p] : FALLBACK_MODELS[p]]));
  return { agents: { claude: ["opus", "sonnet", "haiku", ...t3.claudeAgent], codex: t3.codex, custom: [] }, t3, defaultCwd: homedir() };
}

function routinesWithStatus() {
  const runs = store.runs();
  const now = new Date();
  return store.routines().map((r) => {
    const last = runs.find((x) => x.routineId === r.id);
    const completed = runs.filter((x) => x.routineId === r.id && ["done", "needs_input"].includes(x.state) && x.finishedAt && !x.items?.some((i) => i.key === "teams:access"))
      .sort((a, b) => b.finishedAt.localeCompare(a.finishedAt))[0];
    let nextRun = null;
    try {
      if (r.enabled) nextRun = nextRuns(parseCron(r.schedule), now, 1)[0]?.toISOString() ?? null;
    } catch {}
    return { ...r, lastRun: last ? { id: last.id, state: last.state, startedAt: last.startedAt, finishedAt: last.finishedAt ?? null } : null,
      lastCompletedRun: completed ? { id: completed.id, finishedAt: completed.finishedAt } : null, nextRun };
  });
}

// menubar/RoutineBar.swift decodes routineName, state and a non-null summary from each entry.
async function inbox() {
  const routineNames = Object.fromEntries(store.routines().map((r) => [r.id, r.name]));
  const entries = inboxRuns(store.runs(), store.dismissed()).map(async ({ run, items }) => ({
    runId: run.id,
    routineId: run.routineId,
    routineName: routineNames[run.routineId] ?? run.routineId,
    state: run.state,
    summary: run.summary ?? run.error ?? "",
    error: run.error,
    finishedAt: run.finishedAt,
    items: await withActions(run, items),
    threads: run.threads,
  }));
  const resolved = await Promise.all(entries);
  return { count: summaryLine(inboxModel(resolved))?.actionable ?? 0, entries: resolved };
}

// Done items keep their history but offer no actions.
function withActions(run, items) {
  const dismissed = store.dismissed();
  return Promise.all(
    items.map(async (i) => {
      const done = isDismissed(dismissed, run.routineId, i);
      return { ...i, done, actions: done ? [] : await listActions(i, await contextFor(i, store.routine(run.routineId))) };
    }),
  );
}

const dismissItem = (run, item) => store.dismiss(itemId(run.routineId, item), fingerprint(item));

// One-time move from run-level ackedAt/doneKeys to dismissed.json, oldest run first so the newest wins.
function migrateAcks() {
  const map = store.dismissed();
  for (const run of store.runs().reverse()) {
    if (!run.ackedAt && !run.doneKeys) continue;
    for (const i of run.items) if (run.ackedAt || run.doneKeys.includes(i.key)) map[itemId(run.routineId, i)] = fingerprint(i);
    if (run.ackedAt) map[run.state === "failed" ? failedId(run.routineId) : runRowId(run.routineId)] = run.id;
    delete run.ackedAt;
    delete run.doneKeys;
    store.saveRun(run);
  }
  store.saveDismissed(map);
}

function mustRun(id) {
  const run = store.run(id);
  if (!run) throw new HttpError(404, "no such run");
  return run;
}

async function actionTarget(runId, key, actionId) {
  const run = mustRun(runId);
  const item = run.items.find((i) => i.key === key);
  if (!item) throw new HttpError(404, "no such item in this run");
  const ctx = await contextFor(item, store.routine(run.routineId));
  const action = Object.hasOwn(ACTIONS, actionId) ? ACTIONS[actionId] : null;
  if (!action?.appliesTo(item, ctx)) throw new HttpError(400, `${actionId} does not apply to this item`);
  return { item, ctx, action };
}

async function preview([runId, key, actionId]) {
  const { item, ctx, action } = await actionTarget(runId, key, actionId);
  if (!action.confirm) throw new HttpError(400, `${actionId} has no preview`);
  try {
    return await action.confirm(item, ctx);
  } catch (e) {
    throw new HttpError(502, e.message);
  }
}

// Failures come back as { ok: false, message } with gh's stderr, and are kept in the item's history.
async function runAction([runId, key, actionId], body) {
  const { item, ctx, action } = await actionTarget(runId, key, actionId);
  if (!action.run) throw new HttpError(400, `${actionId} runs in the browser`);
  let input;
  try {
    input = parseInput(body);
  } catch (e) {
    throw new HttpError(400, e.message);
  }
  let res;
  try {
    res = { ok: true, ...(await action.run(item, ctx, input)) };
  } catch (e) {
    res = { ok: false, message: e.message };
  }
  // Re-read after the await so a Done clicked meanwhile is not lost.
  const run = mustRun(runId);
  const it = run.items.find((i) => i.key === key);
  it.history = [...(it.history ?? []), { action: actionId, at: new Date().toISOString(), ok: res.ok, message: res.message, ...(res.threadUrl && { threadUrl: res.threadUrl }) }];
  if (res.threadId && !run.threads.some((t) => t.key === key)) run.threads.push({ key, threadId: res.threadId, url: res.threadUrl, reused: res.reused });
  store.saveRun(run);
  if (res.ok && action.done) dismissItem(run, it);
  return res;
}

function mustRoutine(id) {
  const r = store.routine(id);
  if (!r) throw new HttpError(404, "no such routine");
  return r;
}

const routes = [
  ["GET", /^\/api\/settings$/, () => ({ ...settings(), detectedT3App: (() => { try { return resolveT3App(); } catch { return null; } })() })],
  ["PUT", /^\/api\/settings$/, (_, body) => { try { return saveSettings(body); } catch (e) { throw new HttpError(400, e.message); } }],
  ["POST", /^\/api\/settings\/check-t3$/, () => checkT3()],
  ["POST", /^\/api\/settings\/test-notification$/, async () => {
    if (!settings().desktopNotifications) throw new HttpError(400, "Enable and save desktop notifications first");
    await notify("RoutineBar", "This is a test desktop notification from RoutineBar.");
    return { ok: true };
  }],
  ["GET", /^\/api\/sessions\/([^/]+)$/, ([id]) => { try { return session(id); } catch (e) { throw new HttpError(404, e.message); } }],
  ["POST", /^\/api\/sessions\/([^/]+)\/open$/, ([id]) => openSession(id)],
  ["POST", /^\/api\/teams\/access$/, (_, body) => {
    let teams;
    try { teams = validateTeams(body?.teams); } catch (e) { throw new HttpError(400, e.message); }
    return checkTeamsAccess(teams);
  }],
  ["GET", /^\/api\/routines$/, () => routinesWithStatus()],
  ["GET", /^\/api\/models$/, () => models()],
  ["PUT", /^\/api\/routines\/([^/]+)$/, ([id], body) => (store.upsertRoutine(validateRoutine(id, body)), store.routine(id))],
  ["DELETE", /^\/api\/routines\/([^/]+)$/, ([id]) => (store.deleteRoutine(id), { ok: true })],
  [
    "POST",
    /^\/api\/routines\/([^/]+)\/run$/,
    ([id]) => startManual(mustRoutine(id)),
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
    async ([id]) => {
      const run = mustRun(id);
      const phases = run.repaired ? ["main", "repair"] : ["main"];
      const text = (k) => phases.map((p) => (p === "main" ? "" : `\n--- repair turn ---\n`) + store.text(store.files(id, p)[k])).join("");
      return { ...run, items: await withActions(run, run.items), log: text("log"), err: text("err") };
    },
  ],
  [
    "POST",
    /^\/api\/runs\/([^/]+)\/ack$/,
    ([id], body) => {
      const run = mustRun(id);
      const key = body?.key;
      if (key === undefined) {
        store.dismiss((run.state === "failed" ? failedId : runRowId)(run.routineId), run.id);
        return { ok: true };
      }
      const item = run.items.find((i) => i.key === key);
      if (!item) throw new HttpError(400, "no such item in this run");
      dismissItem(run, item);
      return { ok: true };
    },
  ],
  [
    "POST",
    /^\/api\/runs\/([^/]+)\/rerun$/,
    ([id]) => startManual(mustRoutine(mustRun(id).routineId)),
  ],
  [
    "GET",
    /^\/api\/runs\/([^/]+)\/items\/([^/]+)\/actions$/,
    async ([id, key]) => {
      const run = mustRun(id);
      const item = run.items.find((i) => i.key === key);
      if (!item) throw new HttpError(404, "no such item in this run");
      return (await withActions(run, [item]))[0].actions;
    },
  ],
  ["POST", /^\/api\/runs\/([^/]+)\/items\/([^/]+)\/actions\/([^/]+)\/preview$/, preview],
  ["POST", /^\/api\/runs\/([^/]+)\/items\/([^/]+)\/actions\/([^/]+)$/, runAction],
  ["GET", /^\/api\/inbox$/, () => inbox()],
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
    if (req.method === "GET" && url.pathname === "/inbox-model.mjs") return send(200, readFileSync(new URL("../public/inbox-model.mjs", import.meta.url)), "text/javascript; charset=utf-8");
    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname);
      if (m && req.method === method) return send(200, await handler(m.slice(1).map(decodeURIComponent), await readBody(req), url.searchParams));
    }
    send(404, { error: "not found" });
  } catch (e) {
    send(e.status ?? 500, { error: e.message, ...e.extra });
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
    if (r.enabled && matches(parseCron(r.schedule), now) && !runningRun(r.id)) startRun(r, "schedule");
  }
}

if (!store.hasRoutines()) store.saveRoutines(seeds);
adoptRuns();
migrateAcks();
server.listen(PORT, "127.0.0.1", () => console.log(`routinebar on http://127.0.0.1:${PORT} (home ${store.HOME})`));
scheduleTick();
