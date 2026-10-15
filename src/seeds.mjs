import { homedir } from "node:os";
import { join } from "node:path";

const base = {
  enabled: false,
  agent: "claude",
  model: "opus",
  cwd: join(homedir(), "Projects"),
  t3: { provider: "claudeAgent", model: "claude-opus-5-5", runtimeMode: "approval-required" },
};

export const seeds = [
  {
    ...base,
    id: "review-requested-prs",
    name: "Review requested PRs",
    schedule: "0 9,13 * * 1-5",
    prompt: `Find open pull requests where my review is requested: run \`gh search prs --review-requested=@me --state=open --json repository,number,title,url\`.
For each PR, read the diff (\`gh pr diff <n> -R <owner/repo>\`) and review it for correctness bugs and risky changes.
Do NOT post reviews, comments, or approvals anywhere.
Report one item per PR: key "pr:<owner/repo>#<n>", kind "needs_you", title "<repo>#<n> <title>", url, and note with a one-line verdict (approve, request changes, or needs discussion) plus the single most important finding.
Use status "done" if there are no PRs, otherwise "needs_input".`,
  },
  {
    ...base,
    id: "my-prs-followup",
    name: "Follow up on my PRs",
    schedule: "*/30 8-18 * * 1-5",
    prompt: `List my open pull requests: \`gh search prs --author=@me --state=open --json repository,number,title,url\`.
For each, check review comments since the last push and check status (\`gh pr view <n> -R <owner/repo> --json reviews,comments,statusCheckRollup,reviewDecision,headRefName\`).
- New unaddressed review comments or failing checks: emit a "code" item with key "pr:<owner/repo>#<n>", title, url, repoPath set to a local clone if one exists under ~/Projects (match the git remote), and threadPrompt telling the thread to check out the PR branch, address the review comments or fix the failing checks, run the tests, and push.
- Approved with all checks green: emit a "needs_you" item with the same key format, note "ready to merge".
Never merge anything. Skip PRs with nothing to do.
Use status "done" when there are no items.`,
  },
  {
    ...base,
    id: "jira-in-progress",
    name: "Jira in progress",
    schedule: "*/30 8-18 * * 1-5",
    prompt: `Using your Jira tools, list tickets assigned to me with status "In Progress".
For each ticket emit a "code" item with key "jira:<KEY>", title "<KEY> <summary>", url to the ticket, repoPath set to the local clone under ~/Projects that the ticket most likely belongs to (omit if unsure), and threadPrompt telling the thread to read the ticket, create a new branch named after the key, implement it, and run the tests.
If you have no Jira tool available, use status "needs_input" with summary "No Jira tool available to this agent" and no items.`,
  },
];
