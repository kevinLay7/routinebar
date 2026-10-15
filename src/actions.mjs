import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import * as store from "./store.mjs";
import { createThread, T3Down } from "./t3.mjs";
import { localClone } from "./importers.mjs";
import { loginPath } from "./runner.mjs";
import { canonicalKey, itemId } from "./inbox.mjs";

export function parseKey(key) {
  let m = /^pr:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(key);
  if (m) return { type: "pr", repo: m[1], number: Number(m[2]) };
  m = /^jira:([A-Z][A-Z0-9_]*-\d+)$/.exec(key);
  if (m) return { type: "jira", issue: m[1] };
  return { type: "other" };
}

// ROUTINEBAR_GH is read per call so tests can point it at a fake script.
export function gh(args) {
  return new Promise((resolve, reject) =>
    execFile(process.env.ROUTINEBAR_GH || "gh", args, { env: { ...process.env, PATH: loginPath() }, timeout: 60e3, maxBuffer: 32e6 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr).trim() || err.message)) : resolve(stdout),
    ),
  );
}
const ghJson = async (args) => JSON.parse(await gh(args));

// Failed lookups are dropped from the cache so the next inbox poll retries them.
const cache = new Map();
function cached(key, load) {
  if (!cache.has(key)) cache.set(key, load().catch((e) => (cache.delete(key), Promise.reject(e))));
  return cache.get(key);
}
const currentUser = () => cached("user", async () => (await gh(["api", "user", "--jq", ".login"])).trim());
const prAuthor = ({ repo, number }) => cached(`${repo}#${number}`, async () => (await gh(["pr", "view", String(number), "-R", repo, "--json", "author", "--jq", ".author.login"])).trim());

// mine is null when gh can't say who wrote the PR, which hides the author-specific actions.
export async function contextFor(item, routine, deps = {}) {
  const ref = parseKey(canonicalKey(item));
  let mine = null;
  if (ref.type === "pr") {
    try {
      const [me, author] = await Promise.all([currentUser(), prAuthor(ref)]);
      mine = me === author;
    } catch {}
  }
  return { routine, ref, mine, ...deps };
}

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
export function checkCounts(rollup) {
  const c = { passed: 0, failed: 0, pending: 0 };
  for (const r of rollup ?? []) {
    const v = r.conclusion || r.state;
    c[PASSED.has(v) ? "passed" : FAILED.has(v) ? "failed" : "pending"]++;
  }
  return c;
}

const PR_FIELDS = "state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,title,url";
async function prStatus({ repo, number }) {
  const { statusCheckRollup, ...pr } = await ghJson(["pr", "view", String(number), "-R", repo, "--json", PR_FIELDS]);
  const blocked = pr.state !== "OPEN" ? `the PR is ${pr.state.toLowerCase()}` : pr.isDraft ? "the PR is a draft" : null;
  return { ...pr, checks: checkCounts(statusCheckRollup), blocked };
}

export const MERGE_METHODS = { squash: "allow_squash_merge", merge: "allow_merge_commit", rebase: "allow_rebase_merge" };
async function mergePreview(ref) {
  const [pr, settings] = await Promise.all([prStatus(ref), ghJson(["api", `repos/${ref.repo}`])]);
  const methods = Object.keys(MERGE_METHODS).filter((m) => settings[MERGE_METHODS[m]]);
  return { ...pr, methods, method: methods.includes("squash") ? "squash" : (methods[0] ?? null) };
}

async function failedRunIds({ repo, number }) {
  const checks = await ghJson(["pr", "checks", String(number), "-R", repo, "--json", "bucket,link"]);
  return [...new Set(checks.filter((c) => c.bucket === "fail").map((c) => /\/actions\/runs\/(\d+)/.exec(c.link)?.[1]).filter(Boolean))];
}

export const isGitRepo = (p) => typeof p === "string" && isAbsolute(p) && existsSync(join(p, ".git"));
const repoFor = (item, ref) => item.repoPath ?? (ref.type === "pr" ? localClone(ref.repo) : null);
const seenId = (item, ctx) => itemId(ctx.routine.id, item);

// T3 actions share the runner's seen.json key, so any thread already made for this item is reused.
function t3Action(label, applies, prompt) {
  return {
    label,
    t3: true,
    appliesTo: (item, ctx) => !!ctx.routine && applies(item, ctx),
    confirm: async (item, ctx) => {
      const known = store.seen()[seenId(item, ctx)];
      if (known) return { reuse: known.url };
      const repoPath = repoFor(item, ctx.ref);
      return repoPath ? { repoPath } : { needsPath: true };
    },
    run: async (item, ctx, input) => {
      const known = store.seen()[seenId(item, ctx)];
      if (known) return { message: "Opened the existing thread", threadId: known.threadId, threadUrl: known.url, reused: true };
      const cwd = input.repoPath ?? repoFor(item, ctx.ref);
      if (!cwd) throw new Error("Choose a local repo for this thread");
      let t;
      try {
        t = await (ctx.createThread ?? createThread)({ cwd, title: item.title, prompt: prompt(item, ctx.ref), t3: ctx.routine.t3 });
      } catch (e) {
        throw e instanceof T3Down ? new Error("T3 is not running; thread not created") : e;
      }
      store.markSeen(seenId(item, ctx), { ...t, createdAt: new Date().toISOString() });
      return { message: "Thread started", threadId: t.threadId, threadUrl: t.url, reused: false };
    },
  };
}

