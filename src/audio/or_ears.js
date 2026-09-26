// Ears over OpenRouter (WP3b): energy VAD (vad.js) + POST /api/v1/audio/transcriptions.
// Same public interface and events as the Realtime ears (ears.js), so the host does not care which
// provider runs (docs/voice_providers.md):
//
//   const ears = createOrEars({ settings, apiKey, log });
//   pageAudio.onAudio = (pcm) => ears.pushAudio(pcm);                // 100 ms PCM16 chunks, 24 kHz mono
//   ears.on('vad', ({ type, audio_ms, t, t_rx, item_id }) => ...);   // type 'start' | 'stop'
//   ears.on('stt_delta', ({ item_id, text, so_far, t }) => ...);     // running transcript during speech
//   ears.on('stt_final', ({ item_id, text, t, t_speech_start, t_speech_end, latency_ms }) => ...);
//   ears.on('stt_failed', ({ item_id, error, t }) => ...);
//   ears.on('reset', ({ reason, item_id, t }) => ...);               // close() mid-speech: no 'stop' will come
//
// Utterances. VAD start opens one (item_id "or_<tag>_<n>"); its audio begins preroll_ms before the
// onset. While speech continues, every partial_interval_ms the tail window since the previous one
// (overlap_ms back) is transcribed and stitched onto the running text -> stt_delta (so closers such
// as «у меня всё» show up before the turn ends). When a quiet run reaches early_final_ms, the final
// request starts speculatively: the whole utterance if it is <= full_max_ms, else the tail since the
// last window, stitched onto the running text. If the VAD then stops at that same point, that
// request IS the final (the 600 ms hangover and the STT call overlap); if speech resumes, its text
// becomes a delta. Without a usable speculative request the final starts at VAD stop.
// Utterances shorter than min_speech_ms are not sent: stt_final {text: '', skipped: 'too_short'}.
// stt_final.latency_ms = final emitted - end of speech (capture wall clock of the stop position).
//
// Requests: at most `concurrency` in flight (finals first), timeout_ms per attempt; finals are
// retried `retries` times on timeout/5xx/429/network errors, partial windows never (the next window
// covers the gap). A failed final -> stt_failed. pushAudio never waits for the network.
// Tail windows (partials, the final of a long utterance) are at least min_context_ms long.
// Language (measured 18.09.2026): OpenRouter does not pass `language`/`prompt` to
// gpt-4o-transcribe, which then guesses per request: short answers came back as «Da.»,
// «Cora, stop.», «Segundo.», a 2.7 s mid-phrase window in Serbian. Hence: (1) requests whose
// window starts at the utterance onset get a language anchor prepended (our own voice saying
// «Итак.», see setAnchor; stripped from the text); (2) short all-Latin answers are mapped to
// Cyrillic (fixLatinShort); (3) a transcript in a foreign script is requested again once (finals)
// or dropped (partials). Transcripts that only echo the prompt or are well-known silence
// hallucinations («Продолжение следует…», subtitle credits) are treated as empty.
// Time base: audio_ms = position in the stream pushed to these ears; t = capture wall time of that
// sample (pushAudio {t} = wall time of the chunk's last sample, default Date.now() at push).
// Log records: vad.start, vad.stop, stt.final, stt.failed, vad.reset (same types as ears.js),
// stt.delta (only with log_deltas), or.stt (one per transcription request, with cost), or.stt_error.
//
// Also exported: OpenRouter HTTP helpers shared with or_mouth.js (OrError, orHttpError, toOrError),
// encodeWav, transcribeOnce, and the text helpers stitchText, cleanTranscript, stripAnchor,
// fixLatinShort, isForeignScript.

import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { AudioTimeline } from './ears.js';
import { normalizeSpoken } from './mouth.js';
import { BYTES_PER_MS, SAMPLE_RATE, buildTranscriptionPrompt, loadPeople } from './realtime_ws.js';
import { EnergyVad, toPcmBuffer, vadOptions } from './vad.js';

export const OR_API_BASE = 'https://openrouter.ai/api/v1';
export const OR_STT_URL = `${OR_API_BASE}/audio/transcriptions`;
export const DEFAULT_STT_MODEL = 'openai/gpt-4o-transcribe';
/** Spoken by our own voice before utterance-start requests so the transcriber locks onto Russian. */
export const DEFAULT_ANCHOR_TEXT = 'Итак.';

export const EARS_DEFAULTS = Object.freeze({
  preroll_ms: 300, // audio before the VAD onset included in every request (settings.voice.vad)
  min_speech_ms: 200, // shorter utterances are not transcribed (settings.voice.vad); a clipped «да» is ~250 ms
  partial_interval_ms: 2500,
  overlap_ms: 500,
  full_max_ms: 12_000, // final re-transcribes the whole utterance up to this length
  early_final_ms: 250, // speculative final after this much quiet (0 = off; must be < vad.stop_ms)
  tail_pad_ms: 150, // audio after the end of speech included in the final
  min_context_ms: 4000, // tail windows are at least this long (a 2.7 s mid-phrase window came back in Serbian)
  min_window_ms: 800,
  max_window_ms: 20_000,
  anchor_gap_ms: 200, // silence between the language anchor and the utterance
  lang_retries: 1, // a final in a foreign script is requested again this many times
  concurrency: 2,
  timeout_ms: 6000,
  retries: 1,
  retry_backoff_ms: 200,
  buffer_ms: 30_000,
  stall_ms: 1500, // no audio for this long mid-utterance -> close it (reason 'stall')
  log_deltas: false,
});
const UTTERANCE_KEYS = ['preroll_ms', 'min_speech_ms'];
const ADAPTABLE_FIELDS = ['prompt', 'language', 'provider'];
// (no \b: it is ASCII-only in JS regexes and never matches next to Cyrillic letters)
const HALLUCINATION_RE = /^(?:продолжение следует|спасибо за просмотр|субтитры (?:сделал|создавал|делал|подготовил)(?: .*)?|редактор субтитров(?: .*)?|dimatorzok)$/;

