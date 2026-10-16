# RoutineBar

A local scheduler for agent routines on macOS. Each routine runs a coding agent (Claude Code, Codex, or any shell command) on a cron schedule, collects what needs your attention into an inbox, and opens a T3 thread for each code task. A menu bar item shows the inbox count.

Node 24, no npm dependencies. Data lives in `~/.routinebar/`.

## Install

```sh
bin/install.sh     # builds ~/Applications/RoutineBar.app, loads the server and menu bar LaunchAgents
bin/uninstall.sh   # unloads both and removes the app; keeps ~/.routinebar
```

The dashboard is at http://127.0.0.1:4141. Three starter routines are created disabled; enable them in the Routines tab.

For development, run `node src/server.mjs` (set `ROUTINEBAR_HOME` and `ROUTINEBAR_PORT` to keep it separate) and `node --test src/*.test.mjs`.

## Teams monitoring

Teams monitoring uses the signed-in **Mac Teams client's local message cache**, without a Microsoft 365 connector or a separate Teams login. The Mac reader currently supports **group chats and personal @mentions**. Channel/group-tag monitoring is unavailable with this reader.

Install the optional Python reader once (Python 3.10+):

```sh
bash bin/setup-teams-cache.sh
```

The reader uses [CCL's Chromium reader](https://github.com/cclgroupltd/ccl_chromium_reader) in an isolated environment under `~/.routinebar/tools/teams-cache`. It reads temporary snapshots of current LevelDB files, selects the newest live records, and deletes the snapshots afterward. It identifies your account from your own cached messages and matches explicit mention IDs. It does not call Teams APIs or change message read status.

Open **Routines → Monitor Teams**, choose **Group chat**, enter a display name, and paste the chat link or ID. Choose a lookback window and schedule. New monitors default to off, checking every 10 minutes during weekday work hours when enabled. **Check access** reads the configured conversation from the Mac cache and reports message/mention counts and the last cached message time. Use **Run now** to verify before turning it on.

Only messages already downloaded by Teams are covered. Open the chat in the Mac client to refresh it. The reader cannot prove complete server history or live sync; an empty result means no matching cached messages, not proof there are no new mentions on the server. Stale, unavailable, ambiguous, or undecodable caches create an actionable inbox item. Previously unresolved mentions remain tracked when their messages leave the lookback window or are no longer cached. Both Claude and Codex receive the local snapshot for analysis. Claude's tools and MCP connectors are disabled for that analysis.

## Writing a routine prompt

Write the prompt as a task for an agent working in the routine's directory. Say what to look at, what to never do (merge, post, push to main), and how each finding maps to an item:

- `needs_you`: something you must look at or decide. Shows in the inbox.
- `code`: work a coding agent can do. RoutineBar opens one T3 thread per item in `repoPath` (or the routine's directory) seeded with `threadPrompt`.
- `fyi`: recorded in the run, kept out of the inbox.

Each item also describes whose turn it is:

- `attention: "review"`: a PR needs your review now.
- `attention: "action"`: you need to make a decision, fix something, merge, or follow up.
- `attention: "waiting"`: another person or check must act first; include `waitingOn`.

Include a concrete `nextStep` for every classified item. Waiting items stay visible in their own section but do not add to the menu bar or inbox attention count. Keep waiting items as `needs_you`, not `code`. Older results without these fields appear under Your next steps with a prompt to check the run. A dismissed item returns when its kind or attention changes.

Give every item a stable `key` such as `pr:owner/repo#123` or `jira:SOF-42`. A `code` item's thread is created once per routine and key; later runs that report the same key link the existing thread instead of opening another.

## Agent output contract

RoutineBar appends the contract to every prompt. The agent must end its reply with a fenced json block; the last one in the output wins:

````
```json
{
  "status": "done" | "needs_input",
  "summary": "one or two sentences",
  "items": [
    { "key": "pr:acme/api#42", "title": "acme/api#42 Fix retry", "kind": "code",
      "attention": "action", "nextStep": "Address the two new review comments.",
      "url": "https://github.com/acme/api/pull/42", "note": "2 new review comments",
      "repoPath": "/Users/you/Projects/api", "threadPrompt": "Address the review comments and push." }
  ]
}
```
````

A non-zero exit, a timeout (30 min), or a missing or malformed block marks the run `failed` and keeps the log. A `custom` agent runs `sh -c <command>` with `PROMPT` and `MODEL` in the environment and must print the same block.

## Jira Autopilot polling

The installed autopilot uses `bin/jira-autopilot-poll.mjs` (copied to `~/.claude/jira-autopilot/`) with the machine's authenticated TWG CLI. The helper verifies Kevin's account before querying the exact In Progress statuses in open sprints. Authentication errors, malformed responses, and possibly truncated results block reconciliation rather than appearing as zero tickets. Test with `node bin/jira-autopilot-poll.mjs`.

The routine processes every eligible ticket, with an atomic claim and a separate T3 worktree/thread for each. Existing work is skipped with evidence. Ticket-specific blocks allow the remaining tickets to proceed. `bin/t3-handoff.mjs` mirrors the installed handoff helper and supports the installed T3 Beta app and orchestration protocol 2.

## Editor and agent settings

Open **Settings** to choose T3, VS Code, Cursor, or Terminal for coding tasks. T3 starts an agent thread. VS Code and Cursor open the project folder and start the selected agent in macOS Terminal; Terminal starts the agent directly. Non-T3 sessions have a saved prompt page in RoutineBar where you can start another session.

Settings also contains the default agent, Claude/Codex models, coding permissions, background-check permissions, CLI executable paths, and an optional T3 application path. T3 detects the current app name automatically; **Check connection** verifies it without starting a task. CLI paths accept an executable name on your login PATH or an absolute path, without arguments.

New routines use these defaults. Existing routines retain their agent/model choices; enable **Use the agent and permission defaults from Settings** under **When code is needed** to opt a routine into shared coding defaults. The editor selection and background-check permissions apply globally. Changes affect subsequent launches; running sessions keep their current configuration. Custom shell routines manage their own permissions.

Desktop notifications are controlled under **Settings → Desktop notifications**. Choose alerts for new items needing you, new failures and coding sessions, or every completed run. Attention alerts skip unchanged and dismissed items and work waiting on others. **Send test notification** sends a real macOS alert. These notifications use macOS's Script Editor notification channel; allow its banners in System Settings → Notifications and check Focus settings if banners are silenced. The dashboard does not need to stay open. Delivery errors appear on the run as `notificationError` and in the server log.
