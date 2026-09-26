// Energy VAD over the mixed room audio (PCM16 LE mono 24 kHz), used by or_ears.js (WP3b).
//
// Per frame (frame_ms, 20 ms): level = RMS in dBFS (-100 = digital silence).
// Noise floor: a slow-rising minimum tracker over the frame levels (clamped at floor_min_db,
// smoothed in the dB domain over floor_smooth_ms): it falls to the input at once and rises at most
// floor_rise_db_per_s, but never lags the minimum of the last floor_window_ms (so a new steady
// noise is learned within that window); result clamped to [floor_min_db, floor_max_db]. The
// tracker starts from the first frame, so a noisy room is not mistaken for speech at startup.
// Start: frames >= floor + start_db add up to start_ms (frames between the two thresholds keep
// the count, frames below floor + stop_db reset it) -> 'start', dated at the first loud frame.
// Stop: stop_ms of quiet (frames < floor + stop_db; isolated non-quiet blips shorter than
// break_ms do not break the quiet run) -> 'stop', dated at the first quiet frame = end of speech.
// Pause: a quiet run inside speech reaching pause_ms -> 'pause' (early-final trigger in the
// ears); speech continuing after a pause -> 'resume'.
//
// Positions are stream milliseconds (samples pushed so far / sampleRate). This is a pure state
// machine: push*() returns the events it produced; no clocks, no timers, no I/O.
//   {type:'start',  pos_ms, at_ms, level_db, floor_db}
//   {type:'pause',  pos_ms, at_ms}                 pos_ms = end of speech so far
//   {type:'resume', pos_ms, at_ms}
//   {type:'stop',   pos_ms, at_ms, speech_ms, reason?}   reason 'flush' from flush()
// at_ms = stream position at which the decision was made (detection lag = at_ms - pos_ms).

export const SAMPLE_RATE = 24_000;

export const VAD_DEFAULTS = Object.freeze({
  frame_ms: 20,
  start_db: 12, // above the floor: counts towards a start
  start_ms: 150, // loud time that opens an utterance
  stop_db: 6, // below floor + stop_db: quiet
  stop_ms: 600, // hangover: quiet time that closes an utterance
  break_ms: 40, // non-quiet time that breaks a quiet run (shorter blips are ignored)
  pause_ms: 250, // quiet run that emits 'pause' (0 = never)
  floor_min_db: -70, // digital silence (muted SFU tracks) must not drag the floor to -100
  floor_max_db: -30,
  floor_rise_db_per_s: 1,
  floor_window_ms: 5000, // the floor never lags the minimum of this window (0 = pure tracker)
  // dB-domain smoothing of the tracker input. Calibrated 18.09.2026 on TTS speech + loopback capture:
  // 0 (raw minimum) biases the floor so low that breath/reverb tails keep utterances open; 100+ lets
  // the floor climb towards speech in fluent monologues; 60 keeps it >= 20 dB under speech peaks.
  floor_smooth_ms: 60,
});

