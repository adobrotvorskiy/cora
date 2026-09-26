// Ears: room audio -> Realtime session -> semantic_vad + gpt-live-transcribe events (PLAN.md §2, §3).
//
//   const ears = createEars(session, { log });
//   pageAudio.onAudio = (pcm) => ears.pushAudio(pcm);          // 100 ms PCM16 chunks, 24 kHz mono
//   ears.on('vad', ({ type, audio_ms, t }) => ...);            // type 'start' | 'stop'
//   ears.on('stt_delta', ({ item_id, text, so_far, t }) => ...);
//   ears.on('stt_final', ({ item_id, text, t, t_speech_start, t_speech_end, latency_ms }) => ...);
//   ears.on('stt_failed', ({ item_id, error, t }) => ...);
//   ears.on('reset', ({ reason, item_id, t }) => ...);         // socket lost mid-speech: no 'stop' will come
//
// Time base: the server reports audio_start_ms/audio_end_ms relative to the audio written in the
// current server session. Ears records, for every chunk actually written to the socket, its byte
// offset and the wall time it was captured (pushAudio {t}, default Date.now() at push), and maps
// audio_ms back to wall clock: vad.t is when speech started/stopped in the room, not when the
// event arrived (t_rx). A reconnect starts a new server session -> new epoch -> offsets restart at 0.
// Chunks dropped by the reconnect queue never reach the server and are not counted.
// Measured 18.09.2026 (tools/realtime_selftest.js, semantic_vad eagerness medium, clean TTS speech):
// audio_start_ms is ~450 ms BEFORE the real onset (prefix padding) and the start event arrives
// ~0.3 s after the onset; audio_end_ms is ~550 ms after the last voiced sample and the stop event
// arrives ~0.85 s after the real end of speech; the final transcript ~1.45 s after it. Transcription
// deltas stream live during speech (26 of 28 came before the VAD stop).
//
// Hygiene: server VAD commits one user audio item per turn into the default conversation (we never
// respond in it). Every hygieneIntervalMs the items committed more than itemMaxAgeMs ago are deleted
// (conversation.item.delete).
// Log records: vad.start, vad.stop, stt.final (with transcription usage), stt.failed, vad.reset,
// rt.items_deleted. Deltas are not logged unless {logDeltas: true}.

import { EventEmitter } from 'node:events';
import { BYTES_PER_MS, b64Bytes } from './realtime_ws.js';

const DEFAULTS = {
  itemMaxAgeMs: 120_000,
  hygieneIntervalMs: 30_000,
  timelineMaxChunks: 3000, // 5 min of 100 ms chunks
  logDeltas: false,
};
const MAX_TRACKED_SPEECH = 200;

/** Maps byte offsets of the audio written in one server session to capture wall time. */
export class AudioTimeline {
  constructor(maxEntries = DEFAULTS.timelineMaxChunks) {
    this.maxEntries = maxEntries;
    this.reset();
  }

  reset() {
    this.entries = [];
    this.bytes = 0;
  }

  /** A chunk of `bytes` whose last sample was captured at wall time `tEnd` (ms). */
  add(bytes, tEnd) {
    this.entries.push({ start: this.bytes, bytes, tEnd });
    this.bytes += bytes;
    if (this.entries.length > this.maxEntries * 1.25) this.entries.splice(0, this.entries.length - this.maxEntries);
  }

  /** Audio written so far in this session, ms. */
  get ms() {
    return this.bytes / BYTES_PER_MS;
  }

  /** Wall time (ms) of the sample at `audioMs`; extrapolates outside the kept range; null if empty. */
  toWall(audioMs) {
    if (!this.entries.length || !Number.isFinite(audioMs)) return null;
    const pos = audioMs * BYTES_PER_MS;
    const list = this.entries;
    let lo = 0;
    let hi = list.length - 1;
    if (pos < list[0].start) hi = 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid].start <= pos) lo = mid;
      else hi = mid - 1;
    }
    const e = list[lo];
    return Math.round(e.tEnd - (e.start + e.bytes - pos) / BYTES_PER_MS);
  }
}

