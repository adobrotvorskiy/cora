// Europe/Moscow time helpers (Intl only, no dependencies) with a simulated clock.
//
// Every "what time is it" question goes through now(). It returns real time
// unless a simulation is active (main.js applies --at / --day before the host starts):
//   setSimulatedStart('09:58')  now() continues from 09:58 today (MSK); time keeps flowing.
//   setSimulatedDay('mon')      shifts the date forward to the next Monday (0-6 days),
//                               so dayMode(), todayAt() and nowMsk() all agree.
// Results never depend on the machine time zone: process TZ is not consulted.

export const TZ = 'Europe/Moscow';
/** Weekday keys, index = JS weekday (0 = Sunday). */
export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_MS = 86_400_000;
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

let offsetMs = 0;
let simAt = null;
let simDay = null;

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** Current instant as a Date, including the simulation offset. */
export function now() {
  return new Date(Date.now() + offsetMs);
}

/** Milliseconds the simulation adds to real time (0 when not simulated). */
export function simOffsetMs() {
  return offsetMs;
}

/** Simulation state for logs and --check: {active, at, day, offset_ms}. */
export function simulation() {
  return { active: simAt !== null || simDay !== null, at: simAt, day: simDay, offset_ms: offsetMs };
}

/**
 * Moscow wall-clock parts of `date`.
 * weekday: 0 = Sunday ... 6 = Saturday; dow: 'sun' ... 'sat'.
 * @returns {{date: Date, year: number, month: number, day: number, hour: number, minute: number,
 *   second: number, ms: number, weekday: number, dow: string, ymd: string, hhmm: string, hms: string}}
 */
export function mskParts(date = now()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError('invalid date');
  const p = {};
  for (const { type, value } of partsFormat.formatToParts(d)) {
    if (type !== 'literal') p[type] = Number(value);
  }
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const hhmm = `${pad(p.hour)}:${pad(p.minute)}`;
  return {
    date: d,
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
    ms: d.getUTCMilliseconds(),
    weekday,
    dow: DAYS[weekday],
    ymd: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`,
    hhmm,
    hms: `${hhmm}:${pad(p.second)}`,
  };
}

/** Moscow wall-clock parts of now(), which may be simulated. */
export function nowMsk() {
  return mskParts(now());
}

/**
 * Format `date` as Moscow wall-clock time.
 * Tokens: YYYY MM DD HH mm ss SSS ddd (Mon..Sun). Default 'HH:mm:ss.SSS' (the log's t_msk).
 */
export function formatMsk(date = now(), pattern = 'HH:mm:ss.SSS') {
  const p = mskParts(date);
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss|SSS|ddd/g, (token) => {
    switch (token) {
      case 'YYYY': return pad(p.year, 4);
      case 'MM': return pad(p.month);
      case 'DD': return pad(p.day);
      case 'HH': return pad(p.hour);
      case 'mm': return pad(p.minute);
      case 'ss': return pad(p.second);
      case 'SSS': return pad(p.ms, 3);
      default: return DOW_LABEL[p.weekday];
    }
  });
}

/** Parse "HH:MM" or "HH:MM:SS"; throws on anything else. */
export function parseHHMM(text) {
  const m = HHMM_RE.exec(String(text).trim());
  if (!m) throw new Error(`invalid time "${text}", expected HH:MM`);
  return { hour: Number(m[1]), minute: Number(m[2]), second: m[3] ? Number(m[3]) : 0 };
}

/** The instant of HH:MM[:SS] Moscow time on the Moscow calendar day of `base` (default now()). */
export function todayAt(hhmm, base = now()) {
  const t = parseHHMM(hhmm);
  const p = mskParts(base);
  return mskWallTime(p.year, p.month, p.day, t.hour, t.minute, t.second);
}

/** 'monday_focus' (Mon) | 'daily_plans' (Tue-Thu) | 'off' (Fri-Sun), by the Moscow calendar day. */
export function dayMode(date = now()) {
  const w = mskParts(date).weekday;
  if (w === 1) return 'monday_focus';
  if (w >= 2 && w <= 4) return 'daily_plans';
  return 'off';
}

/** Make now() behave as if the current time were HH:MM today (MSK); time keeps flowing. */
export function setSimulatedStart(hhmm) {
  const t = parseHHMM(hhmm);
  const cur = now();
  offsetMs += todayAt(hhmm, cur).getTime() - cur.getTime();
  simAt = `${pad(t.hour)}:${pad(t.minute)}${t.second ? `:${pad(t.second)}` : ''}`;
  return now();
}

/** Shift the simulated date forward to the next given weekday ('mon' ... 'sun'; 0 days if already). */
export function setSimulatedDay(day) {
  const key = String(day).trim().toLowerCase();
  const idx = DAYS.indexOf(key);
  if (idx < 0) throw new Error(`invalid day "${day}", expected one of ${DAYS.join('|')}`);
  const current = mskParts(now()).weekday;
  offsetMs += ((idx - current + 7) % 7) * DAY_MS;
  simDay = key;
  return now();
}

/** Back to real time. */
export function clearSimulation() {
  offsetMs = 0;
  simAt = null;
  simDay = null;
}

// Moscow wall-clock time -> instant. The second pass handles an offset change
// between the guess and the answer (DST); Moscow has had none since 2014.
function mskWallTime(year, month, day, hour, minute, second) {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let t = wall - zoneOffsetAt(wall);
  const again = wall - zoneOffsetAt(t);
  if (again !== t) t = again;
  return new Date(t);
}

function zoneOffsetAt(t) {
  const p = mskParts(new Date(t));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.ms) - t;
}
