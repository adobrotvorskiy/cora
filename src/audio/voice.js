// Voice provider factory (WP3b): ears + mouth for the provider named by settings.voice.provider.
//
//   const voice = createVoice({ settings, log });
//   await voice.connect();            // openrouter: key check, warm HTTPS connection, STT language anchor
//                                     // (one ~1 s TTS render); openai_realtime: WS handshake
//   voice.ears.pushAudio(pcm);        // same events for both providers (ears.js / or_ears.js)
//   voice.mouth.say(text, {...});     // same say()/renderClip()/cancel contract (mouth.js / or_mouth.js)
//   await voice.close();
//
// Providers (docs/voice_providers.md):
//   'openrouter' (default)  or_ears.js (energy VAD + /audio/transcriptions) + or_mouth.js
//                           (/chat/completions with gpt-audio(-mini)); key settings.keys.openrouter
//                           (Cora_KEY); models settings.voice.tts_model / stt_model / voice.
//   'openai_realtime'       one Realtime WS session (realtime_ws.js) shared by ears.js + mouth.js;
//                           key settings.keys.openai; models from settings.realtime.
//   'yandex_cascade'        yandex_ears.js (SpeechKit STT, a session per SFU slot) + yandex_mouth.js
//                           (SpeechKit TTS); key settings.keys.yandex, folder settings.yandex.folder,
//                           voice settings.yandex.tts; the brain is Yandex AI Studio (brain/client.js).
// The shared OPENROUTER_API_KEY is refused (same rule as brain/client.js).
// cacheKey identifies what the audio sounds like (provider, model, voice, instructions hash): clips
// rendered by one provider/model must not be replayed by another.

import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { requireKey } from '../env.js';
import { createEars } from './ears.js';
import { createElevenMouth } from './eleven_mouth.js';
import { createMouth } from './mouth.js';
import { DEFAULT_ANCHOR_TEXT, DEFAULT_STT_MODEL, createOrEars } from './or_ears.js';
import { createOrMouth, DEFAULT_TTS_MODEL } from './or_mouth.js';
import { RealtimeSession, loadPeople } from './realtime_ws.js';
import { createYandexEars } from './yandex_ears.js';
import { createYandexMouth, TTS_DEFAULTS } from './yandex_mouth.js';

export const VOICE_PROVIDERS = Object.freeze(['openrouter', 'openai_realtime', 'elevenlabs_agent', 'yandex_rt', 'yandex_cascade']);
export const VOICE_DEFAULTS = Object.freeze({
  provider: 'openrouter',
  tts_model: DEFAULT_TTS_MODEL,
  stt_model: DEFAULT_STT_MODEL,
  voice: 'shimmer',
});
/** Env names the host must never use: the shared OpenRouter key belongs to other tools. */
const FORBIDDEN_KEY_NAMES = ['OPENROUTER_API_KEY'];
/** OpenRouter errors that retrying connect() cannot fix. */
const FATAL_CONNECT = new Set(['auth', 'payment', 'model_unavailable', 'bad_request']);

/**
 * Which provider, key NAME and models the settings select (no key values; safe for --check).
 * @returns {{provider: 'openrouter'|'openai_realtime', keyRole: 'openrouter'|'openai', keyName: string, tts_model: string, stt_model: string, voice: string}}
 */
