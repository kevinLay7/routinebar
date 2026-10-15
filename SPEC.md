# routinebar spec

Local scheduler for agent routines on macOS. Node 24, zero npm dependencies. One Swift file for the menu bar.

## Data (all under `~/.routinebar/`, override with `ROUTINEBAR_HOME`)

- `routines.json`: array of Routine.
- `runs/<runId>.json`: one file per Run. Only the server process writes it.
- `logs/<runId>.log` and `logs/<runId>.err`: the agent's stdout and stderr. `runs/<runId>.exit` holds its exit code; `runs/<runId>.out` is codex's final message.
- `seen.json`: `{ [routineId + ":" + canonicalKey(item)]: { threadId, url, createdAt } }`. Dedupes T3 threads across runs.
- `dismissed.json`: `{ [routineId + ":" + canonicalKey(item)]: fingerprint }` for items marked done, where fingerprint hashes the item's kind and note, so an item comes back only when the agent reports something new about it. Run-level rows use `routineId:failed` and `routineId:run` with the run id as the value.

`canonicalKey(item)` (`src/inbox.mjs`) is the one item identity: `pr:owner/repo#n` (lowercased) from a GitHub PR url or a `pr:` key, else `jira:KEY` from a Jira key in the key or url, else the agent's key. The runner stores items under it and drops later duplicates within a run.

```ts
type Agent = "claude" | "codex" | "custom";
type Routine = {
  id: string;            // slug
  name: string;
  enabled: boolean;
  schedule: string;      // one or more 5-field crons joined by "; ", local time
  agent: Agent;
  model: string;
  command?: string;      // custom only; sh template, gets $PROMPT and $MODEL env vars
  cwd: string;           // where the agent runs
  prompt: string;
  t3: { provider: "claudeAgent" | "codex"; model: string; runtimeMode: "approval-required" | "auto-accept-edits" | "full-access" };
  importedFrom?: { source: string; sourceId: string; needsSchedule?: true }; // set by Import; needsSchedule clears on the next editor save
};

type RunState = "running" | "done" | "needs_input" | "failed";
type Item = {
  key: string;           // stable id, e.g. "pr:owner/repo#123" or "jira:SOF-42"
  title: string;
  url?: string;
  kind: "needs_you" | "code" | "fyi";
  note?: string;
  repoPath?: string;     // code items: local repo for the T3 thread; falls back to routine.cwd
  threadPrompt?: string; // code items: instructions for the T3 thread
  history?: { action: string; at: string; ok: boolean; message: string; threadUrl?: string }[]; // one entry per item action attempt
};
type Run = {
  id: string; routineId: string; trigger: "schedule" | "manual";
  agent: Agent; pid: number; // the detached agent's process (group leader)
  repaired?: true;       // a repair turn ran
  state: RunState; startedAt: string; finishedAt?: string;
  summary?: string; items: Item[];
  threads: { key: string; threadId: string; url: string; reused: boolean }[];
  error?: string;
};
```

Run lifecycle is a state machine: `running -> done | needs_input | failed`. Older run files with `ackedAt` or `doneKeys` are moved into `dismissed.json` on startup. Agents run detached (own process group, output straight to files), so they survive a server restart. Each running run is watched by polling its pid every 2 s; on startup the server adopts every `running` run the same way. When the pid is gone, the `.exit` file and logs finish the run; no `.exit` file means `failed` with "interrupted". The 30 min timeout kills the process group.

## Agent contract

The runner appends this to every prompt: the agent must end its reply with a fenced ```json block containing `{ "status": "done" | "needs_input", "summary": string, "items": Item[] }`. The runner parses the **last** ```json block in the final message. Non-zero exit makes the run `failed`. A final message without a valid block gets one repair turn in the same agent session (claude `--resume <session_id>`, codex `exec resume <session id>`; custom has none) that restates the contract and asks for only the json block; the run records `repaired: true`. If that also fails, the run is `failed` and its `summary` holds the last 3 non-empty lines of the first final message. Repair output goes to `<runId>.repair.*` files.

Agent registry (a table, not branches):
- claude: `claude -p <prompt> --model <model> --dangerously-skip-permissions --output-format json`. The final message is `.result` of the last JSON line of stdout.
- codex: `codex exec -m <model> --dangerously-bypass-approvals-and-sandbox -C <cwd> -o runs/<runId>.out <prompt>`. Read the final message from that file.
- custom: `sh -c <command>` with `PROMPT` and `MODEL` env vars; the final message is stdout.
All run with `cwd`, inherit the user's login env (PATH from `zsh -lc 'echo $PATH'` captured once), and have a 30 min timeout (from the run's start).

## T3 threads

For each `kind: "code"` item, if `seen.json` lacks `routineId:key`, create a T3 Code thread and record it. Otherwise reuse the recorded thread (no new thread). See `spike-create-thread.mjs` for the working protocol:
- origin from `~/.t3/userdata/server-runtime.json`
- token via `ELECTRON_RUN_AS_NODE=1 "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)" "/Applications/T3 Code (Alpha).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs" auth session issue --token-only --ttl 1h`. Cache the token in memory for 50 min.
- `GET /api/orchestration/shell` to find the project by `workspaceRoot`; `project.create` if missing; then `thread.create` and `thread.turn.start` via `POST /api/orchestration/dispatch`.
- Thread URL is `<origin>/<contents of ~/.t3/userdata/environment-id>/<threadId>`.
If T3 is not running (no runtime file or connection refused), the run becomes `needs_input` with the item noted "T3 not running; thread not created" and the key is NOT added to seen.json, so the next run retries.

