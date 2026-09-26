// Mouth: verbatim out-of-band readouts on the shared Realtime session (PLAN.md §2.1, §4).
//
// The realtime model is used as TTS only: every readout is a response.create with
// conversation "none" (nothing is added to the default conversation) whose single input is
// {"response_text": <text>, "require_repeat_verbatim": true}; the session instructions carry
// the rule that makes the model say exactly response_text (see realtime_ws.VERBATIM_RULE).
//
//   const mouth = createMouth(session, { log });
//   const h = mouth.say('Тима, тебе слово.', { onAudio: (b64) => player.play(b64), onStart, onEnd });
//   const r = await h.done;   // {status: 'completed'|'cancelled'|'failed', ttfa_ms, audio_ms, usage, ...}
//   h.cancel();               // barge-in: no onAudio call happens after cancel() returns
//   const pcm = await mouth.renderClip('Доброе утро!');   // Buffer, PCM16 mono 24 kHz (clips cache)
//
// Lanes
// - live (say): one readout at a time. say() while one is active or queued -> done rejects with
//   Error 'busy' (err.code 'busy'), unless {queue: true} (FIFO). A live request waiting for a
//   reconnect expires after liveMaxAgeMs (status 'failed', reason 'stale').
// - render (renderClip): FIFO, renderConcurrency at a time, independent of the live lane
//   (parallel out-of-band responses verified 18.09.2026).
// Timing: ttfa_ms = first audio delta - response.create written to the socket; wait_ms = time the
// request waited before that (lane queue or reconnect). audio_ms = audio forwarded (bytes / 48).
// Verbatim: the model's own transcript (response.output_audio_transcript.done) is compared with the
// requested text (lowercase, ё=е, no stress marks, no punctuation); a mismatch is logged as
// rt.verbatim_mismatch and returned as verbatim: false.
// Log records: rt.readout (one per finished readout), rt.verbatim_mismatch.

import { EventEmitter } from 'node:events';
import { BYTES_PER_MS } from './realtime_ws.js';

const DEFAULTS = {
  liveMaxAgeMs: 4000, // a live readout older than this is not worth saying after a reconnect
  firstAudioTimeoutMs: 6000, // live readout without audio by then -> cancel, 'failed' reason 'no_audio'
  doneTimeoutMs: 45_000, // no response.done by then -> cancel, 'failed' reason 'timeout'
  cancelTimeoutMs: 3000, // response.done after cancel not seen by then -> resolve 'cancelled' anyway
  renderConcurrency: 2,
};
const METADATA_MAX_KEYS = 16;

/** The response.create event for one verbatim readout. */
export function buildReadoutEvent(text, { req, kind = 'live', meta, maxOutputTokens } = {}) {
  const metadata = { req: String(req), kind: String(kind) };
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (Object.keys(metadata).length >= METADATA_MAX_KEYS) break;
    if (value == null || key in metadata) continue;
    metadata[String(key).slice(0, 64)] = (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 512);
  }
  const response = {
    conversation: 'none',
    output_modalities: ['audio'],
    metadata,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: JSON.stringify({ response_text: text, require_repeat_verbatim: true }) }],
      },
    ],
  };
  if (maxOutputTokens) response.max_output_tokens = maxOutputTokens;
  return { type: 'response.create', response };
}

/** Text normalized for the verbatim comparison. */
export function normalizeSpoken(text) {
  return String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[̀́]/g, '')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** {match, similarity 0..1 (word-level edit distance)} of what was asked vs what was said. */
export function compareVerbatim(expected, got) {
  const a = normalizeSpoken(expected);
  const b = normalizeSpoken(got);
  if (a === b) return { match: true, similarity: 1 };
  const wa = a ? a.split(' ') : [];
  const wb = b ? b.split(' ') : [];
  const n = Math.max(wa.length, wb.length);
  return { match: false, similarity: n ? Math.round((1 - editDistance(wa, wb) / n) * 1000) / 1000 : 0 };
}

export function createMouth(session, opts = {}) {
  return new Mouth(session, opts);
}