// ---------------------------------------------------------------------------------------------
// OpenRouter HTTP helpers (shared with or_mouth.js)
// ---------------------------------------------------------------------------------------------

export class OrError extends Error {
  /** kind: auth | payment | model_unavailable | bad_request | rate_limit | server | timeout | network | bad_response | stream_error | no_audio | aborted */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'OrError';
    this.kind = kind;
    this.retryable = Boolean(extra.retryable);
    for (const [k, v] of Object.entries(extra)) if (k !== 'retryable' && v !== undefined) this[k] = v;
  }
}

/** OrError from a non-2xx response (message from OpenRouter's {error:{message}}; never the request). */
export async function orHttpError(res) {
  let text = '';
  try {
    text = new TextDecoder('utf-8').decode(await res.arrayBuffer());
  } catch {
    // unreadable body: the status is enough
  }
  let err = {};
  try {
    const parsed = JSON.parse(text);
    err = parsed?.error ?? parsed ?? {};
  } catch {
    // not JSON
  }
  const message = clip(String((typeof err === 'string' ? err : err.message) || text || res.statusText || ''), 300);
  const s = res.status;
  let kind;
  if (s === 401 || s === 403) kind = 'auth';
  else if (s === 402 || /insufficient (?:credits|balance|quota)|no credits/i.test(message)) kind = 'payment';
  else if (s === 404) kind = 'model_unavailable';
  else if (s === 408) kind = 'timeout';
  else if (s === 429) kind = 'rate_limit';
  else if (s >= 500) kind = 'server';
  else kind = 'bad_request';
  return new OrError(kind, `HTTP ${s}${message ? `: ${message}` : ''}`, {
    status: s,
    code: typeof err === 'object' && err ? err.code : undefined,
    retryable: kind === 'timeout' || kind === 'rate_limit' || kind === 'server',
  });
}

/** Any thrown value -> OrError (fetch TypeErrors become retryable network errors). */
export function toOrError(e) {
  if (e instanceof OrError) return e;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return new OrError('aborted', e.message || 'aborted');
  return new OrError('network', `fetch failed: ${e?.cause?.code ?? e?.message ?? e}`, { retryable: true });
}

/** PCM16 LE mono -> WAV file bytes. */
export function encodeWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * One transcription request (no retries). Throws OrError.
 * @returns {Promise<{text: string, usage: object|null, generation_id: string|null}>}
 */
export async function transcribeOnce({ pcm, apiKey, model = DEFAULT_STT_MODEL, language, prompt, provider, url = OR_STT_URL, fetch = globalThis.fetch, signal, sampleRate = SAMPLE_RATE }) {
  const body = { model, input_audio: { data: encodeWav(pcm, sampleRate).toString('base64'), format: 'wav' } };
  if (language) body.language = language;
  if (prompt) body.prompt = prompt;
  if (provider) body.provider = provider;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) throw signal.reason ?? e;
    throw toOrError(e);
  }
  if (!res.ok) throw await orHttpError(res);
  const raw = new TextDecoder('utf-8').decode(await res.arrayBuffer());
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new OrError('bad_response', `non-JSON transcription response: ${clip(raw, 120)}`, { retryable: true });
  }
  if (data?.error) {
    throw new OrError('server', `transcription error: ${clip(data.error.message ?? JSON.stringify(data.error), 200)}`, {
      retryable: true,
      status: Number(data.error.code) || undefined,
    });
  }
  if (typeof data?.text !== 'string') throw new OrError('bad_response', 'transcription response without text', { retryable: true });
  return { text: data.text, usage: data.usage ?? null, generation_id: res.headers.get('x-generation-id') };
}

// ---------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------

/**
 * Join two overlapping transcripts (`next` starts inside the audio `prev` ended with). Overlap
 * alignment over the last/first maxOverlapWords words: `prev` may be matched from any word on but
 * must be matched to its end, `next` from its start; words compare without case, ё/е and
 * punctuation; a misheard word inside the overlap costs a point, it does not break the match.
 * Word fragments cut at a window edge count as matches: a fragment at the start of `next` keeps
 * prev's full word, a fragment at the end of `prev` is replaced by next's full word.
 * No convincing overlap (score < 1.5, i.e. not even one matched content word) -> concatenation.
 */
export function stitchText(prev, next, { maxOverlapWords = 24 } = {}) {
  const a = splitWords(prev);
  const b = splitWords(next);
  if (!a.length) return b.join(' ');
  if (!b.length) return a.join(' ');
  const K = Math.min(maxOverlapWords, a.length);
  const J = Math.min(maxOverlapWords, b.length);
  const A = a.slice(a.length - K).map(normWord);
  const B = b.slice(0, J).map(normWord);
  const dp = Array.from({ length: K + 1 }, () => new Float64Array(J + 1));
  const move = Array.from({ length: K + 1 }, () => new Uint8Array(J + 1)); // 0 diagonal, 1 skip prev word, 2 skip next word
  for (let j = 1; j <= J; j++) {
    dp[0][j] = dp[0][j - 1] - 1;
    move[0][j] = 2;
  }
  for (let i = 1; i <= K; i++) {
    for (let j = 1; j <= J; j++) {
      const diag = dp[i - 1][j - 1] + pairScore(A[i - 1], B[j - 1], i === K, j === 1);
      const up = dp[i - 1][j] - 1;
      const left = dp[i][j - 1] - 1;
      if (diag >= up && diag >= left) dp[i][j] = diag;
      else if (up >= left) {
        dp[i][j] = up;
        move[i][j] = 1;
      } else {
        dp[i][j] = left;
        move[i][j] = 2;
      }
    }
  }
  let bestJ = 0;
  let best = 1.5 - 1e-9;
  for (let j = 1; j <= J; j++) {
    if (dp[K][j] > best) {
      best = dp[K][j];
      bestJ = j;
    }
  }
  if (!bestJ) return [...a, ...b].join(' ');
  if (move[K][bestJ] === 0 && pairKind(A[K - 1], B[bestJ - 1], true, bestJ === 1) === 'prev_cut') {
    return [...a.slice(0, -1), ...b.slice(bestJ - 1)].join(' ');
  }
  return [...a, ...b.slice(bestJ)].join(' ');
}

