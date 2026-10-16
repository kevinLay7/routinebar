import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ACCOUNT = '62f4fec150bd9783f62da8af';
export const JQL = `assignee = "${ACCOUNT}" AND sprint in openSprints() AND status in ("In Progress", "3. In Progress") ORDER BY rank ASC`;

export function validatePoll(identity, result) {
  if (identity.error || identity.errors || identity.data?.accountId !== ACCOUNT) throw new Error('Jira authentication failed or connected account is not Kevin Lay; no reconciliation allowed');
  if (result.error || result.errors || !Array.isArray(result.data?.issues)) throw new Error('Jira query failed or returned an invalid response; no reconciliation allowed');
  const issues = result.data.issues;
  if (issues.length >= 100) throw new Error('Jira poll may be truncated; paginate before reconciling or claiming');
  for (const issue of issues) {
    if (!issue.key || issue.assignee?.accountId !== ACCOUNT || !['In Progress', '3. In Progress'].includes(issue.status?.name)) throw new Error('Jira returned a ticket outside the requested assignee/status; no reconciliation allowed');
  }
  return { authenticated: true, accountId: ACCOUNT, jql: JQL, count: issues.length, issues };
}

export function poll() {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-poll-'));
  const twg = join(homedir(), '.local/bin/twg');
  const read = (args, name) => {
    const file = join(dir, name + '.json');
    execFileSync(twg, [...args, '-o', 'json', '--output-file', file], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 });
    return JSON.parse(readFileSync(file, 'utf8'));
  };
  try {
    const identity = read(['whoami'], 'identity');
    validatePoll(identity, { data: { issues: [] } });
    return validatePoll(identity, read(['jira', 'workitem', 'query', '--jql', JQL, '--site', 'tommycarwash.atlassian.net', '--fields', 'summary,status,assignee,issuetype,labels,components,project', '--limit', '100'], 'issues'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(poll())); }
  catch (error) { console.error('Autopilot poll blocked: ' + error.message); process.exitCode = 1; }
}
