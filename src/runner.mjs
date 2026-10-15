import { spawn, execFile, execFileSync } from "node:child_process";
import { openSync, closeSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import * as store from "./store.mjs";
import { createThread, T3Down } from "./t3.mjs";
import { canonicalKey } from "./inbox.mjs";

const lastJsonLine = (text) => JSON.parse(text.trim().split("\n").findLast((l) => l.startsWith("{")) ?? "null");

// cmd builds the agent process; repair resumes its session for one more turn; result reads the final message
// (and session id) back from the phase's files.
export const AGENTS = {
  claude: {
    cmd: (r) => ({ file: "claude", args: ["-p", r.prompt, "--model", r.model, "--dangerously-skip-permissions", "--output-format", "json"] }),
    repair: (r, sessionId, prompt) => ({ file: "claude", args: ["-p", prompt, "--resume", sessionId, "--model", r.model, "--dangerously-skip-permissions", "--output-format", "json"] }),
    result: (f) => {
      const out = lastJsonLine(store.text(f.log));
      return { text: out?.result ?? "", sessionId: out?.session_id };
    },
  },
  codex: {
    cmd: (r, f) => ({ file: "codex", args: ["exec", "-m", r.model, "--dangerously-bypass-approvals-and-sandbox", "-C", r.cwd, "-o", f.out, r.prompt] }),
    repair: (r, sessionId, prompt, f) => ({ file: "codex", args: ["exec", "resume", "-m", r.model, "--dangerously-bypass-approvals-and-sandbox", "-o", f.out, sessionId, prompt] }),
    result: (f) => ({ text: store.text(f.out), sessionId: /session id: ([\w-]+)/.exec(store.text(f.err))?.[1] }),
  },
  custom: {
    cmd: (r) => ({ file: "sh", args: ["-c", r.command], env: { PROMPT: r.prompt, MODEL: r.model } }),
    result: (f) => ({ text: store.text(f.log) }),
  },
};

const CONTRACT = `

When you finish, end your reply with a fenced \`\`\`json block containing exactly:
{"status": "done" | "needs_input", "summary": string, "items": Item[]}
Item is {"key": string, "title": string, "url"?: string, "kind": "needs_you" | "code" | "fyi", "note"?: string, "repoPath"?: string, "threadPrompt"?: string}.
key is a stable id such as "pr:owner/repo#123" or "jira:SOF-42". "code" items get a coding-agent thread in repoPath (absolute path of a local clone) seeded with threadPrompt.
Use "needs_input" when anything needs the user.`;
const repairPrompt = (reason) => `Your reply did not end with a valid \`\`\`json block (${reason}).${CONTRACT}\n\nReply with only the json block summarizing the work you just did.`;

const TRANSITIONS = { running: ["done", "needs_input", "failed"] };
const KINDS = ["needs_you", "code", "fyi"];
const TIMEOUT = 30 * 60e3;
const POLL = 2e3;

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

// The agent runs in its own process group with output going straight to files, so it outlives a server
// restart; the wrapping sh records the exit code for whichever server process is watching by then.
function spawnDetached({ file, args, env }, f, cwd) {
  const out = openSync(f.log, "w");
  const err = openSync(f.err, "w");
  try {
    const child = spawn("sh", ["-c", 'exit_file=$1; shift; "$@"; echo $? > "$exit_file"', "sh", f.exit, file, ...args], {
      cwd,
      env: { ...process.env, PATH: loginPath(), ...env },
      detached: true,
      stdio: ["ignore", out, err],
    });
    child.on("error", () => {});
    child.unref();
    return child.pid;
  } finally {
    closeSync(out);
    closeSync(err);
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// ponytail: trusts that a live pid is still our agent; a pid reused while the server was down waits out the timeout.
async function waitDead(run) {
  while (alive(run.pid)) {
    if (Date.now() - Date.parse(run.startedAt) > TIMEOUT) {
      try {
        process.kill(-run.pid, "SIGKILL");
      } catch {}
      throw new Error(`timed out after ${TIMEOUT / 60e3} min`);
    }
    await sleep(POLL);
  }
}

function readResult(agent, f) {
  if (!existsSync(f.exit)) return { error: "interrupted" };
  const code = Number(store.text(f.exit).trim());
  if (code !== 0) return { error: [`exit ${code}`, store.text(f.err).trim().split("\n").at(-1)].filter(Boolean).join(": ") };
  return AGENTS[agent].result(f);
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

const lastLines = (text, n) => String(text).split("\n").filter((l) => l.trim()).slice(-n).join("\n");

// One repair turn in the same agent session before a missing or broken json block fails the run.
// attempt(phase, sessionId, reason) resolves to { error } or { text, sessionId }, or null when the agent can't resume.
export async function agentOutput(attempt) {
  const first = await attempt("main");
  if (first.error) return { error: first.error };
  try {
    return { out: parseOutput(first.text) };
  } catch (e) {
    const second = first.sessionId ? await attempt("repair", first.sessionId, e.message) : null;
    if (second && !second.error) {
      try {
        return { out: parseOutput(second.text) };
      } catch {}
    }
    return { error: `bad agent output: ${e.message}${second ? " (also after a repair turn)" : ""}`, tail: lastLines(first.text, 3) };
  }
}

// Phases survive restarts: run.repaired marks that the live pid (if any) belongs to the repair turn.
async function attempt(run, phase, sessionId, reason) {
  const agent = AGENTS[run.agent];
  if (phase === "repair" && !run.repaired) {
    const routine = store.routine(run.routineId);
    if (!agent.repair || !routine) return null;
    const f = store.files(run.id, phase);
    run.pid = spawnDetached(agent.repair(routine, sessionId, repairPrompt(reason), f), f, routine.cwd);
    run.repaired = true;
    store.saveRun(run);
  }
  if (phase === (run.repaired ? "repair" : "main")) await waitDead(run);
  return readResult(run.agent, store.files(run.id, phase));
}

// The same path finishes a run this process started and one adopted from a previous server process.
async function execute(run) {
  const { out, error, tail } = await agentOutput((...a) => attempt(run, ...a));
  if (error) return finish(run, "failed", { error, ...(tail && { summary: tail }) });
  const routine = store.routine(run.routineId);
  if (!routine) return finish(run, "failed", { error: "routine was deleted" });
  const { threads, blocked } = await linkThreads(routine, out.items);
  finish(run, out.status === "needs_input" || blocked ? "needs_input" : "done", { summary: out.summary, items: out.items, threads });
}

export const isRunning = (routineId) => store.runs().some((r) => r.routineId === routineId && r.state === "running");

const watch = (run) => execute(run).catch((e) => run.state === "running" && finish(run, "failed", { error: e.message }));

export function startRun(routine, trigger) {
  const startedAt = new Date().toISOString();
  const run = { id: `${startedAt.replace(/[-:.]/g, "")}-${routine.id}`, routineId: routine.id, trigger, agent: routine.agent, state: "running", startedAt, items: [], threads: [] };
  const f = store.files(run.id);
  run.pid = spawnDetached(AGENTS[routine.agent].cmd({ ...routine, prompt: routine.prompt + CONTRACT }, f), f, routine.cwd);
  store.saveRun(run);
  if (run.pid) watch(run);
  else finish(run, "failed", { error: `could not start the agent in ${routine.cwd}` });
  return run;
}

// A run left running by an earlier server process: keep waiting if its agent lives, else finish from its files.
export const adoptRuns = () => store.runs().filter((r) => r.state === "running").forEach(watch);