## Process

`node src/server.mjs` is one long-lived process (launchd KeepAlive). It:
- ticks every minute on the minute; for each enabled routine whose cron matches the current minute and which has no run in state `running`, starts a run. A routine with a running run is skipped silently; the running run is never touched.
- serves the UI and API on `127.0.0.1:4141` (override with `ROUTINEBAR_PORT`).
- posts a macOS notification (`osascript -e 'display notification ...'`) when a run ends `needs_input` or `failed`, or creates a thread.
Missed ticks while the Mac sleeps are skipped, not caught up.

## API (JSON)

- `GET /api/routines` (each with `lastRun: {id, state, startedAt, finishedAt} | null` and `nextRun: ISO | null`), `PUT /api/routines/:id` (upsert, validate at this boundary), `DELETE /api/routines/:id`
- `POST /api/routines/:id/run` starts a manual run, returns the Run. While the routine has a running run it returns 409 `{ error: "already running", runId }` and leaves that run alone.
- `GET /api/runs?routineId=&limit=50` newest first; `GET /api/runs/:id` includes `log` (stdout) and `err` (stderr) text.
- `POST /api/runs/:id/ack` with body `{ key }` marks that item done for the routine (dismissed.json); without a body it dismisses the run's own row (a failed run, or a needs_input run without items).
- `GET /api/models` returns `{ agents: { claude, codex, custom }, t3: { claudeAgent, codex } }` model suggestions, from `~/.t3/userdata/model-manifest.json` `currentModels` when readable.
- `GET /cron.mjs` serves `src/cron.mjs` so the dashboard parses schedules with the same code.
- `POST /api/runs/:id/rerun` starts the run's routine again (same 409 as above).
- `GET /api/runs/:id/items/:key/actions` lists applicable actions `[{ id, label, needsConfirm, primary, href? }]`; `POST .../actions/:action/preview` returns the confirm preview; `POST .../actions/:action` with optional `{ method?, repoPath? }` runs it and returns `{ ok, message, threadUrl?, reused? }`. Keys are URL-encoded. Inbox items and `GET /api/runs/:id` items carry the same `actions` list. See Item actions.
- `GET /api/inbox` returns `{ count, entries: [{ runId, routineId, routineName, state, summary, error?, finishedAt, items: Item[] (needs_you and code only, minus dismissed), threads }] }`, newest first. The inbox is current state per routine: items come from the routine's latest finished non-failed run only (older runs stay in Runs). A failed run shows only when it is the routine's latest finished run. `summary` is never null (the menu bar decodes it).
- `GET /api/import[?source=]` returns `{ sources: [{ id, label, ok, error?, candidates: [Candidate & { imported }] }] }`. `POST /api/import` with `{ items: [{ source, sourceId }] }` re-lists those sources, creates routines from its own candidates, and returns the created routines. See Import.
- `GET /api/cron/preview?expr=` returns `{ valid, description, next: string[5] }` or `{ valid: false, error }`.

## UI

Single `public/index.html` (vanilla JS + CSS, no build). It imports `/cron.mjs`, so the browser parses schedules with the server's code. Design direction and decisions: `design/DIRECTION.md`.
- **Inbox** (home): a sentence with the count and a breakdown, then rows grouped as Needs your review, Started in T3, and Failed runs (collapsed). Each row has one primary action (merge a ready own PR, review a requested PR in T3, start a Jira ticket in T3, address comments on an own PR, else open the thread, PR, link, or run), an overflow menu with the other actions, and Done. Actions needing confirmation open a sheet with the live preview. J/K move, O opens, Enter runs the primary action, A opens the menu, D marks done. Polls every 15 s and re-renders only when the data changed.
- **Routines**: table with on/off switch, name, plain-English schedule, last run state and time, next run, Run now (an "Already running" link to the running run while one runs; a 409 from Run now or Run again opens that run with an "Already running" toast). A row opens the editor.
- **Editor**: Basics, Schedule, Instructions, When code is needed (T3 provider, model, permissions), with a sticky save bar and an unsaved-changes guard. The id is derived from the name on create and fixed after. The schedule builder covers "at set times" (days and several times) and "on an interval" (every N minutes or hours, optional hours window, days), shows a sentence and the next 7 days, and keeps the raw cron under Advanced. Times with different minutes save as several expressions joined by "; ".
- **Import** (Routines page): a sheet grouped by source, each loading on its own, with one checkbox row per candidate showing both schedules, agent and model, notes, and a collapsed prompt. Imported rows say "From <source>"; routines still needing a schedule carry a "Needs a schedule" chip in the table and the editor.
- **Runs**: table of runs with state, filter by routine; detail shows state, start, duration, trigger, whether a repair turn fixed the output, summary, items (with their actions, history, and Done), threads, the raw log and stderr behind disclosures, and Run again. A failed run's inbox row shows the last lines of the agent's reply above the error.

