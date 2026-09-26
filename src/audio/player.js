// Host-side audio player (WP4): feeds PCM16 mono 24 kHz to the page adapter (WP2, page_inject.js)
// and tracks each utterance until the page has played it or it was cut.
//
//   const player = new Player({ page, log });       // or new Player({ audio: pageAudio, log }) (WP2 handle)
//   await attachPageAudio(page, { onEvent: (ev) => { player.onPageEvent(ev); ... } });   // before goto
//   const h = player.play(clip.pcm, { meta: { text: clip.text, key: clip.key }, source: 'clip' });
//   const h = player.playLive(mouth, 'Тима, тебе слово.');      // streams mouth.say() audio
//   h.abort('barge_in');                                        // page flush + stop feeding
//   const r = await h.done;  // {status: 'completed'|'aborted'|'failed', played_ms, pushed_ms, total_ms,
//                            //  played_ratio, ttfa_ms, reason?, dropped_ms?, partial?, ...}
// 'aborted' = the caller stopped it (abort/stop/interrupt); 'failed' = FAIL_REASONS (page gone,
// navigation, stall, source error before any audio). A source that fails after audio went out
// finishes 'completed' with partial: true once the sent audio has played.
//
// Page API used (page.evaluate): __host_play(b64) -> player state, __host_playEnd(),
// __host_flush() -> {played_ms, dropped_ms}, __host_playerState() -> {queued_ms, playing, played_ms,
// utt, ...}. Page events (forward them with onPageEvent): player.drained {utt, reason 'eos'} ends an
// utterance at once; player.underrun is counted; host.installed (top) = new document -> the active
// playback is gone ('navigated'); worklet.error -> 'worklet_error'. Without forwarded events the
// player polls __host_playerState() after the end-of-stream marker (pollMs), so it still completes.
//
// Feeding: audio is sent in slices of <= sliceMs (200 ms) as it becomes available; a live stream
// arrives ~5x faster than real time, so the page queue is kept <= maxLeadMs (2 s) ahead. abort():
// stops reading the source (iterator.return()), calls onAbort (e.g. mouth cancel), sends
// __host_flush() before anything else can reach the page, and releases the floor at once
// (state 'idle'); done resolves when the flush reports {dropped_ms}: played_ms = pushed - dropped.
//
// One playback at a time: play() while busy -> done rejects with code 'busy', unless
// {queue: true} (FIFO) or {interrupt: true} (abort the current one with reason 'interrupted').
// States (on('state', {state, prev, id, source, t})): 'idle' -> 'starting' (no audio pushed yet,
// e.g. waiting for live TTFA) -> 'speaking' (audio sent to the page) -> 'idle'.
// isSpeaking() = not idle (the host holds the floor).
//
// Log records (logSpeech: false turns them off when the host writes its own): speech.start {id,
// source, text, ttfa_ms?, wait_ms, ...meta}, speech.end {played_ms, duration_ms, completion
// 'event'|'poll', partial?}, speech.abort {status, reason, played_ms, dropped_ms, played_ratio,
// flush_ms}. Reasons: abort (caller default), interrupted, barge_in (caller), stop,
// shutdown, stall (not drained by the expected end + stallMarginMs), page_closed, page_crashed,
// navigated, no_adapter, worklet_error, page_timeout, page_error, source_error, bad_source.

import { EventEmitter } from 'node:events';

export const SAMPLE_RATE = 24_000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

/** Functions run in the page (exported so tests can recognise them in a fake page.evaluate). */
export const PAGE_FN = Object.freeze({
  play: (b64) => window.__host_play(b64),
  playEnd: () => window.__host_playEnd(),
  flush: () => window.__host_flush(),
  state: () => window.__host_playerState(),
});

const DEFAULTS = {
  sliceMs: 200,
  maxLeadMs: 2000,
  pollMs: 100,
  stallMarginMs: 3000,
  evalTimeoutMs: 3000,
  flushTimeoutMs: 1500,
  logSpeech: true, // false: no speech.* records (when the host writes its own)
};

/** Reasons that end a playback with status 'failed' (everything else passed to abort() is 'aborted'). */
export const FAIL_REASONS = new Set(['page_closed', 'page_crashed', 'navigated', 'no_adapter', 'worklet_error', 'page_timeout', 'page_error', 'source_error', 'bad_source', 'error', 'stall']);

