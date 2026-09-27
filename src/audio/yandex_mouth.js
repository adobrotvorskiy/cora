// Yandex SpeechKit TTS v3 (REST utteranceSynthesis) — the mouth of the yandex_cascade provider.
// The server streams newline-delimited JSON with base64 PCM chunks; a standup line (~4 s of speech)
// arrives in one chunk ~150–300 ms after the request, so no text-input streaming is needed.
// Same contract as OrMouth: say(text, {onAudio, onStart, onEnd, format}) -> {id, done, cancel},
// renderClip(text) -> Buffer (PCM16 mono 24 kHz, the page player's rate), cacheKey, stats().
// prefetch(text) synthesizes a line ahead (the brain's `text` is out while it still writes `plan`);
// a say() of the same text within PREFETCH_TTL_MS plays that audio instead of a new request.
// Cost: API v3 bills every request by 250-character units (TTS_PRICING); stats().cost_usd counts
// all requests (say, prefetch, renderClip), renderClip(text, {withInfo: true}) returns its cost_usd.

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

export const TTS_URL = 'https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis';
export const TTS_DEFAULTS = Object.freeze({ voice: 'alena', role: 'good', speed: 1.1 });
/**
 * SpeechKit API v3 synthesis price (Yandex Cloud tariff, 2026, VAT incl.): 0.1626 ₽ per request of up to
 * 250 characters; a longer request counts as ceil(chars / 250). settings.yandex.tts_pricing overrides.
 */
export const TTS_PRICING = Object.freeze({ rub_per_unit: 0.1626, chars_per_unit: 250 });
const USD_RUB = 90; // the host's default settings.cost.usd_rub
const SAMPLE_RATE = 24000;
const STRESSED_VOWEL = /([аеёиоуыэюяАЕЁИОУЫЭЮЯ])́/g;

/**
 * people.json / phrases carry stress as U+0301 after the vowel («Ти́ма»); SpeechKit marks it with
 * «+» before the vowel («Р+ома»). Other combining accents are dropped.
 */
export function toSpeechKitText(text) {
  // NFC keeps «й»/«ё» whole; a Cyrillic vowel + U+0301 has no composed form, so it stays a pair
  return String(text ?? '').normalize('NFC').replace(STRESSED_VOWEL, '+$1').replace(/[̀́]/g, '');
}
/** SpeechKit refuses a single utterance longer than ~250 chars unless unsafe mode splits it. */
const SAFE_CHARS = 240;
/** A prefetched line waits this long for its say() (the host may hold it for a quiet room ~8 s). */
export const PREFETCH_TTL_MS = 20_000;
const PREFETCH_MAX = 3;

export function createYandexMouth(opts = {}) {
  return new YandexMouth(opts);
}