/**
 * How two normalized words relate: 'same'; 'near' (>= 5 letters, one letter differs: «отчета»/«отчету»);
 * 'prev_cut' (prev's last word is the start of next's word: a window cut mid-word);
 * 'next_cut' (next's first word is the end of prev's word). Fragments of >= 4 letters may differ in
 * one letter (live 18.09: «Кторе» for the tail of «архитектуре»).
 */
function pairKind(x, y, lastOfPrev, firstOfNext) {
  if (x === y) return 'same';
  if (x.length >= 5 && nearlyEqual(x, y)) return 'near';
  if (lastOfPrev && x.length >= 2 && y.length > x.length && (y.startsWith(x) || nearlyEqual(x, y.slice(0, x.length)))) return 'prev_cut';
  if (firstOfNext && y.length >= 3 && x.length > y.length && (x.endsWith(y) || nearlyEqual(y, x.slice(-y.length)))) return 'next_cut';
  return null;
}

function pairScore(x, y, lastOfPrev, firstOfNext) {
  const kind = pairKind(x, y, lastOfPrev, firstOfNext);
  if (kind === 'same') return x.length >= 3 ? 2 : 1;
  if (kind === 'near') return 1;
  return kind ? 1.5 : -1;
}

/** Same length, at most one differing letter, at least 4 letters. */
function nearlyEqual(a, b) {
  if (a.length !== b.length || a.length < 4) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
  return true;
}

/** Trimmed transcript, or '' when it is only an echo of the prompt or a known silence hallucination. */
export function cleanTranscript(text, prompt = null) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const n = normalizeSpoken(t);
  if (!n || HALLUCINATION_RE.test(n)) return '';
  if (prompt && n.split(' ').length >= 3 && normalizeSpoken(prompt).includes(n)) return '';
  return t;
}

/**
 * Remove the language anchor («Итак.») the ears prepend to utterance-start requests: the leading
 * words that spell it (also split as «И так») are dropped with their punctuation, the rest is
 * capitalized. Text that does not start with the anchor is returned unchanged.
 */
export function stripAnchor(text, anchorText) {
  const anchor = normalizeSpoken(anchorText).replace(/\s+/g, '');
  const tokens = String(text ?? '').split(/\s+/).filter(Boolean);
  if (!anchor || !tokens.length) return String(text ?? '').trim();
  let joined = '';
  for (let n = 1; n <= Math.min(3, tokens.length); n++) {
    joined += normWord(tokens[n - 1]);
    if (joined === anchor) {
      const rest = tokens.slice(n).join(' ').replace(/^[\s,.;:!?…—–-]+/, '');
      return rest ? rest[0].toUpperCase() + rest.slice(1) : '';
    }
    if (!anchor.startsWith(joined)) break;
  }
  return tokens.join(' ');
}

const LATIN_WORDS = new Map(
  Object.entries({
    da: 'да', net: 'нет', nyet: 'нет', niet: 'нет', vse: 'всё', vsyo: 'всё', vsio: 'всё', vsjo: 'всё', aga: 'ага', ugu: 'угу',
    uhu: 'угу', ok: 'ок', okay: 'окей', okey: 'окей', nu: 'ну', tak: 'так', vot: 'вот', ya: 'я', tut: 'тут', stop: 'стоп',
    cora: 'кора', kora: 'кора', sekundu: 'секунду', segundo: 'секунду', spasibo: 'спасибо', privet: 'привет', poka: 'пока',
    khorosho: 'хорошо', horosho: 'хорошо', ladno: 'ладно', konechno: 'конечно', davay: 'давай', davai: 'давай', est: 'есть', eto: 'это',
  }),
);
const TRANSLIT = [
  ['shch', 'щ'], ['sch', 'щ'], ['zh', 'ж'], ['kh', 'х'], ['ts', 'ц'], ['ch', 'ч'], ['sh', 'ш'], ['yu', 'ю'], ['ya', 'я'], ['yo', 'ё'],
  ['ye', 'е'], ['ju', 'ю'], ['ja', 'я'], ['jo', 'ё'], ['a', 'а'], ['b', 'б'], ['v', 'в'], ['g', 'г'], ['d', 'д'], ['e', 'е'], ['z', 'з'],
  ['i', 'и'], ['j', 'й'], ['k', 'к'], ['l', 'л'], ['m', 'м'], ['n', 'н'], ['o', 'о'], ['p', 'п'], ['r', 'р'], ['s', 'с'], ['t', 'т'],
  ['u', 'у'], ['f', 'ф'], ['h', 'х'], ['c', 'к'], ['y', 'ы'], ['w', 'в'], ['x', 'кс'], ['q', 'к'],
];

/**
 * Russian room, short all-Latin transcript («Da.», «Cora, stop.») -> Cyrillic: known words from a
 * small dictionary, the rest by transliteration. gpt-4o-transcribe on OpenRouter gets no language
 * hint and writes short Russian answers in Latin. Anything else is returned unchanged.
 */
export function fixLatinShort(text, language = 'ru', { maxWords = 4 } = {}) {
  const t = String(text ?? '');
  if (!/^ru/i.test(language || '') || /[а-яё]/i.test(t) || !/[a-z]/i.test(t)) return t;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) return t;
  return words
    .map((w) =>
      w.replace(/[A-Za-z]+/g, (m) => {
        const lower = m.toLowerCase();
        const cyr = LATIN_WORDS.get(lower) ?? transliterate(lower);
        return m[0] !== lower[0] ? cyr[0].toUpperCase() + cyr.slice(1) : cyr;
      }),
    )
    .join(' ');
}

function transliterate(word) {
  let out = '';
  let i = 0;
  outer: while (i < word.length) {
    for (const [lat, cyr] of TRANSLIT) {
      if (word.startsWith(lat, i)) {
        out += cyr;
        i += lat.length;
        continue outer;
      }
    }
    out += word[i];
    i += 1;
  }
  return out;
}