class PageError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

/** Why a page.evaluate failed, from Playwright's error text. */
export function pageErrorReason(err) {
  const m = String(err?.message ?? err);
  if (/crash/i.test(m)) return 'page_crashed';
  if (/has been closed|Target closed|browser has disconnected|Session closed|Browser closed/i.test(m)) return 'page_closed';
  if (/Execution context was destroyed|navigat|Cannot find context|context was destroyed/i.test(m)) return 'navigated';
  if (/__host_\w+ is not a function|__host_\w+ is not defined/i.test(m)) return 'no_adapter';
  return 'page_error';
}

// ---------------------------------------------------------------------------------------------
// ChunkStream: push-based async iterable (mouth.say onAudio -> player.play)
// ---------------------------------------------------------------------------------------------

export class ChunkStream {
  constructor() {
    this._chunks = [];
    this._waiter = null;
    this._ended = false;
    this._error = null;
    this._returned = false;
  }

  /** Append a chunk (Buffer | Int16Array | base64 string). False once ended/closed. */
  push(chunk) {
    if (this._ended || this._returned) return false;
    this._chunks.push(chunk);
    this._wake();
    return true;
  }

  end() {
    if (this._ended) return;
    this._ended = true;
    this._wake();
  }

  fail(err) {
    if (this._ended) return;
    this._error = err ?? new Error('stream failed');
    this._ended = true;
    this._wake();
  }

