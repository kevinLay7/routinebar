#!/usr/bin/env node
// Hands a Jira ticket off to a new T3 thread via the local T3 server's RPC socket.
//
// Usage:
//   node t3-handoff.mjs --repo <path> --title <title> --branch <branch> --prompt-file <file> [--base <branch>] [--no-fetch]
//   --no-fetch bases the worktree on the locally cached origin/<base> instead of fetching first.
//   node t3-handoff.mjs --probe            # auth + socket check only, creates nothing
//
// Prints JSON {threadId, projectId, branch} on success; exits non-zero with a message on failure.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SETTINGS_PATH = join(process.env.ROUTINEBAR_HOME || join(homedir(), '.routinebar'), 'settings.json');
const configuredApp = existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')).t3AppPath : '';
const APP = process.env.T3_APP_PATH || configuredApp || ['/Applications/T3.app', '/Applications/T3 Code.app', '/Applications/T3 Code (Beta).app'].find(existsSync);
if (!APP) throw new Error('T3 application not found; set T3_APP_PATH');
const T3_BIN = join(APP, 'Contents/MacOS', APP.split('/').pop().replace(/\.app$/, ''));
const T3_SERVER = join(APP, 'Contents/Resources/app.asar/apps/server/dist/bin.mjs');
const USERDATA = join(homedir(), '.t3/userdata');

const MODEL_SELECTION = {
  instanceId: 'claudeAgent',
  model: 'claude-opus-5-5',
  options: [
    { id: 'effort', value: 'medium' },
    { id: 'fastMode', value: false },
  ],
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

function fail(msg) {
  console.error(`t3-handoff: ${msg}`);
  process.exit(1);
}

function serverOrigin() {
  let rt;
  try {
    rt = JSON.parse(readFileSync(join(USERDATA, 'server-runtime.json'), 'utf8'));
  } catch {
    fail('T3 server runtime file not found — is T3 Code running?');
  }
  try {
    process.kill(rt.pid, 0);
  } catch {
    fail(`T3 server (pid ${rt.pid}) is not running — open T3 and retry`);
  }
  return `http://127.0.0.1:${rt.port}`;
}

// Short-lived token from T3's own CLI so nothing long-lived is stored on disk.
function issueToken() {
  try {
    return execFileSync(
      T3_BIN,
      [T3_SERVER, 'auth', 'session', 'issue', '--base-dir', join(homedir(), '.t3'), '--token-only', '--ttl', '15m', '--label', 'jira-autopilot', '--log-level', 'none'],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch (e) {
    fail(`could not issue T3 session token: ${e.stderr || e.message}`);
  }
}

async function openSocket(origin, token) {
  const res = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) fail(`websocket ticket request failed: HTTP ${res.status} ${await res.text()}`);
  const { ticket } = await res.json();
  const url = new URL('/ws', origin.replace(/^http/, 'ws'));
  url.searchParams.set('wsTicket', ticket);
  url.searchParams.set('orchestrationProtocol', '2');
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket connection failed')), { once: true });
  });
  return ws;
}

function rpcClient(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msgs;
    try { msgs = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
    for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
      if (m._tag === 'Ping') { ws.send(JSON.stringify({ _tag: 'Pong' })); continue; }
      const p = pending.get(String(m.requestId));
      if (!p) continue;
      if (m._tag === 'Exit') { pending.delete(String(m.requestId)); p.resolve(m.exit); }
      else if (m._tag === 'Chunk') { p.chunks.push(...(m.values ?? [])); }
      else if (m._tag === 'Defect') { pending.delete(String(m.requestId)); p.reject(new Error(JSON.stringify(m.defect))); }
    }
  });
  return (tag, payload, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = String(nextId++);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${tag} timed out`)); }, timeoutMs);
    pending.set(id, {
      chunks: [],
      resolve: (exit) => { clearTimeout(timer); resolve(exit); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }));
  });
}

function projectIdFor(repo) {
  const sql = `select project_id from projection_projects where deleted_at is null and workspace_root = '${repo.replace(/'/g, "''")}' limit 1;`;
  const id = execFileSync('sqlite3', ['-readonly', join(USERDATA, 'state.sqlite'), sql], { encoding: 'utf8' }).trim();
  return id || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const origin = serverOrigin();
  const ws = await openSocket(origin, issueToken());
  const call = rpcClient(ws);

  try {
    if (args.probe) {
      const exit = await call('orchestration.searchThreads', { query: 'jira-autopilot-probe' });
      console.log(JSON.stringify({ ok: exit?._tag === 'Success', exit }, null, 2));
      return;
    }

    for (const k of ['repo', 'title', 'branch', 'prompt-file']) if (!args[k]) fail(`missing --${k}`);
    const repo = args.repo.replace(/\/$/, '');
    const text = readFileSync(args['prompt-file'], 'utf8');
    const now = new Date().toISOString();

    let projectId = projectIdFor(repo);
    if (!projectId) {
      projectId = randomUUID();
      const exit = await call('orchestration.dispatchCommand', {
        type: 'project.create',
        createdBy: 'agent',
        creationSource: 'mcp',
        commandId: randomUUID(),
        projectId,
        title: repo.split('/').pop(),
        workspaceRoot: repo,
        createdAt: now,
      });
      if (exit?._tag !== 'Success') fail(`project.create failed: ${JSON.stringify(exit)}`);
    }

    const threadId = randomUUID();
    const exit = await call('orchestration.launchThread', {
      commandId: randomUUID(),
      creationSource: 'mcp',
      threadId,
      projectId,
      title: args.title,
      modelSelection: MODEL_SELECTION,
      runtimeMode: 'full-access',
      interactionMode: 'default',
      workspaceStrategy: {
        type: 'worktree',
        baseRef: args['no-fetch'] ? `origin/${args.base || 'master'}` : (args.base || 'master'),
        branch: args.branch,
        startFromOrigin: !args['no-fetch'],
      },
      initialMessage: { text, attachments: [] },
    }, 120000);
    if (exit?._tag !== 'Success') fail(`thread launch failed: ${JSON.stringify(exit)}; inspect thread ${threadId} before retrying`);
    console.log(JSON.stringify({ threadId, projectId, branch: args.branch }));
  } finally {
    ws.close();
  }
}

main().catch((e) => fail(e.message));
