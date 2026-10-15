import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseCron } from "./cron.mjs";

const PROJECTS = join(homedir(), "Projects");
const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Cron list with runs of three or more collapsed to ranges: [1,2,3,4,5] -> "1-5", [1,3,5] -> "1,3,5".
function cronList(nums) {
  const v = [...new Set(nums)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < v.length; ) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    parts.push(j - i >= 2 ? `${v[i]}-${v[j]}` : v.slice(i, j + 1).join(","));
    i = j + 1;
  }
  return parts.join(",");
}

const shiftDow = (field, days) => (days && field !== "*" ? cronList([...parseCron(`0 0 * * ${field}`)[0].dow].map((d) => (d + days + 7) % 7)) : field);

// offsetMin is minutes east of UTC (EDT is -240). Returns null when the expression can't be shifted exactly.
export function utcCronToLocal(expr, offsetMin) {
  const [minute, hour, dom, month, dow, ...extra] = expr.trim().split(/\s+/);
  const plain = /^\d+(,\d+)*$/;
  // ponytail: half-hour offsets keep UTC; shift the minute field too if anyone lives in one.
  if (extra.length || dow === undefined || offsetMin % 60 || !plain.test(minute) || !plain.test(hour)) return null;
  const byDay = new Map();
  for (const h of hour.split(",").map(Number)) {
    const local = h + offsetMin / 60;
    const day = Math.floor(local / 24);
    byDay.set(day, [...(byDay.get(day) ?? []), local - day * 24]);
  }
  const wraps = [...byDay.keys()].some(Boolean);
  if (wraps && (dom !== "*" || month !== "*")) return null;
  return [...byDay]
    .sort(([a], [b]) => a - b)
    .map(([day, hours]) => [minute, cronList(hours), dom, month, shiftDow(dow, day)].join(" "))
    .join("; ");
}

// Each FREQ maps (interval, hour, minute, hasDays) to [minute, hour] cron fields, or false when cron can't express it.
const FREQS = {
  MINUTELY: (n, h, m) => !m && 60 % n === 0 && [n === 1 ? "*" : `*/${n}`, h ?? "*"],
  HOURLY: (n, h, m) => !h && 24 % n === 0 && [m ?? "0", n === 1 ? "*" : `*/${n}`],
  DAILY: (n, h, m) => n === 1 && h && [m ?? "0", h],
  WEEKLY: (n, h, m, hasDays) => n === 1 && h && hasDays && [m ?? "0", h],
};

export function rruleToCron(rrule) {
  const { FREQ, INTERVAL = "1", BYDAY, BYHOUR, BYMINUTE, ...rest } = Object.fromEntries(
    rrule.replace(/^RRULE:/i, "").split(";").filter(Boolean).map((kv) => kv.split("=")),
  );
  const days = BYDAY?.split(",").map((d) => DOW[d]);
  if (!FREQS[FREQ] || Object.keys(rest).length || days?.includes(undefined)) return null;
  const nums = (s) => s && cronList(s.split(",").map(Number));
  const fields = FREQS[FREQ](Number(INTERVAL), nums(BYHOUR), nums(BYMINUTE), !!days);
  return fields ? `${fields[0]} ${fields[1]} * * ${days ? cronList(days) : "*"}` : null;
}

// Codex files are flat `key = value` lines whose values are JSON-compatible; stops at the first [table].
export function parseCodexToml(text) {
  const out = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) break;
    const m = /^(\w+)\s*=\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    try {
      out[m[1]] = JSON.parse(m[2]);
    } catch {}
  }
  return out;
}

const readText = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);
const subdirs = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []);

export function localClone(url) {
  const name = basename(url).replace(/\.git$/, "").toLowerCase();
  const hit = subdirs(PROJECTS).find((d) => d.toLowerCase() === name);
  return hit ? join(PROJECTS, hit) : null;
}