const prName = (item, { repo, number }) => `${repo}#${number}${item.url ? ` (${item.url})` : ""}`;
const isPr = (ctx) => ctx.ref.type === "pr";
const reviewRequest = (item, ctx) => isPr(ctx) && item.kind === "needs_you" && ctx.mine === false;
const OPEN_LABEL = { pr: "Open PR", jira: "Open ticket", other: "Open link" };

// Order is priority: the first entry that applies and whose primary() holds is the row's primary action.
export const ACTIONS = {
  merge: {
    label: "Merge",
    appliesTo: (item, ctx) => isPr(ctx) && ctx.mine === true,
    primary: (item) => item.kind === "needs_you",
    done: true,
    confirm: (item, ctx) => mergePreview(ctx.ref),
    run: async (item, { ref }, input) => {
      const p = await mergePreview(ref);
      if (p.blocked) throw new Error(`Not merged: ${p.blocked}`);
      const method = input.method ?? p.method;
      if (!p.methods.includes(method)) throw new Error(`${ref.repo} does not allow ${method} merges`);
      await gh(["pr", "merge", String(ref.number), "-R", ref.repo, `--${method}`]);
      return { message: `Merged with ${method}` };
    },
  },
  "review-in-t3": { ...t3Action("Review in T3", reviewRequest, (item, ref) =>
    `Review the pull request ${prName(item, ref)} in depth. Read the diff with \`gh pr diff ${ref.number} -R ${ref.repo}\` and the existing discussion with \`gh pr view ${ref.number} -R ${ref.repo} --comments\`. Check correctness, edge cases, tests, and naming.\n\nReply with a list of draft review comments, each with the file and line it belongs to and the comment text, plus an overall verdict. Do not post anything to GitHub: no comments, no reviews, no approvals.`), primary: () => true },
  "start-in-t3": { ...t3Action("Start in T3", (item, ctx) => ctx.ref.type === "jira", (item, ref) =>
    [`Implement Jira ticket ${ref.issue}: ${item.title}.`, item.url && `Ticket: ${item.url}`, item.note && `Note: ${item.note}`, "Create a new branch for the work first. Read the ticket with your Jira tools if you have them."].filter(Boolean).join("\n\n")), primary: () => true },
  "address-comments": { ...t3Action("Address comments in T3", (item, ctx) => isPr(ctx), (item, ref) =>
    `Address the review comments and failing checks on the pull request ${prName(item, ref)}. Read them with \`gh pr view ${ref.number} -R ${ref.repo} --comments\` and \`gh pr checks ${ref.number} -R ${ref.repo}\`. Check out the PR branch, make the fixes, and push to that same branch. Do not merge the PR.`), primary: (item, ctx) => ctx.mine === true && item.kind === "code" },
  open: {
    label: (ref) => OPEN_LABEL[ref.type],
    appliesTo: (item) => !!item.url,
    primary: () => true,
    href: (item) => item.url,
  },
  approve: {
    label: "Approve",
    appliesTo: reviewRequest,
    done: true,
    confirm: (item, ctx) => prStatus(ctx.ref),
    run: async (item, { ref }) => {
      await gh(["pr", "review", String(ref.number), "-R", ref.repo, "--approve"]);
      return { message: "Approved" };
    },
  },
  "rerun-checks": {
    label: "Re-run failed checks",
    appliesTo: (item, ctx) => isPr(ctx),
    run: async (item, { ref }) => {
      const ids = await failedRunIds(ref);
      if (!ids.length) throw new Error("No failed GitHub Actions runs on this PR");
      for (const id of ids) await gh(["run", "rerun", id, "--failed", "-R", ref.repo]);
      return { message: `Re-running ${ids.length} failed ${ids.length === 1 ? "run" : "runs"}` };
    },
  },
  "move-to-t3": t3Action("Move to T3", () => true, (item) =>
    [item.title, item.note, item.url, item.threadPrompt].filter(Boolean).join("\n\n")),
};

export async function listActions(item, ctx) {
  const list = [];
  for (const [id, a] of Object.entries(ACTIONS)) {
    if (!a.appliesTo(item, ctx)) continue;
    const needsConfirm = a.t3 ? !!(await a.confirm(item, ctx)).needsPath : !!a.confirm;
    list.push({ id, label: typeof a.label === "function" ? a.label(ctx.ref) : a.label, needsConfirm, ...(a.href && { href: a.href(item) }), primary: false });
  }
  const first = list.find((x) => ACTIONS[x.id].primary?.(item, ctx));
  if (first) first.primary = true;
  return list;
}

// Validates the client's input at the boundary; the action re-checks anything that depends on live PR state.
export function parseInput(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("input must be an object");
  const { method, repoPath, ...rest } = raw;
  if (Object.keys(rest).length) throw new Error(`unknown input ${Object.keys(rest).join(", ")}`);
  if (method !== undefined && !(method in MERGE_METHODS)) throw new Error(`method must be one of ${Object.keys(MERGE_METHODS).join(", ")}`);
  if (repoPath !== undefined && !isGitRepo(repoPath)) throw new Error("repoPath must be an absolute path to an existing git repo");
  return { ...(method && { method }), ...(repoPath && { repoPath }) };
}
