import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalKey, inboxRuns, fingerprint } from "./inbox.mjs";

const URL_512 = "https://github.com/Acme/Store/pull/512";

test("canonicalKey", () => {
  assert.equal(canonicalKey({ key: "std-512-coupon", url: URL_512 }), "pr:acme/store#512");
  assert.equal(canonicalKey({ key: "STD-512 chris comment", url: `${URL_512}#discussion_r1` }), "pr:acme/store#512");
  assert.equal(canonicalKey({ key: "pr:Acme/Store#512" }), "pr:acme/store#512");
  assert.equal(canonicalKey({ key: "ticket STD-512" }), "jira:STD-512");
  assert.equal(canonicalKey({ key: "coupon-ticket", url: "https://acme.atlassian.net/browse/STD-512" }), "jira:STD-512");
  assert.equal(canonicalKey({ key: "jira:STD-512" }), "jira:STD-512");
  assert.equal(canonicalKey({ key: "release-notes", url: "https://example.com/notes" }), "release-notes");
});

const run = (id, routineId, state, items = [], extra = {}) => ({ id, routineId, state, startedAt: id, finishedAt: id, summary: `summary ${id}`, items, threads: [], ...extra });
const titles = (entries) => entries.map(({ run, items }) => [run.id, run.state, items.map((i) => i.title)]);
const prItem = (title, note) => ({ key: canonicalKey({ key: title, url: URL_512 }), title, url: URL_512, kind: "needs_you", note });

test("two runs of one routine with the same PR show one item from the newer run", () => {
  const runs = [
    run("2026-10-15T10:05", "my-pr-monitoring", "needs_input", [prItem("STD-512 coupon lookup: Chris's blocking comment")]),
    run("2026-10-15T10:00", "my-pr-monitoring", "needs_input", [prItem("fix(coupons): secure STD-512 coupon lookup")]),
  ];
  assert.deepEqual(titles(inboxRuns(runs, {})), [["2026-10-15T10:05", "needs_input", ["STD-512 coupon lookup: Chris's blocking comment"]]]);
});

test("an older failed run is hidden after a newer success", () => {
  const runs = [run("2026-10-15T10:05", "pr-reviews", "done", [prItem("Review PR 512")]), run("2026-10-15T10:00", "pr-reviews", "failed", [], { error: "exit 1" })];
  assert.deepEqual(titles(inboxRuns(runs, {})), [["2026-10-15T10:05", "done", ["Review PR 512"]]]);
});

test("a newer failed run shows alongside the latest success", () => {
  const runs = [run("2026-10-15T10:05", "pr-reviews", "failed", [], { error: "exit 1" }), run("2026-10-15T10:00", "pr-reviews", "done", [prItem("Review PR 512")])];
  assert.deepEqual(titles(inboxRuns(runs, {})), [
    ["2026-10-15T10:05", "failed", []],
    ["2026-10-15T10:00", "done", ["Review PR 512"]],
  ]);
  assert.deepEqual(titles(inboxRuns(runs, { "pr-reviews:failed": "2026-10-15T10:05" })), [["2026-10-15T10:00", "done", ["Review PR 512"]]]);
});

test("a dismissed item stays hidden until its note changes", () => {
  const dismissed = { "my-pr-monitoring:pr:acme/store#512": fingerprint({ kind: "needs_you", note: "Chris left a blocking comment" }) };
  const same = [run("2026-10-15T10:05", "my-pr-monitoring", "needs_input", [prItem("Reworded title", "Chris left a blocking comment")])];
  const changed = [run("2026-10-15T10:10", "my-pr-monitoring", "needs_input", [prItem("Reworded title", "Chris replied again")])];
  assert.deepEqual(titles(inboxRuns(same, dismissed)), []);
  assert.deepEqual(titles(inboxRuns(changed, dismissed)), [["2026-10-15T10:10", "needs_input", ["Reworded title"]]]);
});

test("running runs never supersede the latest finished run", () => {
  const runs = [run("2026-10-15T10:05", "pr-reviews", "running", [], { finishedAt: undefined }), run("2026-10-15T10:00", "pr-reviews", "done", [prItem("Review PR 512")])];
  assert.deepEqual(titles(inboxRuns(runs, {})), [["2026-10-15T10:00", "done", ["Review PR 512"]]]);
});
