// ElevenLabs TTS via the stream-input WebSocket — the optional mouth of yandex_cascade
// (settings.yandex.cascade_mouth 'elevenlabs': the «Настя» voice instead of SpeechKit): say() streams
// PCM 24 kHz chunks to onAudio as they arrive (~200–300 ms to first audio), renderClip() is the
// one-shot REST render for the clip cache. Same mouth contract as OrMouth.

import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';

const DEFAULT_MODEL = 'eleven_flash_v2_5';
const TTS_WS = (voiceId, model) => `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?model_id=${model}&output_format=pcm_24000`;

export function createElevenMouth(opts = {}) {
  return new ElevenMouth(opts);
}

export class ElevenMouth extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey         ElevenLabs key (keys.elevenlabs env; never logged)
   * @param {string} opts.voiceId        voice id (Настя: YjESejviApN7SHrbfnA2)
   * @param {string} [opts.model]        eleven_flash_v2_5
   * @param {{event: Function}} [opts.log]
   * @param {Function} [opts.fetch]
   * @param {Function} [opts.WebSocket]
   * @param {() => number} [opts.now]
   */
  constructor({ apiKey, voiceId, model = DEFAULT_MODEL, log = null, fetch = globalThis.fetch, WebSocket: WS = WebSocket, now = Date.now } = {}) {
    super();
    if (!apiKey) throw new Error('createElevenMouth: apiKey is required');
    if (!voiceId) throw new Error('createElevenMouth: voiceId is required');
    this._key = apiKey; // never logged: only this object holds it, and nothing dumps `this`
    this._voiceId = voiceId;
    this._model = model;
    this._logger = log;
    this._fetch = fetch;
    this._WS = WS;
    this._now = now;
    this._instructions = 'elevenlabs-ws';
    this._seq = 0;
    this._closed = false;
    this._stats = { say: 0, clips: 0, completed: 0, cancelled: 0, failed: 0, audio_bytes: 0, ttfa: [] };
  }

  get busy() {
    return false; // each say() gets its own WS; the player serializes playback anyway
  }
  get instructions() {
    return 'elevenlabs-ws';
  }
  get cacheKey() {
    return `elevenlabs|${this._model}|${this._voiceId}|${createHash('sha1').update(this._instructions).digest('hex').slice(0, 12)}`;
  }

  /**
   * Say `text` verbatim, streaming audio to onAudio (base64 PCM16 24 kHz) as it arrives.
   * @returns {{id: string, done: Promise, cancel: Function}}
   */
  say(text, { onAudio, onStart, onEnd, format = 'b64' } = {}) {
    const id = `el_${++this._seq}`;
    const clean = String(text ?? '').trim();
    if (!clean) return { id, done: Promise.resolve({ status: 'completed', audio_ms: 0 }), cancel: () => {} };
    if (this._closed) return { id, done: Promise.reject(Object.assign(new Error('mouth closed'), { code: 'closed' })), cancel: () => {} };
    this._stats.say++;
    const t0 = this._now();
    let ws = null;
    let settled = false;
    let audioBytes = 0;
    let started = false;
    const done = new Promise((resolve, reject) => {
      const finish = (r) => {
        if (settled) return;
        settled = true;
        this._stats.completed++;
        resolve(r);
      };
      const fail = (e) => {
        if (settled) return;
        settled = true;
        this._stats.failed++;
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      try {
        ws = new this._WS(TTS_WS(this._voiceId, this._model), { headers: { 'xi-api-key': this._key }, handshakeTimeout: 8000 });
      } catch (e) {
        fail(e);
        return;
      }
      ws.on('open', () => {
        ws.send(JSON.stringify({ text: ' ', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }));
        ws.send(JSON.stringify({ text: clean, try_trigger_generation: true }));
        ws.send(JSON.stringify({ text: '' })); // end-of-input
      });
      ws.on('message', (d) => {
        let m;
        try { m = JSON.parse(d.toString()); } catch { return; }
        if (m.error || m.detail?.status === 'quota_exceeded') {
          fail(new Error(String(m.error ?? m.detail?.message ?? 'elevenlabs error').slice(0, 160)));
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        if (m.audio) {
          if (!started) {
            started = true;
            this._stats.ttfa.push(this._now() - t0);
            onStart?.({ id, ttfa_ms: this._now() - t0, t: this._now() });
          }
          audioBytes += Math.floor((m.audio.length * 3) / 4);
          this._stats.audio_bytes += Math.floor((m.audio.length * 3) / 4);
          onAudio?.(format === 'buffer' ? Buffer.from(m.audio, 'base64') : m.audio);
        }
        if (m.isFinal) {
          finish({ status: 'completed', audio_ms: Math.round(audioBytes / 48) });
          onEnd?.({ status: 'completed', audio_ms: Math.round(audioBytes / 48) });
          try { ws.close(); } catch { /* ignore */ }
        }
      });
      ws.on('error', fail);
      ws.on('close', () => {
        if (!settled && started) finish({ status: 'completed', audio_ms: Math.round(audioBytes / 48) });
        else if (!settled) finish({ status: 'aborted', audio_ms: 0 });
      });
    });
    return {
      id,
      done,
      cancel: () => {
        try { ws?.close(); } catch { /* ignore */ }
        return done;
      },
    };
  }

  /** One-shot REST render for the clip cache: returns Buffer (PCM16 24 kHz). */
  async renderClip(text) {
    const res = await this._fetch(`https://api.elevenlabs.io/v1/text-to-speech/${this._voiceId}?output_format=pcm_24000`, {
      method: 'POST',
      headers: { 'xi-api-key': this._key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: this._model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    if (!res.ok) throw new Error(`elevenlabs tts ${res.status}: ${(await res.text()).slice(0, 160)}`);
    this._stats.clips++;
    return Buffer.from(await res.arrayBuffer());
  }

  async close() {
    this._closed = true;
  }

  stats() {
    return { ...this._stats, ttfa_p50: p50(this._stats.ttfa) };
  }
}

function p50(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
