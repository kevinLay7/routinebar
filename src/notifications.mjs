import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { settings } from './settings.mjs';
import { canonicalKey } from './inbox.mjs';

export async function notify(title, body, send = promisify(execFile)) {
  await send('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body], { timeout: 10000 });
}
const actionable = item => item.kind === 'needs_you' && item.attention !== 'waiting';
const identity = item => `${canonicalKey(item)}:${item.attention ?? 'action'}`;
export function notificationFor(run, previous, name, prefs = settings(), dismissed = () => false) {
  if (!prefs.desktopNotifications) return null;
  const tasks = run.threads.filter(t => !t.reused).length;
  const known = new Set((previous?.items ?? []).filter(actionable).map(identity));
  const fresh = run.items.filter(i => actionable(i) && !dismissed(i) && !known.has(identity(i))).length;
  const failed = run.state === 'failed' && !(previous?.state === 'failed' && previous.error === run.error);
  const blockedTaskKeys = r => new Set((r?.items ?? []).filter(i => i.kind === 'code' && !r.threads?.some(t => t.key === i.key)).map(identity));
  const previousBlocked = blockedTaskKeys(previous);
  const blocked = [...blockedTaskKeys(run)].filter(k => !previousBlocked.has(k)).length;
  const itemless = run.state === 'needs_input' && !run.items.length && (previous?.state !== 'needs_input' || previous?.summary !== run.summary);
  if (prefs.notificationMode !== 'all' && !failed && !fresh && !tasks && !itemless && !blocked) return null;
  const parts = [run.state === 'failed' && 'Check failed', fresh && `${fresh} new ${fresh === 1 ? 'item needs' : 'items need'} you`, blocked && `${blocked} coding ${blocked === 1 ? 'task could not start' : 'tasks could not start'}`, tasks && `${tasks} coding ${tasks === 1 ? 'session started' : 'sessions started'}`].filter(Boolean);
  return { title: `RoutineBar: ${name}`, body: (parts.join('. ') || run.summary || 'Check complete').slice(0, 300) };
}
