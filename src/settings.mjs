import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { HOME } from './store.mjs';

export const EDITORS = { t3: 'T3', vscode: 'VS Code', cursor: 'Cursor', terminal: 'Terminal' };
export const DEFAULT_SETTINGS = {
  editor: 't3', t3AppPath: '', defaultAgent: 'claude',
  claudeCommand: 'claude', codexCommand: 'codex',
  claudeModel: 'claude-opus-5-5', codexModel: 'gpt-6.1-sol',
  taskPermissions: 'approval-required', scheduledPermissions: 'full-access',
  desktopNotifications: true, notificationMode: 'attention',
};
const file = join(HOME, 'settings.json');
export const settings = () => ({ ...DEFAULT_SETTINGS, ...(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}) });
export function validateSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Settings must be an object');
  if (Object.keys(raw).some(k => !Object.hasOwn(DEFAULT_SETTINGS, k))) throw new Error('Unknown setting');
  const s = { ...DEFAULT_SETTINGS, ...raw };
  const oneOf = (k, values) => { if (!values.includes(s[k])) throw new Error(`${k} must be one of ${values.join(', ')}`); };
  oneOf('editor', Object.keys(EDITORS)); oneOf('defaultAgent', ['claude', 'codex']);
  oneOf('taskPermissions', ['approval-required', 'auto-accept-edits', 'full-access']);
  oneOf('scheduledPermissions', ['read-only', 'full-access']);
  oneOf('notificationMode', ['attention', 'all']);
  if (typeof s.desktopNotifications !== 'boolean') throw new Error('desktopNotifications must be a boolean');
  for (const k of ['claudeCommand', 'codexCommand', 'claudeModel', 'codexModel', 't3AppPath']) {
    if (typeof s[k] !== 'string' || /[\0\r\n]/.test(s[k])) throw new Error(`${k} must be a single line of text`);
    s[k] = s[k].trim();
    if (k !== 't3AppPath' && !s[k]) throw new Error(`${k} is required`);
  }
  for (const k of ['claudeCommand', 'codexCommand']) if (s[k].startsWith('-') || (!isAbsolute(s[k]) && !/^[\w.-]+$/.test(s[k]))) throw new Error(`${k} must be an executable name or absolute path, without arguments`);
  if (s.t3AppPath && (!isAbsolute(s.t3AppPath) || !s.t3AppPath.endsWith('.app'))) throw new Error('T3 app path must be an absolute .app path');
  return s;
}
export function saveSettings(raw) {
  const s = validateSettings(raw);
  writeFileSync(file + '.tmp', JSON.stringify(s, null, 2), { mode: 0o600 }); renameSync(file + '.tmp', file); return s;
}
export function taskConfig(t3, s = settings()) {
  return t3 && !t3.useDefaults ? t3 : { provider: s.defaultAgent === 'claude' ? 'claudeAgent' : 'codex', model: s[`${s.defaultAgent}Model`], runtimeMode: s.taskPermissions };
}
export function resolveT3App(s = settings()) {
  if (s.t3AppPath) {
    if (!existsSync(s.t3AppPath)) throw new Error('The configured T3 app does not exist. Update its path in Settings.');
    return s.t3AppPath;
  }
  const app = ['/Applications/T3.app', '/Applications/T3 Code.app', '/Applications/T3 Code (Beta).app'].find(existsSync);
  if (!app) throw new Error('T3 was not found. Set its application path in Settings.');
  return app;
}
