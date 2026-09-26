// JSONL event log: logs/<name>_YYYY-MM-DD.jsonl (date = Moscow calendar day at open).
//
// One line per event: {ts, t_msk, type, ...fields}
//   ts     real wall-clock instant, ISO 8601 UTC with ms (correlate with provider dashboards)
//   t_msk  app clock in Moscow, "HH:MM:SS.mmm"; follows the --at/--day simulation (clock.js)
// Reserved keys (ts, t_msk, type) in `fields` are ignored.
// Every open appends a `log.open` line with a run id, and close() appends `log.close`,
// so several runs can share one daily file. Writes are synchronous appends.
// Logs contain meeting transcripts and stay local (logs/ is gitignored). Known
// secret values are masked (env.redactSecrets) before anything is written or printed.

import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { formatMsk, simOffsetMs } from './clock.js';
import { LOGS_DIR } from './config.js';
import { redactSecrets } from './env.js';

const RESERVED = new Set(['ts', 't_msk', 'type']);
const CONSOLE_VALUE_MAX = 80;
const CONSOLE_LINE_MAX = 240;

/**
 * @param {object} [opts]
 * @param {string} [opts.name]  file prefix (default 'standup')
 * @param {boolean} [opts.verbose]  mirror a one-line summary of each event to the console
 * @param {string} [opts.dir]  directory (default logs/; tests and the harness pass their own)
 * @returns {{event: (type: string, fields?: object) => object, path: string, run: string, close: () => void}}
 */
export function openLog({ name = 'standup', verbose = false, dir = LOGS_DIR } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}_${formatMsk(new Date(), 'YYYY-MM-DD')}.jsonl`);
  let fd = openSync(path, 'a');
  let reportedFailure = false;
  const run = randomUUID().slice(0, 8);

  function event(type, fields = {}) {
    const realMs = Date.now();
    const record = {
      ts: new Date(realMs).toISOString(),
      t_msk: formatMsk(new Date(realMs + simOffsetMs())),
      type: String(type),
    };
    const extra = fields == null ? {} : typeof fields === 'object' ? fields : { value: fields };
    for (const [key, value] of Object.entries(extra)) {
      if (!RESERVED.has(key)) record[key] = value;
    }
    if (fd !== null) {
      try {
        writeSync(fd, `${redactSecrets(toJson(record))}\n`);
      } catch (e) {
        if (!reportedFailure) {
          reportedFailure = true;
          process.stderr.write(`[log] cannot write ${path}: ${e.code ?? e.message}\n`);
        }
      }
    }
    if (verbose) console.log(redactSecrets(summarize(record)));
    return record;
  }

  function close() {
    if (fd === null) return;
    event('log.close', { run });
    try {
      closeSync(fd);
    } catch {
      // already closed or the disk is gone; nothing useful to do
    }
    fd = null;
  }

  event('log.open', { run, pid: process.pid, node: process.version });
  return { event, path, run, close };
}

// JSON that survives what the host will throw at it: Errors keep their message,
// BigInts become strings, binary data (audio!) becomes a size marker, cycles are cut.
function toJson(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, function replacer(key, v) {
    const original = this[key]; // before toJSON (Buffer.toJSON would dump the bytes)
    if (ArrayBuffer.isView(original) || original instanceof ArrayBuffer) {
      return `<${original.constructor.name} ${original.byteLength}B>`;
    }
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Error) {
      return { name: v.name, message: v.message, ...(v.code ? { code: v.code } : {}), stack: v.stack };
    }
    if (v !== null && typeof v === 'object') {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
}

function summarize(record) {
  const parts = [];
  for (const [key, value] of Object.entries(record)) {
    if (RESERVED.has(key) || value === undefined) continue;
    let text = typeof value === 'string' ? value : toJson(value);
    if (text === undefined) continue;
    text = text.replace(/\s+/g, ' ');
    if (text.length > CONSOLE_VALUE_MAX) text = `${text.slice(0, CONSOLE_VALUE_MAX - 1)}…`;
    parts.push(`${key}=${text}`);
  }
  const line = `${record.t_msk} ${record.type}${parts.length ? ` ${parts.join(' ')}` : ''}`;
  return line.length > CONSOLE_LINE_MAX ? `${line.slice(0, CONSOLE_LINE_MAX - 1)}…` : line;
}