async function claudeCloud() {
  let token;
  try {
    token = JSON.parse(execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 10e3 })).claudeAiOauth.accessToken;
  } catch {
    throw new Error("Not signed in to Claude Code on this Mac.");
  }
  const triggers = [];
  for (let after = null; ; ) {
    const res = await fetch(`https://api.anthropic.com/v1/code/triggers${after ? `?after_id=${encodeURIComponent(after)}` : ""}`, {
      headers: { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "ccr-triggers-2026-01-30" },
      signal: AbortSignal.timeout(15e3),
    });
    if (res.status === 401) throw new Error("Claude login expired. Open Claude Code once to refresh it.");
    if (!res.ok) throw new Error(`Claude cloud answered HTTP ${res.status}.`);
    const page = await res.json();
    triggers.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    after = page.data.at(-1).id;
  }
  const offset = -new Date().getTimezoneOffset();
  return triggers.map((t) => {
    const notes = [];
    const local = utcCronToLocal(t.cron_expression, offset);
    notes.push(local ? "Converted from UTC at current offset" : "Schedule is in UTC");
    let cwd = null;
    for (const s of t.job_config?.ccr?.session_context?.sources ?? []) {
      const url = s.git_repository?.url;
      if (!url) continue;
      const clone = localClone(url);
      cwd ??= clone;
      notes.push(clone ? `Repo ${url} found at ${clone}` : `Repo ${url} has no local clone under ${PROJECTS}`);
    }
    const connectors = (t.mcp_connections ?? []).map((c) => c.name);
    if (connectors.length) notes.push(`Uses cloud connectors: ${connectors.join(", ")}. Make sure your local Claude has them.`);
    notes.push(`${t.enabled ? "On" : "Off"} in Claude cloud`);
    return {
      sourceId: t.id,
      name: t.name,
      prompt: t.derived_state?.prompt ?? "",
      schedule: local ?? t.cron_expression,
      sourceSchedule: `${t.cron_expression} (UTC)`,
      agent: "claude",
      model: t.derived_state?.model || "opus",
      cwd: cwd ?? PROJECTS,
      notes,
    };
  });
}

function claudeDesktop() {
  const dir = join(homedir(), ".claude", "scheduled-tasks");
  return subdirs(dir).flatMap((id) => {
    const text = readText(join(dir, id, "SKILL.md"));
    if (text === null) return [];
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
    const front = Object.fromEntries((m?.[1] ?? "").split("\n").map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter(Boolean).map(([, k, v]) => [k, v.trim()]));
    return [
      {
        sourceId: id,
        name: front.name || id,
        prompt: (m ? m[2] : text).trim(),
        schedule: null,
        sourceSchedule: "",
        agent: "claude",
        model: "opus",
        cwd: PROJECTS,
        notes: [...(front.description ? [`Description: ${front.description}`] : []), "Schedule not found; set one before turning it on"],
      },
    ];
  });
}

function codex() {
  const dir = join(homedir(), ".codex", "automations");
  const model = parseCodexToml(readText(join(homedir(), ".codex", "config.toml")) ?? "").model || "gpt-6.1-sol";
  return subdirs(dir).flatMap((id) => {
    const text = readText(join(dir, id, "automation.toml"));
    if (text === null) return [];
    const a = parseCodexToml(text);
    const schedule = a.rrule ? rruleToCron(a.rrule) : null;
    const notes = [];
    if (!schedule) notes.push(`Codex schedule ${a.rrule ? `"${a.rrule}" has no cron equivalent` : "is missing"}; set one before turning it on`);
    if (a.kind === "heartbeat" || a.target_thread_id) notes.push("In Codex this continued an existing thread; here it runs fresh each time");
    if (a.status) notes.push(`Status in Codex: ${a.status}`);
    return [{ sourceId: a.id || id, name: a.name || id, prompt: a.prompt ?? "", schedule, sourceSchedule: a.rrule ?? "None", agent: "codex", model, cwd: PROJECTS, notes }];
  });
}

export const SOURCES = [
  { id: "claude-cloud", label: "Claude cloud", list: claudeCloud },
  { id: "claude-desktop", label: "Claude desktop", list: claudeDesktop },
  { id: "codex", label: "Codex", list: codex },
];

// One source failing never hides the others. Schedules our cron parser rejects become null so they can't be saved.
export async function listSource({ id, label, list }) {
  try {
    const candidates = (await list()).map((c) => {
      let schedule = c.schedule;
      const notes = [...c.notes];
      try {
        if (schedule) parseCron(schedule);
      } catch {
        notes.push(`Schedule "${schedule}" could not be read; set one before turning it on`);
        schedule = null;
      }
      return { source: id, ...c, schedule, notes };
    });
    return { id, label, ok: true, candidates };
  } catch (e) {
    return { id, label, ok: false, error: e.message, candidates: [] };
  }
}
