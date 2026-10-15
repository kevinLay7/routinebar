import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCron, matches, nextRuns, describe } from "./cron.mjs";

const pad = (n) => String(n).padStart(2, "0");
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const next = (expr, from, n) => nextRuns(parseCron(expr), from, n).map(fmt);

test("weekday business-hours step rolls over the weekend", () => {
  assert.deepEqual(next("*/15 9-17 * * 1-5", new Date(2026, 9, 16, 17, 50), 5), [
    "2026-10-19 09:00",
    "2026-10-19 09:15",
    "2026-10-19 09:30",
    "2026-10-19 09:45",
    "2026-10-19 10:00",
  ]);
});

test("next run is strictly after from", () => {
  assert.deepEqual(next("0 9 * * *", new Date(2026, 9, 16, 9, 0), 1), ["2026-10-17 09:00"]);
});

test("describe", () => {
  assert.equal(describe(parseCron("0 9 * * 1-5")), "At 09:00 on weekdays");
  assert.equal(describe(parseCron("*/15 9-17 * * 1-5")), "Every 15 minutes, 09:00 to 17:59 on weekdays");
  assert.equal(describe(parseCron("30 * * * *")), "Every hour at :30");
  assert.equal(describe(parseCron("0 9,13 * * 1-5")), "At 09:00, 13:00 on weekdays");
  assert.equal(describe(parseCron("15 8 * * 1,3,5")), "At 08:15 on Mon, Wed, Fri");
  assert.equal(describe(parseCron("0 0 1 * *")), "At 00:00 on day 1 of the month");
});

test("dom and dow restricted together use OR", () => {
  assert.deepEqual(next("0 0 10 * 5", new Date(2026, 10, 1), 3), ["2026-11-06 00:00", "2026-11-10 00:00", "2026-11-13 00:00"]);
});

test("star dom with restricted dow uses dow only", () => {
  assert.deepEqual(next("0 0 * * 5", new Date(2026, 10, 1), 2), ["2026-11-06 00:00", "2026-11-13 00:00"]);
  assert.deepEqual(next("0 0 10 * *", new Date(2026, 10, 1), 2), ["2026-11-10 00:00", "2026-12-10 00:00"]);
});

test("dow 7 and 0 are both Sunday", () => {
  assert.deepEqual(next("0 12 * * 7", new Date(2026, 10, 1), 1), ["2026-11-01 12:00"]);
  assert.equal(matches(parseCron("0 12 * * 0"), new Date(2026, 10, 1, 12, 0)), true);
  assert.equal(matches(parseCron("0 12 * * 0"), new Date(2026, 10, 2, 12, 0)), false);
});

test("lists, ranges with steps, and month restriction", () => {
  assert.deepEqual(next("5,10-20/5 3 1 2 *", new Date(2026, 10, 1), 4), [
    "2027-02-01 03:05",
    "2027-02-01 03:10",
    "2027-02-01 03:15",
    "2027-02-01 03:20",
  ]);
});

test("invalid expressions are rejected", () => {
  for (const bad of ["", "* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "5-1 * * * *", "*/0 * * * *", "a * * * *", "* * * * * *"]) {
    assert.throws(() => parseCron(bad), Error, bad);
  }
});

test("several expressions: matches any, next runs merge in order and dedupe", () => {
  const c = parseCron("0 9 * * 1-5; 30 13 * * 1-5; 0 9 * * 1");
  assert.equal(c.length, 3);
  assert.equal(matches(c, new Date(2026, 9, 16, 13, 30)), true);
  assert.equal(matches(c, new Date(2026, 9, 16, 13, 0)), false);
  assert.deepEqual(next("0 9 * * 1-5; 30 13 * * 1-5; 0 9 * * 1", new Date(2026, 9, 16, 10, 0), 4), [
    "2026-10-16 13:30",
    "2026-10-19 09:00",
    "2026-10-19 13:30",
    "2026-10-20 09:00",
  ]);
  assert.equal(describe(c), "At 09:00 on weekdays; At 13:30 on weekdays; At 09:00 on Mon");
});

test("empty segments are ignored and a bad segment rejects the whole schedule", () => {
  assert.equal(describe(parseCron("0 9 * * *;")), "At 09:00");
  assert.throws(() => parseCron("0 9 * * *; 61 * * * *"), /minute out of range/);
  assert.throws(() => parseCron(" ; "), Error);
});