/**
 * Russian room, transcript in another language: letters outside the Russian and plain Latin
 * alphabets (Serbian «ј», Slovene «š», Hangul, ...), or >= 3 words that are mostly Latin. A short
 * window cut mid-phrase is sometimes auto-detected as a neighbouring language.
 */
export function isForeignScript(text, language = 'ru') {
  if (!/^ru/i.test(language || '')) return false;
  let letters = 0;
  let latin = 0;
  for (const ch of String(text ?? '')) {
    if (!/\p{L}/u.test(ch)) continue;
    letters += 1;
    if (/[а-яё]/i.test(ch)) continue;
    if (/[a-z]/i.test(ch)) {
      latin += 1;
      continue;
    }
    return true;
  }
  if (!letters) return false;
  return String(text).split(/\s+/).filter(Boolean).length >= 3 && latin / letters > 0.6;
}

function splitWords(text) {
  return String(text ?? '')
    .split(/\s+/)
    .filter((w) => normWord(w) !== '');
}

function normWord(w) {
  return normalizeSpoken(w).replace(/\s+/g, '');
}

/** What `next` adds to `prev` word-wise; revised when `next` is not an extension of `prev`. */
function diffWords(prev, next) {
  const p = splitWords(prev).map(normWord);
  const words = splitWords(next);
  const n = words.map(normWord);
  if (p.length <= n.length && p.every((w, i) => w === n[i])) return { added: words.slice(p.length).join(' '), revised: false };
  return { added: words.join(' '), revised: p.length > 0 };
}

// ---------------------------------------------------------------------------------------------
// Ears
// ---------------------------------------------------------------------------------------------

export function createOrEars(opts = {}) {
  return new OrEars(opts);
}

