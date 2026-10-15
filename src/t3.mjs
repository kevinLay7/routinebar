import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const USERDATA = join(homedir(), ".t3/userdata");
const APP = "/Applications/T3 Code (Alpha).app";

export class T3Down extends Error {}

let token = null;
async function getToken(fresh) {
  if (!fresh && token && Date.now() - token.at < 50 * 60e3) return token.value;
  const { stdout } = await promisify(execFile)(
    `${APP}/Contents/MacOS/T3 Code (Alpha)`,
    [`${APP}/Contents/Resources/app.asar/apps/server/dist/bin.mjs`, "auth", "session", "issue", "--token-only", "--ttl", "1h", "--label", "routinebar"],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
  );
  token = { value: stdout.trim(), at: Date.now() };
  return token.value;
}

function origin() {
  try {
    return JSON.parse(readFileSync(join(USERDATA, "server-runtime.json"), "utf8")).origin;
  } catch {
    throw new T3Down("no server-runtime.json");
  }
}

async function api(path, body, retried = false) {
  const base = origin();
  let res;
  try {
    res = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${await getToken(retried)}`, "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
  } catch (e) {
    if (e.cause?.code === "ECONNREFUSED") throw new T3Down("connection refused");
    throw e;
  }
  // T3 restarts invalidate issued sessions, so a 401 gets one retry with a fresh token.
  if (res.status === 401 && !retried) return api(path, body, true);
  if (!res.ok) throw new Error(`T3 ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

const dispatch = (command) => api("/api/orchestration/dispatch", { commandId: randomUUID(), createdAt: new Date().toISOString(), ...command });

export async function createThread({ cwd, title, prompt, t3 }) {
  const modelSelection = { instanceId: t3.provider, model: t3.model };
  const mode = { runtimeMode: t3.runtimeMode, interactionMode: "default" };
  const shell = await api("/api/orchestration/shell");
  let projectId = shell.projects.find((p) => p.workspaceRoot === cwd && !p.deletedAt)?.id;
  if (!projectId) {
    projectId = randomUUID();
    await dispatch({ type: "project.create", projectId, title: cwd.split("/").pop() || "project", workspaceRoot: cwd, defaultModelSelection: modelSelection });
  }
  const threadId = randomUUID();
  // The HTTP dispatch route ignores bootstrap.createThread, so create and first turn are two commands.
  await dispatch({ type: "thread.create", threadId, projectId, title, modelSelection, ...mode, branch: null, worktreePath: null });
  await dispatch({
    type: "thread.turn.start",
    threadId,
    message: { messageId: randomUUID(), role: "user", text: prompt, attachments: [] },
    modelSelection,
    ...mode,
  });
  const envId = readFileSync(join(USERDATA, "environment-id"), "utf8").trim();
  return { threadId, url: `${origin()}/${envId}/${threadId}` };
}
