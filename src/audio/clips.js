// Pre-rendered voice clips (PLAN §4 A, WP4).
//
// config/phrases.json templates × config/people.json roster -> texts -> PCM16 mono 24 kHz rendered
// once through mouth.renderClip() and cached on disk:
//
//   cache/<provider>/<model>/<voice>/<sha1>.pcm    raw PCM16 LE mono 24 kHz (what the player plays)
//   cache/<provider>/<model>/<voice>/<sha1>.json   sidecar {text, created, duration_ms, key, person, ...}
//   sha1 = sha1(provider \n model \n voice \n instructions \n text)
//
// The voice identity {provider, model, voice, instructions} comes from the mouth (mouth.identity,
// or the WP3 realtime session), else from settings. Instructions carry the persona line and the
// pace block, so editing either changes every key: stale clips are never played, they just miss.
//
//   const clips = new ClipStore({ settings, mouth, log });
//   await clips.warmup({ present: ['orlov_y', 'tkach_t'] });          // render what is missing
//   const c = clips.get('handoff', { person: 'tkach_t', present });     // sync, {pcm, text, duration_ms} | null
//   if (!c) mouth.say(clips.text('handoff', { person: 'tkach_t', present }));   // miss -> live
//
// Templates: `{name}` = the person's vocative (stress marks U+0301 kept, they steer the voice).
// Two present people with the same first name -> "Имя Фамилия" (vocative + surname_spoken), unless
// the person has disambiguate_with_surname: false. `only_for` limits a per-person key to those ids.
// Variants rotate per phrase key: the same variant is never picked twice in a row (random among the
// others). get() rotates among cached variants only; with a single cached variant it repeats it.
// Texts pass through applyYo() (conservative е->ё dictionary; export for live texts too).
//
// Log records: clips.miss, clips.render, clips.error, clips.fatal, clips.ensure.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CACHE_DIR, CONFIG_DIR, contentPath } from '../config.js';
import { buildInstructions, loadPeople } from './realtime_ws.js';

export const SAMPLE_RATE = 24_000;
/** PCM16 mono 24 kHz: 48 bytes per millisecond. */
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
export const PHRASES_PATH = contentPath('phrases.json');
/** Cost model for estimates (PLAN: ≈ $64 per 1M audio tokens, 20 audio tokens per second). */
export const DEFAULT_PRICING = Object.freeze({ usd_per_m_audio_tokens: 64, audio_tokens_per_s: 20 });
/** Keys the host cannot run without (render these first when the budget is tight). */
export const CORE_KEYS = Object.freeze(['handoff', 'check_done', 'are_you_here', 'start_*', 'closing_*', 'greet_*', 'sorry_continue']);

const DEFAULTS = {
  concurrency: 2,
  retries: 1, // extra attempts per clip for transient errors and verbatim mismatches
  retryDelayMs: 1000,
  renderTimeoutMs: 60_000,
  maxConsecutiveFailures: 4, // circuit breaker: that many clips failing in a row stops ensure()
  minClipMs: 150, // shorter audio is treated as a failed render
};

// ---------------------------------------------------------------------------------------------
// phrases + people
// ---------------------------------------------------------------------------------------------

/** phrases.json -> {key: {key, variants: string[], perPerson, onlyFor: Set|null}}. Throws on bad data. */
export function loadPhrases(path = PHRASES_PATH) {
  let raw = readFileSync(path, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return normalizePhrases(JSON.parse(raw));
}

export function normalizePhrases(data) {
  const out = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (key.startsWith('_')) continue; // comments
    const def = typeof value === 'string' ? { variants: [value] } : Array.isArray(value) ? { variants: value } : (value ?? {});
    const variants = (Array.isArray(def.variants) ? def.variants : [])
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => v.normalize('NFC').trim());
    if (!variants.length) throw new Error(`phrases: "${key}" has no variants`);
    const perPerson = def.per_person ?? variants.some((v) => v.includes('{name}'));
    for (const v of variants) {
      const unknown = [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).find((n) => n !== 'name');
      if (unknown) throw new Error(`phrases: "${key}" uses unknown placeholder {${unknown}}`);
      if (!perPerson && v.includes('{name}')) throw new Error(`phrases: "${key}" has {name} but per_person is false`);
    }
    const onlyFor = Array.isArray(def.only_for) && def.only_for.length ? new Set(def.only_for.map(String)) : null;
    out[key] = { key, variants, perPerson: Boolean(perPerson), onlyFor };
  }
  return out;
}

/** Keys matching `patterns` ('handoff', 'start_*', or the word 'core' = CORE_KEYS); all keys if empty. */
export function selectKeys(phrases, patterns) {
  const all = Object.keys(phrases);
  if (!patterns || (Array.isArray(patterns) && !patterns.length)) return all;
  const list = (Array.isArray(patterns) ? patterns : String(patterns).split(',')).flatMap((p) => (String(p).trim() === 'core' ? CORE_KEYS : [String(p).trim()]));
  const match = (key, p) => (p.endsWith('*') ? key.startsWith(p.slice(0, -1)) : key === p);
  const unknown = list.filter((p) => p && !all.some((k) => match(k, p)));
  if (unknown.length) throw new Error(`phrases: no key matches ${unknown.map((u) => `"${u}"`).join(', ')}`);
  return all.filter((k) => list.some((p) => p && match(k, p)));
}

export function isCoreKey(key) {
  return CORE_KEYS.some((p) => (p.endsWith('*') ? key.startsWith(p.slice(0, -1)) : key === p));
}

const STRESS = /[̀́]/g;

/** Text without stress marks (U+0301/U+0300), NFC. */
export function stripStress(s) {
  return String(s ?? '').normalize('NFC').replace(STRESS, '');
}

function clean(s) {
  return typeof s === 'string' ? s.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
}

