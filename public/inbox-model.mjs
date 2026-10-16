export function freshnessModel(routines) {
  const active = routines.filter((r) => r.enabled).sort((a, b) =>
    (a.lastCompletedRun?.finishedAt ?? "").localeCompare(b.lastCompletedRun?.finishedAt ?? "") || a.name.localeCompare(b.name));
  const checked = active.filter((r) => r.lastCompletedRun);
  return {
    active,
    oldest: checked[0]?.lastCompletedRun.finishedAt,
    newest: checked.at(-1)?.lastCompletedRun.finishedAt,
    unchecked: active.length - checked.length,
    failed: active.filter((r) => r.lastRun?.state === "failed").length,
    running: active.filter((r) => r.lastRun?.state === "running").length,
  };
}

export function inboxModel(entries) {
  const groups = { review: [], action: [], waiting: [], t3: [], failed: [] };
  for (const e of entries) {
    if (e.state === "failed") { groups.failed.push({ e, key: e.runId }); continue; }
    if (!e.items.length) { groups.action.push({ e, key: e.runId }); continue; }
    for (const item of e.items) {
      const thread = item.kind === "code" && e.threads?.find((t) => t.key === item.key);
      const group = item.attention === "waiting" ? "waiting" : thread ? "t3" : item.attention === "review" ? "review" : "action";
      groups[group].push({ e, item, thread, key: `${e.runId}|${item.key}` });
    }
  }
  return groups;
}

export function summaryLine({ review, action, waiting, t3, failed }) {
  const actionable = review.length + action.length + failed.length;
  const total = actionable + waiting.length + t3.length;
  if (!total) return null;
  const parts = [
    review.length && `${review.length} ${review.length === 1 ? "PR" : "PRs"} to review`,
    action.length && `${action.length} ${action.length === 1 ? "next step" : "next steps"} for you`,
    waiting.length && `${waiting.length} waiting on others`,
    t3.length && `${t3.length} coding sessions`,
    failed.length && `${failed.length} failed ${failed.length === 1 ? "run" : "runs"}`,
  ].filter(Boolean);
  return { total, actionable, head: actionable ? `${actionable} ${actionable === 1 ? "thing needs" : "things need"} you` : "Nothing needs you right now", parts };
}
