# RoutineBar

A local scheduler for agent routines on macOS. Each routine runs a coding agent (Claude Code, Codex, or any shell command) on a cron schedule, collects what needs your attention into an inbox, and opens a T3 Code thread for each code task. A menu bar item shows the inbox count.

Node 24, no npm dependencies. Data lives in `~/.routinebar/`.

## Install

```sh
bin/install.sh     # builds ~/Applications/RoutineBar.app, loads the server and menu bar LaunchAgents
bin/uninstall.sh   # unloads both and removes the app; keeps ~/.routinebar
```

The dashboard is at http://127.0.0.1:4141. Three starter routines are created disabled; enable them in the Routines tab.

For development, run `node src/server.mjs` (set `ROUTINEBAR_HOME` and `ROUTINEBAR_PORT` to keep it separate) and `node --test src/*.test.mjs`.

## Writing a routine prompt

Write the prompt as a task for an agent working in the routine's directory. Say what to look at, what to never do (merge, post, push to main), and how each finding maps to an item:

- `needs_you`: something you must look at or decide. Shows in the inbox.
- `code`: work a coding agent can do. RoutineBar opens one T3 Code thread per item in `repoPath` (or the routine's directory) seeded with `threadPrompt`.
- `fyi`: recorded in the run, kept out of the inbox.

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
      "url": "https://github.com/acme/api/pull/42", "note": "2 new review comments",
      "repoPath": "/Users/you/Projects/api", "threadPrompt": "Address the review comments and push." }
  ]
}
```
````

A non-zero exit, a timeout (30 min), or a missing or malformed block marks the run `failed` and keeps the log. A `custom` agent runs `sh -c <command>` with `PROMPT` and `MODEL` in the environment and must print the same block.
