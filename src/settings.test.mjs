import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const root = mkdtempSync(join(tmpdir(), 'rb-settings-'));
process.env.ROUTINEBAR_HOME = root;
const { settings, saveSettings, validateSettings, DEFAULT_SETTINGS, taskConfig } = await import('./settings.mjs');

test('settings persist editor, CLI choices, model and permission defaults', () => {
  assert.deepEqual(settings(), DEFAULT_SETTINGS);
  const saved = saveSettings({ ...DEFAULT_SETTINGS, editor: 'cursor', defaultAgent: 'codex', codexCommand: '/Applications/My Tools/codex', taskPermissions: 'auto-accept-edits' });
  assert.deepEqual(settings(), saved);
  assert.deepEqual(taskConfig({ useDefaults: true }), { provider: 'codex', model: 'gpt-6.1-sol', runtimeMode: 'auto-accept-edits' });
  const override = { provider: 'claudeAgent', model: 'my-model', runtimeMode: 'approval-required' };
  assert.deepEqual(taskConfig(override), override);
});
test('invalid editor, commands, modes and app paths do not change saved settings', () => {
  const before = settings();
  for (const change of [{ editor: 'unknown' }, { claudeCommand: 'claude --foo' }, { codexCommand: 'codex\nanything' }, { taskPermissions: 'yes' }, { t3AppPath: 'T3.app' }, { other: true }]) assert.throws(() => saveSettings({ ...before, ...change }));
  assert.deepEqual(settings(), before);
  assert.equal(validateSettings({ ...before, t3AppPath: '/Applications/T3.app' }).t3AppPath, '/Applications/T3.app');
});
test.after(() => rmSync(root, { recursive: true, force: true }));
