import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rb-actions-test-"));
process.env.ROUTINEBAR_HOME = join(dir, "home");
const log = join(dir, "gh.log");
const prFile = join(dir, "pr.json");
const fake = join(dir, "gh");
writeFileSync(
  fake,
  `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "api user") echo kevin ;;
  "api repos/acme/app") echo '{"allow_squash_merge":true,"allow_merge_commit":false,"allow_rebase_merge":true}' ;;
  "pr view") case "$*" in *author*) echo kevin ;; *) cat "${prFile}" ;; esac ;;
  "pr checks") echo '[{"bucket":"fail","link":"https://github.com/acme/app/actions/runs/555/job/1"},{"bucket":"fail","link":"https://github.com/acme/app/actions/runs/555/job/2"},{"bucket":"pass","link":"https://github.com/acme/app/actions/runs/777/job/3"}]' ;;
  "pr merge") echo merged ;;
  "run rerun") ;;
  *) echo "unexpected $*" >&2; exit 1 ;;
esac
`,
);
chmodSync(fake, 0o755);
process.env.ROUTINEBAR_GH = fake;

const { parseKey, listActions, contextFor, ACTIONS, parseInput } = await import("./actions.mjs");
const store = await import("./store.mjs");

const routine = { id: "r1", t3: { provider: "claudeAgent", model: "claude-haiku-4-5", runtimeMode: "approval-required" } };
const pr = (state, isDraft) =>
  writeFileSync(prFile, JSON.stringify({ state, isDraft, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", statusCheckRollup: [{ conclusion: "SUCCESS" }, { state: "PENDING" }, { conclusion: "FAILURE" }], headRefName: "feat", title: "Feat", url: "https://github.com/acme/app/pull/12" }));
const ghCalls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);

test("key parser", () => {
  assert.deepEqual(parseKey("pr:acme/app#12"), { type: "pr", repo: "acme/app", number: 12 });
  assert.deepEqual(parseKey("pr:my.org/some-repo_x#7"), { type: "pr", repo: "my.org/some-repo_x", number: 7 });
  assert.deepEqual(parseKey("jira:SOF-42"), { type: "jira", issue: "SOF-42" });
  assert.deepEqual(parseKey("pr:acme#12"), { type: "other" });
  assert.deepEqual(parseKey("note:whatever"), { type: "other" });
});

test("applicable actions per item, primary marked with *", async () => {
  const ids = async (item, mine) => (await listActions(item, { routine, ref: parseKey(item.key), mine })).map((a) => (a.primary ? `${a.id}*` : a.id));
  const url = "https://example.com/x";
  assert.deepEqual(await ids({ key: "pr:acme/app#1", kind: "needs_you", url }, true), ["merge*", "address-comments", "open", "rerun-checks", "move-to-t3"]);
  assert.deepEqual(await ids({ key: "pr:acme/app#2", kind: "code", url }, true), ["merge", "address-comments*", "open", "rerun-checks", "move-to-t3"]);
  assert.deepEqual(await ids({ key: "pr:acme/app#3", kind: "needs_you", url }, false), ["review-in-t3*", "address-comments", "open", "approve", "rerun-checks", "move-to-t3"]);
  assert.deepEqual(await ids({ key: "pr:acme/app#4", kind: "needs_you", url }, null), ["address-comments", "open*", "rerun-checks", "move-to-t3"]);
  assert.deepEqual(await ids({ key: "jira:SOF-42", kind: "code", url }, null), ["start-in-t3*", "open", "move-to-t3"]);
  assert.deepEqual(await ids({ key: "misc", kind: "needs_you" }, null), ["move-to-t3"]);
  const noRepo = await listActions({ key: "misc", kind: "needs_you" }, { routine, ref: parseKey("misc"), mine: null });
  assert.deepEqual(noRepo, [{ id: "move-to-t3", label: "Move to T3", needsConfirm: true, primary: false }]);
});

test("merge runs gh pr merge with the default method, and blocks draft or closed PRs", async () => {
  const item = { key: "pr:acme/app#12", kind: "needs_you", title: "Feat" };
  const ctx = await contextFor(item, routine);
  assert.equal(ctx.mine, true);
  pr("OPEN", false);
  const preview = await ACTIONS.merge.confirm(item, ctx);
  assert.deepEqual([preview.checks, preview.methods, preview.method, preview.blocked], [{ passed: 1, failed: 1, pending: 1 }, ["squash", "rebase"], "squash", null]);
  rmSync(log, { force: true });
  assert.deepEqual(await ACTIONS.merge.run(item, ctx, {}), { message: "Merged with squash" });
  assert.equal(ghCalls().at(-1), "pr merge 12 -R acme/app --squash");
  await assert.rejects(ACTIONS.merge.run(item, ctx, { method: "merge" }), { message: "acme/app does not allow merge merges" });

  for (const [state, draft, why] of [["OPEN", true, "Not merged: the PR is a draft"], ["CLOSED", false, "Not merged: the PR is closed"]]) {
    pr(state, draft);
    rmSync(log, { force: true });
    await assert.rejects(ACTIONS.merge.run(item, ctx, {}), { message: why });
    assert.equal(ghCalls().some((l) => l.startsWith("pr merge")), false);
  }
});

test("rerun-checks reruns each failed Actions run once", async () => {
  rmSync(log, { force: true });
  const item = { key: "pr:acme/app#12", kind: "code", title: "Feat" };
  assert.deepEqual(await ACTIONS["rerun-checks"].run(item, { routine, ref: parseKey(item.key) }, {}), { message: "Re-running 1 failed run" });
  assert.deepEqual(ghCalls(), ["pr checks 12 -R acme/app --json bucket,link", "run rerun 555 --failed -R acme/app"]);
});

test("T3 actions create one thread per item and reuse it through seen.json", async () => {
  const calls = [];
  const createThread = async (args) => (calls.push(args), { threadId: "t-1", url: "http://t3/env/t-1" });
  const item = { key: "jira:SOF-42", kind: "code", title: "Fix login", repoPath: "/tmp/repo" };
  const ctx = { routine, ref: parseKey(item.key), mine: null, createThread };
  assert.deepEqual(await ACTIONS["start-in-t3"].run(item, ctx, {}), { message: "Thread started", threadId: "t-1", threadUrl: "http://t3/env/t-1", reused: false });
  assert.deepEqual(await ACTIONS["move-to-t3"].run(item, ctx, {}), { message: "Opened the existing thread", threadId: "t-1", threadUrl: "http://t3/env/t-1", reused: true });
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].cwd, calls[0].title, calls[0].t3], ["/tmp/repo", "Fix login", routine.t3]);
  assert.equal(store.seen()["r1:jira:SOF-42"].url, "http://t3/env/t-1");

  store.markSeen("r1:pr:acme/app#9", { threadId: "old", url: "http://t3/env/old" });
  const pr9 = { key: "pr:acme/app#9", kind: "code", title: "Old" };
  const throwing = { ...ctx, ref: parseKey(pr9.key), createThread: () => assert.fail("must not create") };
  assert.deepEqual(await ACTIONS["address-comments"].confirm(pr9, throwing), { reuse: "http://t3/env/old" });
  assert.equal((await ACTIONS["address-comments"].run(pr9, throwing, {})).reused, true);
});

test("input validation", () => {
  assert.deepEqual(parseInput(undefined), {});
  assert.deepEqual(parseInput({ method: "rebase" }), { method: "rebase" });
  assert.throws(() => parseInput({ method: "yolo" }), { message: "method must be one of squash, merge, rebase" });
  assert.throws(() => parseInput({ repoPath: dir }), { message: "repoPath must be an absolute path to an existing git repo" });
  assert.throws(() => parseInput({ force: true }), { message: "unknown input force" });
});
