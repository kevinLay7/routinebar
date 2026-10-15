const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dom", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dow", min: 0, max: 7 },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parseField(text, { name, min, max }) {
  const values = new Set();
  for (const part of text.split(",")) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`bad ${name} field "${text}"`);
    const lo = m[1] === "*" ? min : Number(m[2]);
    const hi = m[1] === "*" ? max : m[3] !== undefined ? Number(m[3]) : m[4] ? max : lo;
    const step = m[4] ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new Error(`${name} out of range "${part}"`);
    for (let v = lo; v <= hi; v += step) values.add(name === "dow" && v === 7 ? 0 : v);
  }
  return values;
}

function parseOne(expr) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("expected 5 fields: minute hour day-of-month month day-of-week");
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  return { minute, hour, dom, month, dow, domStar: parts[2].startsWith("*"), dowStar: parts[4].startsWith("*") };
}

function dayMatches(c, d) {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  if (c.domStar || c.dowStar) return dom && dow;
  return dom || dow;
}

// A schedule is one or more 5-field expressions joined by ";" because times with
// different minutes (9:00 and 13:30) cannot share a single cron line.
export function parseCron(expr) {
  const list = String(expr).split(";").filter((e) => e.trim());
  if (!list.length) throw new Error("expected 5 fields: minute hour day-of-month month day-of-week");
  return list.map(parseOne);
}

const matchesOne = (c, d) =>
  c.minute.has(d.getMinutes()) && c.hour.has(d.getHours()) && c.month.has(d.getMonth() + 1) && dayMatches(c, d);

export const matches = (cs, d) => cs.some((c) => matchesOne(c, d));

export function nextRuns(cs, from, n) {
  const all = cs.flatMap((c) => nextRunsOne(c, from, n)).sort((a, b) => a - b);
  return all.filter((d, i) => i === 0 || +d !== +all[i - 1]).slice(0, n);
}

function nextRunsOne(c, from, n) {
  const out = [];
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 5 * 366 * 864e5;
  while (out.length < n && d.getTime() < limit) {
    if (!c.month.has(d.getMonth() + 1)) d.setMonth(d.getMonth() + 1, 1), d.setHours(0, 0, 0, 0);
    else if (!dayMatches(c, d)) d.setDate(d.getDate() + 1), d.setHours(0, 0, 0, 0);
    else if (!c.hour.has(d.getHours())) d.setHours(d.getHours() + 1, 0, 0, 0);
    else if (!c.minute.has(d.getMinutes())) d.setMinutes(d.getMinutes() + 1, 0, 0);
    else out.push(new Date(d)), d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}

const sorted = (set) => [...set].sort((a, b) => a - b);
const pad = (n) => String(n).padStart(2, "0");
const isRange = (vals) => vals.length > 1 && vals.every((v, i) => i === 0 || v === vals[i - 1] + 1);

function stepOf(vals, size) {
  const step = vals[1] - vals[0];
  return vals[0] === 0 && vals.length === size / step && vals.every((v, i) => v === i * step) ? step : 0;
}

function describeTime(c) {
  const mins = sorted(c.minute);
  const hours = sorted(c.hour);
  const allHours = hours.length === 24;
  const hourSpan = allHours ? "" : isRange(hours) ? `, ${pad(hours[0])}:00 to ${pad(hours.at(-1))}:59` : `, during hours ${hours.join(", ")}`;
  if (mins.length === 60) return `Every minute${hourSpan}`;
  const step = mins.length > 1 ? stepOf(mins, 60) : 0;
  if (step) return `Every ${step} minutes${hourSpan}`;
  if (allHours) return `Every hour at ${mins.map((m) => ":" + pad(m)).join(", ")}`;
  if (hours.length * mins.length <= 6) return "At " + hours.flatMap((h) => mins.map((m) => `${pad(h)}:${pad(m)}`)).join(", ");
  return `At minutes ${mins.join(", ")}${hourSpan}`;
}

function describeDays(c) {
  const dows = sorted(c.dow);
  const doms = sorted(c.dom);
  const dowText = dows.join() === "1,2,3,4,5" ? "weekdays" : dows.join() === "0,6" ? "weekends" : dows.map((d) => DAYS[d]).join(", ");
  const domText = `day ${doms.join(", ")} of the month`;
  let text = "";
  if (!c.domStar && !c.dowStar) text = ` on ${domText} or ${dowText}`;
  else if (!c.domStar) text = ` on ${domText}`;
  else if (!c.dowStar) text = ` on ${dowText}`;
  if (c.month.size < 12) text += ` in ${sorted(c.month).map((m) => MONTHS[m - 1]).join(", ")}`;
  return text;
}

export const describe = (cs) => cs.map((c) => describeTime(c) + describeDays(c)).join("; ");
