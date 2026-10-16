import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ROUTINEBAR_HOME = mkdtempSync(join(tmpdir(), "rb-runner-test-"));
const { agentOutput, parseOutput, startRun, AGENTS } = await import("./runner.mjs");
const store = await import("./store.mjs");

const VALID = 'Done.\n```json\n{"status":"done","summary":"Reviewed 2 PRs","items":[]}\n```';
const PROSE = "Reviewed acme/app#12.\n\nIt looks fine.\nNo comments posted.\n";

test("agent output preserves who acts next and rejects incomplete waiting items", () => {
  const item = { key: "pr:acme/app#1", title: "Fix", kind: "needs_you", attention: "waiting", waitingOn: "Caleb", nextStep: "Link the Terraform change." };
  const output = (it) => '```json\n' + JSON.stringify({ status: "done", summary: "s", items: [it] }) + '\n```';
  assert.deepEqual(parseOutput(output(item)).items, [item]);
  assert.throws(() => parseOutput(output({ ...item, attention: "maybe" })), /invalid attention/);
  assert.throws(() => parseOutput(output({ ...item, waitingOn: "" })), /needs waitingOn/);
  assert.throws(() => parseOutput(output({ ...item, nextStep: null })), /needs nextStep/);
  assert.throws(() => parseOutput(output({ ...item, kind: "code" })), /cannot start code while waiting/);
});

// A scripted agent: each phase returns the next canned reply and the calls are recorded.
function agent(replies) {
  const calls = [];
  return { calls, attempt: async (phase, sessionId, reason) => (calls.push([phase, sessionId, reason]), replies[phase]) };
}

test("valid output needs no repair turn", async () => {
  const a = agent({ main: { text: VALID, sessionId: "s1" } });
  assert.deepEqual(await agentOutput(a.attempt), { out: { status: "done", summary: "Reviewed 2 PRs", items: [] } });
  assert.deepEqual(a.calls, [["main", undefined, undefined]]);
});

test("missing json block gets one repair turn in the same session", async () => {
  const a = agent({ main: { text: PROSE, sessionId: "s1" }, repair: { text: VALID, sessionId: "s1" } });
  assert.deepEqual(await agentOutput(a.attempt), { out: { status: "done", summary: "Reviewed 2 PRs", items: [] } });
  assert.deepEqual(a.calls, [
    ["main", undefined, undefined],
    ["repair", "s1", "no ```json block in output"],
  ]);
});

test("a repair that also lacks the block fails with the last 3 lines of the first reply", async () => {
  const a = agent({ main: { text: PROSE, sessionId: "s1" }, repair: { text: "Sorry, here you go.", sessionId: "s1" } });
  assert.deepEqual(await agentOutput(a.attempt), {
    error: "bad agent output: no ```json block in output (also after a repair turn)",
    tail: "Reviewed acme/app#12.\nIt looks fine.\nNo comments posted.",
  });
});

test("an agent that can't resume fails without a repair turn", async () => {
  const noSession = agent({ main: { text: PROSE } });
  assert.deepEqual(await agentOutput(noSession.attempt), { error: "bad agent output: no ```json block in output", tail: "Reviewed acme/app#12.\nIt looks fine.\nNo comments posted." });
  assert.deepEqual(noSession.calls.map((c) => c[0]), ["main"]);
  const noRepair = agent({ main: { text: PROSE, sessionId: "s1" }, repair: null });
  assert.equal((await agentOutput(noRepair.attempt)).error, "bad agent output: no ```json block in output");
});

test("a failed process is not repaired", async () => {
  const a = agent({ main: { error: "exit 1: boom" } });
  assert.deepEqual(await agentOutput(a.attempt), { error: "exit 1: boom" });
  assert.deepEqual(a.calls.map((c) => c[0]), ["main"]);
});

