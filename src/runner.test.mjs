import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ROUTINEBAR_HOME = mkdtempSync(join(tmpdir(), "rb-runner-test-"));
const { agentOutput, parseOutput } = await import("./runner.mjs");

const VALID = 'Done.\n```json\n{"status":"done","summary":"Reviewed 2 PRs","items":[]}\n```';
const PROSE = "Reviewed acme/app#12.\n\nIt looks fine.\nNo comments posted.\n";

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