## Item actions

`src/actions.mjs` is a registry `{ [id]: { label, appliesTo(item, ctx), primary?, confirm?, run(item, ctx, input), done? } }` where `ctx = { routine, ref, mine }`: `ref` comes from one key parser (`pr:owner/repo#n`, `jira:KEY`, other) and `mine` says whether the current gh user wrote the PR (null when gh can't tell). Registry order is priority: the first applicable entry whose `primary` holds is the row's primary verb.
- PR: `open`, `address-comments` (T3), `rerun-checks` (`gh run rerun <id> --failed` for each failed Actions run in `gh pr checks`).
- Review request (needs_you PR by someone else): `review-in-t3` (drafts comments, posts nothing), `approve` (confirm).
- Own PR: `merge` (confirm shows live state, checks, review, mergeability and the repo's allowed methods; blocked when not open or draft; squash by default).
- Jira: `open`, `start-in-t3`. Any item: `move-to-t3`.
T3 actions reuse the runner's `seen.json` key `routineId:item.key`, so an item gets at most one thread whichever action makes it. The repo is `item.repoPath`, else a clone under ~/Projects named like the repo, else the user enters a path (must be a git repo). Every attempt appends to the item's `history`; a successful merge or approve marks the item done. gh runs as `$ROUTINEBAR_GH` (default `gh`) with the login PATH; its stderr is the failure message.

## Cron

`src/cron.mjs`: parse 5 fields (minute hour dom month dow), with `*`, lists, ranges, steps, dow 0-7 (both 0 and 7 are Sunday). Standard dom/dow OR semantics when both are restricted. A schedule may hold several expressions separated by `;` (times with different minutes need this): it matches when any does, `nextRuns` merges and dedupes, `describe` joins with "; ". Exports `parseCron`, `matches(cron, date)`, `nextRuns(cron, from, n)`, `describe(cron)`. `src/cron.test.mjs` runs with `node --test` and asserts literal expected values.

## Import

`src/importers.mjs` is a registry of sources `{ id, label, list() }`, each returning Candidates `{ source, sourceId, name, prompt, schedule: string | null, sourceSchedule (empty when the source stores none), agent, model, cwd, notes: string[] }`. A failing source returns `{ ok: false, error }` and the others still show. Sources are only read, never changed.
- `claude-cloud`: `GET https://api.anthropic.com/v1/code/triggers` (beta `ccr-triggers-2026-01-30`) with the Claude Code OAuth token from the keychain. The UTC cron moves to local time at the current offset when minute and hour are plain numbers or lists (several expressions when only some hours cross midnight); otherwise it stays UTC with a note. cwd is a clone under ~/Projects named like the repo, else ~/Projects.
- `claude-desktop`: `~/.claude/scheduled-tasks/*/SKILL.md`; no schedule is stored there.
- `codex`: `~/.codex/automations/*/automation.toml`; `rrule` converts to cron for MINUTELY, HOURLY, DAILY and WEEKLY with INTERVAL, BYDAY, BYHOUR, BYMINUTE.
Import is idempotent on `source + sourceId`. Imported routines start `enabled: false`; a candidate without a schedule gets `0 9 * * 1-5` and `importedFrom.needsSchedule`. The id comes from the name with the editor's slug rule, deduped.

## Seeds

On first start, if `routines.json` is missing, write the three starter routines from `src/seeds.mjs`, all `enabled: false`:
1. `review-requested-prs`: find open PRs where the user's review is requested (`gh search prs --review-requested=@me --state=open`), review each, report as `needs_you` items with a short verdict. Do not post reviews.
2. `my-prs-followup`: for the user's open PRs with new review comments or failing checks, emit a `code` item per PR (key `pr:<repo>#<n>`, repoPath if a local clone is found under ~/Projects, threadPrompt telling the thread to address the comments and push). PRs approved with green checks become `needs_you` items "ready to merge". Never merge.
3. `jira-in-progress`: using the agent's Jira tools, list tickets assigned to the user in status In Progress; emit a `code` item per ticket (key `jira:<KEY>`, threadPrompt to implement the ticket on a new branch). If no Jira tool is available, status `needs_input` with a note saying so.
Schedules: weekdays 9:00 and 13:00 for 1, every 30 minutes 8-18 weekdays for 2 and 3.

## Menu bar

`menubar/RoutineBar.swift`, compiled with `swiftc`, an `NSStatusItem` app (LSUIElement, no Dock icon). Polls `GET /api/inbox` every 30 s. Title shows the count (blank when 0, "!" when server unreachable). Menu: one entry per inbox entry (click opens the dashboard at `#inbox`), separator, "Open Dashboard", "Quit".

## Install

`bin/install.sh` builds the menu bar app into `~/Applications/RoutineBar.app` and writes two LaunchAgents (`com.routinebar.server`, `com.routinebar.menubar`) with RunAtLoad and KeepAlive, then loads them. `bin/uninstall.sh` reverses it.
