// Optional-module loading for the host (WP6): the voice (WP3b src/audio/voice.js, else the WP3
// OpenAI realtime session, else a deaf-mute stub), the player (WP4 src/audio/player.js when it
// exists, else the fallback below on top of the WP2 PageAudio handle) and the clip store.
// Every fallback implements the same interface the host codes against, so swapping a module
// in later is a file drop, not a host change.
//
//   voice:  {kind, ears, mouth, connect(), close(), stats()}
//           ears  = EventEmitter: 'vad' {type:'start'|'stop', t}, 'stt_delta' {so_far, text, t},
//                   'stt_final' {text, t, t_speech_start, t_speech_end}, 'reset'; pushAudio(pcm, {t})
//           mouth = say(text, {onAudio, format, onStart, onEnd}) -> {done, cancel}; renderClip(text);
//                   cancelAll(); busy; identity (for the clip cache)
//   player: play(pcm | AsyncIterable, {meta}) -> {id, done, abort}; isSpeaking(); on('state', fn);
//           onPageEvent(ev) (player.* events from the page adapter); stats()
//   clips:  ClipStore (src/audio/clips.js)

import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hasKey, requireKey } from '../env.js';

export const NO_VOICE_KIND = 'none';

/**
 * Load the voice. Order: src/audio/voice.js (WP3b) -> OpenAI realtime (WP3, needs
 * settings.keys.openai) -> stub (no ears, no mouth; the host still runs on DOM + timers).
 */
export async function loadVoice({ settings, log, purpose = 'host' } = {}) {
  const emit = (type, fields) => {
    try {
      log?.event?.(type, fields);
    } catch {
      // never
    }
  };
  const voiceUrl = new URL('../audio/voice.js', import.meta.url);
  if (existsSync(fileURLToPath(voiceUrl))) {
    try {
      const mod = await import(voiceUrl.href);
      if (typeof mod.createVoice !== 'function') throw new Error('voice.js has no createVoice export');
      const v = await mod.createVoice({ settings, log });
      if (!v?.mouth || !v?.ears) throw new Error('createVoice() returned no ears/mouth');
      emit('voice.loaded', { kind: v.kind ?? 'voice', module: 'src/audio/voice.js', purpose, cache_key: v.cacheKey ?? null, selection: v.selection ?? null });
      return {
        kind: v.kind ?? 'voice',
        ears: v.ears,
        mouth: v.mouth,
        connect: async () => (typeof v.connect === 'function' ? v.connect() : undefined),
        close: async () => {
          for (const fn of [() => v.mouth?.close?.(), () => v.ears?.close?.(), () => v.close?.()]) {
            try {
              await fn();
            } catch {
              // best effort
            }
          }
        },
        stats: () => ({ kind: v.kind ?? 'voice', ...(typeof v.stats === 'function' ? v.stats() : {}), ears: v.ears?.stats?.() ?? null, mouth: v.mouth?.stats?.() ?? null }),
        raw: v,
      };
    } catch (e) {
      emit('voice.error', { module: 'src/audio/voice.js', message: e?.message ?? String(e) });
      if (settings?.voice?.provider && settings.voice.provider !== 'openai_realtime') throw e;
    }
  }
  const keyName = settings?.keys?.openai;
  if (keyName && hasKey(keyName)) {
    const [{ RealtimeSession, loadPeople }, { createEars }, { createMouth }] = await Promise.all([
      import('../audio/realtime_ws.js'),
      import('../audio/ears.js'),
      import('../audio/mouth.js'),
    ]);
    const session = new RealtimeSession({ settings, apiKey: requireKey(keyName), people: loadPeople(), log, maxAttempts: 2 });
    const ears = createEars(session, { log });
    const mouth = createMouth(session, { log });
    emit('voice.loaded', { kind: 'openai_realtime', module: 'src/audio/realtime_ws.js' });
    return {
      kind: 'openai_realtime',
      ears,
      mouth,
      session,
      connect: () => session.connect(),
      close: async () => {
        try {
          mouth.close();
        } catch {
          // ignore
        }
        try {
          ears.close();
        } catch {
          // ignore
        }
        await session.close().catch(() => {});
      },
      stats: () => ({ kind: 'openai_realtime', session: session.stats(), ears: ears.stats(), mouth: mouth.stats() }),
    };
  }
  emit('voice.missing', { reason: 'no src/audio/voice.js and no OpenAI key: the host runs deaf and mute' });
  return stubVoice();
}

