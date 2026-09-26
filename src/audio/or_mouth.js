// Mouth over OpenRouter (WP3b): verbatim readouts with openai/gpt-audio(-mini) through
// POST /api/v1/chat/completions (stream, modalities text+audio, pcm16), with the public interface of
// the Realtime mouth (mouth.js), so the host does not care which provider runs:
//
//   const mouth = createOrMouth({ settings, apiKey, log });
//   const h = mouth.say('Тима, тебе слово.', { onAudio: (b64) => player.play(b64), onStart, onEnd });
//   const r = await h.done;   // {status: 'completed'|'cancelled'|'failed', ttfa_ms, audio_ms, usage, ...}
//   h.cancel();               // barge-in: aborts the HTTP stream; no onAudio call after cancel() returns
//   const pcm = await mouth.renderClip('Доброе утро!');   // Buffer, PCM16 mono 24 kHz (clips cache)
//
// Request: system = the instructions of the Realtime session (persona line + pace block + verbatim
// rule, realtime_ws.buildInstructions), user = {"response_text": text, "require_repeat_verbatim": true},
// audio {voice, format 'pcm16'}. The SSE stream carries choices[0].delta.audio.transcript and
// .data (base64 PCM16 mono 24 kHz); the last chunk carries usage with OpenRouter's cost (USD). The
// stream is decoded as UTF-8 explicitly (a latin-1 default turns the transcript into mojibake).
// Measured 18.09.2026 (gpt-audio-mini): the transcript streams first, then audio in 400 ms chunks;
// headers ~1.0 s, TTFA 1.2-1.9 s.
// Lanes: live (say) one readout at a time; say() while one is active or queued -> done rejects with
// Error 'busy' (err.code 'busy') unless {queue: true} (FIFO). render (renderClip): FIFO,
// renderConcurrency at a time, independent of the live lane. Clips are retried once on transient
// errors before any audio arrived; live readouts are not (the moment has passed; the host decides).
// Timing: ttfa_ms = first audio - request sent (fetch called, last attempt); headers_ms = response
// headers - request sent; wait_ms = first request sent - say()/renderClip() call.
// Verbatim: the model's transcript vs the requested text (mouth.compareVerbatim: lowercase, ё=е,
// no stress marks/punctuation); a mismatch is logged as or.verbatim_mismatch, returned verbatim: false.
// PCM alignment: an odd byte at a chunk edge is carried to the next chunk, so every onAudio chunk
// holds whole samples.
// Log records: or.readout (one per finished readout, with cost_usd), or.verbatim_mismatch,
// or.error (retries), or.warmup.

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { compareVerbatim } from './mouth.js';
import { OR_API_BASE, OrError, orHttpError, toOrError } from './or_ears.js';
import { BYTES_PER_MS, buildInstructions } from './realtime_ws.js';

export const OR_CHAT_URL = `${OR_API_BASE}/chat/completions`;
export const OR_KEY_URL = `${OR_API_BASE}/key`;
export const DEFAULT_TTS_MODEL = 'openai/gpt-audio-mini';

const DEFAULTS = {
  firstAudioTimeoutMs: 6000, // live readout without audio by then -> abort, 'failed' reason 'no_audio'
  doneTimeoutMs: 45_000, // stream not finished by then -> abort, 'failed' reason 'timeout'
  renderConcurrency: 2,
  clipRetries: 1,
  liveRetries: 0,
  retryBackoffMs: 300,
  warmupTimeoutMs: 5000,
};

/** The chat/completions body for one verbatim readout. */
export function buildTtsRequest(text, { model = DEFAULT_TTS_MODEL, voice = 'shimmer', instructions = '', maxOutputTokens, usage = true } = {}) {
  const body = {
    model,
    modalities: ['text', 'audio'],
    audio: { voice, format: 'pcm16' },
    stream: true,
    messages: [
      { role: 'system', content: instructions },
      { role: 'user', content: JSON.stringify({ response_text: text, require_repeat_verbatim: true }) },
    ],
  };
  if (usage) body.usage = { include: true };
  if (maxOutputTokens) body.max_tokens = maxOutputTokens;
  return body;
}

export function createOrMouth(opts = {}) {
  return new OrMouth(opts);
}