export function createEars(session, opts = {}) {
  return new Ears(session, opts);
}

export class Ears extends EventEmitter {
  /**
   * @param {import('./realtime_ws.js').RealtimeSession} session
   * @param {object} [opts]  {log, now, itemMaxAgeMs, hygieneIntervalMs, timelineMaxChunks, logDeltas}
   */
  constructor(session, { log, now = Date.now, ...opts } = {}) {
    super();
    this.session = session;
    this.opts = { ...DEFAULTS, ...opts };
    this._logger = log;
    this._now = now;
    this._epoch = null; // epoch of the timeline
    this._timeline = new AudioTimeline(this.opts.timelineMaxChunks);
    this._speaking = null; // {item_id, start_ms, t_start}
    this._speech = new Map(); // item_id -> {start_ms, t_start, stop_ms, t_stop}
    this._partials = new Map(); // item_id -> text so far
    this._items = new Map(); // item_id -> {t, deleting}
    this._pendingDeletes = new Map(); // event_id -> item_id
    this._latencies = [];
    this._stats = {
      chunks: 0,
      pushed_bytes: 0,
      sent_bytes: 0,
      dropped_bytes: 0,
      vad_starts: 0,
      vad_stops: 0,
      deltas: 0,
      finals: 0,
      failed: 0,
      resets: 0,
      items_deleted: 0,
      delete_errors: 0,
    };
    this._subs = [];
    this._sub('input_audio_buffer.speech_started', (ev, ctx) => this._onSpeechStarted(ev, ctx));
    this._sub('input_audio_buffer.speech_stopped', (ev, ctx) => this._onSpeechStopped(ev, ctx));
    this._sub('input_audio_buffer.committed', (ev, ctx) => {
      if (ev.item_id) this._items.set(ev.item_id, { t: ctx.t, deleting: false });
    });
    this._sub('conversation.item.input_audio_transcription.delta', (ev, ctx) => this._onDelta(ev, ctx));
    this._sub('conversation.item.input_audio_transcription.completed', (ev, ctx) => this._onCompleted(ev, ctx));
    this._sub('conversation.item.input_audio_transcription.failed', (ev, ctx) => this._onFailed(ev, ctx));
    this._sub('conversation.item.deleted', (ev) => {
      if (this._items.delete(ev.item_id)) this._stats.items_deleted++;
    });
    this._sub('server_error', (err) => this._onServerError(err));
    this._sub('disconnected', (info) => this._onDisconnected(info));
    this._hygiene = setInterval(() => this.sweepItems(), this.opts.hygieneIntervalMs);
    this._hygiene.unref?.();
  }

  /** True between a VAD start and its stop. */
  get speaking() {
    return this._speaking !== null;
  }

  /**
   * Send one chunk of room audio (PCM16 LE mono 24 kHz).
   * @param {string|Buffer|ArrayBufferView|ArrayBuffer} chunk  base64 string, Buffer, Int16Array, ...
   * @param {{t?: number}} [o]  wall time (ms) the chunk's last sample was captured; default now
   * @returns {boolean} false if the chunk was empty/invalid
   */
  pushAudio(chunk, { t } = {}) {
    const enc = encodeChunk(chunk);
    if (!enc || !enc.bytes) return false;
    const tEnd = t ?? this._now();
    const { bytes } = enc;
    this._stats.chunks++;
    this._stats.pushed_bytes += bytes;
    this.session.send(
      { type: 'input_audio_buffer.append', audio: enc.b64 },
      {
        bytes,
        onSent: ({ epoch }) => {
          if (epoch !== this._epoch) {
            this._epoch = epoch;
            this._timeline.reset();
          }
          this._timeline.add(bytes, tEnd);
          this._stats.sent_bytes += bytes;
        },
        onDrop: () => {
          this._stats.dropped_bytes += bytes;
        },
      },
    );
    return true;
  }

