// Yandex SpeechKit v3 streaming STT (gRPC RecognizeStreaming), one recognition session per remote
// audio track of the page. Telemost forwards the room through a few SFU slots (2 on the 23.09 live
// standup with 6 people): a slot carries whoever the SFU picked, so a session per slot separates
// people talking over each other, and the host names the speaker from the DOM (core/attribution.js).
//
// The page sends a slot's chunks only while it has sound (worklets.js, with a pre-roll and a short
// tail); after a phrase we stream tailMs of zero PCM in real time so the end-of-utterance detector
// fires. Measured 26.09: zero PCM + EOU HIGH with a 500 ms pause hint -> final ~0.9 s after the
// speech; silence_chunk is ignored by the detector (the final only came when the stream closed).
// A session opens on the first chunk of a track and closes after idleCloseMs without sound (or at
// the next pause after maxSessionMs).
//
// Events (the cascade host consumes the same surface as or_ears.js, minus VAD):
//   'stt_delta' {item_id, track_id, so_far, t}
//   'stt_final' {item_id, track_id, text, t, t_speech_start, t_speech_end}   wall ms
//   'stt_error' {track_id, message}                                          never fatal

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resample24to16 } from './resample.js';

const PROTO_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'proto');
export const STT_ENDPOINT = 'stt.api.cloud.yandex.net:443';
export const EARS_DEFAULTS = Object.freeze({
  model: 'general',
  chunkMs: 100, // page chunk cadence (page_inject DEFAULT_OPTS.chunkMs)
  gapMs: 150, // no chunk for this long -> the track went quiet: start the zero tail
  tailMs: 1500, // zero PCM streamed after the last chunk (the EOU detector needs ~0.9 s of it)
  eou: 'HIGH', // DEFAULT waits ~3 s of silence; HIGH + the pause hint finalizes in ~0.9 s
  pauseHintMs: 500,
  idleCloseMs: 8000, // close a session this long after its last chunk
  maxSessionMs: 280_000, // rotate before SpeechKit's 5-minute stream limit, at a pause
  tickMs: 100,
});

/** Session options for one mono 16 kHz track. */
export function sessionOptions({ model = EARS_DEFAULTS.model, eou = EARS_DEFAULTS.eou, pauseHintMs = EARS_DEFAULTS.pauseHintMs } = {}) {
  return {
    recognition_model: {
      model,
      audio_format: { raw_audio: { audio_encoding: 'LINEAR16_PCM', sample_rate_hertz: 16000, audio_channel_count: 1 } },
      text_normalization: { text_normalization: 'TEXT_NORMALIZATION_DISABLED', profanity_filter: false, literature_text: false },
      language_restriction: { restriction_type: 'WHITELIST', language_code: ['ru-RU'] },
      audio_processing_type: 'REAL_TIME',
    },
    eou_classifier: { default_classifier: { type: eou, ...(pauseHintMs ? { max_pause_between_words_hint_ms: pauseHintMs } : {}) } },
  };
}

let grpcRecognizer = null;
/** Default transport: one gRPC channel for all sessions (proto loaded on first use). */
async function defaultClientFactory(endpoint) {
  if (!grpcRecognizer) {
    const [{ default: grpc }, { default: protoLoader }] = await Promise.all([import('@grpc/grpc-js'), import('@grpc/proto-loader')]);
    const require = createRequire(import.meta.url);
    const def = protoLoader.loadSync('yandex/cloud/ai/stt/v3/stt_service.proto', {
      includeDirs: [PROTO_ROOT, dirname(require.resolve('protobufjs/package.json'))],
      keepCase: true,
      enums: String,
      longs: Number,
      defaults: false,
      oneofs: true,
    });
    grpcRecognizer = { grpc, Recognizer: grpc.loadPackageDefinition(def).speechkit.stt.v3.Recognizer };
  }
  const { grpc, Recognizer } = grpcRecognizer;
  const client = new Recognizer(endpoint, grpc.credentials.createSsl(), { 'grpc.keepalive_time_ms': 20_000 });
  return {
    open(headers) {
      const meta = new grpc.Metadata();
      for (const [k, v] of Object.entries(headers)) meta.add(k, v);
      return client.RecognizeStreaming(meta);
    },
    close: () => client.close(),
  };
}

