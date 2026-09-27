// Settings and well-known paths.
//
// loadSettings() = config/settings.json <- config/settings.local.json <- CLI overrides
// (deep merge: plain objects merge key by key; arrays and scalars replace).
// settings.local.json is optional and gitignored: the meeting links (meeting_url, real_room_url,
// test_room_url), the Telegram chat, the ElevenLabs agent id, the Yandex folder, tuned thresholds.
//
// People and company data never go to git: config/people.json, persona.md, playbook.md,
// phrases.json and stt_fixes.json are local (.gitignore); the repo carries fictional stand-ins
// *.example.* that contentPath() falls back to.

import { existsSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { APP_ROOT, hasKey } from './env.js';

export const CONFIG_DIR = join(APP_ROOT, 'config');
export const CACHE_DIR = join(APP_ROOT, 'cache');
export const LOGS_DIR = join(APP_ROOT, 'logs');
export const STATE_DIR = join(APP_ROOT, 'state');
export const PROFILE_DIR = join(APP_ROOT, 'profile');
export const SETTINGS_PATH = join(CONFIG_DIR, 'settings.json');
export const SETTINGS_LOCAL_PATH = join(CONFIG_DIR, 'settings.local.json');
/** Kill-switch flag file: its appearance means "leave the meeting" (created by stop-standup.ps1). */
export const STOP_FILE = join(STATE_DIR, 'STOP');

/** STANDUP_EXAMPLES_ONLY=1 (npm test): only the committed stand-ins, never this machine's real data. */
export const examplesOnly = () => process.env.STANDUP_EXAMPLES_ONLY === '1';

/** config/<name>, or its committed fictional stand-in config/<base>.example<ext> when the real file is absent. */
export function contentPath(name, dir = CONFIG_DIR) {
  const real = join(dir, name);
  const ext = extname(name);
  const example = join(dir, `${basename(name, ext)}.example${ext}`);
  if (examplesOnly()) return existsSync(example) ? example : real;
  if (existsSync(real)) return real;
  return existsSync(example) ? example : real;
}

/** Order that settings.times must follow. */
export const TIME_KEYS = ['join', 'start', 'wait_lead_until', 'soft_deadline', 'hard_deadline', 'force_leave', 'transcription_cutoff'];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SECTIONS = ['times', 'realtime', 'voice', 'brain', 'floor', 'browser', 'telegram', 'keys'];
/** Same list as src/audio/voice.js VOICE_PROVIDERS (not imported: voice.js depends on this module). */
export const VOICE_PROVIDERS = Object.freeze(['openrouter', 'openai_realtime', 'elevenlabs_agent', 'yandex_rt', 'yandex_cascade']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * @param {object} [opts]
 * @param {object} [opts.cliOverrides]  e.g. {meeting_url} from --url; undefined values are ignored
 * @param {string} [opts.configDir]  directory with settings.json (tests)
 * @returns {object} merged settings (a fresh object on every call)
 */
export function loadSettings({ cliOverrides = {}, configDir = CONFIG_DIR } = {}) {
  const base = readJson(join(configDir, 'settings.json'), true);
  const local = examplesOnly() && configDir === CONFIG_DIR ? {} : (readJson(join(configDir, 'settings.local.json'), false) ?? {});
  const s = deepMerge(deepMerge(base, local), cliOverrides ?? {});
  // yandex_cascade is Yandex end to end: unless brain.provider says otherwise, the brain is AI Studio too
  if (s.voice?.provider === 'yandex_cascade' && isPlainObject(s.brain) && !s.brain.provider) s.brain.provider = 'yandex';
  return s;
}

/** Deep merge for JSON data: plain objects merge recursively; everything else replaces. */
export function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return structuredClone(over === undefined ? base : over);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined || FORBIDDEN_KEYS.has(key)) continue;
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? deepMerge(out[key], value) : structuredClone(value);
  }
  return out;
}

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
/** Fallback offsets (== config/settings.times) so a sparse template still yields a full schedule. */
const TIME_TEMPLATE_DEFAULTS = { join: '09:58', start: '10:00', wait_lead_until: '10:02', soft_deadline: '10:28', hard_deadline: '10:30', force_leave: '10:35', transcription_cutoff: '10:40' };