export class Mouth extends EventEmitter {
  /**
   * @param {import('./realtime_ws.js').RealtimeSession} session
   * @param {object} [opts]  {log, now, liveMaxAgeMs, firstAudioTimeoutMs, doneTimeoutMs, cancelTimeoutMs, renderConcurrency}
   */
  constructor(session, { log, now = Date.now, ...opts } = {}) {
    super();
    this.session = session;
    this.opts = { ...DEFAULTS, ...opts };
    this._logger = log;
    this._now = now;
    this._tag = Math.random().toString(36).slice(2, 6);
    this._seq = 0;
    this._byReq = new Map();
    this._byId = new Map();
    this._byEvent = new Map();
    this._orphans = new Set(); // reqs given up before response.created: cancel them when created
    this._live = { active: null, queue: [] };
    this._render = { active: new Set(), queue: [] };
    this._stats = { say: 0, clips: 0, completed: 0, cancelled: 0, failed: 0, busy: 0, verbatim_mismatch: 0, ttfa: [] };
    this._subs = [];
    this._sub('response.created', (ev, ctx) => this._onCreated(ev, ctx));
    this._sub('response.output_audio.delta', (ev, ctx) => this._onAudio(ev, ctx));
    this._sub('response.output_audio_transcript.delta', (ev) => {
      const r = this._byId.get(ev.response_id);
      if (r) r.transcriptParts.push(ev.delta ?? '');
    });
    this._sub('response.output_audio_transcript.done', (ev) => {
      const r = this._byId.get(ev.response_id);
      if (r) r.transcript = ev.transcript ?? '';
    });
    this._sub('response.done', (ev, ctx) => this._onDone(ev, ctx));
    this._sub('server_error', (err) => this._onServerError(err));
    this._sub('disconnected', () => this._onDisconnected());
  }

  /** True while a live readout is requested or playing. */
  get busy() {
    return Boolean(this._live.active) || this._live.queue.length > 0;
  }

  /**
   * Say `text` verbatim, streaming audio to onAudio as it arrives.
   * @param {string} text
   * @param {object} [o]
   * @param {object} [o.meta]            extra response.metadata (strings; logged by the server)
   * @param {(chunk: string|Buffer) => void} [o.onAudio]  base64 PCM16 (default) or Buffer (format: 'buffer')
   * @param {'b64'|'buffer'} [o.format]
   * @param {(info: {id: string, ttfa_ms: number, t: number}) => void} [o.onStart]  first audio
   * @param {(result: object) => void} [o.onEnd]
   * @param {boolean} [o.queue]          wait for the current readout instead of failing with 'busy'
   * @param {number} [o.maxAgeMs]        override liveMaxAgeMs
   * @param {number} [o.maxOutputTokens]
   * @returns {{id: string, done: Promise<object>, cancel: () => Promise<object>}}
   */
  say(text, o = {}) {
    const r = this._newReadout('live', text, o);
    this._stats.say++;
    if (this._closed) return this._rejected(r, 'closed', 'mouth is closed');
    if (!r.text) return this._rejected(r, 'bad_text', 'say(): text is empty');
    if (this.busy) {
      if (!o.queue) {
        this._stats.busy++;
        return this._rejected(r, 'busy', 'busy: another readout is active');
      }
      this._live.queue.push(r);
    } else {
      this._live.active = r;
      this._request(r);
    }
    return this._handle(r);
  }

  /**
   * Render `text` to PCM16 mono 24 kHz without playing it (clips cache).
   * @returns {Promise<Buffer>} or, with {withInfo: true}, Promise<{pcm, transcript, verbatim, similarity, ttfa_ms, audio_ms, usage}>
   */
  renderClip(text, { meta, withInfo = false, maxOutputTokens } = {}) {
    const r = this._newReadout('clip', text, { meta, maxOutputTokens });
    this._stats.clips++;
    r.chunks = [];
    const out = r.done.then((res) => {
      if (res.status !== 'completed') {
        throw Object.assign(new Error(`renderClip ${res.status}${res.reason ? `: ${res.reason}` : ''}`), { code: res.reason ?? res.status, result: res });
      }
      const pcm = Buffer.concat(r.chunks);
      return withInfo ? { pcm, ...pick(res, ['transcript', 'verbatim', 'similarity', 'ttfa_ms', 'audio_ms', 'usage', 'response_id']) } : pcm;
    });
    if (this._closed || !r.text) {
      this._finish(r, 'failed', { reason: this._closed ? 'closed' : 'bad_text' });
      return out;
    }
    this._render.queue.push(r);
    this._pumpRender();
    return out;
  }