  /** True once end()/fail() was called or the consumer stopped reading. */
  get closed() {
    return this._ended || this._returned;
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const ready = this._take();
        if (ready) return ready;
        return new Promise((resolve, reject) => {
          this._waiter = { resolve, reject };
        });
      },
      return: () => {
        this._returned = true;
        this._chunks = [];
        this._wake();
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  _take() {
    if (this._returned) return Promise.resolve({ value: undefined, done: true });
    if (this._chunks.length) return Promise.resolve({ value: this._chunks.shift(), done: false });
    if (this._ended) return this._error ? Promise.reject(this._error) : Promise.resolve({ value: undefined, done: true });
    return null;
  }

  _wake() {
    const w = this._waiter;
    if (!w) return;
    const ready = this._take();
    if (!ready) return;
    this._waiter = null;
    ready.then(w.resolve, w.reject);
  }
}

// ---------------------------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------------------------

export class Player extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} [o.page]   Playwright page (or a stub with evaluate/on), or WP2's PageAudio handle
   * @param {object} [o.audio]  WP2 PageAudio handle (attachPageAudio result); its .page is used when present
   * @param {{event: Function}} [o.log]
   * @param {() => number} [o.now]
   * Knobs: sliceMs 200, maxLeadMs 2000, pollMs 100, stallMarginMs 3000, evalTimeoutMs 3000,
   * flushTimeoutMs 1500, logSpeech true.
   */
  constructor({ page, audio, log, now = Date.now, ...opts } = {}) {
    super();
    const target = [page, audio, page?.page, audio?.page].find((x) => x && typeof x.evaluate === 'function') ?? null;
    const api = [audio, page].find((x) => x && typeof x.play === 'function' && typeof x.flush === 'function') ?? null;
    if (!target && !api) throw new TypeError('Player: needs a page with evaluate() or a PageAudio handle');
    this.page = target; // Playwright page: page.evaluate(PAGE_FN.*) + close/crash events
    this._api = target ? null : api; // PageAudio without a page: play/playEnd/flush/state methods
    this.opts = { ...DEFAULTS, ...opts };
    this._sliceBytes = Math.max(2, Math.round(this.opts.sliceMs * BYTES_PER_MS) & ~1);
    this._logger = log;
    this._now = now;
    this._state = 'idle';
    this._active = null;
    this._queue = [];
    this._seq = 0;
    this._pageGone = false;
    this._closed = false;
    this._flushing = null; // pending __host_flush() of an aborted playback
    this._stats = { plays: 0, completed: 0, aborted: 0, failed: 0, busy: 0, pushes: 0, pushed_ms: 0, played_ms: 0, underruns: 0 };
    this._frameCache = null; // meeting-frame resolution cache (see _frame)
    this._pageListeners = [];
    if (typeof this.page?.on === 'function') {
      this._listen('close', () => {
        this._pageGone = true;
        this._abortAll('page_closed', { flush: false });
      });
      this._listen('crash', () => this._abortAll('page_crashed', { flush: false }));
      this._listen('framenavigated', () => { this._frameCache = null; });
    }
  }

  /** 'idle' | 'starting' | 'speaking' */
  get state() {
    return this._state;
  }

  /** True while a playback holds the floor (starting or speaking). */
  isSpeaking() {
    return this._state !== 'idle';
  }

  /** The active playback: {id, source, text, meta, state, pushed_ms, t_call} or null. */
  current() {
    const p = this._active;
    return p ? { id: p.id, source: p.meta.source ?? null, text: p.meta.text ?? null, meta: p.meta, state: p.state, pushed_ms: Math.round(p.pushedBytes / BYTES_PER_MS), t_call: p.t_call } : null;
  }

  get queueLength() {
    return this._queue.length;
  }

  /**
   * Play PCM16 mono 24 kHz: a Buffer/Int16Array/base64 string (a clip) or an (async) iterable of
   * such chunks (a stream). meta is logged with speech.* and read lazily: a live caller may fill
   * meta.ttfa_ms before the first chunk arrives.
   * @param {Buffer|Int16Array|string|AsyncIterable|Iterable} source
   * @param {object} [o]
   * @param {object} [o.meta]        {text, key, person, ttfa_ms, total_ms, ...} (logged; primitives only)
   * @param {'clip'|'live'} [o.source]  default meta.source, else 'clip' for PCM and 'stream' for iterables
   * @param {boolean} [o.queue]      wait behind the current playback instead of failing with 'busy'
   * @param {boolean} [o.interrupt]  abort the current playback ('interrupted') and play this now
   * @param {(info: {id, reason}) => void} [o.onAbort]  called once on abort (cancel the producer)
   * @returns {{id: string, done: Promise<object>, abort: (reason?: string) => Promise<object>, meta: object}}
   *   done -> {status: 'completed'|'aborted'|'failed', reason?, played_ms, pushed_ms, total_ms, played_ratio,
   *            ttfa_ms, wait_ms, dropped_ms?, partial?, ...}. 'aborted' = abort()/stop()/interrupt;
   *            'failed' = FAIL_REASONS (page gone, source error before any audio, stall, ...).
   */
  play(source, { meta = {}, source: kind, queue = false, interrupt = false, onAbort } = {}) {
    this._stats.plays++;
    const p = this._newPlayback(source, meta, onAbort);
    if (kind) p.meta.source = kind;
    if (this._closed || this._pageGone) {
      this._finish(p, { status: 'aborted', reason: this._closed ? 'shutdown' : 'page_closed' });
      return this._handle(p);
    }
    if (this._active) {
      if (interrupt) {
        this._abort(this._active, 'interrupted', { advance: false });
      } else if (queue) {
        p.state = 'queued';
        this._queue.push(p);
        return this._handle(p);
      } else {
        this._stats.busy++;
        const err = Object.assign(new Error('player busy: another playback is active'), { code: 'busy' });
        const done = Promise.reject(err);
        done.catch(() => {}); // callers that ignore `done` must not crash the process
        return { id: p.id, done, abort: () => done, meta: p.meta, rejected: true };
      }
    }
    this._start(p);
    return this._handle(p);
  }

  /**
   * Say `text` live: mouth.say() audio streams straight into play(). abort() also cancels the
   * readout. meta.ttfa_ms is filled from mouth's onStart before the first chunk is sent.
   * @param {{say: Function}} mouth
   * @param {string} text
   * @param {object} [o]  {meta, say: extra mouth.say options, queue, interrupt}
   * @returns handle of play() plus `say` (the mouth handle)
   */
  playLive(mouth, text, { meta = {}, say = {}, ...playOpts } = {}) {
    const stream = new ChunkStream();
    const m = { source: 'live', text, ...meta };
    let sayHandle = null;
    let cancelled = false;
    const h = this.play(stream, {
      ...playOpts,
      meta: m,
      onAbort: () => {
        cancelled = true;
        sayHandle?.cancel?.();
      },
    });
    if (h.rejected) return h;
    try {
      sayHandle = mouth.say(text, {
        ...say,
        format: 'buffer',
        onStart: (info) => {
          m.ttfa_ms = info?.ttfa_ms ?? null;
          safeCall(() => say.onStart?.(info), this);
        },
        onAudio: (buf) => stream.push(buf),
        onEnd: (res) => {
          if (res?.status === 'completed') stream.end();
          else stream.fail(Object.assign(new Error(`readout ${res?.status ?? 'failed'}${res?.reason ? `: ${res.reason}` : ''}`), { code: res?.reason ?? res?.status, result: res }));
          safeCall(() => say.onEnd?.(res), this);
        },
      });
    } catch (err) {
      stream.fail(err); // -> aborted 'source_error', nothing played
      return h;
    }
    sayHandle?.done?.catch?.((err) => stream.fail(err)); // busy / closed mouth
    if (cancelled) sayHandle?.cancel?.(); // aborted synchronously before the readout existed
    h.say = sayHandle;
    return h;
  }

  /** Abort the active playback (flush) and drop the queue. Resolves with the active result or null. */
  stop(reason = 'stop') {
    for (const q of [...this._queue]) this._abort(q, reason);
    const p = this._active;
    return p ? this._abort(p, reason, { advance: false }) : Promise.resolve(null);
  }

  /** Feed page events here (attachPageAudio onEvent). */
  onPageEvent(ev) {
    if (!ev || typeof ev.type !== 'string') return;
    const p = this._active;
    switch (ev.type) {
      case 'player.drained': {
        if (!p || !p.eosSent || ev.reason !== 'eos') return;
        if (Number.isInteger(ev.utt) && p.baseUtt != null && ev.utt <= p.baseUtt) return; // an older utterance
        if (p.onDrained) p.onDrained('event');
        else p.drainedEarly = true;
        return;
      }
      case 'player.underrun':
        if (p) {
          p.underruns++;
          this._stats.underruns++;
        }
        return;
      case 'player.started':
        if (p && p.t_page_start == null) p.t_page_start = this._now();
        return;
      case 'host.installed':
        if (ev.top !== false && p) this._abort(p, 'navigated', { flush: false });
        return;
      case 'worklet.error':
        if (p) this._abort(p, 'worklet_error', { flush: false });
        return;
      default:
    }
  }

  /** Stop everything and detach from the page. */
  close() {
    if (this._closed) return;
    this._abortAll('shutdown', { flush: !this._pageGone });
    this._closed = true;
    for (const [type, fn] of this._pageListeners) {
      try {
        (this.page?.off ?? this.page?.removeListener)?.call(this.page, type, fn);
      } catch {
        // page already gone
      }
    }
    this._pageListeners = [];
  }

  stats() {
    return { ...this._stats, state: this._state, queued: this._queue.length };
  }

  // ---- internals -----------------------------------------------------------------------------

  _listen(type, fn) {
    this.page.on(type, fn);
    this._pageListeners.push([type, fn]);
  }

  _newPlayback(source, meta, onAbort) {
    this._seq += 1;
    const m = meta && typeof meta === 'object' ? meta : {};
    if (m.source == null) m.source = isChunk(source) ? 'clip' : 'stream';
    const p = {
      id: `play-${this._seq}`,
      source,
      meta: m,
      onAbort,
      state: 'new', // new | queued | starting | speaking | done
      t_call: this._now(),
      t_first: null,
      t_page_start: null,
      pending: [],
      pendingBytes: 0,
      receivedBytes: 0,
      pushedBytes: 0,
      pushes: 0,
      queuedMs: 0,
      queuedAt: null,
      baseUtt: null,
      underruns: 0,
      srcDone: false,
      srcError: null,
      eosSent: false,
      drainedEarly: false,
      onDrained: null,
      cancelDrain: null,
      pollTimer: null,
      polling: false,
      stallAt: 0,
      stopped: false,
      aborting: false,
      finished: false,
      iter: null,
      waiter: null,
      sleeper: null,
    };
    p.done = new Promise((resolve) => {
      p.resolve = resolve;
    });
    p.wait = () =>
      new Promise((resolve) => {
        p.waiter = resolve;
      });
    p.wake = () => {
      const w = p.waiter;
      p.waiter = null;
      w?.();
    };
    p.sleep = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => {
          p.sleeper = null;
          resolve();
        }, ms);
        p.sleeper = { timer, resolve };
      });
    p.interrupt = () => {
      p.wake();
      const s = p.sleeper;
      if (s) {
        p.sleeper = null;
        clearTimeout(s.timer);
        s.resolve();
      }
    };
    return p;
  }

  _handle(p) {
    return { id: p.id, done: p.done, abort: (reason = 'abort') => this._abort(p, reason), meta: p.meta };
  }

  _setState(state, p) {
    if (state === this._state) return;
    const prev = this._state;
    this._state = state;
    const ev = { state, prev, speaking: state !== 'idle', id: p?.id ?? null, source: p?.meta?.source ?? null, meta: p?.meta ?? null, t: this._now() };
    try {
      this.emit('state', ev);
    } catch (err) {
      this._log('error.player', { where: 'state listener', message: err?.message });
    }
  }

  _start(p) {
    this._active = p;
    p.state = 'starting';
    this._setState('starting', p);
    this._run(p).catch((err) => this._finish(p, { status: 'aborted', reason: 'error', error: errMsg(err) }));
  }

  _next() {
    if (this._active || this._closed) return;
    const p = this._queue.shift();
    if (p) this._start(p);
  }

  async _run(p) {
    let iter;
    try {
      iter = toAsyncIterator(p.source);
    } catch (err) {
      this._finish(p, { status: 'aborted', reason: 'bad_source', error: errMsg(err) });
      return;
    }
    p.iter = iter;
    this._pump(p, iter);
    try {
      if (this._flushing) await this._flushing; // see _abort(): a push during the flush fade is lost
      for (;;) {
        if (p.stopped) return;
        if (p.pendingBytes >= 2) {
          await this._lead(p);
          if (p.stopped) return;
          const slice = takeSlice(p, this._sliceBytes);
          if (slice) await this._push(p, slice);
          continue;
        }
        if (p.srcDone) break;
        await p.wait();
      }
      if (p.stopped) return;
      if (p.srcError && !p.pushedBytes) {
        this._finish(p, { status: 'aborted', reason: 'source_error', error: errMsg(p.srcError) });
        return;
      }
      if (!p.pushedBytes) {
        this._finish(p, { status: 'completed', empty: true });
        return;
      }
      p.eosSent = true;
      await this._eval(PAGE_FN.playEnd);
      if (p.stopped) return;
      const how = await this._drain(p);
      if (p.stopped) return;
      if (how === 'event' || how === 'poll') {
        this._finish(p, {
          status: 'completed',
          completion: how,
          ...(p.srcError ? { partial: true, reason: 'source_error', error: errMsg(p.srcError) } : {}),
        });
      } else if (how === 'stall') {
        this._abort(p, 'stall');
      } else if (how === 'page_error') {
        this._finish(p, { status: 'aborted', reason: p.pageError?.reason ?? 'page_error', error: errMsg(p.pageError) });
      } else {
        this._abort(p, how, { flush: false });
      }
    } catch (err) {
      if (p.stopped) return;
      if (err instanceof PageError) {
        if (err.reason === 'page_closed' && this.page?.isClosed?.() === true) this._pageGone = true;
        this._finish(p, { status: 'aborted', reason: err.reason, error: err.message });
        return;
      }
      this._finish(p, { status: 'aborted', reason: 'error', error: errMsg(err) });
    }
  }

  async _pump(p, iter) {
    try {
      for (;;) {
        if (p.stopped) break;
        const { value, done } = await iter.next();
        if (done || p.stopped) break;
        const buf = toBuffer(value);
        if (buf.length) {
          p.pending.push(buf);
          p.pendingBytes += buf.length;
          p.receivedBytes += buf.length;
          p.wake();
        }
      }
    } catch (err) {
      p.srcError = err ?? new Error('source failed');
    } finally {
      p.srcDone = true;
      p.wake();
    }
  }

  async _lead(p) {
    if (!this.opts.maxLeadMs || p.queuedAt == null) return;
    const est = p.queuedMs - (this._now() - p.queuedAt);
    if (est > this.opts.maxLeadMs) await p.sleep(Math.min(est - this.opts.maxLeadMs + 5, 1000));
  }

  async _push(p, slice) {
    if (!p.pushedBytes) this._onFirstAudio(p);
    p.pushedBytes += slice.length;
    p.pushes++;
    this._stats.pushes++;
    const st = await this._eval(PAGE_FN.play, slice.toString('base64'));
    if (p.pushes === 1) p.baseUtt = Number.isInteger(st?.utt) ? st.utt : null;
    const now = this._now();
    if (st && typeof st.queued_ms === 'number') {
      p.queuedMs = st.queued_ms;
    } else {
      p.queuedMs = Math.max(0, p.queuedMs - (p.queuedAt == null ? 0 : now - p.queuedAt)) + slice.length / BYTES_PER_MS;
    }
    p.queuedAt = now;
    if (st?.worklet === 'error') throw new PageError('worklet_error', 'page player worklet failed to load (CSP? use bypassCSP)');
  }

  _onFirstAudio(p) {
    p.t_first = this._now();
    p.state = 'speaking';
    if (this._active === p) this._setState('speaking', p);
    if (this.opts.logSpeech) this._log('speech.start', { id: p.id, ...logMeta(p.meta), wait_ms: p.t_first - p.t_call });
  }

  _drain(p) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (how) => {
        if (settled) return;
        settled = true;
        if (p.pollTimer) clearInterval(p.pollTimer);
        p.pollTimer = null;
        p.onDrained = null;
        p.cancelDrain = null;
        resolve(how);
      };
      if (p.drainedEarly) {
        done('event');
        return;
      }
      p.onDrained = done;
      p.cancelDrain = () => done('cancelled');
      const now = this._now();
      const remaining = Math.max(0, p.queuedMs - (p.queuedAt == null ? 0 : now - p.queuedAt));
      p.stallAt = now + remaining + this.opts.stallMarginMs;
      p.pollTimer = setInterval(() => this._poll(p), this.opts.pollMs);
    });
  }

  async _poll(p) {
    if (p.polling || !p.onDrained) return;
    if (this._now() > p.stallAt) {
      p.onDrained('stall');
      return;
    }
    p.polling = true;
    try {
      const st = await this._eval(PAGE_FN.state);
      if (!p.onDrained) return;
      if (st?.worklet === 'error') {
        p.onDrained('worklet_error');
        return;
      }
      // queued_ms counts our pushed audio until the page consumed it, so idle + empty = done
      if (st && st.playing === false && st.queued_ms === 0) p.onDrained('poll');
    } catch (err) {
      if (p.onDrained) {
        p.pageError = err;
        p.onDrained('page_error');
      }
    } finally {
      p.polling = false;
    }
  }

  _abortAll(reason, { flush = true } = {}) {
    for (const q of [...this._queue]) this._abort(q, reason);
    if (this._active) this._abort(this._active, reason, { flush, advance: false });
  }

  _abort(p, reason = 'abort', { flush = true, advance = true } = {}) {
    if (p.finished || p.aborting) return p.done;
    p.aborting = true;
    p.stopped = true;
    p.interrupt();
    p.cancelDrain?.();
    try {
      const r = p.iter?.return?.();
      r?.catch?.(() => {});
    } catch {
      // the source may not support return()
    }
    if (p.onAbort) safeCall(() => p.onAbort({ id: p.id, reason }), this);
    const qi = this._queue.indexOf(p);
    if (qi >= 0) {
      this._queue.splice(qi, 1);
      this._finish(p, { status: 'aborted', reason });
      return p.done;
    }
    const wasActive = this._active === p;
    if (wasActive) {
      this._active = null; // release the floor now; the flush below is already on its way
      this._setState('idle', p);
    }
    if (flush && p.pushedBytes > 0 && !this._pageGone) {
      const t0 = this._now();
      // page.evaluate is issued synchronously here, before any later play() can reach the page
      const flushing = this._eval(PAGE_FN.flush, undefined, this.opts.flushTimeoutMs).then(
        (r) => {
          const dropped = Number.isFinite(r?.dropped_ms) ? r.dropped_ms : undefined;
          this._finish(p, { status: 'aborted', reason, dropped_ms: dropped, flush_ms: this._now() - t0, ...(r?.timeout ? { flush_timeout: true } : {}) });
        },
        (err) => this._finish(p, { status: 'aborted', reason, flush_error: err?.reason ?? 'page_error' }),
      );
      // The page worklet drops everything queued when its flush fade ends, including audio pushed
      // right after the flush message: the next playback waits for the flush to complete.
      this._flushing = flushing;
      flushing.finally(() => {
        if (this._flushing === flushing) this._flushing = null;
      });
    } else {
      this._finish(p, { status: 'aborted', reason });
    }
    if (wasActive && advance) this._next();
    return p.done;
  }

  _finish(p, res0) {
    if (p.finished) return;
    const res = res0.status === 'aborted' && FAIL_REASONS.has(res0.reason) ? { ...res0, status: 'failed' } : res0;
    p.finished = true;
    p.stopped = true;
    p.state = 'done';
    if (p.pollTimer) clearInterval(p.pollTimer);
    p.pollTimer = null;
    p.interrupt();
    const now = this._now();
    const pushedMs = Math.round(p.pushedBytes / BYTES_PER_MS);
    let playedMs;
    if (res.status === 'completed') playedMs = pushedMs;
    else if (typeof res.dropped_ms === 'number') playedMs = Math.max(0, pushedMs - res.dropped_ms);
    else playedMs = Math.max(0, Math.round(pushedMs - Math.max(0, p.queuedMs - (p.queuedAt == null ? 0 : now - p.queuedAt))));
    const totalMs = Number.isFinite(p.meta.total_ms) ? p.meta.total_ms : p.srcDone && !p.srcError ? Math.round(p.receivedBytes / BYTES_PER_MS) : null;
    const denom = totalMs || pushedMs;
    const out = {
      id: p.id,
      status: res.status,
      ...res,
      played_ms: playedMs,
      pushed_ms: pushedMs,
      total_ms: totalMs,
      played_ratio: res.status === 'completed' ? (denom ? 1 : 0) : denom ? Math.round((playedMs / denom) * 1000) / 1000 : 0,
      // live: the mouth's TTFA (playLive fills meta.ttfa_ms); clips: play() -> the page started playing
      ttfa_ms: Number.isFinite(p.meta.ttfa_ms) ? p.meta.ttfa_ms : p.t_page_start != null ? p.t_page_start - p.t_call : p.t_first != null ? p.t_first - p.t_call : null,
      duration_ms: p.t_first != null ? now - p.t_first : 0,
      wait_ms: p.t_first != null ? p.t_first - p.t_call : null,
      underruns: p.underruns,
      source: p.meta.source ?? null,
      text: p.meta.text ?? null,
    };
    if (res.status === 'completed') this._stats.completed++;
    else if (res.status === 'failed') this._stats.failed++;
    else this._stats.aborted++;
    this._stats.pushed_ms += pushedMs;
    this._stats.played_ms += playedMs;
    const base = { id: p.id, ...logMeta(p.meta), played_ms: playedMs, pushed_ms: pushedMs, duration_ms: out.duration_ms };
    if (!this.opts.logSpeech) {
      // the host writes its own speech.* records
    } else if (res.status === 'completed') {
      this._log('speech.end', { ...base, completion: res.completion ?? null, underruns: p.underruns, ...(res.partial ? { partial: true, error: res.error } : {}), ...(res.empty ? { empty: true } : {}) });
    } else {
      this._log('speech.abort', {
        ...base,
        status: res.status,
        reason: res.reason,
        started: p.t_first != null,
        played_ratio: out.played_ratio,
        ...(res.dropped_ms != null ? { dropped_ms: res.dropped_ms } : {}),
        ...(res.flush_ms != null ? { flush_ms: res.flush_ms } : {}),
        ...(res.flush_error ? { flush_error: res.flush_error } : {}),
        ...(res.flush_timeout ? { flush_timeout: true } : {}),
        ...(res.error ? { error: res.error } : {}),
      });
    }
    if (this._active === p) {
      this._active = null;
      this._setState('idle', p);
      this._next();
    }
    p.resolve(out);
  }

  /** The same calls through a PageAudio handle (play/playEnd/flush/state methods). */
  _callApi(fn, arg) {
    const a = this._api;
    if (fn === PAGE_FN.play) return a.play(arg);
    if (fn === PAGE_FN.playEnd) return a.playEnd();
    if (fn === PAGE_FN.flush) return a.flush();
    if (fn === PAGE_FN.state) return typeof a.state === 'function' ? a.state() : Promise.resolve(null);
    return Promise.reject(new Error('unknown page call'));
  }

  /**
   * The frame that hosts the meeting app. Since the 21.09 Telemost update the call runs inside
   * a /private-join/<id> iframe; the microphone clone handed to Telemost comes from THAT frame's
   * adapter, so the player must feed the same frame — playing into the top document would speak
   * into a parallel adapter nobody hears. Falls back to the main frame (pre-21.09 layout, tests).
   */
  async _frame() {
    if (this._frameCache) return this._frameCache;
    const p = this.page;
    if (!p || typeof p.frames !== 'function') return p;
    for (const f of p.frames()) {
      const hit = await f
        .evaluate(
          () =>
            typeof window.__host_play === 'function' &&
            !!document.querySelector('[data-testid="enter-conference-button"], [data-testid="end-call-button"], [data-testid="end-call-alt-button"]'),
        )
        .catch(() => false);
      if (hit) {
        this._frameCache = f;
        return f;
      }
    }
    this._frameCache = typeof p.mainFrame === 'function' ? p.mainFrame() : p;
    return this._frameCache;
  }

  /** page.evaluate with a timeout; failures become PageError {reason}. */
  async _eval(fn, arg, timeoutMs = this.opts.evalTimeoutMs) {
    if (this._pageGone) throw new PageError('page_closed', 'page is closed');
    let timer = null;
    try {
      const target = this.page && typeof this.page.frames === 'function' ? await this._frame() : this.page;
      const call = target ? (arg === undefined ? target.evaluate(fn) : target.evaluate(fn, arg)) : this._callApi(fn, arg);
      if (!timeoutMs) return await call;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PageError('page_timeout', `page.evaluate timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      return await Promise.race([call, timeout]);
    } catch (err) {
      if (err instanceof PageError) throw err;
      throw new PageError(pageErrorReason(err), errMsg(err));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _log(type, fields) {
    try {
      this._logger?.event?.(type, fields);
    } catch {
      // logging must never break audio
    }
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function isChunk(x) {
  return typeof x === 'string' || Buffer.isBuffer(x) || ArrayBuffer.isView(x) || x instanceof ArrayBuffer;
}

function toAsyncIterator(source) {
  if (isChunk(source)) {
    let used = false;
    return {
      next: async () => {
        if (used) return { value: undefined, done: true };
        used = true;
        return { value: source, done: false };
      },
      return: async () => {
        used = true;
        return { value: undefined, done: true };
      },
    };
  }
  if (source && typeof source[Symbol.asyncIterator] === 'function') return source[Symbol.asyncIterator]();
  if (source && typeof source[Symbol.iterator] === 'function') {
    const it = source[Symbol.iterator]();
    return {
      next: async () => it.next(),
      return: async () => {
        it.return?.();
        return { value: undefined, done: true };
      },
    };
  }
  throw new TypeError('play(): expected PCM (Buffer | Int16Array | base64 string) or an (async) iterable of chunks');
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'base64');
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  throw new TypeError(`bad audio chunk: ${typeof chunk}`);
}

/** Up to maxBytes (even) from the pending chunks; an odd trailing byte waits for the next chunk. */
function takeSlice(p, maxBytes) {
  let want = Math.min(p.pendingBytes, maxBytes);
  want -= want & 1;
  if (want <= 0) return null;
  const parts = [];
  let got = 0;
  while (got < want) {
    const head = p.pending[0];
    const need = want - got;
    if (head.length <= need) {
      parts.push(head);
      p.pending.shift();
      got += head.length;
    } else {
      parts.push(head.subarray(0, need));
      p.pending[0] = head.subarray(need);
      got += need;
    }
  }
  p.pendingBytes -= got;
  return parts.length === 1 ? parts[0] : Buffer.concat(parts, got);
}

function logMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta ?? {})) {
    if (v == null || typeof v === 'function' || typeof v === 'object') continue;
    out[k] = typeof v === 'string' && v.length > 200 ? `${v.slice(0, 199)}…` : v;
  }
  return out;
}

function errMsg(err) {
  return String(err?.message ?? err ?? 'unknown error').slice(0, 300);
}

function safeCall(fn, player) {
  try {
    fn();
  } catch (err) {
    player._log('error.player', { where: 'callback', message: err?.message });
  }
}