test("items in one run are deduped by canonical key, first wins", () => {
  const out = parseOutput(
    '```json\n{"status":"needs_input","summary":"s","items":[' +
      '{"key":"std-512","title":"fix(coupons): secure STD-512 coupon lookup","url":"https://github.com/Acme/Store/pull/512","kind":"needs_you"},' +
      '{"key":"chris-comment","title":"STD-512: Chris\'s blocking comment","url":"https://github.com/acme/store/pull/512","kind":"needs_you"},' +
      '{"key":"jira:STD-9","title":"Ticket","kind":"code"}]}\n```',
  );
  assert.deepEqual(out.items.map((i) => [i.key, i.title]), [
    ["pr:acme/store#512", "fix(coupons): secure STD-512 coupon lookup"],
    ["jira:STD-9", "Ticket"],
  ]);
});

test("running a Teams routine passes saved filters and unresolved mentions to the agent", async () => {
  const capture = join(process.env.ROUTINEBAR_HOME, "agent-prompt.txt");
  const teams = { team: "Engineering", channel: "Backend", personalMentions: false, tags: ["On-call"], includeReplies: true, lookbackHours: 6 };
  const routine = { id: "teams-test", name: "Teams test", agent: "claude", model: "opus", cwd: process.env.ROUTINEBAR_HOME, prompt: "Keep summaries brief.", teams };
  store.upsertRoutine(routine);
  store.saveRun({ id: "previous-teams", routineId: routine.id, state: "done", startedAt: "2026-01-01", items: [{ key: "teams:team:channel:123", title: "Still needs a response", kind: "needs_you" }], threads: [] });
  const original = AGENTS.claude.cmd;
  try {
    AGENTS.claude.cmd = r => ({ file: process.execPath, args: ["--input-type=module", "-e", `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(capture)}, process.argv[1]); process.stdout.write(${JSON.stringify(JSON.stringify({ result: VALID }))});`, r.prompt] });
    const run = startRun(routine, "manual", { readTeams: async () => ({ source: "mac-teams-cache", messages: [{ text: "local fixture", mentionedSelf: true }] }) });
    const deadline = Date.now() + 10000;
    while (store.run(run.id).state === "running" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(store.run(run.id).state, "done");
    const prompt = readFileSync(capture, "utf8");
    assert.ok(prompt.startsWith("Keep summaries brief."));
    assert.ok(prompt.includes(JSON.stringify(teams)));
    assert.match(prompt, /teams:team:channel:123/);
    assert.match(prompt, /local fixture/);
    assert.match(prompt, /When you finish, end your reply/);
  } finally { AGENTS.claude.cmd = original; }
});


test("a Mac cache failure keeps unresolved items and reports an actionable access problem", async () => {
  const routine = { id: "teams-unavailable", name: "Teams", agent: "claude", prompt: "", teams: {} };
  store.saveRun({ id: "previous-unavailable", routineId: routine.id, state: "done", startedAt: "2026-01-01", items: [{ key: "teams:c:1", title: "Unresolved", kind: "needs_you" }], threads: [] });
  const run = startRun(routine, "manual", { readTeams: async () => { throw new Error("Open Teams and retry"); } });
  await new Promise(resolve => setTimeout(resolve, 20));
  const saved = store.run(run.id);
  assert.equal(saved.state, "needs_input");
  assert.deepEqual(saved.items.map(i => i.key), ["teams:c:1", "teams:access"]);
  assert.equal(saved.items[1].nextStep, "Open Teams and retry");
  assert.equal(saved.pid, undefined);
});

test("an empty successful cache check completes without starting an agent", async () => {
  const routine = { id: "teams-empty", name: "Teams", agent: "claude", prompt: "", teams: {} };
  const run = startRun(routine, "manual", { readTeams: async () => ({ messages: [{ mentionedSelf: false }], coverage: "Downloaded messages only" }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  const saved = store.run(run.id);
  assert.equal(saved.state, "done");
  assert.equal(saved.pid, undefined);
  assert.deepEqual(saved.items, []);
  assert.equal(saved.teamsCache.messageCount, 1);
  assert.match(saved.summary, /does not prove complete live coverage/);
});