  /** Cancel the live readout and everything queued behind it (clips too with {clips: true}). */
  cancelAll({ clips = false } = {}) {
    const all = [...this._live.queue, ...(this._live.active ? [this._live.active] : [])];
    if (clips) all.push(...this._render.queue, ...this._render.active);
    return Promise.all(all.map((r) => this._cancel(r)));
  }

  stats() {
    const t = this._stats.ttfa;
    return {
      say: this._stats.say,
      clips: this._stats.clips,
      completed: this._stats.completed,
      cancelled: this._stats.cancelled,
      failed: this._stats.failed,
      busy_rejects: this._stats.busy,
      verbatim_mismatch: this._stats.verbatim_mismatch,
      live_active: Boolean(this._live.active),
      live_queued: this._live.queue.length,
      renders_active: this._render.active.size,
      renders_queued: this._render.queue.length,
      ttfa_ms: t.length ? { last: t.at(-1), avg: Math.round(t.reduce((s, x) => s + x, 0) / t.length), max: Math.max(...t), n: t.length } : null,
    };
  }

  /** Detach from the session; pending readouts fail with reason 'closed'; later calls fail too. */
  close() {
    this._closed = true;
    for (const r of [...this._live.queue, ...this._render.queue]) this._finish(r, 'failed', { reason: 'closed' });
    for (const r of [...this._byReq.values()]) {
      if (r.responseId) this._sendCancel(r); // stop generating (and paying for) audio nobody takes
      this._finish(r, 'failed', { reason: 'closed' });
    }
    for (const [type, fn] of this._subs) this.session.off(type, fn);
    this._subs = [];
  }

  // ---- internals -----------------------------------------------------------------------------

  _sub(type, fn) {
    this.session.on(type, fn);
    this._subs.push([type, fn]);
  }

  _newReadout(kind, text, o) {
    this._seq += 1;
    const r = {
      id: `${kind === 'live' ? 'say' : 'clip'}-${this._seq}-${this._tag}`,
      kind,
      text: typeof text === 'string' ? text.trim() : '',
      o,
      state: 'new', // new | requesting | sent | created | streaming | done
      t_call: this._now(),
      t_sent: null,
      t_first_audio: null,
      t_cancel: null,
      responseId: null,
      createEventId: null,
      cancelRequested: false,
      cancelSent: false,
      audioBytes: 0,
      droppedAfterCancel: 0,
      transcript: null,
      transcriptParts: [],
      timers: [],
      chunks: null,
    };
    r.done = new Promise((resolve) => {
      r.resolve = resolve;
    });
    return r;
  }

  _handle(r) {
    return { id: r.id, done: r.done, cancel: () => this._cancel(r) };
  }

  _rejected(r, code, message) {
    const err = Object.assign(new Error(message), { code });
    const done = Promise.reject(err);
    done.catch(() => {}); // callers that ignore `done` must not crash the process
    return { id: r.id, done, cancel: () => done };
  }

  _request(r) {
    r.state = 'requesting';
    this._byReq.set(r.id, r);
    const ev = buildReadoutEvent(r.text, { req: r.id, kind: r.kind, meta: r.o.meta, maxOutputTokens: r.o.maxOutputTokens });
    const eventId = this.session.send(ev, {
      maxAgeMs: r.kind === 'live' ? (r.o.maxAgeMs ?? this.opts.liveMaxAgeMs) : undefined,
      onSent: ({ t }) => {
        if (r.state !== 'requesting') return;
        r.state = 'sent';
        r.t_sent = t;
        if (r.kind === 'live') this._timer(r, this.opts.firstAudioTimeoutMs, () => this._abort(r, 'no_audio'));
        this._timer(r, this.opts.doneTimeoutMs, () => this._abort(r, 'timeout'));
      },
      onDrop: ({ reason }) => this._finish(r, r.cancelRequested ? 'cancelled' : 'failed', { reason }),
    });
    if (eventId && r.state !== 'done') {
      r.createEventId = eventId;
      this._byEvent.set(eventId, r);
    }
  }

  _timer(r, ms, fn) {
    if (!ms) return;
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    r.timers.push(timer);
  }

  _abort(r, reason) {
    if (r.state === 'done') return;
    if (reason === 'no_audio' && r.t_first_audio) return;
    if (r.responseId) this._sendCancel(r);
    this._finish(r, 'failed', { reason });
  }