/**
 * @param {object} o
 * @param {string} o.apiKey              Yandex Cloud API key (never logged)
 * @param {string} [o.folderId]
 * @param {{event: Function}} [o.log]
 * @param {() => number} [o.now]
 * @param {(endpoint: string) => Promise<{open: (headers: object) => object, close: () => void}>} [o.clientFactory]  tests
 */
export function createYandexEars({ apiKey, folderId = null, log = null, now = Date.now, endpoint = STT_ENDPOINT, clientFactory = defaultClientFactory, ...opts } = {}) {
  if (!apiKey) throw new Error('yandex_ears: apiKey is required');
  const o = { ...EARS_DEFAULTS, ...opts };
  const em = new EventEmitter();
  const sessions = new Map(); // track id -> session
  const stats = { sessions_opened: 0, audio_ms: 0, silence_ms: 0, finals: 0, errors: 0 };
  let clientP = null;
  let seq = 0;
  let closed = false;

  const ev = (type, fields) => {
    try {
      log?.event?.(type, fields);
    } catch {
      // logging must never break the ears
    }
  };
  const client = () => (clientP ??= Promise.resolve().then(() => clientFactory(endpoint)));

  function openSession(trackId, at) {
    const s = {
      id: ++seq,
      trackId,
      call: null,
      pending: [], // requests written before the gRPC call exists
      dead: false,
      openedAt: at,
      lastChunkAt: at,
      cursorMs: 0, // audio time sent so far (chunks + silence)
      silenceMs: 0, // zero tail streamed since the last chunk
      segments: [], // {audio, wall}: audio offset -> wall clock anchors, one per chunk
      finals: 0,
    };
    const headers = { authorization: `Api-Key ${apiKey}`, ...(folderId ? { 'x-folder-id': folderId } : {}) };
    client()
      .then((c) => {
        if (s.dead) return;
        s.call = c.open(headers);
        s.call.on('data', (r) => onResponse(s, r));
        s.call.on('error', (e) => onDead(s, e));
        s.call.on('end', () => onDead(s, null));
        for (const req of s.pending) s.call.write(req);
        s.pending = null;
      })
      .catch((e) => onDead(s, e));
    stats.sessions_opened++;
    ev('stt.session_open', { track_id: trackId, session: s.id });
    write(s, { session_options: sessionOptions(o) });
    return s;
  }

  function write(s, req) {
    if (s.dead) return;
    if (s.call) {
      try {
        s.call.write(req);
      } catch (e) {
        onDead(s, e);
      }
    } else s.pending.push(req);
  }

  function onDead(s, err) {
    if (s.dead && !err) return;
    const wasDead = s.dead;
    s.dead = true;
    if (sessions.get(s.trackId) === s) sessions.delete(s.trackId);
    // CANCELLED is our own end(); anything else is worth a line
    const msg = err ? String(err.details ?? err.message ?? err).slice(0, 200) : null;
    if (err && err.code !== 1 && !wasDead) {
      stats.errors++;
      ev('stt.error', { track_id: s.trackId, session: s.id, code: err.code ?? null, message: msg });
      em.emit('stt_error', { track_id: s.trackId, message: msg });
    }
  }

  function end(s, reason) {
    if (s.dead) return;
    s.dead = true;
    if (sessions.get(s.trackId) === s) sessions.delete(s.trackId);
    ev('stt.session_close', { track_id: s.trackId, session: s.id, reason, audio_ms: s.cursorMs, finals: s.finals });
    try {
      s.call?.end();
    } catch {
      // already gone
    }
  }

  /** Session audio offset -> wall ms (the last anchor at or before it, extrapolated). */
  function wallOf(s, audioMs) {
    let a = s.segments[0];
    for (const seg of s.segments) {
      if (seg.audio > audioMs) break;
      a = seg;
    }
    return a ? Math.round(a.wall + (audioMs - a.audio)) : null;
  }

  function onResponse(s, r) {
    const t = now();
    const alt = (u) => u?.alternatives?.[0] ?? null;
    if (r.partial) {
      const a = alt(r.partial);
      const text = String(a?.text ?? '').trim();
      if (text) em.emit('stt_delta', { item_id: `${s.trackId}#${s.id}.${s.finals + 1}`, track_id: s.trackId, so_far: text, t });
      return;
    }
    if (r.final) {
      const a = alt(r.final);
      const text = String(a?.text ?? '').trim();
      if (!text) return;
      s.finals++;
      stats.finals++;
      // proto3 leaves zero out of the message: a missing start_time_ms is the start of the stream
      const start = wallOf(s, Number(a.start_time_ms ?? 0) || 0);
      const stop = Number.isFinite(Number(a.end_time_ms)) ? wallOf(s, Number(a.end_time_ms)) : null;
      em.emit('stt_final', { item_id: `${s.trackId}#${s.id}.${s.finals}`, track_id: s.trackId, text, t, t_speech_start: start, t_speech_end: stop, latency_ms: stop ? t - stop : null });
      return;
    }
    if (r.status_code && r.status_code.code_type && r.status_code.code_type !== 'WORKING') {
      ev('stt.status', { track_id: s.trackId, session: s.id, code: r.status_code.code_type, message: String(r.status_code.message ?? '').slice(0, 200) });
    }
  }

  /**
   * One page chunk of one track: Int16Array 24 kHz mono (page_inject onTrackAudio).
   * @param {Int16Array|Buffer} pcm
   * @param {string} trackId
   */
  function pushAudio(pcm, trackId) {
    if (closed || typeof trackId !== 'string' || !trackId || !pcm?.length) return;
    const at = now();
    let s = sessions.get(trackId);
    if (!s || s.dead) {
      s = openSession(trackId, at);
      sessions.set(trackId, s);
    }
    const samples = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    const pcm16 = resample24to16(samples);
    const ms = Math.round((samples.length / 24000) * 1000);
    // the chunk ended at ~`at`: anchor its start in wall time
    s.segments.push({ audio: s.cursorMs, wall: at - ms });
    if (s.segments.length > 600) s.segments.splice(0, s.segments.length - 600);
    write(s, { chunk: { data: Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength) } });
    s.cursorMs += ms;
    s.lastChunkAt = at;
    s.silenceMs = 0;
    stats.audio_ms += ms;
  }

  const timer = setInterval(() => {
    const t = now();
    for (const s of [...sessions.values()]) {
      const quietFor = t - s.lastChunkAt;
      if (quietFor >= o.idleCloseMs) {
        end(s, 'idle');
        continue;
      }
      if (t - s.openedAt >= o.maxSessionMs && quietFor >= 1000) {
        end(s, 'rotate');
        continue;
      }
      // stream the gap as zero PCM (in real time) until the tail is covered
      if (quietFor >= o.gapMs && s.silenceMs < o.tailMs) {
        const due = Math.min(o.tailMs, quietFor) - s.silenceMs;
        if (due >= 20) {
          if (s.silenceMs === 0) s.segments.push({ audio: s.cursorMs, wall: s.lastChunkAt });
          write(s, { chunk: { data: Buffer.alloc(due * 32) } }); // 16 kHz PCM16: 32 bytes per ms
          s.silenceMs += due;
          s.cursorMs += due;
          stats.silence_ms += due;
        }
      }
    }
  }, o.tickMs);
  timer.unref?.();

  return Object.assign(em, {
    pushAudio,
    /** All tracks ended (the room emptied): let the open utterances finalize. */
    flush() {
      for (const s of sessions.values()) s.lastChunkAt = Math.min(s.lastChunkAt, now() - o.gapMs);
    },
    close() {
      closed = true;
      clearInterval(timer);
      for (const s of [...sessions.values()]) end(s, 'close');
      sessions.clear();
      clientP?.then((c) => c.close?.()).catch(() => {});
    },
    stats: () => ({ provider: 'speechkit_stt', open: sessions.size, ...stats }),
  });
}
