import { spawn, execFileSync } from "node:child_process";
import { openSync, closeSync, existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import * as store from "./store.mjs";
import { T3Down } from "./t3.mjs";
import { launchTask as createThread } from "./editor.mjs";
import { settings } from "./settings.mjs";
import { canonicalKey, openItems, isDismissed } from "./inbox.mjs";
import { notify, notificationFor } from "./notifications.mjs";
import { teamsPrompt } from "./teams.mjs";
import { readMacTeams } from "./teams-desktop.mjs";

const lastJsonLine = (text) => JSON.parse(text.trim().split("\n").findLast((l) => l.startsWith("{")) ?? "null");
const snapshotArgs = r => r.teams ? ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "", "--disable-slash-commands"] : [];

// cmd builds the agent process; repair resumes its session for one more turn; result reads the final message
// (and session id) back from the phase's files.
export function scheduledArgs(agent, s = settings()) {
  if (s.scheduledPermissions === 'full-access') return [agent === 'claude' ? '--dangerously-skip-permissions' : '--dangerously-bypass-approvals-and-sandbox'];
  return agent === 'claude' ? ['--permission-mode', 'plan'] : ['--config', 'sandbox_mode="read-only"', '--config', 'approval_policy="never"'];
}

export const AGENTS = {
  claude: {
    cmd: (r) => ({ file: settings().claudeCommand, args: ["-p", r.prompt, "--model", r.model, ...scheduledArgs("claude"), "--output-format", "json", ...snapshotArgs(r)] }),
    repair: (r, sessionId, prompt) => ({ file: settings().claudeCommand, args: ["-p", prompt, "--resume", sessionId, "--model", r.model, ...scheduledArgs("claude"), "--output-format", "json", ...snapshotArgs(r)] }),
    result: (f) => {
      const out = lastJsonLine(store.text(f.log));
      return { text: out?.result ?? "", sessionId: out?.session_id };
    },
  },
  codex: {
    cmd: (r, f) => ({ file: settings().codexCommand, args: ["exec", "-m", r.model, ...scheduledArgs("codex"), "-C", r.cwd, "-o", f.out, r.prompt] }),
    repair: (r, sessionId, prompt, f) => ({ file: settings().codexCommand, args: ["exec", "resume", "-m", r.model, ...scheduledArgs("codex"), "-o", f.out, sessionId, prompt] }),
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
Item is {"key": string, "title": string, "url"?: string, "kind": "needs_you" | "code" | "fyi", "attention": "review" | "action" | "waiting", "nextStep": string, "waitingOn"?: string, "note"?: string, "repoPath"?: string, "threadPrompt"?: string}.
key is a stable id such as "pr:owner/repo#123" or "jira:SOF-42". "code" items get a coding-agent thread in repoPath (absolute path of a local clone) seeded with threadPrompt.
For every item, identify whose turn it is from the actual review and discussion. Use attention "review" only when the user needs to review a PR now; "action" for a decision, fix, merge, or follow-up the user must do; "waiting" when another person or a check must act first. A PR with changes already requested is waiting on its author unless a new revision needs the user's review. A user's own PR awaiting approval is waiting, not a review task for the user. Do not turn a missing approval into a request to bypass it. nextStep is a short, concrete instruction or the condition that will unblock the item. For waiting items, include waitingOn (person or check) and keep kind "needs_you" so they remain tracked; do not use kind "code" or open a thread for waiting work. If the owner or next step is unclear, use "action" and say what needs clarification instead of guessing.
Use "needs_input" when anything needs the user.`;
const repairPrompt = (reason) => `Your reply did not end with a valid \`\`\`json block (${reason}).${CONTRACT}\n\nReply with only the json block summarizing the work you just did.`;

const TRANSITIONS = { running: ["done", "needs_input", "failed"] };
const KINDS = ["needs_you", "code", "fyi"];
const TIMEOUT = 30 * 60e3;
const POLL = 2e3;

let pathCache;
export const loginPath = () => (pathCache ??= execFileSync("zsh", ["-lc", "echo $PATH"], { encoding: "utf8" }).trim());

function finish(run, state, patch) {
  if (!TRANSITIONS[run.state]?.includes(state)) throw new Error(`illegal run transition ${run.state} -> ${state}`);
  Object.assign(run, patch, { state, finishedAt: new Date().toISOString() });
  store.saveRun(run);
  const previous = store.runs().find(r => r.routineId === run.routineId && r.id !== run.id && r.state !== "running");
  const name = store.routine(run.routineId)?.name ?? run.routineId;
  const dismissed = store.dismissed();
  const notification = notificationFor(run, previous, name, settings(), item => isDismissed(dismissed, run.routineId, item));
  if (notification) notify(notification.title, notification.body).catch(e => {
    store.saveRun({ ...store.run(run.id), notificationError: e.message });
    console.error(`Desktop notification failed for ${run.id}: ${e.message}`);
  });
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
    if (it.attention !== undefined && !["review", "action", "waiting"].includes(it.attention)) throw new Error(`item ${i} has invalid attention`);
    if (it.attention !== undefined && (typeof it.nextStep !== "string" || !it.nextStep.trim())) throw new Error(`item ${i} needs nextStep`);
    if (it.attention === "waiting" && (typeof it.waitingOn !== "string" || !it.waitingOn.trim())) throw new Error(`item ${i} needs waitingOn`);
    if (it.attention === "waiting" && it.kind === "code") throw new Error(`item ${i} cannot start code while waiting`);
    for (const f of ["url", "note", "repoPath", "threadPrompt", "attention", "nextStep", "waitingOn"]) if (typeof it[f] === "string") item[f] = it[f];
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

export const runningRun = (routineId) => store.runs().find((r) => r.routineId === routineId && r.state === "running");

const watch = (run) => execute(run).catch((e) => run.state === "running" && finish(run, "failed", { error: e.message }));

export function startRun(routine, trigger, { readTeams = readMacTeams } = {}) {
  const startedAt = new Date().toISOString();
  const run = { id: `${startedAt.replace(/[-:.]/g, "")}-${routine.id}`, routineId: routine.id, trigger, agent: routine.agent, state: "running", startedAt, items: [], threads: [] };
  const f = store.files(run.id);
  const previous = routine.teams && store.runs().find(r => r.routineId === routine.id && !["failed", "running"].includes(r.state));
  const outstanding = previous ? openItems(previous, store.dismissed()) : [];
  const launch = (snapshot) => {
    const prompt = routine.prompt + (routine.teams ? teamsPrompt(routine.teams, { previous: outstanding, snapshot }) : "") + CONTRACT;
    run.pid = spawnDetached(AGENTS[routine.agent].cmd({ ...routine, prompt }, f), f, routine.cwd);
    store.saveRun(run);
    if (run.pid) watch(run);
    else finish(run, "failed", { error: `could not start the agent in ${routine.cwd}` });
  };
  if (routine.teams) {
    store.saveRun(run);
    Promise.resolve().then(() => readTeams(routine.teams, outstanding)).then(snapshot => {
      const mentions = snapshot.messages.filter(m => m.mentionedSelf).length;
      run.teamsCache = { capturedAt: snapshot.capturedAt, lastCachedMessageAt: snapshot.lastCachedMessageAt, messageCount: snapshot.messages.length, mentionCount: mentions, coverage: snapshot.coverage };
      if (!mentions && !outstanding.some(i => i.key !== "teams:access")) return finish(run, "done", {
        summary: `No personal @mentions found in ${snapshot.messages.length} downloaded messages in the selected window. Mac cache only; this does not prove complete live coverage.`,
      });
      launch(snapshot);
    }).catch(e => finish(run, "needs_input", {
      summary: "Mac Teams cache needs attention", items: [...outstanding.filter(i => i.key !== "teams:access"), {
        key: "teams:access", title: "Check Mac Teams access", kind: "needs_you", attention: "action", nextStep: e.message,
      }],
    }));
  } else launch();
  return run;
}

// A run left running by an earlier server process: keep waiting if its agent lives, else finish from its files.
export const adoptRuns = () => store.runs().filter((r) => r.state === "running").forEach(watch);
