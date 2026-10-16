import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { resolveT3App, taskConfig } from './settings.mjs';

const USERDATA = join(homedir(), '.t3/userdata');
export class T3Down extends Error {}
let token;
async function getToken(fresh) {
  const app = resolveT3App();
  if (!fresh && token?.app === app && Date.now() - token.at < 50 * 60e3) return token.value;
  const { stdout } = await promisify(execFile)(join(app, 'Contents/MacOS', basename(app, '.app')), [join(app, 'Contents/Resources/app.asar/apps/server/dist/bin.mjs'), 'auth', 'session', 'issue', '--base-dir', join(homedir(), '.t3'), '--token-only', '--ttl', '1h', '--label', 'routinebar'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  token = { value: stdout.trim(), at: Date.now(), app }; return token.value;
}
function origin() {
  try { const rt = JSON.parse(readFileSync(join(USERDATA, 'server-runtime.json'), 'utf8')); return rt.origin || `http://127.0.0.1:${rt.port}`; }
  catch { throw new T3Down('T3 is not running. Open T3 and try again.'); }
}
export function rpcClient(ws) {
  const pending = new Map(); let next = 0;
  ws.addEventListener('message', ev => {
    let messages; try { messages = JSON.parse(String(ev.data)); } catch { return; }
    for (const m of Array.isArray(messages) ? messages : [messages]) {
      if (m._tag === 'Ping') { ws.send(JSON.stringify({ _tag: 'Pong' })); continue; }
      const p = pending.get(String(m.requestId)); if (!p) continue;
      if (m._tag === 'Exit' || m._tag === 'Defect') {
        pending.delete(String(m.requestId)); clearTimeout(p.timer);
        if (m._tag === 'Defect' || m.exit?._tag !== 'Success') p.reject(new Error('T3 request failed: ' + JSON.stringify(m.defect ?? m.exit)));
        else p.resolve(m.exit.value);
      }
    }
  });
  return (tag, payload) => new Promise((resolve, reject) => {
    const id = String(++next);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('T3 request timed out; check T3 before retrying.')); }, 120e3);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
  });
}
async function connect() {
  const base = origin();
  let res;
  try {
    for (const fresh of [false, true]) {
      res = await fetch(base + '/api/auth/websocket-ticket', { method: 'POST', headers: { authorization: `Bearer ${await getToken(fresh)}` } });
      if (res.status !== 401) break;
    }
  } catch (e) { if (e.cause?.code === 'ECONNREFUSED') throw new T3Down('T3 is not running'); throw e; }
  if (!res.ok) throw new Error(`T3 connection failed: HTTP ${res.status}`);
  const { ticket } = await res.json(); const url = new URL('/ws', base.replace(/^http/, 'ws'));
  url.searchParams.set('wsTicket', ticket); url.searchParams.set('orchestrationProtocol', '2');
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new T3Down('T3 connection timed out')); }, 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new T3Down('Could not connect to T3')); }, { once: true });
  });
  return ws;
}
export async function checkT3() {
  const ws = await connect();
  try { await rpcClient(ws)('orchestration.searchThreads', { query: 'routinebar-connection-check' }); return { ok: true, appPath: resolveT3App() }; }
  finally { ws.close(); }
}
export async function createThread({ cwd, title, prompt, t3 }) {
  const config = taskConfig(t3); const modelSelection = { instanceId: config.provider, model: config.model };
  const ws = await connect(); const call = rpcClient(ws);
  try {
    const { stdout } = await promisify(execFile)('sqlite3', ['-readonly', join(USERDATA, 'state.sqlite'), `select project_id from projection_projects where deleted_at is null and workspace_root = '${cwd.replace(/'/g, "''")}' limit 1;`]);
    let projectId = stdout.trim();
    if (!projectId) {
      projectId = randomUUID();
      await call('orchestration.dispatchCommand', { type: 'project.create', createdBy: 'agent', creationSource: 'mcp', commandId: randomUUID(), projectId, title: basename(cwd), workspaceRoot: cwd, defaultModelSelection: modelSelection, createdAt: new Date().toISOString() });
    }
    const threadId = randomUUID();
    await call('orchestration.launchThread', { commandId: randomUUID(), creationSource: 'mcp', threadId, projectId, title, modelSelection, runtimeMode: config.runtimeMode, interactionMode: 'default', workspaceStrategy: { type: 'root' }, initialMessage: { text: prompt, attachments: [] } });
    return { threadId, url: `t3-thread://v1/${threadId}`, editor: 't3' };
  } finally { ws.close(); }
}
