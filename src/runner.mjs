import { spawn, execFile, execFileSync } from "node:child_process";
import { createWriteStream, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as store from "./store.mjs";
import { createThread, T3Down } from "./t3.mjs";
import { canonicalKey } from "./inbox.mjs";

export const AGENTS = {
  claude: (r) => ({ file: "claude", args: ["-p", r.prompt, "--model", r.model, "--dangerously-skip-permissions", "--output-format", "text"] }),
  codex: (r, tmp) => ({ file: "codex", args: ["exec", "-m", r.model, "--dangerously-bypass-approvals-and-sandbox", "-C", r.cwd, "-o", tmp, r.prompt], outputFile: tmp }),
  custom: (r) => ({ file: "sh", args: ["-c", r.command], env: { PROMPT: r.prompt, MODEL: r.model } }),
};

const CONTRACT = `

When you finish, end your reply with a fenced \`\`\`json block containing exactly:
{"status": "done" | "needs_input", "summary": string, "items": Item[]}
Item is {"key": string, "title": string, "url"?: string, "kind": "needs_you" | "code" | "fyi", "note"?: string, "repoPath"?: string, "threadPrompt"?: string}.
key is a stable id such as "pr:owner/repo#123" or "jira:SOF-42". "code" items get a coding-agent thread in repoPath (absolute path of a local clone) seeded with threadPrompt.
Use "needs_input" when anything needs the user.`;

const TRANSITIONS = { running: ["done", "needs_input", "failed"] };
const KINDS = ["needs_you", "code", "fyi"];
const TIMEOUT = 30 * 60e3;

let pathCache;
export const loginPath = () => (pathCache ??= execFileSync("zsh", ["-lc", "echo $PATH"], { encoding: "utf8" }).trim());

function notify(title, body) {
  execFile("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run", title, body], () => {});
}

function finish(run, state, patch) {
  if (!TRANSITIONS[run.state]?.includes(state)) throw new Error(`illegal run transition ${run.state} -> ${state}`);
  Object.assign(run, patch, { state, finishedAt: new Date().toISOString() });
  store.saveRun(run);
  const created = run.threads.filter((t) => !t.reused).length;
  if (state !== "done" || created) {
    const name = store.routine(run.routineId)?.name ?? run.routineId;
    notify(`RoutineBar: ${name}`, [state.replace("_", " "), created && `${created} new thread(s)`, run.summary ?? run.error].filter(Boolean).join(". "));
  }
}

export function parseOutput(text) {
  const blocks = [...String(text).matchAll(/```json[^\n]*\n([\s\S]*?)```/g)];
  if (!blocks.length) throw new Error("no ```json block in output");
  const out = JSON.parse(blocks.at(-1)[1]);
  if (!["done", "needs_input"].includes(out?.status)) throw new Error(`bad status ${JSON.stringify(out?.status)}`);
  if (typeof out.summary !== "string") throw new Error("summary must be a string");
  if (!Array.isArray(out.items)) throw new Error("items must be an array");
  const items = new Map();
  out.items.forEach((it, i) => {
    if (typeof it?.key !== "string" || !it.key || typeof it.title !== "string" || !KINDS.includes(it.kind)) {
      throw new Error(`item ${i} needs string key, string title, kind in ${KINDS.join("|")}`);
    }
    const item = { key: it.key, title: it.title, kind: it.kind };
    for (const f of ["url", "note", "repoPath", "threadPrompt"]) if (typeof it[f] === "string") item[f] = it[f];
    item.key = canonicalKey(item);
    if (!items.has(item.key)) items.set(item.key, item);
  });
  return { status: out.status, summary: out.summary, items: [...items.values()] };
}

function exec({ file, args, env }, cwd, logFile) {
  return new Promise((resolve) => {
    const log = createWriteStream(logFile);
    let stdout = "";
    let error;
    const child = spawn(file, args, { cwd, env: { ...process.env, PATH: loginPath(), ...env }, timeout: TIMEOUT, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (c) => ((stdout += c), log.write(c)));
    child.stderr.on("data", (c) => log.write(c));
    child.on("error", (e) => (error = e.message));
    child.on("close", (code, signal) => {
      log.end();
      resolve({ stdout, error: error ?? (signal ? `killed by ${signal}` : code !== 0 ? `exit ${code}` : null) });
    });
  });
}

async function linkThreads(routine, items) {
  const threads = [];
  let blocked = false;
  for (const item of items.filter((i) => i.kind === "code")) {
    const id = `${routine.id}:${item.key}`;
    const known = store.seen()[id];
    if (known) {
      threads.push({ key: item.key, threadId: known.threadId, url: known.url, reused: true });
      continue;
    }
    try {
      const t = await createThread({ cwd: item.repoPath ?? routine.cwd, title: item.title, prompt: item.threadPrompt ?? item.title, t3: routine.t3 });
      store.markSeen(id, { ...t, createdAt: new Date().toISOString() });
      threads.push({ key: item.key, ...t, reused: false });
    } catch (e) {
      blocked = true;
      item.note = e instanceof T3Down ? "T3 not running; thread not created" : `Thread not created: ${e.message}`;
    }
  }
  return { threads, blocked };
}

async function execute(routine, run) {
  const tmp = join(tmpdir(), `routinebar-${run.id}.txt`);
  const spec = AGENTS[routine.agent]({ ...routine, prompt: routine.prompt + CONTRACT }, tmp);
  const res = await exec(spec, routine.cwd, store.logPath(run.id));
  if (res.error) return finish(run, "failed", { error: res.error });
  let out;
  try {
    out = parseOutput(spec.outputFile ? readFileSync(spec.outputFile, "utf8") : res.stdout);
  } catch (e) {
    return finish(run, "failed", { error: `bad agent output: ${e.message}` });
  } finally {
    rmSync(tmp, { force: true });
  }
  const { threads, blocked } = await linkThreads(routine, out.items);
  finish(run, out.status === "needs_input" || blocked ? "needs_input" : "done", { summary: out.summary, items: out.items, threads });
}

export const isRunning = (routineId) => store.runs().some((r) => r.routineId === routineId && r.state === "running");

export function startRun(routine, trigger) {
  const startedAt = new Date().toISOString();
  const run = { id: `${startedAt.replace(/[-:.]/g, "")}-${routine.id}`, routineId: routine.id, trigger, state: "running", startedAt, items: [], threads: [] };
  store.saveRun(run);
  execute(routine, run).catch((e) => run.state === "running" && finish(run, "failed", { error: e.message }));
  return run;
}

export function failInterrupted() {
  for (const r of store.runs()) if (r.state === "running") finish(r, "failed", { error: "interrupted" });
}
