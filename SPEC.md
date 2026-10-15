# routinebar spec

Local scheduler for agent routines on macOS. Node 24, zero npm dependencies. One Swift file for the menu bar.

## Data (all under `~/.routinebar/`, override with `ROUTINEBAR_HOME`)

- `routines.json`: array of Routine.
- `runs/<runId>.json`: one file per Run. Only the process running that run writes it.
- `logs/<runId>.log`: raw agent stdout+stderr.
- `seen.json`: `{ [routineId + ":" + item.key]: { threadId, url, createdAt } }`. Dedupes T3 threads across runs.

```ts
type Agent = "claude" | "codex" | "custom";
type Routine = {
  id: string;            // slug
  name: string;
  enabled: boolean;
  schedule: string;      // 5-field cron, local time
  agent: Agent;
  model: string;
  command?: string;      // custom only; sh template, gets $PROMPT and $MODEL env vars
  cwd: string;           // where the agent runs
  prompt: string;
  t3: { provider: "claudeAgent" | "codex"; model: string; runtimeMode: "approval-required" | "auto-accept-edits" | "full-access" };
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
};
type Run = {
  id: string; routineId: string; trigger: "schedule" | "manual";
  state: RunState; startedAt: string; finishedAt?: string;
  summary?: string; items: Item[];
  threads: { key: string; threadId: string; url: string; reused: boolean }[];
  error?: string; ackedAt?: string;
};
```

Run lifecycle is a state machine: `running -> done | needs_input | failed`. Acking sets `ackedAt` and removes the run from the inbox. On startup, any run left `running` by a dead process becomes `failed` with error "interrupted".

## Agent contract

The runner appends this to every prompt: the agent must end its reply with a fenced ```json block containing `{ "status": "done" | "needs_input", "summary": string, "items": Item[] }`. The runner parses the **last** ```json block in the output. Parse failure or non-zero exit makes the run `failed`, with the log kept.

Agent registry (a table, not branches):
- claude: `claude -p <prompt> --model <model> --dangerously-skip-permissions --output-format text`
- codex: `codex exec -m <model> --dangerously-bypass-approvals-and-sandbox -C <cwd> -o <tmpfile> <prompt>`. Read the final message from the tmpfile.
- custom: `sh -c <command>` with `PROMPT` and `MODEL` env vars.
All run with `cwd`, inherit the user's login env (PATH from `zsh -lc 'echo $PATH'` captured once), and have a 30 min timeout.

## T3 threads

For each `kind: "code"` item, if `seen.json` lacks `routineId:key`, create a T3 Code thread and record it. Otherwise reuse the recorded thread (no new thread). See `spike-create-thread.mjs` for the working protocol:
- origin from `~/.t3/userdata/server-runtime.json`
- token via `ELECTRON_RUN_AS_NODE=1 "/Applications/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)" "/Applications/T3 Code (Alpha).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs" auth session issue --token-only --ttl 1h`. Cache the token in memory for 50 min.
- `GET /api/orchestration/shell` to find the project by `workspaceRoot`; `project.create` if missing; then `thread.create` and `thread.turn.start` via `POST /api/orchestration/dispatch`.
- Thread URL is `<origin>/<contents of ~/.t3/userdata/environment-id>/<threadId>`.
If T3 is not running (no runtime file or connection refused), the run becomes `needs_input` with the item noted "T3 not running; thread not created" and the key is NOT added to seen.json, so the next run retries.

## Process

`node src/server.mjs` is one long-lived process (launchd KeepAlive). It:
- ticks every minute on the minute; for each enabled routine whose cron matches the current minute and which has no run in state `running`, starts a run.
- serves the UI and API on `127.0.0.1:4141` (override with `ROUTINEBAR_PORT`).
- posts a macOS notification (`osascript -e 'display notification ...'`) when a run ends `needs_input` or `failed`, or creates a thread.
Missed ticks while the Mac sleeps are skipped, not caught up.

## API (JSON)

- `GET /api/routines`, `PUT /api/routines/:id` (upsert, validate at this boundary), `DELETE /api/routines/:id`
- `POST /api/routines/:id/run` starts a manual run, returns the Run.
- `GET /api/runs?routineId=&limit=50` newest first; `GET /api/runs/:id` includes `log` text.
- `POST /api/runs/:id/ack`
- `GET /api/inbox` returns `{ count, entries: [{ runId, routineName, state, summary, finishedAt, items: Item[] (needs_you and code only), threads }] }` for unacked runs in `needs_input` or `failed`, plus unacked `done` runs that have needs_you or code items. Newest first.
- `GET /api/cron/preview?expr=` returns `{ valid, description, next: string[5] }` or `{ valid: false, error }`.

## UI

Single `public/index.html` (vanilla JS + CSS, no build). Three tabs:
- **Inbox**: the summary of what needs the user. Each entry shows routine, summary, items with links, T3 thread links, an Ack button.
- **Routines**: list with enabled toggle, next run, Run now, edit. Editor form covers every Routine field. The cron builder has presets (every N minutes, hourly at :MM, daily at HH:MM, weekdays at HH:MM, weekly on chosen days at HH:MM) that write the cron string, a raw cron text field, and a live preview from `/api/cron/preview` (plain-English description and next 5 runs).
- **Runs**: table of runs with state badges, filter by routine, click for detail with summary, items and log.

## Cron

`src/cron.mjs`: parse 5 fields (minute hour dom month dow), with `*`, lists, ranges, steps, dow 0-7 (both 0 and 7 are Sunday). Standard dom/dow OR semantics when both are restricted. Exports `parseCron`, `matches(cron, date)`, `nextRuns(cron, from, n)`, `describe(cron)`. `src/cron.test.mjs` runs with `node --test` and asserts literal expected values.

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