/**
 * Shift the daily schedule so the meeting starts at startHHMM: every times.* key keeps its
 * offset from template.start (10:00 when the template omits or invalidates it). "--start 10:00"
 * with the default template reproduces it exactly. Callers restrict startHHMM to 00:05–22:55 so
 * the +40 min cutoff never crosses midnight. Missing/invalid template keys fall back to the
 * built-in defaults, so the result always covers every TIME_KEYS entry.
 * @param {string} startHHMM  "HH:MM"
 * @param {object} [template]  settings.times-like map of "HH:MM" values
 * @returns {object} full times map (TIME_KEYS order)
 */
export function deriveTimes(startHHMM, template = {}) {
  const anchor = toMin(startHHMM);
  const base = typeof template.start === 'string' && HHMM_RE.test(template.start) ? toMin(template.start) : toMin(TIME_TEMPLATE_DEFAULTS.start);
  const out = {};
  for (const key of TIME_KEYS) {
    const v = typeof template[key] === 'string' && HHMM_RE.test(template[key]) ? template[key] : TIME_TEMPLATE_DEFAULTS[key];
    out[key] = toHHMM(anchor + (toMin(v) - base));
  }
  return out;
}

/**
 * Sanity checks for --check. errors = the host cannot run correctly; warnings = suspicious.
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validateSettings(s) {
  const errors = [];
  const warnings = [];
  for (const section of SECTIONS) {
    if (!isPlainObject(s?.[section])) errors.push(`settings.${section} is missing`);
  }
  if (!s?.meeting_url) {
    errors.push('meeting_url is empty: put the meeting link into config/settings.local.json (or pass --url)');
  } else {
    try {
      if (new URL(s.meeting_url).protocol !== 'https:') errors.push('meeting_url must be https://');
    } catch {
      errors.push('meeting_url is not a valid URL');
    }
  }
  if (isPlainObject(s?.times)) {
    let prev = null;
    for (const key of TIME_KEYS) {
      const value = s.times[key];
      if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        errors.push(`times.${key} must be "HH:MM"`);
        prev = null;
        continue;
      }
      if (prev && value <= prev.value) errors.push(`times.${key} (${value}) must be after times.${prev.key} (${prev.value})`);
      prev = { key, value };
    }
  }
  if (isPlainObject(s?.realtime)) {
    if (s.realtime.speed !== 1) warnings.push(`realtime.speed is ${s.realtime.speed}; keep 1.0 (API speed-up distorts the voice)`);
    if (typeof s.realtime.pace_instructions !== 'string' || !s.realtime.pace_instructions.trim()) warnings.push('realtime.pace_instructions is empty');
  }
  if (isPlainObject(s?.voice)) {
    const v = s.voice;
    if (!VOICE_PROVIDERS.includes(v.provider)) errors.push(`voice.provider must be one of ${VOICE_PROVIDERS.join('|')}`);
    if (v.provider === 'openrouter') {
      for (const key of ['tts_model', 'stt_model', 'voice']) {
        if (typeof v[key] !== 'string' || !v[key].trim()) errors.push(`voice.${key} must be a non-empty string`);
      }
    }
    if (v.provider === 'elevenlabs_agent') {
      for (const key of ['eleven_voice_id', 'eleven_llm', 'eleven_tts_model']) {
        if (typeof v[key] !== 'string' || !v[key].trim()) errors.push(`voice.${key} must be a non-empty string`);
      }
      if (typeof v.eleven_agent_id !== 'string' || !v.eleven_agent_id.trim()) warnings.push('voice.eleven_agent_id is empty: run node tools/eleven_agent_setup.js');
      if (typeof s.keys?.elevenlabs !== 'string' || !s.keys.elevenlabs) errors.push('keys.elevenlabs must name an env variable (the elevenlabs_agent provider needs it)');
    }
    if (v.provider === 'yandex_cascade') {
      const y = isPlainObject(s.yandex) ? s.yandex : {};
      if (typeof y.folder !== 'string' || !y.folder.trim()) errors.push('yandex.folder must be the cloud folder id (settings.local.json) for voice.provider yandex_cascade');
      if (y.tts !== undefined && !isPlainObject(y.tts)) errors.push('yandex.tts must be an object {voice, role, speed}');
      if (y.tts_pricing !== undefined && !isPlainObject(y.tts_pricing)) errors.push('yandex.tts_pricing must be an object {rub_per_unit, chars_per_unit}');
      if (y.cascade_mouth !== undefined && !['speechkit', 'elevenlabs'].includes(y.cascade_mouth)) errors.push('yandex.cascade_mouth must be speechkit|elevenlabs');
    }
    if (v.host !== undefined && !['automaton', 'agent'].includes(v.host)) errors.push('voice.host must be automaton|agent');
    if (v.host === 'agent') {
      // the agent (src/agent/conductor.js) runs on Yandex AI Studio: the same key and folder as the cascade brain
      if (typeof s.yandex?.folder !== 'string' || !s.yandex.folder.trim()) errors.push('yandex.folder must be the cloud folder id for voice.host agent');
      if (v.provider === 'elevenlabs_agent' || v.provider === 'yandex_rt') errors.push(`voice.host agent needs ears and a mouth (yandex_cascade or openrouter), not ${v.provider}`);
    }
    if (v.eleven !== undefined && !isPlainObject(v.eleven)) errors.push('voice.eleven must be an object');
    for (const group of ['vad', 'stt']) {
      if (v[group] === undefined) continue;
      if (!isPlainObject(v[group])) {
        errors.push(`voice.${group} must be an object`);
        continue;
      }
      for (const [key, value] of Object.entries(v[group])) {
        if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`voice.${group}.${key} must be a number`);
      }
    }
    const vad = isPlainObject(v.vad) ? v.vad : {};
    if (typeof vad.start_db === 'number' && typeof vad.stop_db === 'number' && vad.stop_db >= vad.start_db) errors.push('voice.vad.stop_db must be below voice.vad.start_db');
    const early = isPlainObject(v.stt) ? v.stt.early_final_ms : undefined;
    if (typeof early === 'number' && early > 0 && typeof vad.stop_ms === 'number' && early >= vad.stop_ms) {
      warnings.push(`voice.stt.early_final_ms (${early}) >= voice.vad.stop_ms (${vad.stop_ms}): the speculative final is off`);
    }
  }
  if (s?.agent !== undefined) {
    const a = s.agent;
    if (!isPlainObject(a)) errors.push('agent must be an object {model, timeout_ms, temperature, budget, pricing}');
    else {
      for (const k of ['timeout_ms', 'temperature']) if (a[k] !== undefined && (typeof a[k] !== 'number' || !Number.isFinite(a[k]))) errors.push(`agent.${k} must be a number`);
      if (a.budget !== undefined && !isPlainObject(a.budget)) errors.push('agent.budget must be an object {max_calls, max_tokens, max_rub}');
      if (a.pricing !== undefined && a.pricing !== null && !isPlainObject(a.pricing)) errors.push('agent.pricing must be an object {rub_per_1k_input, rub_per_1k_output}');
    }
  }
  if (isPlainObject(s?.keys)) {
    for (const role of ['openai', 'openrouter', 'elevenlabs', 'yandex', 'yandex_folder', 'telegram']) {
      if (typeof s.keys[role] !== 'string' || !s.keys[role]) errors.push(`keys.${role} must name an env variable`);
    }
  }
  if (isPlainObject(s?.browser) && !['chrome', 'msedge'].includes(s.browser.channel)) {
    warnings.push(`browser.channel "${s.browser.channel}" is not chrome/msedge; --check cannot verify it`);
  }
  return { errors, warnings };
}

/**
 * Brain provider rule (PLAN §2.7): brain.provider 'yandex' (the yandex_cascade voice sets it) uses
 * Yandex AI Studio; otherwise OpenRouter if its key is present, else the OpenAI fallback, else none.
 * Returns env variable names, never values.
 * @returns {{provider: 'openrouter'|'openai'|'yandex'|'none', model: string|null, keyName: string|null}}
 */
export function selectBrainProvider(settings, { has = (name) => hasKey(name) } = {}) {
  const { keys, brain } = settings;
  if (brain.provider === 'yandex') {
    if (!has(keys.yandex)) return { provider: 'none', model: null, keyName: null };
    return { provider: 'yandex', model: brain.yandex_model ?? 'aliceai-llm-flash/latest', keyName: keys.yandex };
  }
  if (has(keys.openrouter)) return { provider: 'openrouter', model: brain.openrouter_model, keyName: keys.openrouter };
  if (has(keys.openai)) return { provider: 'openai', model: brain.openai_fallback_model, keyName: keys.openai };
  return { provider: 'none', model: null, keyName: null };
}

function readJson(path, required) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' && !required) return null;
    throw new Error(`cannot read ${path}: ${e.code ?? e.message}`);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM from Notepad
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON in ${path}: ${e.message}`);
  }
  if (!isPlainObject(data)) throw new Error(`${path} must contain a JSON object`);
  return data;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