  _cancel(r) {
    if (r.state === 'done' || r.cancelRequested) return r.done;
    r.cancelRequested = true;
    r.t_cancel = this._now();
    const liveIdx = this._live.queue.indexOf(r);
    if (liveIdx >= 0) {
      this._live.queue.splice(liveIdx, 1);
      this._finish(r, 'cancelled', { reason: 'before_start' });
      return r.done;
    }
    const renderIdx = this._render.queue.indexOf(r);
    if (renderIdx >= 0) {
      this._render.queue.splice(renderIdx, 1);
      this._finish(r, 'cancelled', { reason: 'before_start' });
      return r.done;
    }
    if (r.state === 'requesting' && r.createEventId && this.session.unqueue(r.createEventId)) {
      this._finish(r, 'cancelled', { reason: 'before_send' });
      return r.done;
    }
    if (r.responseId) this._sendCancel(r); // else sent on response.created
    this._timer(r, this.opts.cancelTimeoutMs, () => this._finish(r, 'cancelled', { reason: 'cancel_timeout' }));
    return r.done;
  }

  _sendCancel(r) {
    if (r.cancelSent || !r.responseId) return;
    r.cancelSent = true;
    this.session.send({ type: 'response.cancel', response_id: r.responseId });
  }

  _onCreated(ev, ctx) {
    const req = ev.response?.metadata?.req;
    const r = req ? this._byReq.get(req) : null;
    if (!r && req && ev.response?.id && this._orphans.delete(req)) {
      // we already gave up on this readout (timeout/cancel before creation): stop paying for it
      this.session.send({ type: 'response.cancel', response_id: ev.response.id });
      return;
    }
    if (!r || !ev.response?.id) return;
    r.responseId = ev.response.id;
    r.t_created = ctx.t;
    this._byId.set(r.responseId, r);
    if (r.state === 'requesting' || r.state === 'sent') r.state = 'created';
    if (r.cancelRequested) this._sendCancel(r);
  }

  _onAudio(ev, ctx) {
    const r = this._byId.get(ev.response_id);
    if (!r) return;
    if (r.cancelRequested || r.state === 'done') {
      r.droppedAfterCancel++;
      return;
    }
    const bytes = Buffer.byteLength(ev.delta ?? '', 'base64');
    r.audioBytes += bytes;
    if (!r.t_first_audio) {
      r.t_first_audio = ctx.t;
      r.state = 'streaming';
      const info = { id: r.id, ttfa_ms: r.t_sent != null ? ctx.t - r.t_sent : null, t: ctx.t };
      if (r.o.onStart) safe(() => r.o.onStart(info), this, 'onStart');
    }
    if (r.kind === 'clip') {
      r.chunks.push(Buffer.from(ev.delta ?? '', 'base64'));
    } else if (r.o.onAudio) {
      const chunk = r.o.format === 'buffer' ? Buffer.from(ev.delta ?? '', 'base64') : ev.delta;
      safe(() => r.o.onAudio(chunk), this, 'onAudio');
    }
  }

  _onDone(ev, ctx) {
    const res = ev.response ?? {};
    const r = this._byId.get(res.id) ?? (res.metadata?.req ? this._byReq.get(res.metadata.req) : null);
    if (!r || r.state === 'done') return;
    let status;
    let reason;
    if (r.cancelRequested) {
      status = 'cancelled';
      reason = res.status === 'cancelled' ? undefined : `server_${res.status}`;
    } else if (res.status === 'completed') {
      status = 'completed';
    } else if (res.status === 'cancelled') {
      status = 'cancelled';
      reason = res.status_details?.reason ?? 'server_cancelled';
    } else {
      status = 'failed';
      const d = res.status_details ?? {};
      reason = res.status === 'incomplete' ? `incomplete:${d.reason ?? '?'}` : (d.error?.code ?? d.reason ?? res.status ?? 'unknown');
    }
    this._finish(r, status, { reason, usage: res.usage ?? null, t: ctx.t });
  }

  _onServerError(err) {
    const r = err?.event_id ? this._byEvent.get(err.event_id) : null;
    if (!r || r.state === 'done') return;
    this._finish(r, r.cancelRequested ? 'cancelled' : 'failed', { reason: err.code ?? err.type ?? 'server_error', error: err });
  }

