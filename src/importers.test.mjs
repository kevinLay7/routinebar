import { test } from "node:test";
import assert from "node:assert/strict";
import { rruleToCron, utcCronToLocal, parseCodexToml } from "./importers.mjs";

test("rrule to cron", () => {
  assert.equal(rruleToCron("RRULE:FREQ=MINUTELY;INTERVAL=5"), "*/5 * * * *");
  assert.equal(rruleToCron("RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=30"), "30 9 * * *");
  assert.equal(rruleToCron("RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=8;BYMINUTE=0"), "0 8 * * 1,3,5");
  assert.equal(rruleToCron("FREQ=HOURLY;INTERVAL=2;BYDAY=MO,TU,WE,TH,FR"), "0 */2 * * 1-5");
  assert.equal(rruleToCron("RRULE:FREQ=MONTHLY;BYMONTHDAY=1"), null);
  assert.equal(rruleToCron("RRULE:FREQ=MINUTELY;INTERVAL=7"), null);
});

test("UTC cron to local with an injected offset", () => {
  assert.equal(utcCronToLocal("0 12 * * *", -240), "0 8 * * *");
  assert.equal(utcCronToLocal("0 2 * * 1-5", -240), "0 22 * * 0-4");
  assert.equal(utcCronToLocal("30 2,14 * * 1-5", -240), "30 22 * * 0-4; 30 10 * * 1-5");
  assert.equal(utcCronToLocal("0 23 * * 5", 120), "0 1 * * 6");
  assert.equal(utcCronToLocal("0 2 1 * *", -240), null);
  assert.equal(utcCronToLocal("0 14 1 * *", -240), "0 10 1 * *");
  assert.equal(utcCronToLocal("*/15 * * * *", -240), null);
  assert.equal(utcCronToLocal("0 12 * * *", 330), null);
});

test("codex automation toml parse", () => {
  const text = `version = 1
id = "finish-release"
kind = "heartbeat"
name = "Finish release"
prompt = "Line one.\\n\\nSay \\"done\\"."
status = "PAUSED"
rrule = "RRULE:FREQ=MINUTELY;INTERVAL=5"
created_at = 1788988045096

[extra]
model = "ignored"
`;
  assert.deepEqual(parseCodexToml(text), {
    version: 1,
    id: "finish-release",
    kind: "heartbeat",
    name: "Finish release",
    prompt: 'Line one.\n\nSay "done".',
    status: "PAUSED",
    rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
    created_at: 1788988045096,
  });
});