/** A voice that hears nothing and cannot speak; say()/renderClip() fail with code 'no_voice'. */
export function stubVoice() {
  const ears = new EventEmitter();
  ears.pushAudio = () => false;
  ears.speaking = false;
  ears.stats = () => ({ stub: true });
  ears.close = () => {};
  const fail = () => {
    const err = Object.assign(new Error('no voice available'), { code: 'no_voice' });
    const done = Promise.reject(err);
    done.catch(() => {});
    return { id: 'stub', done, cancel: () => done };
  };
  const mouth = {
    say: fail,
    renderClip: () => Promise.reject(Object.assign(new Error('no voice available'), { code: 'no_voice' })),
    cancelAll: () => Promise.resolve([]),
    busy: false,
    identity: null,
    stats: () => ({ stub: true }),
    close: () => {},
  };
  return { kind: NO_VOICE_KIND, ears, mouth, connect: async () => {}, close: async () => {}, stats: () => ({ kind: NO_VOICE_KIND }) };
}

/**
 * Load the player: src/audio/player.js (WP4) when it exports Player/createPlayer, else the
 * fallback below. Both take {audio (PageAudio), log}.
 */
export async function loadPlayer({ page, audio, log } = {}) {
  const url = new URL('../audio/player.js', import.meta.url);
  if (existsSync(fileURLToPath(url))) {
    try {
      const mod = await import(url.href);
      const make = typeof mod.createPlayer === 'function' ? mod.createPlayer : typeof mod.Player === 'function' ? (o) => new mod.Player(o) : null;
      if (make) {
        const p = make({ page, audio, log, logSpeech: false }); // the host writes speech.* itself
        if (typeof p.play === 'function' && typeof p.isSpeaking === 'function') {
          log?.event?.('player.loaded', { module: 'src/audio/player.js' });
          if (typeof p.onPageEvent !== 'function') p.onPageEvent = () => {};
          return p;
        }
      }
      log?.event?.('player.fallback', { reason: 'src/audio/player.js has no compatible Player/createPlayer' });
    } catch (e) {
      log?.event?.('player.fallback', { reason: e?.message ?? String(e) });
    }
  }
  return createPlayer({ audio, log });
}

const BYTES_PER_MS = 48;

/**
 * Fallback player over the WP2 page API: one utterance at a time, exact end via __host_playEnd +
 * player.drained, abort via __host_flush, barge-in ratio = played_ms / total_ms.
 */
