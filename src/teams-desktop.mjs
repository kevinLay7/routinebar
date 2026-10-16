import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME } from "./store.mjs";

export function readMacTeams(config, previous = []) {
  const python = join(HOME, "tools", "teams-cache", "bin", "python");
  if (!existsSync(python)) throw new Error("Mac Teams reader is not installed. Run bash bin/setup-teams-cache.sh on this Mac.");
  return new Promise((resolve, reject) => {
    const child = execFile(python, [fileURLToPath(new URL("../bin/teams-cache.py", import.meta.url))], { timeout: 120000, maxBuffer: 3e6 }, (error, stdout, stderr) => {
      try {
        if (error) {
          let message = "Could not read the Mac Teams cache. Open Teams on this Mac and retry.";
          try { message = JSON.parse(stderr).error || message; } catch {}
          throw new Error(message);
        }
        const data = JSON.parse(stdout);
        if (data?.source !== "mac-teams-cache" || data.chatId !== config.chatId || !Array.isArray(data.messages)) throw new Error("Invalid Mac Teams snapshot");
        resolve(data);
      } catch (e) { reject(e); }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ config, previousKeys: previous.map(i => i.key) }));
  });
}