/** Keys of VAD_DEFAULTS taken from `obj` when they are finite numbers. */
export function vadOptions(obj = {}) {
  const out = {};
  for (const key of Object.keys(VAD_DEFAULTS)) {
    const v = obj?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

export function createVad(opts = {}, extra = {}) {
  return new EnergyVad(opts, extra);
}

export class EnergyVad {
  /**
   * @param {object} [opts]  overrides of VAD_DEFAULTS (unknown keys ignored)
   * @param {{sampleRate?: number}} [extra]
   */
  constructor(opts = {}, { sampleRate = SAMPLE_RATE } = {}) {
    this.opts = { ...VAD_DEFAULTS, ...vadOptions(opts) };
    if (this.opts.stop_db >= this.opts.start_db) throw new Error('vad: stop_db must be below start_db');
    this.sampleRate = sampleRate;
    this.frameSamples = Math.max(1, Math.round((sampleRate * this.opts.frame_ms) / 1000));
    this.frameMs = (this.frameSamples * 1000) / sampleRate;
    this.reset();
  }

  reset() {
    this._samples = 0; // samples consumed into frames
    this._acc = 0;
    this._accN = 0;
    this._odd = null; // dangling byte of an odd-length chunk
    this._ema = null;
    this._tracker = null;
    this._win = []; // monotonic deque {t, v} for the window minimum
    this._winHead = 0;
    this._floor = this.opts.floor_min_db;
    this._level = -100;
    this._speaking = false;
    this._loudMs = 0;
    this._attackStart = null;
    this._onset = null;
    this._quietMs = 0;
    this._quietStart = null;
    this._breakMs = 0;
    this._paused = false;
    this._frames = 0;
  }

  get speaking() {
    return this._speaking;
  }

  /** Inside an utterance, in a quiet run that already emitted 'pause'. */
  get paused() {
    return this._paused;
  }

  get floorDb() {
    return this._floor;
  }

  get levelDb() {
    return this._level;
  }

  /** Stream position of the frames processed so far, ms. */
  get positionMs() {
    return (this._frames * this.frameMs);
  }

  state() {
    return {
      speaking: this._speaking,
      paused: this._paused,
      level_db: round1(this._level),
      floor_db: round1(this._floor),
      loud_ms: this._loudMs,
      quiet_ms: this._quietMs,
      onset_ms: this._onset,
      position_ms: this.positionMs,
    };
  }

  /**
   * Feed PCM16 LE mono samples (any chunk size; partial frames carry over).
   * @param {Buffer|Uint8Array|Int16Array|ArrayBuffer} chunk
   * @returns {object[]} events
   */
  pushPcm(chunk) {
    const events = [];
    let buf = toPcmBytes(chunk);
    if (!buf || !buf.length) return events;
    if (this._odd) {
      buf = Buffer.concat([this._odd, buf]);
      this._odd = null;
    }
    const even = buf.length - (buf.length % 2);
    if (even < buf.length) this._odd = Buffer.from(buf.subarray(even));
    const n = this.frameSamples;
    for (let off = 0; off < even; off += 2) {
      const s = buf.readInt16LE(off);
      this._acc += s * s;
      this._accN += 1;
      if (this._accN === n) {
        const meanSq = this._acc / n;
        this._acc = 0;
        this._accN = 0;
        this._frame(meanSq > 0 ? 10 * Math.log10(meanSq / 1073741824) : -100, events);
      }
    }
    return events;
  }

  /**
   * Feed one level frame (dBFS) of `ms` milliseconds, e.g. the page's per-track 50 ms levels.
   * Use either pushPcm or pushLevel on one instance, not both.
   */
  pushLevel(db, ms = this.frameMs) {
    const events = [];
    this._frame(Number.isFinite(db) ? db : -100, events, ms);
    return events;
  }

  /** Close an open utterance now (end of stream, stall). Returns the stop event or null. */
  flush() {
    if (!this._speaking) return null;
    const pos = this.positionMs;
    const end = this._quietStart ?? pos;
    const ev = { type: 'stop', pos_ms: end, at_ms: pos, speech_ms: end - this._onset, reason: 'flush' };
    this._endUtterance();
    return ev;
  }

  // ---- internals -----------------------------------------------------------------------------

  _frame(rawDb, events, ms = this.frameMs) {
    const db = Math.max(-100, rawDb);
    const o = this.opts;
    const startPos = this.positionMs;
    if (ms === this.frameMs) this._frames += 1;
    else this._frames += ms / this.frameMs;
    const endPos = this.positionMs;
    this._level = db;

    // noise floor: minimum tracking over frame levels (dB domain; a power average would let one
    // loud frame hide the short inter-word dips that keep the floor honest during speech)
    const x = Math.max(o.floor_min_db, db);
    if (o.floor_smooth_ms > 0 && this._ema !== null) this._ema += (1 - Math.exp(-ms / o.floor_smooth_ms)) * (x - this._ema);
    else this._ema = x;
    const input = this._ema;
    this._tracker = this._tracker === null ? input : Math.min(this._tracker + (o.floor_rise_db_per_s * ms) / 1000, input);
    let floor = this._tracker;
    if (o.floor_window_ms > 0) floor = Math.max(floor, this._windowMin(endPos, input));
    this._floor = Math.min(o.floor_max_db, Math.max(o.floor_min_db, floor));

    const loud = db >= this._floor + o.start_db;
    const quiet = db < this._floor + o.stop_db;

    if (!this._speaking) {
      if (loud) {
        if (this._loudMs === 0) this._attackStart = startPos;
        this._loudMs += ms;
      } else if (quiet) {
        this._loudMs = 0;
        this._attackStart = null;
      }
      if (this._loudMs >= o.start_ms) {
        this._speaking = true;
        this._onset = this._attackStart;
        this._quietMs = 0;
        this._quietStart = null;
        this._breakMs = 0;
        this._paused = false;
        events.push({ type: 'start', pos_ms: this._onset, at_ms: endPos, level_db: round1(db), floor_db: round1(this._floor) });
      }
      return;
    }

    if (quiet) {
      if (this._quietStart === null) {
        this._quietStart = startPos;
        this._quietMs = 0;
      }
      this._quietMs += this._breakMs + ms; // blips shorter than break_ms count as quiet
      this._breakMs = 0;
    } else if (this._quietStart !== null) {
      this._breakMs += ms;
      if (this._breakMs >= o.break_ms) {
        if (this._paused) events.push({ type: 'resume', pos_ms: this._quietStart + this._quietMs, at_ms: endPos });
        this._paused = false;
        this._quietStart = null;
        this._quietMs = 0;
        this._breakMs = 0;
      }
      return;
    } else {
      return;
    }

    if (!this._paused && o.pause_ms > 0 && o.pause_ms < o.stop_ms && this._quietMs >= o.pause_ms) {
      this._paused = true;
      events.push({ type: 'pause', pos_ms: this._quietStart, at_ms: endPos });
    }
    if (this._quietMs >= o.stop_ms) {
      const end = this._quietStart;
      events.push({ type: 'stop', pos_ms: end, at_ms: endPos, speech_ms: end - this._onset });
      this._endUtterance();
    }
  }

  _endUtterance() {
    this._speaking = false;
    this._paused = false;
    this._loudMs = 0;
    this._attackStart = null;
    this._onset = null;
    this._quietMs = 0;
    this._quietStart = null;
    this._breakMs = 0;
  }

  _windowMin(t, v) {
    const win = this._win;
    while (win.length > this._winHead && win[win.length - 1].v >= v) win.pop();
    win.push({ t, v });
    const cutoff = t - this.opts.floor_window_ms;
    while (this._winHead < win.length && win[this._winHead].t <= cutoff) this._winHead += 1;
    if (this._winHead > 512) {
      this._win = win.slice(this._winHead);
      this._winHead = 0;
    }
    return this._win[this._winHead].v;
  }
}

/**
 * PCM bytes for any supported chunk type (base64 string, Buffer, typed array, ArrayBuffer);
 * views are copied so a caller reusing its buffer cannot change audio we keep. null if unsupported.
 */
export function toPcmBuffer(chunk) {
  if (typeof chunk === 'string') return Buffer.from(chunk, 'base64');
  if (Buffer.isBuffer(chunk)) return Buffer.from(chunk);
  if (ArrayBuffer.isView(chunk)) return Buffer.from(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  if (chunk instanceof ArrayBuffer) return Buffer.from(new Uint8Array(chunk));
  return null;
}

/** Like toPcmBuffer but without copying (read-only use). */
function toPcmBytes(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  if (typeof chunk === 'string') return Buffer.from(chunk, 'base64');
  return null;
}

/** RMS level of a PCM16 LE buffer in dBFS (-100 for silence/empty). */
export function pcmLevelDb(buf) {
  const b = toPcmBytes(buf);
  if (!b || b.length < 2) return -100;
  let acc = 0;
  const n = Math.floor(b.length / 2);
  for (let i = 0; i < n; i++) {
    const s = b.readInt16LE(i * 2);
    acc += s * s;
  }
  const meanSq = acc / n;
  return meanSq > 0 ? Math.max(-100, 10 * Math.log10(meanSq / 1073741824)) : -100;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}