export class OrMouth extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} [opts.settings]      merged settings (voice.tts_model, voice.voice, realtime.persona_line/pace_instructions)
   * @param {string} opts.apiKey          OpenRouter key (caller gets it via env.requireKey; never logged)
   * @param {{event: Function}} [opts.log]
   * @param {Function} [opts.fetch]       fetch implementation (tests)
   * @param {() => number} [opts.now]     clock, ms
   * @param {string} [opts.url]           chat/completions endpoint
   * @param {string} [opts.keyUrl]        key-info endpoint used by warmup()
   * @param {string} [opts.model]         overrides settings.voice.tts_model
   * @param {string} [opts.voice]         overrides settings.voice.voice
   * @param {string} [opts.instructions]  overrides buildInstructions(settings)
   * Timing knobs: firstAudioTimeoutMs, doneTimeoutMs, renderConcurrency, clipRetries, liveRetries,
   * retryBackoffMs, warmupTimeoutMs (see DEFAULTS).
   */
  constructor({ settings = {}, apiKey, log, fetch = globalThis.fetch, now = Date.now, url = OR_CHAT_URL, keyUrl = OR_KEY_URL, model, voice, instructions, ...opts } = {}) {
    super();
    if (!apiKey) throw new Error('createOrMouth: apiKey is required');
    if (typeof fetch !== 'function') throw new Error('createOrMouth: no fetch implementation');
    const v = settings.voice ?? {};
    this.opts = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) if (typeof opts[key] === 'number' && Number.isFinite(opts[key])) this.opts[key] = opts[key];
    this.model = model ?? v.tts_model ?? DEFAULT_TTS_MODEL;
    this.voice = voice ?? v.voice ?? settings.realtime?.voice ?? 'shimmer';
    this._instructions = instructions ?? buildInstructions(settings);
    // the key lives only in these closures (never on `this`, so it cannot end up in a log dump)
    const auth = `Bearer ${apiKey}`;
    this._post = (body, signal) => fetch(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body, signal });
    this._getKeyInfo = (signal) => fetch(keyUrl, { method: 'GET', headers: { Authorization: auth }, signal });
    this._logger = log;
    this._now = now;
    this._tag = Math.random().toString(36).slice(2, 6);
    this._seq = 0;
    this._closed = false;
    this._sendUsage = true; // dropped for the session if the endpoint rejects `usage`
    this._live = { active: null, queue: [] };
    this._render = { active: new Set(), queue: [] };
    this._stats = { say: 0, clips: 0, completed: 0, cancelled: 0, failed: 0, busy: 0, verbatim_mismatch: 0, audio_bytes: 0, cost_usd: 0, ttfa: [] };
  }

  /** True while a live readout is requested or playing. */
  get busy() {
    return Boolean(this._live.active) || this._live.queue.length > 0;
  }

  /** System instructions of every readout (part of the clip cache key). */
  get instructions() {
    return this._instructions;
  }

  /** Stable id of what the audio sounds like: provider, model, voice, instructions hash. */
  get cacheKey() {
    return `openrouter|${this.model}|${this.voice}|${sha1(this._instructions).slice(0, 12)}`;
  }

  /**
   * Say `text` verbatim, streaming audio to onAudio as it arrives.
   * @param {string} text
   * @param {object} [o]
   * @param {object} [o.meta]            logged with the readout (or.readout.meta)
   * @param {(chunk: string|Buffer) => void} [o.onAudio]  base64 PCM16 (default) or Buffer (format: 'buffer')
   * @param {'b64'|'buffer'} [o.format]
   * @param {(info: {id: string, ttfa_ms: number, t: number}) => void} [o.onStart]  first audio
   * @param {(result: object) => void} [o.onEnd]
   * @param {boolean} [o.queue]          wait for the current readout instead of failing with 'busy'
   * @param {number} [o.maxAgeMs]        a queued readout that cannot start within this many ms of say() fails 'stale'
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
      this._launch(r);
    }
    return this._handle(r);
  }

  /**
   * Render `text` to PCM16 mono 24 kHz without playing it (clips cache).
   * @returns {Promise<Buffer>} or, with {withInfo: true}, Promise<{pcm, transcript, verbatim, similarity, ttfa_ms, audio_ms, usage, cost_usd, response_id}>
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
      if (!withInfo) return pcm;
      const info = { pcm };
      for (const k of ['transcript', 'verbatim', 'similarity', 'ttfa_ms', 'audio_ms', 'usage', 'cost_usd', 'response_id']) info[k] = res[k];
      return info;
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

  /**
   * Open the HTTPS connection and check the key (GET /key: no model call, no cost).
   * @returns {Promise<{ok: true, ms: number, usage_usd: number|null, usage_daily_usd: number|null, limit_remaining_usd: number|null, is_free_tier: boolean|null}>}
   * Throws OrError (auth/payment/network/timeout/server).
   */
  async warmup({ timeoutMs = this.opts.warmupTimeoutMs } = {}) {
    const t0 = this._now();
    let res;
    try {
      res = await this._getKeyInfo(AbortSignal.timeout(timeoutMs));
    } catch (e) {
      const err =
        e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? new OrError('timeout', `no answer from OpenRouter within ${timeoutMs} ms`, { retryable: true })
          : toOrError(e);
      this._log('or.warmup', { ok: false, kind: err.kind, message: err.message, ms: this._now() - t0 });
      throw err;
    }
    const ms = this._now() - t0;
    if (!res.ok) {
      const err = await orHttpError(res);
      this._log('or.warmup', { ok: false, status: res.status, kind: err.kind, message: err.message, ms });
      throw err;
    }
    let d = {};
    try {
      d = JSON.parse(new TextDecoder('utf-8').decode(await res.arrayBuffer()))?.data ?? {};
    } catch {
      // key info is informational only
    }
    const info = {
      ok: true,
      ms,
      usage_usd: finiteOrNull(d.usage),
      usage_daily_usd: finiteOrNull(d.usage_daily),
      limit_remaining_usd: finiteOrNull(d.limit_remaining),
      is_free_tier: typeof d.is_free_tier === 'boolean' ? d.is_free_tier : null,
    };
    this._log('or.warmup', { ...info, model: this.model, voice: this.voice });
    return info;
  }

  stats() {
    const t = this._stats.ttfa;
    return {
      provider: 'openrouter',
      model: this.model,
      voice: this.voice,
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
      audio_ms: Math.round(this._stats.audio_bytes / BYTES_PER_MS),
      cost_usd: Math.round(this._stats.cost_usd * 1e8) / 1e8,
      ttfa_ms: t.length ? { last: t.at(-1), avg: Math.round(t.reduce((s, x) => s + x, 0) / t.length), max: Math.max(...t), n: t.length } : null,
    };
  }

  /** Abort everything; pending readouts fail with reason 'closed'; later calls fail too. */
  close() {
    this._closed = true;
    const all = [...this._live.queue, ...this._render.queue, ...(this._live.active ? [this._live.active] : []), ...this._render.active];
    for (const r of all) this._finish(r, 'failed', { reason: 'closed' });
  }

  // ---- internals -----------------------------------------------------------------------------

  _newReadout(kind, text, o) {
    this._seq += 1;
    const r = {
      id: `${kind === 'live' ? 'say' : 'clip'}-${this._seq}-${this._tag}`,
      kind,
      text: typeof text === 'string' ? text.trim() : '',
      o,
      state: 'new', // new | sent | streaming | done
      t_call: this._now(),
      t_first_sent: null,
      t_sent: null,
      t_headers: null,
      t_first_audio: null,
      t_cancel: null,
      controller: null,
      cancelRequested: false,
      attempts: 0,
      responseId: null,
      responseModel: null,
      upstream: null,
      usage: null,
      finishReason: null,
      audioBytes: 0,
      carry: null,
      droppedAfterCancel: 0,
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

  _launch(r) {
    if (r.kind === 'live' && r.o.maxAgeMs != null && this._now() - r.t_call > r.o.maxAgeMs) {
      this._finish(r, 'failed', { reason: 'stale' });
      return;
    }
    this._run(r).catch((err) => this._finish(r, 'failed', { reason: 'internal', error: err }));
  }

  async _run(r) {
    const retries = r.kind === 'live' ? this.opts.liveRetries : this.opts.clipRetries;
    let retriesUsed = 0;
    for (;;) {
      r.attempts++;
      try {
        await this._attempt(r);
        return;
      } catch (e) {
        if (r.state === 'done') return; // cancelled / closed / timed out meanwhile
        const err = toOrError(e);
        this._clearTimers(r);
        if (err.kind === 'bad_request' && this._sendUsage && /\busage\b/i.test(err.message)) {
          this._sendUsage = false; // retry at once without usage accounting
          this._log('or.error', { phase: 'tts', id: r.id, kind: err.kind, status: err.status ?? null, message: err.message, dropped_field: 'usage' });
          continue;
        }
        if (err.retryable && !r.t_first_audio && retriesUsed < retries && !this._closed) {
          retriesUsed++;
          this._log('or.error', { phase: 'tts', id: r.id, attempt: r.attempts, kind: err.kind, status: err.status ?? null, message: err.message, retry: true });
          await sleep(this.opts.retryBackoffMs);
          if (r.state === 'done') return;
          continue;
        }
        this._finish(r, 'failed', { reason: err.kind, error: err });
        return;
      }
    }
  }

  async _attempt(r) {
    const controller = new AbortController();
    r.controller = controller;
    const body = buildTtsRequest(r.text, {
      model: this.model,
      voice: this.voice,
      instructions: this._instructions,
      maxOutputTokens: r.o.maxOutputTokens,
      usage: this._sendUsage,
    });
    r.state = 'sent';
    r.t_sent = this._now();
    r.t_first_sent ??= r.t_sent;
    if (r.kind === 'live') this._timer(r, this.opts.firstAudioTimeoutMs, () => this._abort(r, 'no_audio'));
    this._timer(r, this.opts.doneTimeoutMs, () => this._abort(r, 'timeout'));
    let res;
    try {
      res = await this._post(JSON.stringify(body), controller.signal);
    } catch (e) {
      if (controller.signal.aborted) throw controller.signal.reason ?? e;
      throw toOrError(e);
    }
    if (r.state === 'done') return;
    r.t_headers = this._now();
    if (!res.ok) throw await orHttpError(res);
    if (/event-stream/i.test(res.headers.get('content-type') ?? '')) await this._readSse(r, res);
    else await this._readJson(r, res);
    if (r.state === 'done') return;
    if (!r.audioBytes) throw new OrError('no_audio', 'response carried no audio', { retryable: true });
    this._finish(r, 'completed');
  }

  async _readSse(r, res) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let ended = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          ended = true;
          break;
        }
        if (r.state === 'done') return;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          this._onLine(r, line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) this._onLine(r, buffer.replace(/\r$/, ''));
    } finally {
      if (!ended) reader.cancel().catch(() => {});
    }
  }

  async _readJson(r, res) {
    const data = JSON.parse(new TextDecoder('utf-8').decode(await res.arrayBuffer()));
    if (data?.error) throw new OrError('server', `error: ${clip(data.error.message ?? JSON.stringify(data.error), 200)}`, { retryable: true });
    this._onChunk(r, data);
  }

  _onLine(r, line) {
    if (!line || line[0] === ':' || !line.startsWith('data:')) return; // keep-alives (": OPENROUTER PROCESSING"), event:, id:
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    this._onChunk(r, chunk);
  }

  _onChunk(r, chunk) {
    if (chunk?.error) {
      throw new OrError('stream_error', `stream error: ${clip(chunk.error.message ?? JSON.stringify(chunk.error), 200)}`, {
        retryable: !r.t_first_audio,
        status: Number(chunk.error.code) || undefined,
      });
    }
    if (chunk.id && !r.responseId) r.responseId = chunk.id;
    if (chunk.provider) r.upstream = chunk.provider;
    if (chunk.model) r.responseModel = chunk.model;
    if (chunk.usage) r.usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const audio = choice.delta?.audio ?? choice.message?.audio;
      if (audio) {
        if (typeof audio.transcript === 'string' && audio.transcript) r.transcriptParts.push(audio.transcript);
        if (typeof audio.data === 'string' && audio.data) this._onAudio(r, audio.data);
      }
      if (choice.finish_reason) r.finishReason = choice.finish_reason;
    }
  }

  _onAudio(r, b64) {
    if (r.state === 'done' || r.cancelRequested) {
      r.droppedAfterCancel++;
      return;
    }
    let buf = Buffer.from(b64, 'base64');
    let aligned = !r.carry && buf.length % 2 === 0;
    if (r.carry) {
      buf = Buffer.concat([r.carry, buf]);
      r.carry = null;
    }
    if (buf.length % 2) {
      r.carry = Buffer.from(buf.subarray(buf.length - 1));
      buf = buf.subarray(0, buf.length - 1);
      aligned = false;
    }
    if (!buf.length) return;
    r.audioBytes += buf.length;
    if (!r.t_first_audio) {
      r.t_first_audio = this._now();
      r.state = 'streaming';
      if (r.o.onStart) safe(() => r.o.onStart({ id: r.id, ttfa_ms: r.t_first_audio - r.t_sent, t: r.t_first_audio }), this, 'onStart');
    }
    if (r.kind === 'clip') {
      r.chunks.push(Buffer.from(buf));
    } else if (r.o.onAudio) {
      const chunk = r.o.format === 'buffer' ? Buffer.from(buf) : aligned ? b64 : buf.toString('base64');
      safe(() => r.o.onAudio(chunk), this, 'onAudio');
    }
  }

  _timer(r, ms, fn) {
    if (!ms) return;
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    r.timers.push(timer);
  }

  _clearTimers(r) {
    for (const timer of r.timers) clearTimeout(timer);
    r.timers = [];
  }

  _abort(r, reason) {
    if (r.state === 'done') return;
    if (reason === 'no_audio' && r.t_first_audio) return;
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
    this._finish(r, 'cancelled', r.t_first_audio ? {} : { reason: 'before_audio' });
    return r.done;
  }

  _finish(r, status, { reason, error } = {}) {
    if (r.state === 'done') return;
    r.state = 'done';
    this._clearTimers(r);
    if (status !== 'completed' && r.controller && !r.controller.signal.aborted) r.controller.abort(new OrError('aborted', `readout ${status}`)); // stops the HTTP stream
    const tDone = this._now();
    const transcript = r.transcriptParts.length ? r.transcriptParts.join('') : null;
    const cost = typeof r.usage?.cost === 'number' ? r.usage.cost : null;
    const result = {
      id: r.id,
      kind: r.kind,
      status,
      ...(reason ? { reason } : {}),
      response_id: r.responseId,
      model: r.responseModel ?? this.model,
      upstream: r.upstream,
      ttfa_ms: r.t_first_audio != null && r.t_sent != null ? r.t_first_audio - r.t_sent : null,
      headers_ms: r.t_headers != null && r.t_sent != null ? r.t_headers - r.t_sent : null,
      audio_ms: Math.round(r.audioBytes / BYTES_PER_MS),
      wait_ms: r.t_first_sent != null ? r.t_first_sent - r.t_call : null,
      attempts: r.attempts,
      usage: r.usage,
      cost_usd: cost,
      transcript,
      verbatim: null,
      similarity: null,
      finish_reason: r.finishReason,
      t_call: r.t_call,
      t_sent: r.t_sent,
      t_first_audio: r.t_first_audio,
      t_done: tDone,
      ...(r.cancelRequested ? { cancel_ms: tDone - r.t_cancel, dropped_after_cancel: r.droppedAfterCancel } : {}),
      ...(error ? { error: { code: error.kind ?? error.code, message: clip(error.message, 300), ...(error.status ? { status: error.status } : {}) } } : {}),
    };
    if (status === 'completed') {
      const v = compareVerbatim(r.text, transcript ?? '');
      result.verbatim = v.match;
      result.similarity = v.similarity;
      if (!v.match) {
        this._stats.verbatim_mismatch++;
        this._log('or.verbatim_mismatch', { id: r.id, kind: r.kind, expected: r.text, got: transcript, similarity: v.similarity });
      }
    }
    this._stats[status]++;
    this._stats.audio_bytes += r.audioBytes;
    if (cost != null) this._stats.cost_usd += cost;
    if (result.ttfa_ms != null) {
      this._stats.ttfa.push(result.ttfa_ms);
      if (this._stats.ttfa.length > 200) this._stats.ttfa.shift();
    }
    this._log('or.readout', {
      id: r.id,
      kind: r.kind,
      status,
      ...(reason ? { reason } : {}),
      model: result.model,
      voice: this.voice,
      ttfa_ms: result.ttfa_ms,
      headers_ms: result.headers_ms,
      audio_ms: result.audio_ms,
      wait_ms: result.wait_ms,
      attempts: r.attempts,
      chars: r.text.length,
      verbatim: result.verbatim,
      cost_usd: cost,
      prompt_tokens: r.usage?.prompt_tokens,
      completion_tokens: r.usage?.completion_tokens,
      text: r.text.length > 200 ? `${r.text.slice(0, 199)}…` : r.text,
      ...(r.o?.meta ? { meta: r.o.meta } : {}),
      ...(result.error ? { error: result.error } : {}),
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
    if (r.o?.onEnd) safe(() => r.o.onEnd(result), this, 'onEnd');
    r.resolve(result);
    if (r.kind === 'live') this._pumpLive();
    else this._pumpRender();
  }

  _pumpLive() {
    while (!this._closed && !this._live.active && this._live.queue.length) {
      const next = this._live.queue.shift();
      this._live.active = next;
      this._launch(next); // may finish at once ('stale') and pump again
    }
  }

  _pumpRender() {
    while (!this._closed && this._render.active.size < this.opts.renderConcurrency && this._render.queue.length) {
      const next = this._render.queue.shift();
      this._render.active.add(next);
      this._launch(next);
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
    mouth._log('or.error', { phase: 'callback', where, message: err?.message });
  }
}

function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex');
}

function finiteOrNull(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
