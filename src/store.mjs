import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.ROUTINEBAR_HOME || join(homedir(), ".routinebar");
const RUNS = join(HOME, "runs");
const LOGS = join(HOME, "logs");
mkdirSync(RUNS, { recursive: true });
mkdirSync(LOGS, { recursive: true });

const read = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);
function write(file, value) {
  writeFileSync(file + ".tmp", JSON.stringify(value, null, 2));
  renameSync(file + ".tmp", file);
}

const ROUTINES = join(HOME, "routines.json");
const SEEN = join(HOME, "seen.json");
const DISMISSED = join(HOME, "dismissed.json");

export const hasRoutines = () => existsSync(ROUTINES);
export const routines = () => read(ROUTINES, []);
export const routine = (id) => routines().find((r) => r.id === id);
export const saveRoutines = (list) => write(ROUTINES, list);
export function upsertRoutine(r) {
  const list = routines().filter((x) => x.id !== r.id);
  saveRoutines([...list, r]);
}
export const deleteRoutine = (id) => saveRoutines(routines().filter((r) => r.id !== id));

export const seen = () => read(SEEN, {});
export function markSeen(id, record) {
  write(SEEN, { ...seen(), [id]: record });
}

export const dismissed = () => read(DISMISSED, {});
export const saveDismissed = (map) => write(DISMISSED, map);
export const dismiss = (id, value) => saveDismissed({ ...dismissed(), [id]: value });

export const saveRun = (run) => write(join(RUNS, run.id + ".json"), run);
export const run = (id) => read(join(RUNS, id + ".json"), null);
// ponytail: reads every run file per call; add an index or pruning if runs/ grows past a few thousand.
export const runs = () =>
  readdirSync(RUNS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => read(join(RUNS, f)))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
export const logPath = (id) => join(LOGS, id + ".log");
export const log = (id) => (existsSync(logPath(id)) ? readFileSync(logPath(id), "utf8") : "");