export function selectVoiceProvider(settings = {}) {
  const v = { ...VOICE_DEFAULTS, ...definedOf(settings.voice) };
  if (!VOICE_PROVIDERS.includes(v.provider)) throw new Error(`voice: unknown provider "${v.provider}" (expected ${VOICE_PROVIDERS.join('|')})`);
  const keys = settings.keys ?? {};
  const keyRole = v.provider === 'openrouter' ? 'openrouter' : v.provider === 'elevenlabs_agent' ? 'elevenlabs' : v.provider === 'yandex_rt' || v.provider === 'yandex_cascade' ? 'yandex' : 'openai';
  const keyName = keys[keyRole];
  if (typeof keyName !== 'string' || !keyName) throw new Error(`voice: settings.keys.${keyRole} must name an env variable`);
  if (FORBIDDEN_KEY_NAMES.includes(keyName)) throw new Error(`voice: settings.keys.${keyRole} names the shared ${keyName}; the standup host must use its own key`);
  if (v.provider === 'yandex_rt') {
    // Yandex AI Studio Realtime: ears + brain + voice in one WS session; the folder id is a second secret
    const folderName = keys.yandex_folder;
    if (typeof folderName !== 'string' || !folderName) throw new Error('voice: settings.keys.yandex_folder must name an env variable (cloud folder id)');
    return { provider: v.provider, keyRole, keyName, folderName, tts_model: 'speechkit-rt', stt_model: 'speechkit-streaming', voice: settings.yandex?.voice ?? 'alena', llm: 'speech-realtime-250923' };
  }
  if (v.provider === 'yandex_cascade') {
    // ears = SpeechKit STT per SFU slot, brain = Yandex AI Studio (brain.provider 'yandex'), mouth = SpeechKit TTS
    // (settings.yandex.cascade_mouth 'elevenlabs' keeps the ElevenLabs «Настя» voice instead)
    const y = settings.yandex ?? {};
    if (typeof y.folder !== 'string' || !y.folder) throw new Error('voice: settings.yandex.folder must be the cloud folder id (settings.local.json)');
    const tts = { ...TTS_DEFAULTS, ...definedOf(y.tts) };
    const eleven = y.cascade_mouth === 'elevenlabs';
    return {
      provider: v.provider,
      keyRole: 'yandex',
      keyName,
      folder: y.folder,
      mouth: eleven ? 'elevenlabs' : 'speechkit',
      tts_model: eleven ? (v.eleven_tts_model ?? 'eleven_flash_v2_5') : 'speechkit-tts-v3',
      stt_model: `speechkit-stt-v3/${y.stt_model ?? 'general'}`,
      voice: eleven ? (v.eleven_voice_id ?? '') : `${tts.voice}${tts.role ? `/${tts.role}` : ''} x${tts.speed}`,
      llm: settings.brain?.yandex_model ?? 'aliceai-llm-flash/latest',
    };
  }
  if (v.provider === 'openrouter') return { provider: v.provider, keyRole, keyName, tts_model: v.tts_model, stt_model: v.stt_model, voice: v.voice };
  if (v.provider === 'elevenlabs_agent') {
    // the agent is hearing + brain + voice in one; the host drives it through src/core/agent_host.js
    return { provider: v.provider, keyRole, keyName, tts_model: v.eleven_tts_model ?? 'eleven_flash_v2_5', stt_model: 'scribe_realtime', voice: v.eleven_voice_id ?? '', agent_id: v.eleven_agent_id ?? null, llm: v.eleven_llm ?? null };
  }
  const rt = settings.realtime ?? {};
  return {
    provider: v.provider,
    keyRole,
    keyName,
    tts_model: rt.model ?? 'gpt-realtime-2.1',
    stt_model: rt.transcribe_model ?? 'gpt-live-transcribe',
    voice: rt.voice ?? 'shimmer',
  };
}

/**
 * @param {object} opts
 * @param {object} opts.settings        loadSettings() result
 * @param {{event: Function}} [opts.log]
 * @param {{openrouter?: string, openai?: string} | ((role: string, envName: string) => string)} [opts.keys]
 *        key VALUES (tests, or a caller that already resolved them); default env.requireKey(settings.keys.<role>)
 * @param {object} [opts.env]           env for requireKey (default process.env + repo .env files)
 * @param {Function} [opts.fetch]       fetch for the OpenRouter provider (tests)
 * @param {object[]} [opts.people]      people.json entries (transcription prompt); default loadPeople()
 * @param {() => number} [opts.now]
 * @param {object} [opts.ears]          extra options for the ears constructor (e.g. {stt, vad} for OpenRouter)
 * @param {object} [opts.mouth]         extra options for the mouth constructor
 * @returns {{kind: string, selection: object, ears: object, mouth: object, instructions: string, cacheKey: string,
 *   connect: () => Promise<object>, close: () => Promise<void>, stats: () => object, session?: RealtimeSession}}
 */