function foldName(s) {
  return stripStress(s).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/** First name as spoken to the person: vocative, else spoken, else the first word of display. */
export function firstName(p) {
  return clean(p?.vocative) || clean(p?.spoken) || clean(String(p?.display ?? '').split(/\s+/)[0]);
}

/** Surname as spoken: surname_spoken, else the rest of display. */
export function surnameOf(p) {
  return clean(p?.surname_spoken) || clean(String(p?.display ?? '').trim().split(/\s+/).slice(1).join(' '));
}

/** What {name} becomes: vocative, or «vocative surname_spoken» with withSurname. */
export function spokenName(p, { withSurname = false } = {}) {
  const first = firstName(p);
  const last = withSurname ? surnameOf(p) : '';
  return last ? `${first} ${last}` : first;
}

/** People among `others` (not excluded, not `person`) with the same first name (ё=е, no stress). */
export function findNamesakes(person, others = []) {
  const f = foldName(firstName(person));
  if (!f) return [];
  return others.filter((o) => o && o !== person && !(o.id != null && o.id === person.id) && !o.exclude && foldName(firstName(o)) === f);
}

function peopleList(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.people) ? data.people : [];
  return list.filter((p) => p && typeof p === 'object' && p.id != null).map((p) => ({ ...p, id: String(p.id) }));
}

function toIds(list) {
  if (list == null) return [];
  const arr = list instanceof Set ? [...list] : Array.isArray(list) ? list : String(list).split(',');
  return arr.map((x) => (x && typeof x === 'object' ? x.id : x)).filter((x) => x != null && String(x).trim()).map((x) => String(x).trim());
}

// ---------------------------------------------------------------------------------------------
// ё dictionary
// ---------------------------------------------------------------------------------------------

// Words whose е-spelling can only mean the ё-word. "все/всё" is ambiguous and handled by context below.
const YO_WORDS = [
  'ещё', 'её', 'всё-таки', 'твоё', 'моё', 'своё', 'вперёд',
  'идёт', 'идём', 'пойдёт', 'пойдём', 'придёт', 'придём', 'уйдёт', 'найдёт', 'найдём', 'перейдём', 'перейдёт',
  'начнём', 'начнёт', 'ждём', 'ждёт', 'подождём', 'подождёт', 'даёт', 'даём', 'передаёт', 'передаём',
  'берёт', 'берём', 'возьмёт', 'возьмём', 'ведёт', 'ведём', 'поймёт', 'поймём', 'пришлёт', 'пришлём',
  'нашёл', 'пришёл', 'ушёл', 'зашёл', 'прошёл', 'перешёл', 'подошёл', 'решён', 'решённый',
  'отчёт', 'отчёта', 'отчёту', 'отчётом', 'отчёте', 'отчёты', 'отчётов', 'отчётам', 'отчётами', 'отчётах',
  'учёт', 'учёта', 'расчёт', 'расчёта', 'расчёты', 'счёт', 'счёта', 'объём', 'приём', 'подъём',
  'тёзка', 'тёзки', 'тёзок', 'трёх', 'четырёх', 'лёгкий', 'лёгкая', 'лёгкое', 'лёгкие',
  'серёжа', 'алёша', 'серёжа', 'артём', 'пётр', 'фёдор', 'семён', 'алёна', 'смирнова',
];
const YO_MAP = new Map(YO_WORDS.map((w) => [w.replace(/ё/g, 'е'), w]));
const WORD = /[\p{L}̀́]+(?:-[\p{L}̀́]+)*/gu;
const NOT_LETTER_BEFORE = '(?<![\\p{L}\\u0300\\u0301])';
const VSE = [
  new RegExp(`${NOT_LETTER_BEFORE}(все)(?=\\s+(?:равно|ещё|еще)(?![\\p{L}]))`, 'giu'), // всё равно, всё ещё
  // у меня всё / на этом всё / вот и всё / это всё / пока всё — before punctuation or the end
  new RegExp(`(?<=(?:^|[^\\p{L}\\u0301])(?:у\\s+(?:меня|тебя|нас|вас|него|неё|нее|них)|на\\s+этом|вот\\s+и|это|пока)\\s+)(все)(?=\\s*(?:[.?!,…;:)]|$))`, 'giu'),
  // "Тима, все?" / "Все?" -> "всё?"
  new RegExp(`(?<=(?:^|[,:—–-]\\s*))(все)(?=\\s*\\?)`, 'giu'),
];

function matchCase(src, target) {
  if (src.length > 1 && src === src.toUpperCase()) return target.toUpperCase();
  if (src[0] === src[0].toUpperCase() && src[0] !== src[0].toLowerCase()) return target[0].toUpperCase() + target.slice(1);
  return target;
}

/** Conservative е -> ё fixes (ещё, идёт, начнём, «у тебя всё?» …). Idempotent; words with ё or stress marks are kept. */
export function applyYo(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text.replace(WORD, (w) => {
    if (/[ёЁ̀́]/.test(w)) return w;
    const yo = YO_MAP.get(w.toLowerCase());
    return yo ? matchCase(w, yo) : w;
  });
  for (const re of VSE) out = out.replace(re, (m) => matchCase(m, 'всё'));
  return out;
}

