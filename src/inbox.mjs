import { createHash } from "node:crypto";

// Agents word keys differently run to run, so identity comes from the PR url or Jira key when there is one.
export function canonicalKey({ key, url = "" }) {
  const pr = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url) ?? /^pr:([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(key);
  if (pr) return `pr:${pr[1].toLowerCase()}/${pr[2].toLowerCase()}#${pr[3]}`;
  const jira = /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(key) ?? /\b([A-Z][A-Z0-9]+-\d+)\b/.exec(url);
  return jira ? `jira:${jira[1]}` : key;
}

export const fingerprint = (item) => createHash("sha1").update(`${item.kind}\n${item.note ?? ""}`).digest("hex").slice(0, 12);
export const itemId = (routineId, item) => `${routineId}:${canonicalKey(item)}`;
export const isDismissed = (dismissed, routineId, item) => dismissed[itemId(routineId, item)] === fingerprint(item);
// Run-level rows (a failed run, a needs_input run without items) are dismissed by run id under these keys.
export const failedId = (routineId) => `${routineId}:failed`;
export const runRowId = (routineId) => `${routineId}:run`;

export const openItems = (run, dismissed) => run.items.filter((i) => i.kind !== "fyi" && !isDismissed(dismissed, run.routineId, i));

// Per routine: the latest finished non-failed run's open items, plus the latest run if it failed after that.
// runs must be newest first.
export function inboxRuns(runs, dismissed) {
  const out = [];
  for (const list of Map.groupBy(runs.filter((r) => r.state !== "running"), (r) => r.routineId).values()) {
    const [latest] = list;
    const ok = list.find((r) => r.state !== "failed");
    if (latest.state === "failed" && dismissed[failedId(latest.routineId)] !== latest.id) out.push({ run: latest, items: [] });
    if (!ok) continue;
    const items = openItems(ok, dismissed);
    const itemless = ok.state === "needs_input" && !ok.items.some((i) => i.kind !== "fyi");
    if (items.length || (itemless && dismissed[runRowId(ok.routineId)] !== ok.id)) out.push({ run: ok, items });
  }
  return out.sort((a, b) => b.run.finishedAt.localeCompare(a.run.finishedAt));
}
