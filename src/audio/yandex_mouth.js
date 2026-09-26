// Yandex SpeechKit TTS v3 (REST utteranceSynthesis) — the mouth of the yandex_cascade provider.
// The server streams newline-delimited JSON with base64 PCM chunks; a standup line (~4 s of speech)
// arrives in one chunk ~150–300 ms after the request, so no text-input streaming is needed.
// Same contract as OrMouth: say(text, {onAudio, onStart, onEnd, format}) -> {id, done, cancel},
// renderClip(text) -> Buffer (PCM16 mono 24 kHz, the page player's rate), cacheKey, stats().

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

export const TTS_URL = 'https://tts.api.cloud.yandex.net/tts/v3/utteranceSynthesis';
export const TTS_DEFAULTS = Object.freeze({ voice: 'alena', role: 'good', speed: 1.1 });
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
   */
  constructor({ apiKey, folderId = null, tts = {}, log = null, fetch = globalThis.fetch, now = Date.now, timeoutMs = 6000 } = {}) {
    super();
    if (!apiKey) throw new Error('createYandexMouth: apiKey is required');
    this._key = apiKey; // only this object holds it; nothing dumps `this`
    this._folder = folderId;
    this._tts = { ...TTS_DEFAULTS, ...definedOf(tts) };
    this._log = log;
    this._fetch = fetch;
    this._now = now;
    this._timeoutMs = timeoutMs;
    this._seq = 0;
    this._closed = false;
    this._inflight = new Set();
    this._stats = { say: 0, clips: 0, completed: 0, cancelled: 0, failed: 0, chars: 0, audio_ms: 0, ttfa: [] };
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
    const run = async () => {
      let first = null;
      let bytes = 0;
      try {
        await this._synthesize(clean, ctl.signal, (pcm) => {
          if (cancelled) return;
          if (first === null) {
            first = this._now();
            this._stats.ttfa.push(first - t0);
            safe(() => onStart?.({ id, ttfa_ms: first - t0, t: first }));
          }
          bytes += pcm.length;
          safe(() => onAudio?.(format === 'buffer' ? pcm : pcm.toString('base64')));
        });
      } catch (e) {
        if (cancelled) return this._end({ status: 'cancelled', ttfa_ms: first === null ? null : first - t0, audio_ms: msOf(bytes) }, onEnd);
        this._stats.failed++;
        const err = e instanceof Error ? e : new Error(String(e));
        this._event('mouth.error', { id, chars: clean.length, code: err.code ?? null, message: err.message.slice(0, 200) });
        safe(() => onEnd?.({ status: 'failed', error: err.message }));
        throw err;
      }
      this._stats.chars += clean.length;
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
        return done.catch(() => {});
      },
    };
  }

  /** One-shot render for the clip cache: Buffer, PCM16 mono 24 kHz. */
  async renderClip(text) {
    const clean = String(text ?? '').trim();
    if (!clean) return Buffer.alloc(0);
    if (this._closed) throw Object.assign(new Error('mouth closed'), { code: 'closed' });
    const parts = [];
    await this._synthesize(clean, AbortSignal.timeout(this._timeoutMs * 2), (pcm) => parts.push(pcm));
    this._stats.clips++;
    this._stats.chars += clean.length;
    return Buffer.concat(parts);
  }

  async close() {
    this._closed = true;
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
      audio_ms: this._stats.audio_ms,
      ttfa_ms: t.length ? { last: t.at(-1), p50: p50(t), max: Math.max(...t), n: t.length } : null,
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
