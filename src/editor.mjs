import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { HOME } from './store.mjs';
import { settings, taskConfig, EDITORS } from './settings.mjs';
import { createThread } from './t3.mjs';

const exec = promisify(execFile);
const dir = join(HOME, 'sessions');
const quote = s => `'${String(s).replace(/'/g, "'\\''")}'`;
export function interactiveCommand(config, s) {
  if (config.provider === 'claudeAgent') return [s.claudeCommand, '--model', config.model, ...(config.runtimeMode === 'full-access' ? ['--dangerously-skip-permissions'] : ['--permission-mode', config.runtimeMode === 'auto-accept-edits' ? 'acceptEdits' : 'manual'])];
  return [s.codexCommand, '-m', config.model, ...(config.runtimeMode === 'full-access' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', config.runtimeMode === 'approval-required' ? 'read-only' : 'workspace-write', '--ask-for-approval', 'on-request'])];
}
export function sessionScript(cwd, command, promptPath) {
  return `#!/bin/zsh -l\ncd -- ${quote(cwd)} || exit 1\n${command.map(quote).join(' ')} -- "$(cat -- ${quote(promptPath)})"\n`;
}
export function session(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid session ID');
  const file = join(dir, id + '.json');
  if (!existsSync(file)) throw new Error('Session not found');
  return JSON.parse(readFileSync(file, 'utf8'));
}
export async function openSession(id, run = exec) {
  const task = session(id);
  if (task.editor !== 'terminal') await run('/usr/bin/open', ['-a', task.editor === 'vscode' ? 'Visual Studio Code' : 'Cursor', task.cwd]);
  await run('/usr/bin/open', ['-a', 'Terminal', join(dir, id + '.command')]);
  return { ok: true };
}
export async function launchTask({ cwd, title, prompt, t3 }, deps = {}) {
  const s = deps.settings ?? settings();
  if (s.editor === 't3') return (deps.createThread ?? createThread)({ cwd, title, prompt, t3: taskConfig(t3, s) });
  if (!isAbsolute(cwd) || !existsSync(cwd)) throw new Error('Task directory does not exist');
  const id = randomUUID();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const task = { id, cwd, title, prompt, editor: s.editor, config: taskConfig(t3, s), createdAt: new Date().toISOString() };
  const promptPath = join(dir, id + '.txt');
  writeFileSync(promptPath, prompt, { mode: 0o600 });
  writeFileSync(join(dir, id + '.json'), JSON.stringify(task, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, id + '.command'), sessionScript(cwd, interactiveCommand(task.config, s), promptPath), { mode: 0o700 });
  await openSession(id, deps.exec ?? exec);
  return { threadId: id, url: `#sessions/${id}`, editor: s.editor };
}
export const editorName = () => EDITORS[settings().editor];
