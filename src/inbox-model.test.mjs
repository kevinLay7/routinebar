import { test } from "node:test";
import assert from "node:assert/strict";
import { inboxModel, summaryLine, freshnessModel } from "../public/inbox-model.mjs";

test("freshness covers enabled routines including those with no inbox findings", () => {
  const completed = (finishedAt) => ({ id: finishedAt, finishedAt });
  const f = freshnessModel([
    { name: "Disabled", enabled: false, lastCompletedRun: completed("2020-01-01T00:00:00Z") },
    { name: "New", enabled: true },
    { name: "Latest", enabled: true, lastCompletedRun: completed("2026-10-16T13:15:00Z") },
    { name: "Failed", enabled: true, lastCompletedRun: completed("2026-10-16T12:00:00Z"), lastRun: { state: "failed", finishedAt: "2026-10-16T13:20:00Z" } },
    { name: "Running", enabled: true, lastCompletedRun: completed("2026-10-16T13:00:00Z"), lastRun: { state: "running" } },
  ]);
  assert.deepEqual(f.active.map((r) => r.name), ["New", "Failed", "Running", "Latest"]);
  assert.equal(f.oldest, "2026-10-16T12:00:00Z");
  assert.equal(f.newest, "2026-10-16T13:15:00Z");
  assert.equal(f.unchecked, 1);
  assert.equal(f.failed, 1);
  assert.equal(f.running, 1);
});

test("freshness does not invent a completion for empty or never-run routines", () => {
  assert.equal(freshnessModel([]).oldest, undefined);
  const f = freshnessModel([{ name: "First", enabled: true, lastRun: { state: "running" } }]);
  assert.equal(f.oldest, undefined);
  assert.equal(f.newest, undefined);
  assert.equal(f.unchecked, 1);
});

const entry = (items, extra = {}) => ({ runId: "run-1", state: "needs_input", items, threads: [], ...extra });

test("inbox separates review, decisions, waiting, threads, and failures by whose turn it is", () => {
  const m = inboxModel([
    entry([
      { key: "pr:acme/app#1", attention: "review" },
      { key: "pr:acme/app#2", attention: "action" },
      { key: "pr:acme/app#3", attention: "waiting", waitingOn: "Caleb" },
      { key: "jira:APP-4", kind: "code" },
    ], { threads: [{ key: "jira:APP-4", url: "t3://thread" }] }),
    entry([], { runId: "failed-1", state: "failed" }),
  ]);
  assert.equal(m.review[0].item.key, "pr:acme/app#1");
  assert.equal(m.action[0].item.key, "pr:acme/app#2");
  assert.equal(m.waiting[0].item.waitingOn, "Caleb");
  assert.equal(m.t3[0].thread.url, "t3://thread");
  assert.equal(m.failed[0].key, "failed-1");
  assert.equal(summaryLine(m).actionable, 3);
  assert.equal(summaryLine(m).total, 5);
  assert.deepEqual(summaryLine(m).parts, ["1 PR to review", "1 next step for you", "1 waiting on others", "1 coding sessions", "1 failed run"]);
});

test("waiting-only inbox stays visible without asking the user to act", () => {
  const line = summaryLine(inboxModel([entry([{ key: "pr:acme/app#1", attention: "waiting" }])]));
  assert.equal(line.head, "Nothing needs you right now");
  assert.equal(line.actionable, 0);
  assert.equal(line.total, 1);
});

test("old results are next steps to clarify, not presumed PR reviews", () => {
  const m = inboxModel([entry([{ key: "pr:acme/app#1", note: "Waiting? Review?" }]), entry([], { runId: "itemless" })]);
  assert.equal(m.action.length, 2);
  assert.equal(m.review.length, 0);
  assert.equal(summaryLine(inboxModel([])), null);
});