/** Final form of a clip/live text: NFC, ё fixes, single spaces. */
export function finalizeText(text) {
  return applyYo(String(text ?? '').normalize('NFC')).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------------------------
// identity, keys, files
// ---------------------------------------------------------------------------------------------

function normalizeIdentity(v = {}) {
  return {
    provider: String(v.provider || 'unknown'),
    model: String(v.model || 'unknown'),
    voice: String(v.voice || 'unknown'),
    instructions: typeof v.instructions === 'string' ? v.instructions : '',
  };
}

/** Voice identity from the mouth (identity/voiceIdentity property or method, WP3 realtime session, plain props). */
export function identityFromMouth(mouth) {
  if (!mouth) return null;
  for (const k of ['identity', 'voiceIdentity']) {
    let v = mouth[k];
    if (typeof v === 'function') v = v.call(mouth);
    if (v && typeof v === 'object' && v.model) return normalizeIdentity(v);
  }
  const s = mouth.session;
  if (s && typeof s.instructions === 'string' && s.config) {
    const c = s.config;
    return normalizeIdentity({ provider: 'openai_realtime', model: c.model, voice: c.audio?.output?.voice, instructions: s.instructions });
  }
  if (mouth.model && mouth.voice) {
    // or_mouth.js: model/voice/instructions props; the provider is the first field of its cacheKey
    const provider = mouth.provider ?? (typeof mouth.cacheKey === 'string' && mouth.cacheKey.includes('|') ? mouth.cacheKey.split('|')[0] : null) ?? mouth.kind;
    return normalizeIdentity({ provider, model: mouth.model, voice: mouth.voice, instructions: mouth.instructions });
  }
  return null;
}

/**
 * Voice identity from settings (dry runs, no mouth), mirroring src/audio/voice.js: provider
 * settings.voice.provider (default 'openrouter'); openrouter -> or_mouth.js (tts_model default
 * openai/gpt-audio-mini, voice, instructions = buildInstructions); openai_realtime -> the WP3 session
 * (settings.realtime.model/voice, same instructions). The mouth's own identity wins when there is a mouth.
 */
export function identityFromSettings(settings = {}) {
  const v = settings.voice ?? {};
  const rt = settings.realtime ?? {};
  const provider = v.provider || 'openrouter';
  if (provider === 'openai_realtime') {
    return normalizeIdentity({ provider, model: rt.model || 'gpt-realtime-2.1', voice: rt.voice || 'shimmer', instructions: buildInstructions(settings) });
  }
  return normalizeIdentity({
    provider,
    model: v.tts_model || 'openai/gpt-audio-mini',
    voice: v.voice || rt.voice || 'shimmer',
    instructions: typeof v.instructions === 'string' ? v.instructions : buildInstructions(settings),
  });
}

/** Explicit identity > mouth > settings. */
export function voiceIdentity({ mouth, settings, identity } = {}) {
  if (identity) return normalizeIdentity(identity);
  return identityFromMouth(mouth) ?? identityFromSettings(settings);
}

/** sha1(provider \n model \n voice \n instructions \n text), hex. */
export function clipHash(identity, text) {
  const id = normalizeIdentity(identity);
  return createHash('sha1').update([id.provider, id.model, id.voice, id.instructions, String(text)].join('\n'), 'utf8').digest('hex');
}

function segment(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_') || '_';
}

/** cache/<provider>/<model>/<voice> (path-safe segments: "openai/gpt-audio-mini" -> "openai_gpt-audio-mini"). */
export function cacheDirFor(root, identity) {
  const id = normalizeIdentity(identity);
  return join(root, segment(id.provider), segment(id.model), segment(id.voice));
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, file);
  } catch {
    try {
      writeFileSync(file, data); // Windows: target locked by a reader -> overwrite in place
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// audio helpers
// ---------------------------------------------------------------------------------------------

const EDGE_WIN = 240; // 10 ms at 24 kHz

/**
 * Leading/trailing near-silence of a PCM16 buffer, ms (10 ms resolution). A 10 ms window counts as
 * sound when its RMS is above thresholdDb and a neighbouring window is too: an isolated click at an
 * edge is treated as silence. cut = the sound goes on into the very last window (audio stopped
 * mid-sound: a truncated render).
 * @returns {{lead_ms: number, tail_ms: number, cut: boolean}}
 */
export function edgeSilenceMs(pcm, thresholdDb = -45) {
  const n = pcm.length >> 1;
  const wins = Math.floor(n / EDGE_WIN);
  if (!wins) return { lead_ms: 0, tail_ms: 0, cut: false };
  const thr2 = (32768 * 10 ** (thresholdDb / 20)) ** 2;
  const loud = new Uint8Array(wins);
  for (let w = 0; w < wins; w++) {
    let ss = 0;
    for (let i = w * EDGE_WIN, end = i + EDGE_WIN; i < end; i++) {
      const v = pcm.readInt16LE(i * 2);
      ss += v * v;
    }
    loud[w] = ss / EDGE_WIN > thr2 ? 1 : 0;
  }
  const sustained = (w) => loud[w] && ((w > 0 && loud[w - 1]) || (w + 1 < wins && loud[w + 1]));
  let a = 0;
  while (a < wins && !sustained(a)) a++;
  if (a >= wins) return { lead_ms: Math.round(n / 24), tail_ms: 0, cut: false };
  let b = wins - 1;
  while (b > a && !sustained(b)) b--;
  const tailMs = Math.round((n - (b + 1) * EDGE_WIN) / 24);
  return { lead_ms: a * 10, tail_ms: tailMs, cut: b === wins - 1 };
}

const TRIM_PAD_LEAD_MS = 20;
const TRIM_PAD_TAIL_MS = 80;

/** PCM without edge silence (and edge clicks) beyond the pads (a view, no copy). */
export function trimEdges(pcm, edges = edgeSilenceMs(pcm)) {
  const start = Math.max(0, edges.lead_ms - TRIM_PAD_LEAD_MS) * BYTES_PER_MS;
  const end = pcm.length - Math.max(0, edges.tail_ms - TRIM_PAD_TAIL_MS) * BYTES_PER_MS;
  return end - start >= BYTES_PER_MS * 50 ? pcm.subarray(start, end) : pcm;
}

/** WAV file bytes for PCM16 mono. */
export function pcmToWav(pcm, sampleRate = SAMPLE_RATE) {
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

/** Rough spoken length of a text before it is rendered (calibrated on the 18.09 realtime readouts). */
export function estimateDurationMs(text) {
  return Math.round(800 + 75 * stripStress(text).length);
}

/** Audio-token cost of `ms` of speech. */
export function audioCostUsd(ms, pricing = DEFAULT_PRICING) {
  return ((ms / 1000) * pricing.audio_tokens_per_s * pricing.usd_per_m_audio_tokens) / 1e6;
}

// ---------------------------------------------------------------------------------------------
// render errors
// ---------------------------------------------------------------------------------------------

// or_mouth.js (OrError.kind): auth | payment | model_unavailable are fatal; rate_limit | server | timeout |
// network | bad_response | stream_error | no_audio are transient; bad_request fails the clip.
const FATAL_CODES = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'insufficient_credits', 'billing_hard_limit_reached', 'billing_not_active',
  'payment_required', 'payment', 'auth', 'model_unavailable', 'invalid_api_key', 'account_deactivated', 'unauthorized', 'forbidden',
  'model_not_found', 'http_401', 'http_402', 'http_403', 'closed', 'missing_key', 'no_mouth',
]);
const FATAL_STATUS = new Set([401, 402, 403]);
const FATAL_TEXT = /insufficient[_ ]quota|credit[_ ]balance|no credits|insufficient credits|exceeded your current quota|billing|payment required|invalid[_ ]api[_ ]key|incorrect api key|missing key|unauthori[sz]ed|account[_ ]deactivated|mouth is closed/i;
const RETRY_CODES = new Set([
  'rate_limit_exceeded', 'rate_limit', 'server', 'network', 'bad_response', 'stream_error',
  'http_429', 'timeout', 'no_audio', 'disconnected', 'stale', 'server_error', 'empty_audio',
  'backpressure', 'verbatim_mismatch', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

function errorFacts(err) {
  const codes = [err?.code, err?.kind, err?.error?.code, err?.result?.error?.code, err?.result?.reason, err?.cause?.code, err?.error?.type, err?.type]
    .filter((c) => c != null && c !== '')
    .map(String);
  const status = Number(err?.status ?? err?.statusCode ?? err?.response?.status ?? err?.result?.error?.status ?? err?.cause?.status) || null;
  const message = [err?.message, err?.error?.message, err?.result?.error?.message, err?.cause?.message].filter(Boolean).join(' | ');
  return { codes, status, message };
}

/** 'fatal' (stop everything: credits, auth, closed mouth) | 'retry' (transient) | 'fail' (this clip only). */
export function classifyRenderError(err) {
  const { codes, status, message } = errorFacts(err);
  if (codes.some((c) => FATAL_CODES.has(c)) || FATAL_STATUS.has(status) || FATAL_TEXT.test(message)) return 'fatal';
  if (codes.some((c) => RETRY_CODES.has(c) || /^http_5\d\d$/.test(c) || c.startsWith('incomplete'))) return 'retry';
  if (status === 429 || (status >= 500 && status < 600)) return 'retry';
  if (/timed? ?out|rate limit|temporar|overloaded|ECONNRESET|socket hang up|network/i.test(message)) return 'retry';
  return 'fail';
}

/** Human-readable STOP message for ensure() stats.fatal (tools print it; the host logs it). */
export function fatalMessage(fatal, identity = {}, { requests } = {}) {
  if (!fatal) return '';
  const who = identity.provider ? `${identity.provider} (${identity.model})` : 'the voice provider';
  const detail = `${fatal.code}${fatal.message ? `: ${fatal.message}` : ''}`;
  const sent = requests != null ? ` after ${requests} request(s)` : '';
  if (/credit|quota|billing|payment|http_402/i.test(`${fatal.code} ${fatal.message}`) || fatal.status === 402) {
    return `STOP: ${who} has no credits (${detail}).\nRendering stopped${sent}; nothing was retried. Top up the account (or switch the key), then run again:\nclips already rendered stay cached and are not paid for twice.`;
  }
  if (/http_401|http_403|unauthori|invalid_api_key|missing key|missing_key/i.test(`${fatal.code} ${fatal.message}`) || fatal.status === 401 || fatal.status === 403) {
    return `STOP: ${who} rejected the key (${detail}). Check it with \`node src/main.js --check\` (present/absent only).`;
  }
  if (fatal.code === 'http_429' || fatal.status === 429) {
    return `STOP: ${who} answered HTTP 429 (${detail}): rate limit or no credits (the endpoint does not say which).\nNot retried. Check the account balance, then run again.`;
  }
  if (fatal.code === 'too_many_failures') return `STOP: ${detail}. Nothing more is sent; see the errors above and logs/render_clips_*.jsonl.`;
  return `STOP: ${detail}.`;
}

/** {code, status?, message} of a render/connect error (fatal codes win), for stats and fatalMessage(). */
export function describeRenderError(err) {
  return errorSummary(err);
}

function errorSummary(err) {
  const { codes, status, message } = errorFacts(err);
  const code = codes.find((c) => FATAL_CODES.has(c)) ?? codes[0] ?? (status ? `http_${status}` : 'error');
  return { code, ...(status ? { status } : {}), message: message.slice(0, 300) || String(err).slice(0, 300) };
}

function addUsage(total, u, costUsd) {
  if (!u || typeof u !== 'object') {
    if (typeof costUsd !== 'number') return;
    u = {};
  }
  total.responses += 1;
  total.input_tokens += u.input_tokens ?? u.prompt_tokens ?? 0;
  total.output_tokens += u.output_tokens ?? u.completion_tokens ?? 0;
  total.audio_out_tokens += u.output_token_details?.audio_tokens ?? u.completion_tokens_details?.audio_tokens ?? 0;
  const cost = typeof u.cost === 'number' ? u.cost : costUsd;
  if (typeof cost === 'number') {
    total.cost_usd += cost;
    total.priced += 1;
  }
}

function compactUsage(u) {
  if (!u || typeof u !== 'object') return undefined;
  const out = {
    input_tokens: u.input_tokens ?? u.prompt_tokens,
    output_tokens: u.output_tokens ?? u.completion_tokens,
    audio_out_tokens: u.output_token_details?.audio_tokens ?? u.completion_tokens_details?.audio_tokens,
    cost: typeof u.cost === 'number' ? u.cost : undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v != null));
}

// ---------------------------------------------------------------------------------------------
// ClipStore
// ---------------------------------------------------------------------------------------------

export class ClipStore {
  /**
   * @param {object} [o]
   * @param {object} [o.settings]    merged settings (voice/realtime sections feed the identity fallback)
   * @param {object} [o.mouth]       has renderClip(text, {withInfo, meta}); its identity keys the cache
   * @param {{event: Function}} [o.log]
   * @param {string} [o.cacheDir]    cache root (default scripts/standup_host/cache)
   * @param {object} [o.phrases]     parsed phrases.json (default: config/phrases.json)
   * @param {object[]} [o.people]    people.json entries (default: config/people.json)
   * @param {object} [o.identity]    explicit {provider, model, voice, instructions} (tests, dry runs)
   * @param {object} [o.pricing]     {usd_per_m_audio_tokens, audio_tokens_per_s}
   * @param {() => number} [o.random]
   * Knobs: concurrency 2, retries 1, retryDelayMs 1000, renderTimeoutMs 60000, maxConsecutiveFailures 4, minClipMs 150.
   */
  constructor({ settings = {}, mouth = null, log = null, cacheDir = CACHE_DIR, phrases, people, identity = null, pricing, random = Math.random, ...knobs } = {}) {
    this.settings = settings;
    this.mouth = mouth;
    this.cacheRoot = cacheDir;
    this.opts = { ...DEFAULTS, ...knobs };
    this.phrases = phrases ? normalizePhrases(phrases) : loadPhrases();
    const all = peopleList(people ?? loadPeople());
    this._byId = new Map(all.map((p) => [p.id, p]));
    /** Roster: people.json entries without `exclude`. */
    this.people = all.filter((p) => !p.exclude);
    this.pricing = { ...DEFAULT_PRICING, ...(settings.voice?.pricing ?? {}), ...(pricing ?? {}) };
    this._identity = identity;
    this._logger = log;
    this._random = random;
    this._last = new Map(); // phrase key -> last variant index
    this._present = null; // Set of ids (setPresent)
    this._stats = { hits: 0, misses: 0, not_applicable: 0, rendered: 0, render_failed: 0 };
  }

  /** {provider, model, voice, instructions} used for keys (re-read on every call). */
  get identity() {
    return voiceIdentity({ mouth: this.mouth, settings: this.settings, identity: this._identity });
  }

  /** Cache directory of the current identity. */
  get dir() {
    return cacheDirFor(this.cacheRoot, this.identity);
  }

  /** Who is in the call (ids or people objects); used for surname disambiguation when opts.present is absent. */
  setPresent(ids) {
    this._present = ids == null ? null : new Set(toIds(ids));
  }

  /** Cache key of `text` for the current voice identity. */
  hash(text) {
    return clipHash(this.identity, finalizeText(text));
  }

  /** True if a clip for the text (or hash) is cached. */
  has(textOrHash, { isHash = /^[0-9a-f]{40}$/.test(String(textOrHash)) } = {}) {
    const hash = isHash ? String(textOrHash) : this.hash(textOrHash);
    return existsSync(join(this.dir, `${hash}.pcm`));
  }

  /** All variant texts of `key` for `person` (no rotation); null when the phrase does not apply. */
  variants(key, { person, present } = {}) {
    const r = this._resolve(key, person, present);
    return r ? r.texts.map((t) => ({ ...t })) : null;
  }

  /**
   * Text of a phrase: {name} filled, surname added for present namesakes, variant rotated
   * (or `variantIndex`). null when the phrase does not apply (only_for, unknown person).
   * Throws on an unknown key or a per-person key without `person`.
   */
  text(key, { person, present, variantIndex } = {}) {
    const r = this._resolve(key, person, present);
    if (!r) return null;
    const i = this._choose(key, r.texts.length, null, variantIndex);
    return r.texts[i].text;
  }

  /**
   * Cached clip for a phrase (synchronous file read). Rotates among cached variants.
   * trim (default true): leading/trailing near-silence (< -45 dBFS) is cut down to 20/80 ms pads, so
   * the player is not "speaking" through the ~0.3-0.5 s of silence the models append (someone
   * answering right after «тебе слово» must not look like a barge-in). The file on disk is untouched.
   * @returns {{pcm: Buffer, text: string, duration_ms: number, key: string, variant: number, person: string|null, hash: string, lead_ms: number, tail_ms: number, trimmed_ms: number, source: 'clip'} | null}
   */
  get(key, { person, present, variantIndex, trim = true } = {}) {
    const r = this._resolve(key, person, present);
    if (!r) {
      this._stats.not_applicable++;
      return null;
    }
    const identity = this.identity;
    const dir = cacheDirFor(this.cacheRoot, identity);
    const entries = r.texts.map((t) => ({ ...t, hash: clipHash(identity, t.text) }));
    let cached = entries.filter((e) => existsSync(join(dir, `${e.hash}.pcm`))).map((e) => e.variant);
    if (variantIndex != null) {
      const want = ((variantIndex % entries.length) + entries.length) % entries.length;
      cached = cached.filter((v) => v === want);
    }
    if (!cached.length) return this._miss(key, r, entries, variantIndex);
    const i = this._choose(key, entries.length, cached, null);
    const e = entries[i];
    let pcm;
    try {
      pcm = readFileSync(join(dir, `${e.hash}.pcm`));
    } catch {
      return this._miss(key, r, entries, variantIndex);
    }
    this._stats.hits++;
    const edges = edgeSilenceMs(pcm);
    const out = trim ? trimEdges(pcm, edges) : pcm;
    return {
      key,
      variant: i,
      person: r.person?.id ?? null,
      text: e.text,
      hash: e.hash,
      pcm: out,
      duration_ms: Math.round(out.length / BYTES_PER_MS),
      ...edges, // of the file
      trimmed_ms: Math.round((pcm.length - out.length) / BYTES_PER_MS),
      source: 'clip',
    };
  }

  /** Cached clip by hash: {pcm, hash, duration_ms, meta (sidecar or null)} | null. */
  getByHash(hash) {
    const base = join(this.dir, hash);
    let pcm;
    try {
      pcm = readFileSync(`${base}.pcm`);
    } catch {
      return null;
    }
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
    } catch {
      // sidecar is optional
    }
    return { pcm, hash, text: meta?.text ?? null, duration_ms: Math.round(pcm.length / BYTES_PER_MS), meta };
  }

  /**
   * Everything the roster needs: general phrases once, per-person phrases for each `present` person
   * (only_for honoured), plus the «Имя Фамилия» forms for people who have a namesake in the roster.
   * Deduplicated by hash. Nothing is rendered.
   * @param {object} [o]
   * @param {object[]} [o.people]    roster override (default: this.people)
   * @param {string[]} [o.present]   ids to render for (default: the whole roster)
   * @param {string|string[]} [o.keys] key names/patterns/'core' (default: all)
   * @param {boolean} [o.surnames=true]
   * @returns {{key: string, person: string|null, variant: number, surname: boolean, text: string, hash: string, cached: boolean}[]}
   */
  plan({ people, present, keys, surnames = true } = {}) {
    const roster = people ? peopleList(people).filter((p) => !p.exclude) : this.people;
    const byId = new Map(roster.map((p) => [p.id, p]));
    const targets = present == null ? roster : toIds(present).map((id) => byId.get(id) ?? this._byId.get(id)).filter((p) => p && !p.exclude);
    const identity = this.identity;
    const dir = cacheDirFor(this.cacheRoot, identity);
    const entries = [];
    const seen = new Set();
    const add = (key, person, variant, text, surname) => {
      const hash = clipHash(identity, text);
      if (seen.has(hash)) return;
      seen.add(hash);
      entries.push({ key, person: person?.id ?? null, variant, surname, text, hash, cached: existsSync(join(dir, `${hash}.pcm`)) });
    };
    for (const key of selectKeys(this.phrases, keys)) {
      const ph = this.phrases[key];
      if (!ph.perPerson) {
        ph.variants.forEach((t, i) => add(key, null, i, finalizeText(t), false));
        continue;
      }
      for (const person of targets) {
        if (ph.onlyFor && !ph.onlyFor.has(person.id)) continue;
        const forms = [false];
        if (surnames && person.disambiguate_with_surname !== false && findNamesakes(person, roster).length && surnameOf(person)) forms.push(true);
        for (const withSurname of forms) {
          const name = spokenName(person, { withSurname });
          ph.variants.forEach((t, i) => add(key, person, i, finalizeText(t.replaceAll('{name}', name)), withSurname));
        }
      }
    }
    return entries;
  }

  /** Counts and cost estimate of a plan: {total, cached, missing, cached_audio_ms, est_missing_audio_ms, est_cost_usd, by_key}. */
  summarize(entries) {
    const dir = this.dir;
    const out = { total: entries.length, cached: 0, missing: 0, cached_audio_ms: 0, est_missing_audio_ms: 0, est_cost_usd: 0, by_key: {} };
    for (const e of entries) {
      const k = (out.by_key[e.key] ??= { total: 0, cached: 0 });
      k.total++;
      if (existsSync(join(dir, `${e.hash}.pcm`))) {
        out.cached++;
        k.cached++;
        out.cached_audio_ms += fileAudioMs(join(dir, `${e.hash}.pcm`));
      } else {
        out.missing++;
        out.est_missing_audio_ms += estimateDurationMs(e.text);
      }
    }
    out.est_cost_usd = round6(audioCostUsd(out.est_missing_audio_ms, this.pricing));
    return out;
  }

  /**
   * Render what is missing, `concurrency` (2) at a time. Never throws for render errors:
   * - fatal errors (credits exhausted, auth, closed mouth) stop scheduling at once -> stats.fatal;
   * - transient errors and verbatim mismatches get `retries` (1) more attempts;
   * - maxConsecutiveFailures (4) failed clips in a row stop the run too (stats.fatal code 'too_many_failures').
   * A clip whose transcript still differs from its text is not cached (keepMismatch: true caches it).
   * @param {Array<{text: string, key?: string, person?: string, variant?: number, surname?: boolean}>} list
   * @param {object} [o]  {concurrency, signal, onProgress(info), keepMismatch, retries}
   * @returns {Promise<object>} stats
   */
  async ensure(list, { concurrency = this.opts.concurrency, signal, onProgress, keepMismatch = false, retries = this.opts.retries } = {}) {
    const t0 = Date.now();
    const identity = this.identity;
    const dir = cacheDirFor(this.cacheRoot, identity);
    const stats = {
      requested: list.length,
      unique: 0,
      cached: 0,
      rendered: 0,
      failed: 0,
      mismatched: 0,
      cut: 0, // rendered, but still sounding at the last sample after the retry (kept, see warnings)
      skipped: 0,
      attempts: 0,
      audio_ms: 0, // all clips of the list that are on disk afterwards
      rendered_audio_ms: 0,
      usage: { responses: 0, input_tokens: 0, output_tokens: 0, audio_out_tokens: 0, cost_usd: 0, priced: 0 },
      cost_usd: 0,
      cost_source: 'none',
      fatal: null,
      errors: [],
      warnings: [],
      elapsed_ms: 0,
      dir,
    };
    const todo = [];
    const seen = new Set();
    for (const item of list) {
      if (!item || typeof item.text !== 'string' || !item.text.trim()) continue;
      const text = finalizeText(item.text);
      const hash = clipHash(identity, text);
      if (seen.has(hash)) continue;
      seen.add(hash);
      stats.unique++;
      const file = join(dir, `${hash}.pcm`);
      if (existsSync(file)) {
        stats.cached++;
        stats.audio_ms += fileAudioMs(file);
      } else {
        todo.push({ ...item, text, hash });
      }
    }
    if (todo.length && !this.mouth?.renderClip) {
      stats.fatal = { code: 'no_mouth', message: 'ClipStore has no mouth to render with' };
      stats.skipped = todo.length;
    }
    let next = 0;
    let done = 0;
    let streak = 0;
    const stopped = () => stats.fatal || signal?.aborted;
    const worker = async () => {
      while (!stopped() && next < todo.length) {
        const entry = todo[next++];
        const res = await this._renderOne(entry, dir, identity, stats, { keepMismatch, retries, stopped });
        done++;
        if (res.status === 'rendered') streak = 0;
        else if (res.status !== 'skipped') streak++;
        if (!stats.fatal && streak >= this.opts.maxConsecutiveFailures) {
          stats.fatal = { code: 'too_many_failures', message: `${streak} clips in a row failed; last: ${res.error?.code ?? res.status}` };
          this._log('clips.fatal', stats.fatal);
        }
        if (onProgress) {
          try {
            onProgress({ done, total: todo.length, entry, ...res });
          } catch {
            // progress output must not break rendering
          }
        }
      }
    };
    if (!stats.fatal) await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
    stats.skipped = todo.length - stats.rendered - stats.failed - stats.mismatched;
    const u = stats.usage;
    if (u.priced && u.priced === u.responses) {
      stats.cost_usd = round6(u.cost_usd);
      stats.cost_source = 'usage.cost';
    } else if (u.audio_out_tokens) {
      stats.cost_usd = round6((u.audio_out_tokens * this.pricing.usd_per_m_audio_tokens) / 1e6 + (u.priced ? u.cost_usd : 0));
      stats.cost_source = 'audio_tokens';
    } else if (stats.rendered_audio_ms) {
      stats.cost_usd = round6(audioCostUsd(stats.rendered_audio_ms, this.pricing));
      stats.cost_source = 'estimate';
    }
    stats.elapsed_ms = Date.now() - t0;
    this._log('clips.ensure', {
      unique: stats.unique,
      cached: stats.cached,
      rendered: stats.rendered,
      failed: stats.failed,
      mismatched: stats.mismatched,
      skipped: stats.skipped,
      audio_ms: stats.audio_ms,
      cost_usd: stats.cost_usd,
      cost_source: stats.cost_source,
      fatal: stats.fatal,
      elapsed_ms: stats.elapsed_ms,
      provider: identity.provider,
      model: identity.model,
      voice: identity.voice,
    });
    return stats;
  }

  /** plan() + ensure(): everything the present roster needs. Returns ensure() stats + plan counts. */
  async warmup({ people, present, keys, surnames = true, ...ensureOpts } = {}) {
    const entries = this.plan({ people, present, keys, surnames });
    const before = this.summarize(entries);
    const stats = await this.ensure(entries, ensureOpts);
    return { ...stats, planned: entries.length, est_cost_usd: before.est_cost_usd, est_missing_audio_ms: before.est_missing_audio_ms };
  }

  /** Render (or load) one arbitrary text. Resolves {pcm, text, hash, duration_ms}; rejects with the render error. */
  async renderText(text, meta = {}) {
    const stats = await this.ensure([{ ...meta, text }], { concurrency: 1 });
    const hit = this.getByHash(clipHash(this.identity, finalizeText(text)));
    if (hit) return { ...hit, text: finalizeText(text) };
    const e = stats.fatal ?? stats.errors[0] ?? { code: 'not_rendered', message: 'clip was not rendered' };
    throw Object.assign(new Error(`render failed: ${e.code}: ${e.message ?? ''}`), { code: e.code, fatal: Boolean(stats.fatal), stats });
  }

  stats() {
    return { ...this._stats, present: this._present ? [...this._present] : null };
  }

  // ---- internals -----------------------------------------------------------------------------

  _person(arg) {
    if (arg == null) return null;
    if (typeof arg === 'string' || typeof arg === 'number') {
      const p = this._byId.get(String(arg));
      return p && !p.exclude ? p : null;
    }
    if (typeof arg === 'object') {
      if (arg.id != null && this._byId.has(String(arg.id))) {
        const p = this._byId.get(String(arg.id));
        return p.exclude ? null : p;
      }
      return firstName(arg) ? arg : null; // a guest: text() works, get() misses
    }
    return null;
  }

  _presentPeople(arg) {
    const src = arg ?? this._present;
    if (src == null) return null;
    const list = src instanceof Set ? [...src] : Array.isArray(src) ? src : toIds(src);
    return list.map((x) => (x && typeof x === 'object' ? (x.id != null && this._byId.get(String(x.id))) || x : this._byId.get(String(x)))).filter(Boolean);
  }

  _resolve(key, personArg, presentArg) {
    const ph = this.phrases[key];
    if (!ph) throw new Error(`clips: unknown phrase key "${key}"`);
    if (!ph.perPerson) return { key, person: null, surname: false, texts: ph.variants.map((t, i) => ({ variant: i, text: finalizeText(t) })) };
    if (personArg == null) throw new TypeError(`clips: "${key}" is per-person, pass {person}`);
    const person = this._person(personArg);
    if (!person) {
      this._log('clips.error', { reason: 'unknown_person', key, person: String(personArg?.id ?? personArg?.display ?? personArg) });
      return null;
    }
    if (ph.onlyFor && !ph.onlyFor.has(String(person.id))) return null;
    const present = this._presentPeople(presentArg);
    const surname = Boolean(present) && person.disambiguate_with_surname !== false && Boolean(surnameOf(person)) && findNamesakes(person, present).length > 0;
    const name = spokenName(person, { withSurname: surname });
    return { key, person, surname, texts: ph.variants.map((t, i) => ({ variant: i, text: finalizeText(t.replaceAll('{name}', name)) })) };
  }

  _choose(key, n, allowed, explicit) {
    let i;
    if (explicit != null && Number.isInteger(explicit)) {
      i = ((explicit % n) + n) % n;
    } else {
      const base = allowed ?? Array.from({ length: n }, (_, k) => k);
      const last = this._last.get(key);
      const pool = base.length > 1 ? base.filter((x) => x !== last) : base;
      i = pool[Math.min(pool.length - 1, Math.floor(this._random() * pool.length))];
    }
    this._last.set(key, i);
    return i;
  }

  _miss(key, r, entries, variantIndex) {
    this._stats.misses++;
    this._log('clips.miss', {
      key,
      person: r.person?.id ?? null,
      surname: r.surname || undefined,
      variant: variantIndex ?? undefined,
      text: entries[0]?.text,
    });
    return null;
  }

  async _renderOne(entry, dir, identity, stats, { keepMismatch, retries, stopped }) {
    let lastError = null;
    for (let attempt = 1; attempt <= 1 + retries; attempt++) {
      if (stopped()) return { status: 'skipped' };
      stats.attempts++;
      let out;
      try {
        out = await withTimeout(
          this.mouth.renderClip(entry.text, { withInfo: true, meta: { clip: entry.hash.slice(0, 12), key: entry.key ?? null, person: entry.person ?? null } }),
          this.opts.renderTimeoutMs,
        );
      } catch (err) {
        lastError = err;
        const kind = classifyRenderError(err);
        if (kind === 'fatal') {
          const e = errorSummary(err);
          if (!stats.fatal) {
            stats.fatal = e;
            this._log('clips.fatal', { ...e, key: entry.key, person: entry.person, text: entry.text });
          }
          return { status: 'skipped', error: e };
        }
        // or_mouth.js already retries transient errors itself (opts.clipRetries): no second layer
        const mouthRetries = Number(this.mouth?.opts?.clipRetries) > 0;
        if (kind === 'retry' && attempt <= retries && !mouthRetries && !stopped()) {
          await sleep(this.opts.retryDelayMs * attempt);
          continue;
        }
        return this._failed(entry, stats, 'failed', errorSummary(err));
      }
      const info = Buffer.isBuffer(out) || out instanceof Uint8Array ? { pcm: Buffer.from(out) } : (out ?? {});
      const pcm = info.pcm ? Buffer.from(info.pcm) : null;
      if (!pcm || pcm.length < this.opts.minClipMs * BYTES_PER_MS) {
        lastError = { code: 'empty_audio', message: `${pcm?.length ?? 0} bytes of audio` };
        if (attempt <= retries && !stopped()) continue;
        return this._failed(entry, stats, 'failed', lastError);
      }
      addUsage(stats.usage, info.usage, info.cost_usd);
      if (info.verbatim === false && !keepMismatch) {
        lastError = { code: 'verbatim_mismatch', message: `said «${info.transcript ?? ''}»`, transcript: info.transcript ?? null, similarity: info.similarity ?? null };
        if (attempt <= retries && !stopped()) continue;
        return this._failed(entry, stats, 'mismatched', lastError);
      }
      const even = pcm.length & 1 ? pcm.subarray(0, pcm.length - 1) : pcm;
      const edges = edgeSilenceMs(even);
      if (edges.cut && attempt <= retries && !stopped()) {
        lastError = { code: 'cut_audio', message: 'audio stops mid-sound' };
        continue; // truncated render: one more try; a second cut one is kept but flagged
      }
      const durationMs = Math.round(even.length / BYTES_PER_MS);
      const sidecar = {
        text: entry.text,
        created: new Date().toISOString(),
        duration_ms: durationMs,
        key: entry.key ?? null,
        person: entry.person ?? null,
        variant: entry.variant ?? null,
        surname: entry.surname ?? false,
        provider: identity.provider,
        model: identity.model,
        voice: identity.voice,
        instructions_sha1: createHash('sha1').update(identity.instructions, 'utf8').digest('hex').slice(0, 12),
        sample_rate: SAMPLE_RATE,
        bytes: even.length,
        ...edges,
        transcript: info.transcript ?? null,
        verbatim: info.verbatim ?? null,
        similarity: info.similarity ?? null,
        ttfa_ms: info.ttfa_ms ?? null,
        attempts: attempt,
        usage: compactUsage(info.usage),
      };
      try {
        mkdirSync(dir, { recursive: true });
        atomicWrite(join(dir, `${entry.hash}.pcm`), even);
        atomicWrite(join(dir, `${entry.hash}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
      } catch (err) {
        return this._failed(entry, stats, 'failed', { code: err.code ?? 'write_error', message: err.message });
      }
      stats.rendered++;
      stats.audio_ms += durationMs;
      stats.rendered_audio_ms += durationMs;
      this._stats.rendered++;
      if (edges.cut) {
        stats.cut++;
        stats.warnings.push({ code: 'cut_audio', key: entry.key ?? null, person: entry.person ?? null, text: entry.text, hash: entry.hash });
      }
      this._log('clips.render', {
        hash: entry.hash.slice(0, 12),
        key: entry.key ?? null,
        person: entry.person ?? null,
        variant: entry.variant ?? null,
        audio_ms: durationMs,
        lead_ms: edges.lead_ms,
        tail_ms: edges.tail_ms,
        attempts: attempt,
        verbatim: info.verbatim ?? null,
      });
      return { status: 'rendered', audio_ms: durationMs, attempts: attempt };
    }
    return this._failed(entry, stats, 'failed', errorSummary(lastError));
  }

  _failed(entry, stats, status, error) {
    if (status === 'mismatched') stats.mismatched++;
    else stats.failed++;
    this._stats.render_failed++;
    const rec = { key: entry.key ?? null, person: entry.person ?? null, variant: entry.variant ?? null, text: entry.text, status, ...error };
    stats.errors.push(rec);
    this._log('clips.error', rec);
    return { status, error };
  }

  _log(type, fields) {
    try {
      this._logger?.event?.(type, fields);
    } catch {
      // logging must never break audio
    }
  }
}

// ---------------------------------------------------------------------------------------------
// the mouth used by the tools
// ---------------------------------------------------------------------------------------------

/**
 * Open the voice that renders clips (tools/render_clips.js, tools/audition_names.js).
 * src/audio/voice.js (createVoice) when it exists; WP3's realtime mouth only when
 * settings.voice.provider === 'openai_realtime'. Keys stay inside the process (env.js).
 * @returns {Promise<{mouth: object, kind: string, close: () => Promise<void>}>}
 */
export async function openRenderVoice({ settings = {}, log } = {}) {
  const voiceUrl = new URL('./voice.js', import.meta.url);
  if (existsSync(fileURLToPath(voiceUrl))) {
    const { createVoice } = await import(voiceUrl.href);
    const v = await createVoice({ settings, log });
    const close = async () => {
      try {
        await (typeof v?.close === 'function' ? v.close() : v?.mouth?.close?.());
      } catch {
        // closing is best effort
      }
    };
    if (!v?.mouth?.renderClip) {
      await close();
      throw Object.assign(new Error('voice.js: createVoice() returned no mouth.renderClip'), { code: 'no_mouth' });
    }
    try {
      if (typeof v.connect === 'function') await v.connect(); // openrouter: key check (GET /key, free)
    } catch (err) {
      await close();
      throw err;
    }
    return { mouth: v.mouth, kind: v.kind ?? 'voice', close };
  }
  if (settings?.voice?.provider === 'openai_realtime') {
    const [{ RealtimeSession, loadPeople: people }, { createMouth }, { requireKey }] = await Promise.all([
      import('./realtime_ws.js'),
      import('./mouth.js'),
      import('../env.js'),
    ]);
    // maxAttempts 1: a refused handshake (HTTP 429 = quota) must not be retried in a loop
    const session = new RealtimeSession({ settings, apiKey: requireKey(settings.keys.openai), people: people(), log, maxAttempts: 1 });
    await session.connect();
    const mouth = createMouth(session, { log });
    return {
      mouth,
      kind: 'openai_realtime',
      close: async () => {
        mouth.close();
        await session.close();
      },
    };
  }
  throw Object.assign(new Error('src/audio/voice.js is not available and settings.voice.provider is not "openai_realtime"'), { code: 'no_mouth' });
}

/**
 * Offline stand-in for the tools' --mock: renders a synthetic voiced tone (≈ 70 ms per character,
 * 60 ms leading silence). failAfter = N -> from call N+1 on every render fails like an account
 * without credits (HTTP 429, code credit_balance_exhausted).
 */
export function createSyntheticMouth({ instructions = '', failAfter = null, delayMs = 20 } = {}) {
  let calls = 0;
  return {
    kind: 'mock',
    identity: { provider: 'mock', model: 'synthetic', voice: 'tone', instructions },
    get calls() {
      return calls;
    },
    async renderClip(text, { withInfo = false } = {}) {
      const n0 = ++calls;
      await sleep(delayMs);
      if (failAfter != null && n0 > failAfter) {
        throw Object.assign(new Error('You have no credits remaining'), { code: 'credit_balance_exhausted', status: 429 });
      }
      const ms = 600 + 70 * stripStress(text).length;
      const n = Math.round(ms * 24);
      const pcm = Buffer.alloc(n * 2);
      for (let i = 1440; i < n - 7200; i++) {
        // 60 ms lead, 300 ms silent tail like a real render
        const t = i / SAMPLE_RATE;
        const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t);
        pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 180 * t) * env * 9000), i * 2);
      }
      return withInfo ? { pcm, transcript: text, verbatim: true, similarity: 1, usage: { completion_tokens_details: { audio_tokens: Math.round(ms / 50) } } } : pcm;
    },
    close() {},
  };
}

function fileAudioMs(file) {
  try {
    return Math.round(statSync(file).size / BYTES_PER_MS);
  } catch {
    return 0;
  }
}

function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function withTimeout(promise, ms) {
  if (!ms) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`render timed out after ${ms} ms`), { code: 'timeout' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
