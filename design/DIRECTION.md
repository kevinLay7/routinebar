# RoutineBar dashboard direction

## Brief

Designing the local dashboard of RoutineBar for one developer on macOS (a browser tab opened from the menu bar).
Goal: see in seconds what needs me, clear it, and keep routines scheduled correctly.
Tone: a native, quiet work tool. Dense, keyboard friendly, nothing decorative.
Main risk: the old UI made every run look the same; the user could not tell what to do next.
Must remember: one sentence at the top that says how many things need you and what kind.
Constraints: one vanilla `public/index.html`, zero deps, light and dark, no em or en dashes in copy.

## Research log

Mobbin MCP was the planned screen and flow source. Every call (`search_screens` for inbox triage and cron tables, `search_flows` for recurring schedule creation) returned "Mobbin MCP requires a paid plan", so no Mobbin screens were reviewed. Refero MCP is not installed. Fallback sources, all read this session:

- Linear Inbox docs (linear.app/docs/inbox): J/K or arrows move through notifications, single-key actions (U read, H snooze, Backspace delete), Priority tab first.
- GitHub notifications docs (docs.github.com, managing notifications from your inbox): per-row Done removes an item and keeps it findable; Done is the primary triage verb; filters by reason such as review requested.
- Vercel Cron Jobs docs (vercel.com/docs/cron-jobs/manage-cron-jobs): jobs listed in a settings page with a View Logs action per job and a Disable control; disabled jobs stay listed.
- Trigger.dev scheduled tasks docs (trigger.dev/docs/tasks/scheduled): schedule rows carry cron pattern, next run, last run and status; clicking a row opens an inspector to enable, edit or delete.
- Bundled craft refs: typography.md, color.md, craft-details.md, anti-ai-slop.md.

Gap: no screenshots were inspected, so layout specifics below come from the documented behaviour of these products plus the craft refs, not from pixel references.

## Reference lock

- Primary direction: Linear-style triage list. Preserve: grouped rows instead of cards, single-key keyboard triage (J/K, O, D), one primary verb per row, Done as the exit.
- Preserve from macOS context: system font (SF Pro via `system-ui`), 13px UI base, `ui-monospace` for cron, prompts, logs, system blue as the only action color.
- Borrow only: Trigger.dev's row anatomy for routines (status, next run, last run on one line; row opens the editor). GitHub's Done semantics (item leaves the inbox, still visible in the run).
- Role rules: blue means "you can act" (primary button, links, focus ring, selected chips, switch on). Green, amber, red, gray mean run state and appear only in state dots and state labels. Nothing else is colored.
- Media: none. The product is text and status; no illustration, the empty state is typographic.
- Reject: card grids, colored left stripes, emoji, indigo, gradient fills, a dark default, badges on everything.
- Token commitments: neutral cool grays, 1px hairlines for grouping, radius 6px on controls and 10px on list containers, no shadows except the sticky save bar, light default with a separate dark scale.

## Tokens

- Type: 12 (meta, caps labels with 0.06em tracking), 13 (UI base), 15 (row titles in inbox, section titles), 22 (page summary line). Weights 400, 500, 600. Tabular numerals for times and durations.
- Spacing: 4, 8, 12, 16, 24, 32, 48.
- Color (light): bg #f6f6f7, surface #fff, text #1c1c1e, muted #6b6b70, subtle #8e8e93, line #e3e3e6, accent #0a64d8.
- Color (dark): bg #161618, surface #1f1f22, text #f2f2f4, muted #a1a1a6, line #2f2f33, accent #3d8bfd.
- Status: needs you amber, failed red, done green, running gray with a pulse. Each with a tinted bg for the label pill.
- Focus: 2px accent ring with 2px offset, `:focus-visible` only.

## Decision ledger

| Decision | Source | Role kept | Why |
|---|---|---|---|
| Inbox is home, opens with "3 things need you" plus a breakdown | User plan; Linear Priority-first inbox | Summary is text, not a stat tile | Answers "do I need to act" before any scanning |
| Rows grouped as Needs your review, Started in T3, Failed runs (collapsed) | User plan; GitHub reason grouping | Group headers are caps labels, not cards | Kind decides the verb, so grouping by kind groups by action |
| One primary action per row plus Done | GitHub Done; Linear single verbs | Blue only on the primary action | Removes the "which link do I click" problem of the old cards |
| Done per item, run acked when its last item is done | GitHub Done is per notification | Server `doneKeys` | Clearing one PR must not hide the other PR from the same run |
| J/K to move, O to open, D for Done | Linear keyboard triage | Visible focus ring | Triage without the mouse |
| Routines as a table: switch, name, plain schedule, last run, next run, Run now; row opens editor | Trigger.dev schedule rows; Vercel cron list | State color only in the last-run dot | Scheduling questions are answered by columns, not by opening each item |
| Editor sections with a title and one-line explanation on the left, fields right; sticky save bar | Vercel settings pattern (sectioned settings with per-section save footer) adapted to one save bar | Save bar is the only shadowed surface | Long form stays scannable; unsaved state is always visible |
| Schedule builder with "At set times" and "On an interval", day chips, times list, live sentence, 7-day strip, raw cron under Advanced | User plan; craft-details forms | Chips use accent only when selected | Most schedules are weekday times or work-hour intervals; cron stays reachable |
| Plain names for T3 permissions: Ask before changes, Auto-accept edits, Full access | User plan | Segmented control | Users decide risk, not enum strings |
| Model as text input with per-agent suggestions from the T3 manifest | User plan; native datalist | Free text still allowed | New model ids work without a release |
| Light default, dark through prefers-color-scheme | anti-ai-slop #3; color.md | Separate dark neutral scale | Matches the system the menu bar app lives in |
| Relative times ("12 min ago", "in 2 h") updated every 30 s, inbox polled every 15 s and only re-rendered when data changes | User plan; craft-details layout shift | Tabular numerals | No jumping rows while reading |

## Memorable detail

The week strip under the schedule: seven day columns showing the actual next runs, so "every 30 minutes, 8 to 6, weekdays" reads as a shape (busy weekdays, empty weekend) instead of a cron string.