export class YandexMouth extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey          Yandex Cloud API key (never logged)
   * @param {string} [opts.folderId]      cloud folder (x-folder-id)
   * @param {{voice?: string, role?: string|null, speed?: number}} [opts.tts]  settings.yandex.tts
   * @param {{event: Function}} [opts.log]
   * @param {Function} [opts.fetch]
   * @param {() => number} [opts.now]
   * @param {number} [opts.timeoutMs]     no first audio within this -> failed
   * @param {{rub_per_unit?: number, chars_per_unit?: number}} [opts.pricing]  settings.yandex.tts_pricing
   * @param {number} [opts.usdRub]        settings.cost.usd_rub (costs are reported in USD like other providers)
   */
  constructor({ apiKey, folderId = null, tts = {}, log = null, fetch = globalThis.fetch, now = Date.now, timeoutMs = 6000, pricing = null, usdRub = USD_RUB } = {}) {
    super();
    if (!apiKey) throw new Error('createYandexMouth: apiKey is required');
    this._key = apiKey; // only this object holds it; nothing dumps `this`
    this._folder = folderId;
    this._tts = { ...TTS_DEFAULTS, ...definedOf(tts) };
    this._log = log;
    this._fetch = fetch;
    this._now = now;
    this._timeoutMs = timeoutMs;
    this._pricing = { ...TTS_PRICING, ...definedOf(pricing) };
    this._usdRub = Number(usdRub) > 0 ? Number(usdRub) : USD_RUB;
    this._seq = 0;
    this._closed = false;
    this._inflight = new Set();
    this._prefetched = new Map(); // text -> {at, ctl, parts: Promise<Buffer[]>}
    this._stats = { say: 0, clips: 0, completed: 0, cancelled: 0, failed: 0, chars: 0, units: 0, audio_ms: 0, ttfa: [], prefetch: { started: 0, used: 0, unused: 0, failed: 0 } };
  }

  get busy() {
    return false; // every say() is its own request; the player serializes playback
  }
  get instructions() {
    const { voice, role, speed } = this._tts;
    return `speechkit|${voice}|${role ?? '-'}|${speed}`;
  }
  get cacheKey() {
    return `yandex_tts|${sha1(this.instructions).slice(0, 12)}`;
  }
  /** Clip cache identity (clips.js identityFromMouth): another voice, role or speed is another cache. */
  get identity() {
    return { provider: 'yandex_tts', model: 'speechkit-tts-v3', voice: this._tts.voice, instructions: this.instructions };
  }

  /**
   * Say `text` verbatim; audio goes to onAudio as base64 PCM16 24 kHz (or Buffer with format 'buffer').
   * @returns {{id: string, done: Promise<{status: 'completed'|'cancelled', ttfa_ms: number|null, audio_ms: number}>, cancel: () => Promise}}
   */
  say(text, { onAudio, onStart, onEnd, format = 'b64' } = {}) {
    const id = `sk_${++this._seq}`;
    const clean = String(text ?? '').trim();
    if (!clean) return { id, done: Promise.resolve({ status: 'completed', ttfa_ms: null, audio_ms: 0 }), cancel: async () => {} };
    if (this._closed) return { id, done: Promise.reject(Object.assign(new Error('mouth closed'), { code: 'closed' })), cancel: async () => {} };
    this._stats.say++;
    const ctl = new AbortController();
    let cancelled = false;
    const t0 = this._now();
    const ahead = this._takePrefetched(clean);
    const run = async () => {
      let first = null;
      let bytes = 0;
      const feed = (pcm) => {
        if (cancelled) return;
        if (first === null) {
          first = this._now();
          this._stats.ttfa.push(first - t0);
          safe(() => onStart?.({ id, ttfa_ms: first - t0, t: first, prefetched: Boolean(ahead) }));
        }
        bytes += pcm.length;
        safe(() => onAudio?.(format === 'buffer' ? pcm : pcm.toString('base64')));
      };
      try {
        const parts = ahead ? await this._awaitPrefetched(ahead, ctl.signal) : null;
        if (parts) {
          this._stats.prefetch.used++;
          for (const pcm of parts) feed(pcm);
        } else {
          await this._synthesize(clean, ctl.signal, feed);
          this._billed(clean);
        }
      } catch (e) {
        if (cancelled) return this._end({ status: 'cancelled', ttfa_ms: first === null ? null : first - t0, audio_ms: msOf(bytes) }, onEnd);
        this._stats.failed++;
        const err = e instanceof Error ? e : new Error(String(e));
        this._event('mouth.error', { id, chars: clean.length, code: err.code ?? null, message: err.message.slice(0, 200) });
        safe(() => onEnd?.({ status: 'failed', error: err.message }));
        throw err;
      }
      if (cancelled) return this._end({ status: 'cancelled', ttfa_ms: first === null ? null : first - t0, audio_ms: msOf(bytes) }, onEnd);
      this._stats.audio_ms += msOf(bytes);
      return this._end({ status: 'completed', ttfa_ms: first === null ? null : first - t0, audio_ms: msOf(bytes) }, onEnd);
    };
    const done = run().finally(() => this._inflight.delete(entry));
    const entry = { ctl, done };
    this._inflight.add(entry);
    return {
      id,
      done,
      cancel: () => {
        cancelled = true;
        ctl.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
        ahead?.ctl.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
        return done.catch(() => {});
      },
    };
  }

  /**
   * Start synthesizing `text` now; a say() of the same text within PREFETCH_TTL_MS uses it. Idempotent
   * per text; at most PREFETCH_MAX lines are kept (the oldest is dropped). Never throws.
   * @returns {boolean} true if a new synthesis started
   */
  prefetch(text) {
    const clean = String(text ?? '').trim();
    if (!clean || this._closed) return false;
    this._expirePrefetched();
    if (this._prefetched.has(clean)) return false;
    while (this._prefetched.size >= PREFETCH_MAX) this._dropPrefetched(this._prefetched.keys().next().value);
    const ctl = new AbortController();
    const parts = [];
    const entry = { at: this._now(), ctl, parts: null };
    entry.parts = this._synthesize(clean, ctl.signal, (pcm) => parts.push(pcm)).then(
      () => {
        this._billed(clean);
        return parts;
      },
      (e) => {
        if (!ctl.signal.aborted) {
          this._stats.prefetch.failed++;
          this._event('mouth.prefetch_error', { chars: clean.length, code: e?.code ?? null, message: String(e?.message ?? e).slice(0, 200) });
        }
        return null; // say() falls back to a fresh request
      },
    );
    this._prefetched.set(clean, entry);
    this._stats.prefetch.started++;
    return true;
  }

  _takePrefetched(clean) {
    this._expirePrefetched();
    const entry = this._prefetched.get(clean);
    if (entry) this._prefetched.delete(clean);
    return entry ?? null;
  }

  /** The prefetched audio, or null (failed / cancelled) so say() synthesizes afresh. */
  async _awaitPrefetched(entry, signal) {
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([entry.parts, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  _expirePrefetched() {
    const t = this._now();
    for (const [text, e] of this._prefetched) if (t - e.at > PREFETCH_TTL_MS) this._dropPrefetched(text);
  }

  _dropPrefetched(text) {
    const e = this._prefetched.get(text);
    if (!e) return;
    this._prefetched.delete(text);
    this._stats.prefetch.unused++;
    e.ctl.abort(Object.assign(new Error('prefetch dropped'), { code: 'cancelled' }));
  }

  /** One-shot render for the clip cache: Buffer, PCM16 mono 24 kHz; with {withInfo: true} {pcm, audio_ms, cost_usd}. */
  async renderClip(text, { withInfo = false } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) return withInfo ? { pcm: Buffer.alloc(0), audio_ms: 0, cost_usd: 0 } : Buffer.alloc(0);
    if (this._closed) throw Object.assign(new Error('mouth closed'), { code: 'closed' });
    const parts = [];
    await this._synthesize(clean, AbortSignal.timeout(this._timeoutMs * 2), (pcm) => parts.push(pcm));
    this._stats.clips++;
    const costUsd = this._billed(clean);
    const pcm = Buffer.concat(parts);
    return withInfo ? { pcm, audio_ms: msOf(pcm.length), cost_usd: costUsd } : pcm;
  }

  /** USD cost of synthesizing `text` once (API v3: per started 250-character unit). */
  costUsd(text) {
    const units = Math.ceil(String(text ?? '').trim().length / this._pricing.chars_per_unit);
    return (units * this._pricing.rub_per_unit) / this._usdRub;
  }

  /** Count one successful synthesis request; returns its USD cost. */
  _billed(clean) {
    this._stats.chars += clean.length;
    this._stats.units += Math.ceil(clean.length / this._pricing.chars_per_unit);
    return this.costUsd(clean);
  }

  async close() {
    this._closed = true;
    for (const text of [...this._prefetched.keys()]) this._dropPrefetched(text);
    for (const e of this._inflight) e.ctl.abort(Object.assign(new Error('mouth closed'), { code: 'closed' }));
  }

  stats() {
    const t = this._stats.ttfa;
    return {
      provider: 'yandex_tts',
      voice: this._tts.voice,
      role: this._tts.role ?? null,
      say: this._stats.say,
      clips: this._stats.clips,
      completed: this._stats.completed,
      cancelled: this._stats.cancelled,
      failed: this._stats.failed,
      chars: this._stats.chars,
      units: this._stats.units,
      cost_usd: Math.round(((this._stats.units * this._pricing.rub_per_unit) / this._usdRub) * 1e6) / 1e6,
      audio_ms: this._stats.audio_ms,
      ttfa_ms: t.length ? { last: t.at(-1), p50: p50(t), max: Math.max(...t), n: t.length } : null,
      prefetch: { ...this._stats.prefetch },
    };
  }

  _end(result, onEnd) {
    this._stats[result.status === 'completed' ? 'completed' : 'cancelled']++;
    safe(() => onEnd?.(result));
    return result;
  }

  /** POST utteranceSynthesis and feed every audio chunk (Buffer) to onPcm as it arrives. */
  async _synthesize(text, signal, onPcm) {
    const { voice, role, speed } = this._tts;
    const body = {
      text: toSpeechKitText(text),
      hints: [{ voice }, ...(role ? [{ role }] : []), ...(speed && speed !== 1 ? [{ speed }] : [])],
      outputAudioSpec: { rawAudio: { audioEncoding: 'LINEAR16_PCM', sampleRateHertz: SAMPLE_RATE } },
      loudnessNormalizationType: 'LUFS',
      ...(text.length > SAFE_CHARS ? { unsafeMode: true } : {}),
    };
    const headers = { 'Content-Type': 'application/json', Authorization: `Api-Key ${this._key}` };
    if (this._folder) headers['x-folder-id'] = this._folder;
    const firstByte = AbortSignal.timeout(this._timeoutMs);
    const res = await this._fetch(TTS_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.any([signal, firstByte]) }).catch((e) => {
      throw signal.aborted ? signal.reason : Object.assign(new Error(`speechkit tts: ${e?.cause?.code ?? e?.message ?? e}`), { code: firstByte.aborted ? 'timeout' : 'network' });
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw Object.assign(new Error(`speechkit tts ${res.status}: ${detail}`), { code: res.status === 401 || res.status === 403 ? 'auth' : 'http', status: res.status });
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const handle = (line) => {
      if (!line.trim()) return;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        return;
      }
      if (j.error) throw Object.assign(new Error(`speechkit tts: ${String(j.error.message ?? JSON.stringify(j.error)).slice(0, 200)}`), { code: 'server' });
      const data = j.result?.audioChunk?.data;
      if (data) onPcm(Buffer.from(data, 'base64'));
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    handle(buf + dec.decode());
  }

  _event(type, fields) {
    try {
      this._log?.event?.(type, fields);
    } catch {
      // logging must never break the mouth
    }
  }
}

function msOf(bytes) {
  return Math.round((bytes / 2 / SAMPLE_RATE) * 1000);
}

function safe(fn) {
  try {
    fn();
  } catch {
    // a caller's callback must not break the readout
  }
}

function p50(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex');
}

function definedOf(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}