export class OrEars extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} [opts.settings]      merged settings (voice.stt_model, voice.vad, voice.stt, realtime.language, ...)
   * @param {string} [opts.apiKey]        OpenRouter key (caller gets it via env.requireKey; never logged)
   * @param {{event: Function}} [opts.log]
   * @param {Function} [opts.fetch]       fetch implementation (tests)
   * @param {() => number} [opts.now]     wall clock, ms
   * @param {object[]} [opts.people]      people.json entries for the transcription prompt (default: loadPeople())
   * @param {Function} [opts.transcriber] (pcm, {signal, kind, item_id, from_ms, to_ms, attempt, anchored}) => Promise<{text, usage?}>; replaces HTTP (tests)
   * @param {string} [opts.url]           transcription endpoint
   * @param {string} [opts.model]         overrides settings.voice.stt_model
   * @param {string} [opts.language]     overrides settings.voice.language / realtime.language
   * @param {string|false} [opts.prompt]  transcription prompt; false = none; default from settings + people
   *                                      (sent, but OpenRouter does not pass it to gpt-4o-transcribe as of 18.09.2026)
   * @param {object} [opts.stt]           overrides of EARS_DEFAULTS (snake_case), over settings.voice.stt
   * @param {object} [opts.vad]           overrides of vad.js VAD_DEFAULTS + preroll_ms/min_speech_ms, over settings.voice.vad
   * @param {{pcm: Buffer, text: string}} [opts.anchor]  language anchor (see setAnchor)
   * @param {boolean} [opts.logDeltas]
   */
  constructor({ settings = {}, apiKey, log, fetch = globalThis.fetch, now = Date.now, people, transcriber, url = OR_STT_URL, model, language, prompt, stt, vad, anchor, logDeltas } = {}) {
    super();
    const v = settings.voice ?? {};
    const vadCfg = { ...(v.vad ?? {}), ...(vad ?? {}) };
    this.opts = { ...EARS_DEFAULTS, ...numbersOf(vadCfg, UTTERANCE_KEYS), ...numbersOf(v.stt), ...numbersOf(stt) };
    const logSetting = logDeltas ?? stt?.log_deltas ?? v.stt?.log_deltas;
    if (logSetting !== undefined) this.opts.log_deltas = Boolean(logSetting);
    this.model = model ?? v.stt_model ?? DEFAULT_STT_MODEL;
    const lang = language ?? v.language ?? settings.realtime?.language ?? 'ru';
    this.language = Array.isArray(lang) ? String(lang[0] ?? '') : String(lang ?? ''); // request field (dropped if rejected)
    this.textLanguage = this.language; // language of the room, for transcript checks
    const p = prompt !== undefined ? prompt : v.stt_prompt;
    this.prompt = p === false || p === null ? null : typeof p === 'string' ? p : buildTranscriptionPrompt(settings, people ?? loadPeople());
    this.sttProvider = v.stt_provider ?? null; // OpenRouter provider prefs; ignored by this endpoint as of 18.09.2026
    if (!transcriber) {
      if (!apiKey) throw new Error('createOrEars: apiKey is required');
      if (typeof fetch !== 'function') throw new Error('createOrEars: no fetch implementation');
    }
    this._transcriber =
      transcriber ??
      ((pcm, o) =>
        transcribeOnce({ pcm, apiKey, fetch, url, model: this.model, language: this.language || undefined, prompt: this.prompt, provider: this.sttProvider, signal: o.signal }));
    this._logger = log;
    this._now = now;
    this._anchor = null;
    if (anchor) this.setAnchor(anchor);
    this._tag = Math.random().toString(36).slice(2, 6);
    const pauseMs = this.opts.early_final_ms > 0 ? this.opts.early_final_ms : 0;
    this._vad = new EnergyVad({ ...vadOptions(vadCfg), pause_ms: pauseMs });
    this._timeline = new AudioTimeline();
    this._chunks = []; // {start (byte offset), buf}
    this._bytes = 0;
    this._odd = null;
    this._lastPushAt = now();
    this._utt = null; // open utterance
    this._seq = 0;
    this._reqSeq = 0;
    this._pending = [];
    this._active = new Set();
    this._pumpScheduled = false;
    this._closed = false;
    this._latencies = [];
    this._stats = {
      chunks: 0,
      pushed_bytes: 0,
      vad_starts: 0,
      vad_stops: 0,
      pauses: 0,
      deltas: 0,
      finals: 0,
      failed: 0,
      resets: 0,
      skipped_short: 0,
      spec_hits: 0,
      requests: 0,
      req_ok: 0,
      req_failed: 0,
      req_aborted: 0,
      retries: 0,
      lang_retries: 0,
      gaps: 0,
      filtered: 0,
      translit: 0,
      foreign: 0,
      stt_audio_ms: 0,
      cost_usd: 0,
    };
    this._watchdog = setInterval(() => {
      if (this._utt && this._now() - this._lastPushAt > this.opts.stall_ms) this.flush('stall');
    }, 250);
    this._watchdog.unref?.();
  }

  /** True between a VAD start and its stop. */
  get speaking() {
    return this._utt !== null;
  }

  /** Audio pushed so far, ms. */
  get audioMs() {
    return this._bytes / BYTES_PER_MS;
  }

  /** Wall time (ms) of `audioMs` in the pushed stream (null if nothing was pushed). */
  audioMsToWall(audioMs) {
    return this._timeline.toWall(audioMs);
  }

  /** Interface parity with ears.js (no server-side items here). */
  sweepItems() {
    return 0;
  }

  /**
   * Language anchor: PCM16 24 kHz of our own voice saying `text` (voice.connect() renders
   * DEFAULT_ANCHOR_TEXT with the mouth). It is prepended, with anchor_gap_ms of silence, to every
   * request whose window starts at the utterance onset, and stripped from the transcript.
   * OpenRouter does not pass `language`/`prompt` to gpt-4o-transcribe; without the anchor short
   * answers come back as «Da.», «Cora, stop.», «Segundo.». null removes it.
   */
  setAnchor(anchor) {
    if (anchor == null) {
      this._anchor = null;
      return;
    }
    const pcm = toPcmBuffer(anchor.pcm);
    const text = typeof anchor.text === 'string' ? anchor.text.trim() : '';
    if (!pcm?.length || !text) throw new Error('setAnchor: {pcm, text} required');
    this._anchor = { pcm: pcm.length % 2 ? pcm.subarray(0, pcm.length - 1) : pcm, text };
    this._log('or.anchor', { text, ms: Math.round(pcm.length / BYTES_PER_MS) });
  }

  /** {text, ms} of the current anchor, or null. */
  get anchor() {
    return this._anchor ? { text: this._anchor.text, ms: Math.round(this._anchor.pcm.length / BYTES_PER_MS) } : null;
  }

  /** VAD internals: {speaking, paused, level_db, floor_db, loud_ms, quiet_ms, onset_ms, position_ms}. */
  vadState() {
    return this._vad.state();
  }

  /**
   * One chunk of room audio (PCM16 LE mono 24 kHz). Synchronous and cheap: VAD, buffering and
   * request scheduling only; the network runs later.
   * @param {string|Buffer|ArrayBufferView|ArrayBuffer} chunk  base64 string, Buffer, Int16Array, ...
   * @param {{t?: number}} [o]  wall time (ms) of the chunk's last sample; default now
   * @returns {boolean} false if the chunk was empty/invalid or the ears are closed
   */
  pushAudio(chunk, { t } = {}) {
    if (this._closed) return false;
    let buf = toPcmBuffer(chunk);
    if (!buf || !buf.length) return false;
    if (this._odd) {
      buf = Buffer.concat([this._odd, buf]);
      this._odd = null;
    }
    if (buf.length % 2) {
      this._odd = Buffer.from(buf.subarray(buf.length - 1));
      buf = buf.subarray(0, buf.length - 1);
      if (!buf.length) return true;
    }
    const tEnd = t ?? this._now();
    this._chunks.push({ start: this._bytes, buf });
    this._bytes += buf.length;
    this._timeline.add(buf.length, tEnd);
    this._lastPushAt = this._now();
    this._stats.chunks++;
    this._stats.pushed_bytes += buf.length;
    this._prune();
    let events = [];
    try {
      events = this._vad.pushPcm(buf);
    } catch (err) {
      this._log('or.error', { phase: 'vad', message: err?.message });
    }
    for (const ev of events) this._onVad(ev);
    if (this._utt) this._maybePartial();
    return true;
  }

  /** Close the open utterance now (all tracks ended, stall): 'stop' + final as usual. */
  flush(reason = 'flush') {
    if (this._closed) return false;
    const ev = this._vad.flush();
    if (!ev) return false;
    this._onStop(ev.pos_ms, reason);
    return true;
  }

  stats() {
    const s = this._stats;
    const lat = this._latencies;
    const vad = this._vad.state();
    return {
      provider: 'openrouter',
      model: this.model,
      chunks: s.chunks,
      pushed_ms: Math.round(s.pushed_bytes / BYTES_PER_MS),
      session_audio_ms: Math.round(this._bytes / BYTES_PER_MS),
      vad_starts: s.vad_starts,
      vad_stops: s.vad_stops,
      pauses: s.pauses,
      deltas: s.deltas,
      finals: s.finals,
      failed: s.failed,
      resets: s.resets,
      skipped_short: s.skipped_short,
      spec_hits: s.spec_hits,
      speaking: this.speaking,
      floor_db: vad.floor_db,
      level_db: vad.level_db,
      requests: s.requests,
      req_ok: s.req_ok,
      req_failed: s.req_failed,
      req_aborted: s.req_aborted,
      retries: s.retries,
      lang_retries: s.lang_retries,
      gaps: s.gaps,
      filtered: s.filtered,
      translit: s.translit,
      foreign: s.foreign,
      anchor: this.anchor,
      active: this._active.size,
      queued: this._pending.length,
      stt_audio_ms: Math.round(s.stt_audio_ms),
      cost_usd: Math.round(s.cost_usd * 1e8) / 1e8,
      final_latency_ms: lat.length
        ? { last: lat.at(-1), avg: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length), max: Math.max(...lat), n: lat.length }
        : null,
    };
  }

  /** Stop timers, abort requests; an utterance open at this moment gets 'reset'. Idempotent. */
  close() {
    if (this._closed) return;
    this._closed = true;
    clearInterval(this._watchdog);
    const utt = this._utt;
    this._utt = null;
    if (utt) {
      this._stats.resets++;
      this._log('vad.reset', { reason: 'closed', item_id: utt.item_id });
      this.emit('reset', { reason: 'closed', item_id: utt.item_id, t: this._now() });
    }
    for (const req of [...this._pending, ...this._active]) this._dropReq(req);
    this._pending = [];
  }

  // ---- utterances --------------------------------------------------------------------------------

  _onVad(ev) {
    switch (ev.type) {
      case 'start':
        this._onStart(ev);
        return;
      case 'pause':
        this._onPause(ev);
        return;
      case 'resume':
        this._onResume();
        return;
      case 'stop':
        this._onStop(ev.pos_ms, ev.reason ?? null);
        return;
      default:
    }
  }

  _onStart(ev) {
    const now = this._now();
    this._seq += 1;
    const itemId = `or_${this._tag}_${this._seq}`;
    const bufStart = this._chunks.length ? this._chunks[0].start / BYTES_PER_MS : 0;
    const onset = ev.pos_ms;
    const from = Math.max(bufStart, onset - this.opts.preroll_ms);
    const t = this._wall(onset, now);
    this._utt = {
      item_id: itemId,
      onset,
      from,
      t_start: t,
      end: null,
      t_end: null,
      so_far: '',
      covered: from, // audio (ms) covered by completed windows
      next_cut: onset + this.opts.partial_interval_ms,
      partial: null,
      spec: null,
      final: null,
      reqs: new Set(),
      done: false,
    };
    this._stats.vad_starts++;
    this._log('vad.start', { item_id: itemId, audio_ms: onset, lag_ms: now - t, level_db: ev.level_db, floor_db: ev.floor_db });
    this.emit('vad', { type: 'start', audio_ms: onset, t, t_rx: now, item_id: itemId });
  }

  _onPause(ev) {
    const utt = this._utt;
    if (!utt || utt.done || utt.spec) return;
    this._stats.pauses++;
    if (ev.pos_ms - utt.onset < this.opts.min_speech_ms) return; // would be skipped at stop anyway
    utt.spec = this._issueFinal(utt, ev.pos_ms, true);
  }

  _onResume() {
    const utt = this._utt;
    const spec = utt?.spec;
    if (!spec) return;
    utt.spec = null;
    spec.stale = true;
    if (spec.state === 'queued') this._dropReq(spec);
    else if (spec.result && !spec.result.foreign) this._applyDelta(utt, spec, spec.result.text);
    // still in flight: its text becomes a delta when it arrives
  }

  _onStop(endMs, reason) {
    const utt = this._utt;
    if (!utt) return;
    this._utt = null;
    const now = this._now();
    utt.end = endMs;
    utt.t_end = this._wall(endMs, now);
    const speechMs = endMs - utt.onset;
    this._stats.vad_stops++;
    this._log('vad.stop', { item_id: utt.item_id, audio_ms: endMs, speech_ms: speechMs, lag_ms: now - utt.t_end, ...(reason ? { reason } : {}) });
    this.emit('vad', { type: 'stop', audio_ms: endMs, t: utt.t_end, t_rx: now, item_id: utt.item_id, speech_ms: speechMs, ...(reason ? { reason } : {}) });
    for (const r of [...utt.reqs]) if (r.kind === 'partial' || (r.kind === 'spec' && r.stale)) this._dropReq(r); // the final covers them
    utt.partial = null;
    if (speechMs < this.opts.min_speech_ms) {
      for (const r of [...utt.reqs]) this._dropReq(r);
      utt.spec = null;
      this._stats.skipped_short++;
      this._emitFinal(utt, '', { skipped: 'too_short' });
      return;
    }
    const spec = utt.spec;
    utt.spec = null;
    if (spec && !spec.stale && !spec.failed && spec.end === endMs) {
      utt.final = spec;
      spec.adopted = true;
      this._stats.spec_hits++;
      if (spec.result) this._finalize(utt, spec, spec.result);
      return;
    }
    if (spec) {
      spec.stale = true;
      this._dropReq(spec);
    }
    utt.final = this._issueFinal(utt, endMs, false);
  }

  _issueFinal(utt, endMs, speculative) {
    const o = this.opts;
    const to = Math.min(this.audioMs, endMs + o.tail_pad_ms);
    let from = utt.from;
    if (to - utt.from > o.full_max_ms && utt.so_far) from = Math.max(utt.from, Math.min(utt.covered - o.overlap_ms, to - o.min_context_ms));
    if (to - from > o.max_window_ms) {
      from = to - o.max_window_ms;
      this._stats.gaps++;
    }
    const base = from > utt.from ? utt.so_far : ''; // tail window: stitched onto the running text
    const req = this._newReq(utt, speculative ? 'spec' : 'final', from, to, base, endMs);
    this._enqueue(req);
    return req;
  }

  _maybePartial() {
    const utt = this._utt;
    if (!utt || utt.done || utt.partial || utt.spec || this._vad.paused) return;
    const pos = this.audioMs;
    if (pos < utt.next_cut) return;
    const o = this.opts;
    let from = Math.max(utt.from, Math.min(utt.covered - o.overlap_ms, pos - o.min_context_ms));
    if (pos - from < o.min_window_ms) return;
    if (pos - from > o.max_window_ms) {
      from = pos - o.max_window_ms;
      this._stats.gaps++;
    }
    const req = this._newReq(utt, 'partial', from, pos, from > utt.from ? utt.so_far : '', null);
    utt.partial = req;
    utt.next_cut = pos + o.partial_interval_ms;
    this._enqueue(req);
  }

  _applyDelta(utt, req, text) {
    if (!text || utt.done || req.to <= utt.covered) return;
    let soFar;
    if (req.from <= utt.from) soFar = text; // window covers the utterance from its start
    else if (req.base === utt.so_far) soFar = stitchText(utt.so_far, text);
    else return; // the running text moved on since this window was cut
    const { added, revised } = diffWords(utt.so_far, soFar);
    utt.so_far = soFar;
    utt.covered = req.to;
    this._stats.deltas++;
    if (this.opts.log_deltas) this._log('stt.delta', { item_id: utt.item_id, text: added, so_far_chars: soFar.length, ...(revised ? { revised } : {}) });
    this.emit('stt_delta', { item_id: utt.item_id, text: added, so_far: soFar, t: this._now(), ...(revised ? { revised: true } : {}) });
  }

  _finalize(utt, req, result) {
    const text = req.base ? stitchText(req.base, result.text) : result.text;
    for (const r of [...utt.reqs]) if (r !== req) this._dropReq(r);
    this._emitFinal(utt, text, {
      speculative: req.kind === 'spec',
      request_ms: result.ms,
      window_ms: Math.round(req.to - req.from),
      ...(req.base ? { stitched: true } : {}),
    });
  }

  _emitFinal(utt, text, extra) {
    if (utt.done) return;
    utt.done = true;
    const t = this._now();
    const latency = utt.t_end != null ? t - utt.t_end : null;
    this._stats.finals++;
    if (latency != null && !extra.skipped) {
      this._latencies.push(latency);
      if (this._latencies.length > 200) this._latencies.shift();
    }
    this._log('stt.final', { item_id: utt.item_id, text, latency_ms: latency, speech_ms: utt.end - utt.onset, model: this.model, ...extra });
    this.emit('stt_final', { item_id: utt.item_id, text, t, t_speech_start: utt.t_start, t_speech_end: utt.t_end, latency_ms: latency, ...extra });
  }

  // ---- requests ------------------------------------------------------------------------------------

  _newReq(utt, kind, from, to, base, end) {
    const req = {
      id: ++this._reqSeq,
      utt,
      kind, // partial | spec | final
      from,
      to,
      pcm: this._slice(from, to),
      base,
      end,
      state: 'queued', // queued | active | done | dropped
      controller: new AbortController(),
      attempts: 0,
      result: null,
      stale: false,
      adopted: false,
      failed: false,
    };
    utt.reqs.add(req);
    return req;
  }

  _enqueue(req) {
    this._pending.push(req);
    this._schedulePump();
  }

  _schedulePump() {
    if (this._pumpScheduled || this._closed) return;
    this._pumpScheduled = true;
    setImmediate(() => {
      this._pumpScheduled = false;
      this._pump();
    });
  }

  _pump() {
    while (!this._closed && this._active.size < this.opts.concurrency && this._pending.length) {
      let i = this._pending.findIndex((r) => r.kind !== 'partial');
      if (i < 0) i = 0;
      const [req] = this._pending.splice(i, 1);
      this._start(req);
    }
  }

  _start(req) {
    req.state = 'active';
    this._active.add(req);
    this._stats.requests++;
    this._run(req)
      .then(
        (res) => this._onResult(req, res),
        (err) => this._onError(req, err),
      )
      .catch((err) => this._log('or.error', { phase: 'stt_handler', message: err?.message }))
      .finally(() => {
        this._active.delete(req);
        req.utt.reqs.delete(req);
        if (req.utt.partial === req) {
          req.utt.partial = null;
          if (this._utt === req.utt) this._maybePartial();
        }
        this._schedulePump();
      });
  }

  async _run(req) {
    const o = this.opts;
    const maxRetries = req.kind === 'partial' ? 0 : o.retries;
    const maxLangRetries = req.kind === 'partial' ? 0 : o.lang_retries;
    let retriesUsed = 0;
    let langRetries = 0;
    let cost = null;
    for (;;) {
      req.attempts++;
      const anchor = this._anchor && req.from <= req.utt.from + 1 ? this._anchor : null; // only where the window starts at the onset
      const pcm = anchor ? Buffer.concat([anchor.pcm, Buffer.alloc(Math.round(o.anchor_gap_ms * BYTES_PER_MS) & ~1), req.pcm]) : req.pcm;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(new OrError('timeout', `no transcript within ${o.timeout_ms} ms`, { retryable: true })), o.timeout_ms);
      const signal = AbortSignal.any([req.controller.signal, timeout.signal]);
      const t0 = this._now();
      try {
        const out = await raceAbort(
          this._transcriber(pcm, { signal, kind: req.kind, item_id: req.utt.item_id, from_ms: req.from, to_ms: req.to, attempt: req.attempts, anchored: Boolean(anchor) }),
          signal,
        );
        const raw = typeof out?.text === 'string' ? out.text : '';
        if (typeof out?.usage?.cost === 'number') cost = (cost ?? 0) + out.usage.cost;
        const post = this._postprocess(raw, anchor);
        if (post.foreign && langRetries < maxLangRetries && !this._closed) {
          langRetries++;
          this._stats.lang_retries++;
          this._log('or.stt_error', { item_id: req.utt.item_id, kind: req.kind, attempt: req.attempts, error: 'foreign_script', text: raw, retry: true });
          continue;
        }
        return { ...post, raw, usage: out?.usage ?? null, cost_usd: cost, generation_id: out?.generation_id ?? null, ms: this._now() - t0, anchored: Boolean(anchor) };
      } catch (e) {
        if (req.controller.signal.aborted) throw req.controller.signal.reason ?? new OrError('aborted', 'aborted');
        const err = timeout.signal.aborted ? timeout.signal.reason : toOrError(e);
        const field = err.kind === 'bad_request' ? this._adaptableField(err) : null;
        if (field) {
          this._log('or.stt_error', { item_id: req.utt.item_id, kind: req.kind, error: err.kind, status: err.status ?? null, message: err.message, dropped_field: field });
          continue; // retried without the field; not counted as a retry
        }
        if (err.retryable && retriesUsed < maxRetries && !this._closed) {
          retriesUsed++;
          this._stats.retries++;
          this._log('or.stt_error', { item_id: req.utt.item_id, kind: req.kind, attempt: req.attempts, error: err.kind, status: err.status ?? null, message: err.message, retry: true });
          try {
            await sleep(o.retry_backoff_ms, undefined, { signal: req.controller.signal });
          } catch {
            throw req.controller.signal.reason ?? new OrError('aborted', 'aborted');
          }
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** A 400 naming an optional request field we send: drop it for the rest of the session. */
  _adaptableField(err) {
    for (const field of ADAPTABLE_FIELDS) {
      const key = field === 'provider' ? 'sttProvider' : field;
      if (this[key] && new RegExp(`\\b${field}\\b`, 'i').test(err.message)) {
        this[key] = field === 'language' ? '' : null;
        return field;
      }
    }
    return null;
  }

  /** Transcript clean-up: silence hallucinations/prompt echo, anchor, short Latin answers; foreign-script flag. */
  _postprocess(raw, anchor) {
    const cleaned = cleanTranscript(raw, this.prompt);
    const filtered = !cleaned && normalizeSpoken(raw) !== '';
    const unanchored = anchor && cleaned ? stripAnchor(cleaned, anchor.text) : cleaned;
    const text = fixLatinShort(unanchored, this.textLanguage);
    return { text, filtered, translit: text !== unanchored, foreign: isForeignScript(text, this.textLanguage) };
  }

  _onResult(req, res) {
    if (req.state === 'dropped') return;
    req.state = 'done';
    const { text } = res;
    const utt = req.utt;
    this._stats.req_ok++;
    this._stats.stt_audio_ms += req.to - req.from;
    if (res.cost_usd != null) this._stats.cost_usd += res.cost_usd;
    if (res.filtered) this._stats.filtered++;
    if (res.translit) this._stats.translit++;
    if (res.foreign) this._stats.foreign++;
    this._log('or.stt', {
      item_id: utt.item_id,
      kind: req.kind,
      from_ms: Math.round(req.from),
      to_ms: Math.round(req.to),
      audio_ms: Math.round(req.to - req.from),
      ms: res.ms,
      attempts: req.attempts,
      chars: text.length,
      cost_usd: res.cost_usd,
      ...(res.anchored ? { anchored: true } : {}),
      ...(res.filtered ? { filtered: res.raw } : {}),
      ...(res.translit ? { translit: res.raw } : {}),
      ...(res.foreign ? { foreign: res.raw } : {}),
    });
    if (utt.done) return;
    if (utt.final === req) {
      this._finalize(utt, req, res);
      return;
    }
    if (req.kind === 'spec' && utt.spec === req && !req.stale) {
      req.result = res; // wait for the VAD: stop adopts it, resume turns it into a delta
      return;
    }
    if (req.kind !== 'final' && !res.foreign) this._applyDelta(utt, req, text); // a foreign-script window would poison the running text
  }

  _onError(req, err) {
    if (req.state === 'dropped' || this._closed) return;
    req.state = 'done';
    this._stats.req_failed++;
    const utt = req.utt;
    this._log('or.stt_error', {
      item_id: utt.item_id,
      kind: req.kind,
      attempts: req.attempts,
      error: err?.kind ?? 'error',
      status: err?.status ?? null,
      message: clip(err?.message ?? String(err), 300),
    });
    if (utt.done) return;
    if (utt.final === req) {
      for (const r of [...utt.reqs]) if (r !== req) this._dropReq(r);
      utt.done = true;
      this._stats.failed++;
      const error = { code: err?.kind ?? 'error', message: clip(err?.message ?? String(err), 200), ...(err?.status ? { status: err.status } : {}) };
      this._log('stt.failed', { item_id: utt.item_id, error });
      this.emit('stt_failed', { item_id: utt.item_id, error, t: this._now() });
      return;
    }
    if (req.kind === 'spec' && utt.spec === req) {
      req.failed = true;
      utt.spec = null; // VAD stop will start a regular final
    }
  }

  _dropReq(req) {
    if (req.state === 'done' || req.state === 'dropped') return;
    if (req.state === 'queued') {
      const i = this._pending.indexOf(req);
      if (i >= 0) this._pending.splice(i, 1);
    }
    req.state = 'dropped';
    req.controller.abort(new OrError('aborted', 'request no longer needed'));
    req.utt.reqs.delete(req);
    if (req.utt.partial === req) req.utt.partial = null;
    this._stats.req_aborted++;
  }

  // ---- audio buffer --------------------------------------------------------------------------------

  _prune() {
    const keepFrom = this._bytes - this.opts.buffer_ms * BYTES_PER_MS;
    while (this._chunks.length > 1 && this._chunks[0].start + this._chunks[0].buf.length <= keepFrom) this._chunks.shift();
  }

  /** PCM of [fromMs, toMs) of the pushed stream (clamped to what is still buffered); a copy. */
  _slice(fromMs, toMs) {
    let a = Math.max(0, Math.floor(fromMs * BYTES_PER_MS));
    a -= a % 2;
    let b = Math.min(this._bytes, Math.ceil(toMs * BYTES_PER_MS));
    b -= b % 2;
    if (this._chunks.length) a = Math.max(a, this._chunks[0].start);
    if (b <= a) return Buffer.alloc(0);
    const parts = [];
    for (const c of this._chunks) {
      const end = c.start + c.buf.length;
      if (end <= a) continue;
      if (c.start >= b) break;
      parts.push(c.buf.subarray(Math.max(0, a - c.start), Math.min(c.buf.length, b - c.start)));
    }
    return Buffer.concat(parts);
  }

  _wall(audioMs, fallback) {
    return this._timeline.toWall(audioMs) ?? fallback;
  }

  _log(type, fields) {
    try {
      this._logger?.event?.(type, fields);
    } catch {
      // never let logging break audio
    }
  }
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function raceAbort(promise, signal) {
  promise?.catch?.(() => {}); // the loser of the race must not become an unhandled rejection
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function numbersOf(obj, keys = null) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (keys && !keys.includes(k)) continue;
    if (!keys && !(k in EARS_DEFAULTS)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
