import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = mkdtempSync(join(tmpdir(), 'rb-editor-'));
process.env.ROUTINEBAR_HOME = root;
const { launchTask, interactiveCommand, session, openSession, sessionScript } = await import('./editor.mjs');
const { DEFAULT_SETTINGS } = await import('./settings.mjs');
const { scheduledArgs } = await import('./runner.mjs');

test('VS Code, Cursor and Terminal launch the selected agent with a persistent task prompt', async () => {
  for (const editor of ['vscode', 'cursor', 'terminal']) {
    const calls = [];
    const launched = await launchTask({ cwd: root, title: 'Fix it', prompt: 'Task with $HOME and `commands`', t3: { useDefaults: true } }, { settings: { ...DEFAULT_SETTINGS, editor, defaultAgent: 'codex' }, exec: async (...args) => calls.push(args) });
    assert.equal(launched.editor, editor);
    const saved = session(launched.threadId);
    assert.equal(saved.config.provider, 'codex');
    assert.equal(saved.prompt, 'Task with $HOME and `commands`');
    assert.equal(launched.url, '#sessions/' + launched.threadId);
    assert.equal(calls.at(-1)[0], '/usr/bin/open');
    assert.deepEqual(calls.at(-1)[1].slice(0, 2), ['-a', 'Terminal']);
    if (editor !== 'terminal') assert.deepEqual(calls[0][1], ['-a', editor === 'vscode' ? 'Visual Studio Code' : 'Cursor', root]);
    const more = []; await openSession(launched.threadId, async (...args) => more.push(args));
    assert.equal(more.length, calls.length);
  }
});
test('T3 receives the resolved settings or an existing routine override', async () => {
  const calls = [];
  const deps = { settings: { ...DEFAULT_SETTINGS, defaultAgent: 'codex' }, createThread: async v => { calls.push(v); return { threadId: 'test' }; } };
  await launchTask({ cwd: root, title: 'Task', prompt: 'Hello', t3: { useDefaults: true } }, deps);
  assert.equal(calls[0].t3.provider, 'codex');
  const override = { provider: 'claudeAgent', model: 'custom', runtimeMode: 'full-access' };
  await launchTask({ cwd: root, title: 'Task', prompt: 'Hello', t3: override }, deps);
  assert.deepEqual(calls[1].t3, override);
});
test('permission choices reach both interactive and unattended commands', () => {
  assert.deepEqual(interactiveCommand({provider:'claudeAgent',model:'test',runtimeMode:'auto-accept-edits'},DEFAULT_SETTINGS), ['claude','--model','test','--permission-mode','acceptEdits']);
  assert.ok(interactiveCommand({provider:'codex',model:'test',runtimeMode:'approval-required'},DEFAULT_SETTINGS).includes('read-only'));
  assert.ok(interactiveCommand({provider:'codex',model:'test',runtimeMode:'auto-accept-edits'},DEFAULT_SETTINGS).includes('workspace-write'));
  for (const agent of ['claude', 'codex']) {
    assert.ok(scheduledArgs(agent, DEFAULT_SETTINGS)[0].includes('dangerously'));
    assert.ok(!scheduledArgs(agent, { scheduledPermissions:'read-only' }).join(' ').includes('dangerously'));
  }
});
test('Terminal script passes prompt and paths literally without executing their contents', () => {
  const tool = join(root, "fake 'tool"); const output = join(root,'args.json'); const promptPath = join(root, "prompt 'file");
  writeFileSync(tool, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(2)));`, {mode:0o700});
  const prompt = '$(touch /tmp/routinebar-should-not-exist) `whoami` "quote"';
  writeFileSync(promptPath, prompt);
  const script = join(root,'test.command');writeFileSync(script,sessionScript(root,[tool,'--model','value with spaces'],promptPath));
  execFileSync('/bin/zsh',['-f',script]);
  assert.deepEqual(JSON.parse(readFileSync(output)), ['--model','value with spaces','--',prompt]);
  assert.throws(() => session('../secret'));
});
test.after(() => rmSync(root, {recursive:true,force:true}));