  _onDisconnected() {
    for (const r of [...this._byReq.values()]) {
      if (r.state === 'requesting') continue; // still queued in the session: goes out after reconnect
      this._finish(r, r.cancelRequested ? 'cancelled' : 'failed', { reason: 'disconnected' });
    }
  }

  _finish(r, status, { reason, usage = null, t, error } = {}) {
    if (r.state === 'done') return;
    r.state = 'done';
    for (const timer of r.timers) clearTimeout(timer);
    r.timers = [];
    this._byReq.delete(r.id);
    if (r.responseId) this._byId.delete(r.responseId);
    if (r.createEventId) this._byEvent.delete(r.createEventId);
    if (!r.responseId && r.t_sent != null && status !== 'completed' && reason !== 'disconnected') {
      this._orphans.add(r.id);
      if (this._orphans.size > 64) this._orphans.delete(this._orphans.values().next().value);
    }
    const tDone = t ?? this._now();
    const result = {
      id: r.id,
      kind: r.kind,
      status,
      ...(reason ? { reason } : {}),
      response_id: r.responseId,
      ttfa_ms: r.t_first_audio != null && r.t_sent != null ? r.t_first_audio - r.t_sent : null,
      audio_ms: Math.round(r.audioBytes / BYTES_PER_MS),
      wait_ms: r.t_sent != null ? r.t_sent - r.t_call : null,
      usage,
      transcript: r.transcript ?? (r.transcriptParts.length ? r.transcriptParts.join('') : null),
      verbatim: null,
      similarity: null,
      t_call: r.t_call,
      t_sent: r.t_sent,
      t_first_audio: r.t_first_audio,
      t_done: tDone,
      ...(r.cancelRequested ? { cancel_ms: tDone - r.t_cancel, dropped_after_cancel: r.droppedAfterCancel } : {}),
      ...(error ? { error: { code: error.code, message: error.message } } : {}),
    };
    if (status === 'completed') {
      const v = compareVerbatim(r.text, result.transcript ?? '');
      result.verbatim = v.match;
      result.similarity = v.similarity;
      if (!v.match) {
        this._stats.verbatim_mismatch++;
        this._log('rt.verbatim_mismatch', { id: r.id, kind: r.kind, expected: r.text, got: result.transcript, similarity: v.similarity });
      }
    }
    this._stats[status]++;
    if (result.ttfa_ms != null) {
      this._stats.ttfa.push(result.ttfa_ms);
      if (this._stats.ttfa.length > 200) this._stats.ttfa.shift();
    }
    this._log('rt.readout', {
      id: r.id,
      kind: r.kind,
      status,
      ...(reason ? { reason } : {}),
      ttfa_ms: result.ttfa_ms,
      audio_ms: result.audio_ms,
      wait_ms: result.wait_ms,
      chars: r.text.length,
      verbatim: result.verbatim,
      text: r.text.length > 200 ? `${r.text.slice(0, 199)}…` : r.text,
    });
    // free the lane before callbacks so onEnd may start the next readout
    if (r.kind === 'live') {
      if (this._live.active === r) this._live.active = null;
      const i = this._live.queue.indexOf(r);
      if (i >= 0) this._live.queue.splice(i, 1);
    } else {
      this._render.active.delete(r);
      const i = this._render.queue.indexOf(r);
      if (i >= 0) this._render.queue.splice(i, 1);
    }
    if (r.o.onEnd) safe(() => r.o.onEnd(result), this, 'onEnd');
    r.resolve(result);
    if (r.kind === 'live') this._pumpLive();
    else this._pumpRender();
  }

  _pumpLive() {
    if (this._closed || this._live.active || !this._live.queue.length) return;
    const next = this._live.queue.shift();
    this._live.active = next;
    this._request(next);
  }

  _pumpRender() {
    while (!this._closed && this._render.active.size < this.opts.renderConcurrency && this._render.queue.length) {
      const next = this._render.queue.shift();
      this._render.active.add(next);
      this._request(next);
    }
  }

  _log(type, fields) {
    try {
      this._logger?.event?.(type, fields);
    } catch {
      // never let logging break audio
    }
  }
}

function safe(fn, mouth, where) {
  try {
    fn();
  } catch (err) {
    mouth._log('rt.error', { phase: 'callback', where, message: err?.message });
  }
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj[k];
  return out;
}

function editDistance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