export function createVoice({ settings = {}, log, keys, env = process.env, fetch, people, now, ears: earsOpts = {}, mouth: mouthOpts = {} } = {}) {
  const selection = selectVoiceProvider(settings);
  if (selection.provider === 'elevenlabs_agent') {
    throw new Error('voice: the elevenlabs_agent provider has no ears/mouth cascade; the agent host (src/core/agent_host.js) drives it');
  }
  const apiKey = resolveKey(selection, keys, env);
  const ppl = people ?? loadPeople();
  const clock = now ? { now } : {};
  const logEvent = (type, fields) => {
    try {
      log?.event?.(type, fields);
    } catch {
      // logging must never break voice
    }
  };
  logEvent('voice.init', { provider: selection.provider, key: selection.keyName, tts_model: selection.tts_model, stt_model: selection.stt_model, voice: selection.voice });

  if (selection.provider === 'openrouter') {
    const httpOpts = fetch ? { fetch } : {};
    const ears = createOrEars({ settings, apiKey, log, people: ppl, ...httpOpts, ...clock, ...earsOpts });
    const mouth = createOrMouth({ settings, apiKey, log, ...httpOpts, ...clock, ...mouthOpts });
    return {
      kind: 'openrouter',
      selection,
      ears,
      mouth,
      instructions: mouth.instructions,
      cacheKey: mouth.cacheKey,
      connect: async () => {
        const info = await connectOpenRouter(mouth, logEvent);
        return { ...info, anchor: await ensureAnchor(ears, mouth, settings, logEvent) };
      },
      close: async () => {
        ears.close();
        mouth.close();
      },
      stats: () => {
        const e = ears.stats();
        const m = mouth.stats();
        return { kind: 'openrouter', ears: e, mouth: m, cost_usd: round8((e.cost_usd ?? 0) + (m.cost_usd ?? 0)) };
      },
    };
  }

  if (selection.provider === 'yandex_cascade') {
    const y = settings.yandex ?? {};
    const httpOpts = fetch ? { fetch } : {};
    const eou = { ...(y.eou ? { eou: y.eou } : {}), ...(Number.isFinite(y.pause_hint_ms) ? { pauseHintMs: y.pause_hint_ms } : {}) };
    const ears = createYandexEars({ apiKey, folderId: selection.folder, model: y.stt_model ?? 'general', ...eou, log, ...clock, ...earsOpts });
    const mouth =
      selection.mouth === 'elevenlabs'
        ? createElevenMouth({ apiKey: requireKey(settings.keys?.elevenlabs, env), voiceId: settings.voice?.eleven_voice_id, log, ...httpOpts, ...clock, ...mouthOpts })
        : createYandexMouth({ apiKey, folderId: selection.folder, tts: y.tts, pricing: y.tts_pricing, usdRub: settings.cost?.usd_rub, log, ...httpOpts, ...clock, ...mouthOpts });
    return {
      kind: 'yandex_cascade',
      selection,
      ears,
      mouth,
      instructions: mouth.instructions,
      cacheKey: mouth.cacheKey,
      // one short render proves the key, the folder and the TTS role before we join the room
      connect: async () => {
        const clockNow = now ?? Date.now;
        const t0 = clockNow();
        const pcm = await mouth.renderClip('Итак.');
        return { provider: 'yandex_cascade', mouth: selection.mouth, tts_ms: clockNow() - t0, tts_bytes: pcm.length };
      },
      close: async () => {
        ears.close();
        await mouth.close();
      },
      stats: () => {
        const m = mouth.stats();
        // SpeechKit TTS requests (live lines, prefetches, clip renders); STT is not priced here
        return { kind: 'yandex_cascade', ears: ears.stats(), mouth: m, cost_usd: typeof m.cost_usd === 'number' ? m.cost_usd : 0 };
      },
    };
  }

  const session = new RealtimeSession({ settings, apiKey, people: ppl, log, ...clock });
  const ears = createEars(session, { log, ...clock, ...earsOpts });
  const mouth = createMouth(session, { log, ...clock, ...mouthOpts });
  const instructions = session.instructions;
  return {
    kind: 'openai_realtime',
    selection,
    session,
    ears,
    mouth,
    instructions,
    cacheKey: `openai_realtime|${selection.tts_model}|${selection.voice}|${sha1(instructions).slice(0, 12)}`,
    connect: () => session.connect(),
    close: async () => {
      ears.close();
      mouth.close();
      await session.close();
    },
    stats: () => ({ kind: 'openai_realtime', session: session.stats(), ears: ears.stats(), mouth: mouth.stats() }),
  };
}

/** Key check + warm connection; retries transient failures (3 tries), fails at once on auth/payment. */
async function connectOpenRouter(mouth, logEvent) {
  const delays = [0, 500, 1000];
  let last = null;
  for (const [i, delay] of delays.entries()) {
    if (delay) await sleep(delay);
    try {
      const info = await mouth.warmup();
      return { provider: 'openrouter', attempts: i + 1, ...info };
    } catch (err) {
      last = err;
      logEvent('voice.connect_error', { attempt: i + 1, kind: err?.kind, status: err?.status ?? null, message: err?.message });
      if (FATAL_CONNECT.has(err?.kind)) break;
    }
  }
  throw last;
}

/**
 * Render the STT language anchor with our own voice, once (or_ears.setAnchor explains why).
 * settings.voice.stt_anchor: text to say (default «Итак.») or false. Failure only costs accuracy on
 * one-word answers (fixLatinShort still maps «Da.» -> «Да.»), so it is logged, not thrown.
 */
async function ensureAnchor(ears, mouth, settings, logEvent) {
  const cfg = settings.voice?.stt_anchor;
  if (cfg === false || ears.anchor) return ears.anchor;
  const text = typeof cfg === 'string' && cfg.trim() ? cfg.trim() : DEFAULT_ANCHOR_TEXT;
  try {
    const pcm = await mouth.renderClip(text, { meta: { purpose: 'stt_anchor' } });
    ears.setAnchor({ pcm, text });
    return ears.anchor;
  } catch (err) {
    logEvent('voice.anchor_error', { code: err?.code ?? err?.kind ?? null, message: err?.message });
    return null;
  }
}

function resolveKey(selection, keys, env) {
  if (typeof keys === 'function') {
    const value = keys(selection.keyRole, selection.keyName);
    if (typeof value === 'string' && value.trim()) return value.trim();
  } else if (keys && typeof keys === 'object') {
    const value = keys[selection.keyRole];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return requireKey(selection.keyName, env);
}

function definedOf(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex');
}

function round8(x) {
  return Math.round(x * 1e8) / 1e8;
}
