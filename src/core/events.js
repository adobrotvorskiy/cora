// Shared primitives of the host core (WP6): event names, bounded event/transcript buffers,
// an async audio queue (mouth -> player streaming) and a serializer for the event loop.
//
// Everything here is dependency-free and synchronous except AsyncQueue, so state.js,
// floor.js, guards.js and host.js can share vocabulary without importing each other.

/** Meeting phases (PLAN.md §2 «Контракты» + 'left' once the host has left the call). */
export const PHASES = Object.freeze(['waiting', 'starting', 'round', 'open_floor', 'closing', 'silent', 'left']);
/** Participant statuses (context.js knows pending|spoke|speaking|absent; 'skipped' maps to pending for the brain). */
export const STATUSES = Object.freeze(['pending', 'speaking', 'spoke', 'absent', 'skipped']);
/** Brain triggers (context.js TRIGGERS). */
export const TRIGGERS = Object.freeze([
  'turn_end_candidate', 'silence', 'joined', 'left', 'chat', 'question_to_host', 'timer', 'barge_in', 'plan_refresh',
]);
/** Turn-end reasons emitted by the floor controller. */
export const TURN_END_REASONS = Object.freeze(['closer', 'vad_stop', 'silence_2500']);
/** Timer names, in the order they fire (settings.times keys). */
export const TIMER_NAMES = Object.freeze(['start', 'wait_lead_until', 'soft_deadline', 'hard_deadline', 'force_leave']);

/** Bounded FIFO of {t, type, ...} records for context.recent_events. */
export class RingLog {
  constructor(max = 60) {
    this.max = max;
    this.items = [];
  }

  push(record) {
    this.items.push(record);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    return record;
  }

  /** Last n records (oldest first). */
  recent(n = 20) {
    return this.items.slice(-n);
  }

  clear() {
    this.items = [];
  }
}

/** Transcript lines {t (ms), who, text} with a time window for context.transcript_window. */
export class Transcript {
  constructor(max = 200) {
    this.max = max;
    this.lines = [];
  }

  push(line) {
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
    return line;
  }

  /** Lines whose t is within the last `windowMs` before `now` (oldest first). */
  window(windowMs, now = Date.now()) {
    const from = now - windowMs;
    return this.lines.filter((l) => typeof l.t !== 'number' || l.t >= from);
  }

  /** Concatenated text of the last `windowMs` (for question detection / closers). */
  tail(windowMs, now = Date.now()) {
    return this.window(windowMs, now).map((l) => l.text).join(' ');
  }
}

/**
 * Async iterable queue: producers push() chunks, the consumer `for await`s them.
 * end() finishes the iteration after the queued chunks; abort() discards them and finishes at once.
 */
export class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.ended = false;
    this.aborted = false;
  }

  push(item) {
    if (this.ended) return false;
    if (this.waiters.length) this.waiters.shift()({ value: item, done: false });
    else this.items.push(item);
    return true;
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  abort() {
    this.aborted = true;
    this.items = [];
    this.end();
  }

  get size() {
    return this.items.length;
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.abort();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/**
 * Runs async handlers strictly one after another (the host's event loop): every inbound event
 * is queued and handled in order, so state mutations never interleave. Errors go to onError
 * and never break the chain.
 */
export class Serializer {
  constructor({ onError = () => {} } = {}) {
    this.onError = onError;
    this.chain = Promise.resolve();
    this.pending = 0;
  }

  /** @returns {Promise<any>} resolves with fn's result (undefined if it threw). */
  run(fn) {
    this.pending++;
    const p = this.chain.then(async () => {
      try {
        return await fn();
      } catch (e) {
        try {
          this.onError(e);
        } catch {
          // never
        }
        return undefined;
      } finally {
        this.pending--;
      }
    });
    this.chain = p.then(() => undefined, () => undefined);
    return p;
  }

  /** Resolves once everything queued so far has run. */
  idle() {
    return this.chain;
  }
}

/** Monotonic-ish ms clock helper for modules that accept an injectable `now`. */
export const wallNow = () => Date.now();
