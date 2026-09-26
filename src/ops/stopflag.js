// Kill-switch flag file: state/STOP (config.STOP_FILE).
//
// The flag's presence means «уйди из встречи»: the host leaves the call within ~1–2 s.
// Who creates it: stop-standup.ps1 (or by hand: New-Item state\STOP), the watchdog in
// run-standup.ps1, and requestStop() here (voice command, harness).
// A flag left over from an earlier run is stale: run-standup.ps1 removes it before it
// starts the host; a host started directly (node src/main.js) should call
// clearStopFlag() once at startup, before watchStopFlag().
//
// Detection is polling, not fs.watch: one existsSync() every 250 ms costs nothing,
// behaves the same on every file system and bounds the detection latency at
// intervalMs, which leaves the host >= 750 ms to fall silent.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { STOP_FILE } from '../config.js';

const REASON_MAX = 200;

/** True if the flag file exists. */
export function isStopRequested({ file = STOP_FILE } = {}) {
  return existsSync(file);
}

/** Create the flag (and its directory). Returns the path. */
export function requestStop(reason = 'stop requested', { file = STOP_FILE } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${new Date().toISOString()} ${reason}\n`);
  return file;
}

/** Remove the flag. true = a flag was removed, false = there was none; other errors throw. */
export function clearStopFlag({ file = STOP_FILE } = {}) {
  try {
    unlinkSync(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/**
 * Poll for the flag and call cb({file, at, reason}) when it appears: on the first check
 * (next tick) if it already exists, then once per appearance (removed and created again
 * fires again). Creates the flag's directory if it is missing, so the file can be dropped
 * there by hand. The interval timer is unref'd: the watcher alone never keeps the process
 * alive. Errors from cb (sync or async) go to onError and never stop the watcher.
 *
 * @param {(info: {file: string, at: Date, reason: string}) => unknown} cb
 * @param {object} [opts]
 * @param {number} [opts.intervalMs]  poll period (default 250 ms)
 * @param {string} [opts.file]  default config.STOP_FILE (tests pass a temp path)
 * @param {(err: unknown) => void} [opts.onError]
 * @returns {{stop: () => void, readonly fired: number}}
 */
export function watchStopFlag(cb, { intervalMs = 250, file = STOP_FILE, onError = () => {} } = {}) {
  if (typeof cb !== 'function') throw new TypeError('watchStopFlag: cb must be a function');
  const report = (err) => {
    try {
      onError(err);
    } catch {
      // an error handler that throws must not kill the poller
    }
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch (e) {
    report(e);
  }

  let present = false;
  let fired = 0;
  let stopped = false;
  const check = () => {
    if (stopped) return;
    const exists = existsSync(file);
    if (exists === present) return;
    present = exists;
    if (!exists) return; // flag removed: re-armed for the next appearance
    fired++;
    try {
      const ret = cb({ file, at: new Date(), reason: readReason(file) });
      if (ret && typeof ret.then === 'function') ret.then(undefined, report);
    } catch (e) {
      report(e);
    }
  };

  const period = Number(intervalMs) > 0 ? Math.max(10, Number(intervalMs)) : 250;
  const timer = setInterval(check, period);
  timer.unref();
  const first = setImmediate(check);
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      clearImmediate(first);
    },
    get fired() {
      return fired;
    },
  };
}

// The flag's text, if any (stop-standup.ps1 writes who/when). PowerShell 5.1 may
// write UTF-16LE with a BOM; an empty file (New-Item) gives ''.
function readReason(file) {
  try {
    const buf = readFileSync(file);
    let text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le', 2) : buf.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text;
  } catch {
    return '';
  }
}