  /** Wall time (ms) of `audioMs` in the current server session's audio stream (null if unknown). */
  audioMsToWall(audioMs) {
    return this._timeline.toWall(audioMs);
  }

  /** Audio written to the current server session so far, ms. */
  get audioMs() {
    return this._timeline.ms;
  }

  /** Delete committed items older than itemMaxAgeMs. Returns how many deletes were sent. */
  sweepItems() {
    if (this.session.state !== 'open') return 0;
    const cutoff = this._now() - this.opts.itemMaxAgeMs;
    let sent = 0;
    for (const [itemId, item] of this._items) {
      if (item.deleting || item.t > cutoff) continue;
      item.deleting = true;
      const eventId = this.session.send(
        { type: 'conversation.item.delete', item_id: itemId },
        { onDrop: () => this._items.delete(itemId) },
      );
      if (eventId) {
        this._pendingDeletes.set(eventId, itemId);
        sent++;
      }
    }
    if (sent) this._log('rt.items_deleted', { count: sent, tracked: this._items.size });
    return sent;
  }

  stats() {
    const s = this._stats;
    const lat = this._latencies;
    return {
      epoch: this._epoch,
      chunks: s.chunks,
      pushed_ms: Math.round(s.pushed_bytes / BYTES_PER_MS),
      sent_ms: Math.round(s.sent_bytes / BYTES_PER_MS),
      dropped_ms: Math.round(s.dropped_bytes / BYTES_PER_MS),
      session_audio_ms: Math.round(this._timeline.ms),
      vad_starts: s.vad_starts,
      vad_stops: s.vad_stops,
      deltas: s.deltas,
      finals: s.finals,
      failed: s.failed,
      resets: s.resets,
      speaking: this.speaking,
      items_tracked: this._items.size,
      items_deleted: s.items_deleted,
      delete_errors: s.delete_errors,
      final_latency_ms: lat.length
        ? { last: lat.at(-1), avg: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length), max: Math.max(...lat), n: lat.length }
        : null,
    };
  }

  /** Stop the hygiene timer and detach from the session. */
  close() {
    clearInterval(this._hygiene);
    for (const [type, fn] of this._subs) this.session.off(type, fn);
    this._subs = [];
  }

  // ---- internals -----------------------------------------------------------------------------

  _sub(type, fn) {
    this.session.on(type, fn);
    this._subs.push([type, fn]);
  }

  _onSpeechStarted(ev, ctx) {
    const t = this._timeline.toWall(ev.audio_start_ms) ?? ctx.t;
    const sp = { item_id: ev.item_id ?? null, start_ms: ev.audio_start_ms, t_start: t, stop_ms: null, t_stop: null };
    this._speaking = sp;
    if (sp.item_id) this._remember(sp.item_id, sp);
    this._stats.vad_starts++;
    this._log('vad.start', { item_id: sp.item_id, audio_ms: ev.audio_start_ms, lag_ms: ctx.t - t });
    this.emit('vad', { type: 'start', audio_ms: ev.audio_start_ms, t, t_rx: ctx.t, item_id: sp.item_id });
  }

  _onSpeechStopped(ev, ctx) {
    const t = this._timeline.toWall(ev.audio_end_ms) ?? ctx.t;
    const sp = (ev.item_id && this._speech.get(ev.item_id)) || this._speaking || { item_id: ev.item_id ?? null, start_ms: null, t_start: null };
    sp.stop_ms = ev.audio_end_ms;
    sp.t_stop = t;
    if (sp.item_id) this._remember(sp.item_id, sp);
    this._speaking = null;
    this._stats.vad_stops++;
    const dur = sp.start_ms != null ? ev.audio_end_ms - sp.start_ms : null;
    this._log('vad.stop', { item_id: sp.item_id, audio_ms: ev.audio_end_ms, speech_ms: dur, lag_ms: ctx.t - t });
    this.emit('vad', { type: 'stop', audio_ms: ev.audio_end_ms, t, t_rx: ctx.t, item_id: sp.item_id, speech_ms: dur });
  }

  _onDelta(ev, ctx) {
    const soFar = (this._partials.get(ev.item_id) ?? '') + (ev.delta ?? '');
    this._partials.set(ev.item_id, soFar);
    this._stats.deltas++;
    if (this.opts.logDeltas) this._log('stt.delta', { item_id: ev.item_id, text: ev.delta });
    this.emit('stt_delta', { item_id: ev.item_id, text: ev.delta ?? '', so_far: soFar, t: ctx.t });
  }

  _onCompleted(ev, ctx) {
    const sp = this._speech.get(ev.item_id);
    const latency = sp?.t_stop != null ? ctx.t - sp.t_stop : null;
    this._partials.delete(ev.item_id);
    this._speech.delete(ev.item_id);
    this._stats.finals++;
    if (latency != null) {
      this._latencies.push(latency);
      if (this._latencies.length > 200) this._latencies.shift();
    }
    const text = ev.transcript ?? '';
    this._log('stt.final', {
      item_id: ev.item_id,
      text,
      latency_ms: latency,
      speech_ms: sp?.stop_ms != null && sp?.start_ms != null ? sp.stop_ms - sp.start_ms : null,
      ...(ev.usage ? { usage: ev.usage } : {}),
    });
    this.emit('stt_final', {
      item_id: ev.item_id,
      text,
      t: ctx.t,
      t_speech_start: sp?.t_start ?? null,
      t_speech_end: sp?.t_stop ?? null,
      latency_ms: latency,
    });
  }

  _onFailed(ev, ctx) {
    this._partials.delete(ev.item_id);
    this._speech.delete(ev.item_id);
    this._stats.failed++;
    this._log('stt.failed', { item_id: ev.item_id, error: ev.error });
    this.emit('stt_failed', { item_id: ev.item_id, error: ev.error ?? null, t: ctx.t });
  }

  _onServerError(err) {
    const itemId = err?.event_id ? this._pendingDeletes.get(err.event_id) : undefined;
    if (itemId === undefined) return;
    this._pendingDeletes.delete(err.event_id);
    this._items.delete(itemId); // already gone (or never existed): stop tracking it
    this._stats.delete_errors++;
  }

  _onDisconnected(info) {
    const t = info?.t ?? this._now();
    if (this._speaking) {
      const sp = this._speaking;
      this._speaking = null;
      this._stats.resets++;
      this._log('vad.reset', { reason: 'disconnected', item_id: sp.item_id });
      this.emit('reset', { reason: 'disconnected', item_id: sp.item_id, t });
    }
    // items, partial transcripts and pending deletes belong to the lost server session
    this._items.clear();
    this._partials.clear();
    this._pendingDeletes.clear();
    this._speech.clear();
  }

  _remember(itemId, sp) {
    this._speech.set(itemId, sp);
    if (this._speech.size > MAX_TRACKED_SPEECH) this._speech.delete(this._speech.keys().next().value);
  }

  _log(type, fields) {
    try {
      this._logger?.event?.(type, fields);
    } catch {
      // never let logging break audio
    }
  }
}

/** {b64, bytes} for any supported chunk type; null for unsupported input. */
function encodeChunk(chunk) {
  if (typeof chunk === 'string') return { b64: chunk, bytes: b64Bytes(chunk) };
  if (Buffer.isBuffer(chunk)) return { b64: chunk.toString('base64'), bytes: chunk.length };
  if (ArrayBuffer.isView(chunk)) {
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return { b64: buf.toString('base64'), bytes: buf.length };
  }
  if (chunk instanceof ArrayBuffer) return { b64: Buffer.from(chunk).toString('base64'), bytes: chunk.byteLength };
  return null;
}