export function createPlayer({ audio, log = null, now = Date.now, doneTimeoutMs = 4000 } = {}) {
  const em = new EventEmitter();
  let current = null;
  let seq = 0;
  let flushing = null; // pending __host_flush(): the next playback waits for it (the worklet drops pushes racing a flush)
  const stats = { utterances: 0, completed: 0, aborted: 0, failed: 0, underruns: 0, played_ms: 0 };
  const emit = (type, fields) => {
    try {
      log?.event?.(type, fields);
    } catch {
      // never
    }
  };

  function toB64(chunk) {
    if (typeof chunk === 'string') return chunk;
    if (Buffer.isBuffer(chunk)) return chunk.toString('base64');
    if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('base64');
    if (chunk instanceof ArrayBuffer) return Buffer.from(chunk).toString('base64');
    return null;
  }

  function chunkMs(chunk) {
    if (typeof chunk === 'string') return Math.round((chunk.length * 3) / 4 / BYTES_PER_MS);
    const bytes = Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk) ? chunk.byteLength : chunk instanceof ArrayBuffer ? chunk.byteLength : 0;
    return Math.round(bytes / BYTES_PER_MS);
  }

  function setSpeaking(on, u) {
    em.emit('state', { speaking: on, id: u?.id ?? null, meta: u?.meta ?? null });
  }

  function finish(u, status, extra = {}) {
    if (u.finished) return;
    u.finished = true;
    clearTimeout(u.timer);
    const t = now();
    const playedMs = extra.played_ms ?? u.played_ms ?? (status === 'completed' ? u.total_ms : 0);
    const result = {
      id: u.id,
      status,
      meta: u.meta,
      source: u.source,
      total_ms: u.total_ms,
      played_ms: playedMs,
      played_ratio: u.total_ms > 0 ? Math.min(1, Math.round((playedMs / u.total_ms) * 1000) / 1000) : status === 'completed' ? 1 : 0,
      ttfa_ms: u.t_started != null ? u.t_started - u.t_call : null,
      underruns: u.underruns,
      t_call: u.t_call,
      t_start: u.t_started,
      t_end: t,
      ...(extra.error ? { error: extra.error } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
    };
    stats[status === 'completed' ? 'completed' : status === 'aborted' ? 'aborted' : 'failed']++;
    stats.played_ms += playedMs;
    if (current === u) current = null;
    setSpeaking(false, u);
    u.resolve(result);
  }

  async function pump(u, src) {
    try {
      if (flushing) await flushing.catch(() => {});
      if (u.aborting || u.finished) return;
      if (typeof src === 'string' || Buffer.isBuffer(src) || ArrayBuffer.isView(src) || src instanceof ArrayBuffer) {
        u.total_ms = chunkMs(src);
        await audio.play(toB64(src));
      } else if (src && typeof src[Symbol.asyncIterator] === 'function') {
        u.source = u.source ?? 'live';
        for await (const chunk of src) {
          if (u.aborting || u.finished) break;
          const b64 = toB64(chunk);
          if (!b64) continue;
          u.total_ms += chunkMs(chunk);
          await audio.play(b64);
        }
      } else {
        throw new Error('player.play: unsupported source');
      }
      if (u.aborting || u.finished) return;
      u.eos = true;
      await audio.playEnd();
      u.timer = setTimeout(() => finish(u, 'completed', { reason: 'drain_timeout' }), Math.max(doneTimeoutMs, u.total_ms - (u.played_ms ?? 0) + doneTimeoutMs));
      u.timer.unref?.();
    } catch (e) {
      if (u.aborting || u.finished) return;
      emit('player.error', { id: u.id, message: e?.message ?? String(e) });
      finish(u, 'failed', { error: e?.message ?? String(e) });
    }
  }

  /**
   * @param {Buffer|Int16Array|string|AsyncIterable} src  whole clip (PCM16 24 kHz / base64) or a chunk stream
   * @param {{meta?: object, source?: string}} [o]
   * @returns {{id: string, done: Promise<object>, abort: (reason?: string) => Promise<object>}}
   */
  function play(src, { meta = null, source } = {}) {
    if (current) {
      emit('player.preempt', { id: current.id, by: seq + 1 });
      current.abort('preempted');
    }
    const u = {
      id: `utt-${++seq}`,
      meta,
      source: source ?? (typeof src === 'string' || Buffer.isBuffer(src) || ArrayBuffer.isView(src) ? 'clip' : 'live'),
      t_call: now(),
      t_started: null,
      total_ms: 0,
      played_ms: null,
      underruns: 0,
      eos: false,
      aborting: false,
      finished: false,
      timer: null,
      resolve: null,
    };
    u.done = new Promise((resolve) => {
      u.resolve = resolve;
    });
    u.abort = async (reason = 'abort') => {
      if (u.finished || u.aborting) return u.done;
      u.aborting = true;
      let flushed = null;
      const f = Promise.resolve().then(() => audio.flush());
      flushing = f.finally(() => {
        if (flushing === f) flushing = null;
      });
      try {
        flushed = await f;
      } catch (e) {
        emit('player.error', { id: u.id, where: 'flush', message: e?.message ?? String(e) });
      }
      finish(u, 'aborted', { played_ms: flushed?.played_ms ?? u.played_ms ?? 0, reason });
      return u.done;
    };
    current = u;
    stats.utterances++;
    setSpeaking(true, u);
    void pump(u, src);
    return { id: u.id, done: u.done, abort: u.abort };
  }

  /** Feed page adapter events (player.started / underrun / drained / aborted). */
  function onPageEvent(ev) {
    const u = current;
    if (!u || !ev || typeof ev.type !== 'string') return;
    switch (ev.type) {
      case 'player.started':
        if (u.t_started == null) u.t_started = now();
        break;
      case 'player.underrun':
        u.underruns++;
        stats.underruns++;
        break;
      case 'player.drained':
        if (typeof ev.played_ms === 'number') u.played_ms = ev.played_ms;
        if (u.eos) finish(u, 'completed', { reason: ev.reason });
        break;
      case 'player.aborted':
        if (typeof ev.played_ms === 'number') u.played_ms = ev.played_ms;
        if (u.aborting) finish(u, 'aborted', { played_ms: ev.played_ms });
        break;
      default:
        break;
    }
  }

  return {
    play,
    onPageEvent,
    isSpeaking: () => current !== null,
    current: () => (current ? { id: current.id, meta: current.meta, source: current.source, total_ms: current.total_ms } : null),
    abort: (reason) => (current ? current.abort(reason) : Promise.resolve(null)),
    on: (type, fn) => {
      em.on(type, fn);
      return () => em.off(type, fn);
    },
    stats: () => ({ ...stats }),
  };
}

/** The clip store (WP4). Returns null (and logs) when phrases/people cannot be loaded. */
export async function loadClips({ settings, mouth, log } = {}) {
  try {
    const { ClipStore } = await import('../audio/clips.js');
    return new ClipStore({ settings, mouth, log });
  } catch (e) {
    log?.event?.('clips.unavailable', { message: e?.message ?? String(e) });
    return null;
  }
}
