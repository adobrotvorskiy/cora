// Per-call brain input (PLAN.md §2 «Контракты»): one compact JSON snapshot of the meeting.
// This is the only part of the prompt that changes between calls; the system prompt stays
// byte-stable so the provider can cache it.
//
// `state` is a snapshot owned by the host (WP6 state.js) and may already use the contract
// field names. buildContext() fills defaults, formats instants (Date or epoch ms) as Moscow
// "HH:MM:SS", keeps the last `windowSec` of transcript and the last `maxEvents` events,
// clips long texts (keeping the tail: the end of a phrase decides a turn end) and trims to
// ~maxTokens: oldest transcript first, then oldest events, then shorter texts.

import { formatMsk, mskParts, now as clockNow } from '../clock.js';

/** Contract key order. */
export const CONTEXT_KEYS = Object.freeze([
  'now', 'day_mode', 'phase', 'deadline', 'lead_present', 'participants', 'speaker', 'host', 'plan',
  'recent_events', 'transcript_window', 'trigger',
]);
export const PHASES = Object.freeze(['waiting', 'starting', 'round', 'open_floor', 'closing', 'silent']);
export const STATUSES = Object.freeze(['pending', 'spoke', 'speaking', 'absent']);
export const TRIGGERS = Object.freeze([
  'turn_end_candidate', 'silence', 'joined', 'left', 'chat', 'question_to_host', 'timer', 'barge_in', 'plan_refresh',
]);

// leadId: people.json "first_always" (loadBrainAssets().firstAlways); only used when the
// state has no lead_present of its own. Neither given -> lead_present: null (unknown).
const DEFAULTS = { windowSec: 45, maxEvents: 20, maxTokens: 2500, leadId: null, maxTextChars: 400 };
const EVENT_TEXT_MAX = 160;
const UTTERANCE_MAX = 220;

/**
 * Rough token count for budgeting (o200k-style tokenizers: ~3.5 chars/token for ASCII
 * JSON, ~2.9 for Cyrillic). Calibrated against provider usage in tools/bench_brain.js.
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  let ascii = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 128) ascii++;
  return Math.ceil(ascii / 3.5 + (s.length - ascii) / 2.9);
}

/**
 * @param {object} state  host snapshot: {now, day_mode, phase, deadline:{soft,hard}, lead_present?,
 *   participants:[{id,name,present,joined,status}], speaker:{id,conf,since_s|since,silence_ms}|null,
 *   host:{speaking,silent_mode,last_utterance,last_interrupted}, plan:{next,then},
 *   recent_events|events:[{t,type,...}], transcript_window|transcript:[{t,who,text}], trigger}
 * @param {{windowSec?: number, maxEvents?: number, maxTokens?: number, leadId?: string|null, maxTextChars?: number}} [opts]
 *   leadId: people.json "first_always" id, used only if state.lead_present is not a boolean
 * @returns {object} context in contract key order (JSON-serializable)
 */
export function buildContext(state = {}, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const nowValue = state.now ?? clockNow();
  const nowSec = secOfDay(nowValue);
  const participants = (state.participants ?? []).filter((p) => p && p.id != null).map((p) => ({
    id: String(p.id),
    name: p.name ?? p.display ?? String(p.id),
    present: Boolean(p.present),
    joined: fmtTime(p.joined) ?? null,
    status: STATUSES.includes(p.status) ? p.status : p.present ? 'pending' : 'absent',
  }));
  const orlov = o.leadId ? participants.find((p) => p.id === o.leadId) : null;

  const events = (state.recent_events ?? state.events ?? []).slice(-o.maxEvents).map(compactEvent);
  const transcript = (state.transcript_window ?? state.transcript ?? [])
    .filter((e) => e && typeof e.text === 'string' && e.text.trim())
    .filter((e) => {
      const t = secOfDay(e.t);
      return nowSec === null || t === null || nowSec - t <= o.windowSec;
    })
    .map((e) => ({ t: fmtTime(e.t), who: e.who == null ? '?' : String(e.who), text: clipTail(e.text.trim(), o.maxTextChars) }));

  const ctx = {
    now: fmtTime(nowValue),
    day_mode: state.day_mode ?? null,
    phase: state.phase ?? 'waiting',
    deadline: { soft: state.deadline?.soft ?? null, hard: state.deadline?.hard ?? null },
    lead_present: typeof state.lead_present === 'boolean' ? state.lead_present : orlov ? orlov.present : null,
    participants,
    speaker: compactSpeaker(state.speaker, nowValue),
    host: {
      speaking: Boolean(state.host?.speaking),
      silent_mode: Boolean(state.host?.silent_mode),
      last_utterance: state.host?.last_utterance ? clipTail(String(state.host.last_utterance), UTTERANCE_MAX) : null,
      last_interrupted: Boolean(state.host?.last_interrupted),
    },
    plan: { next: state.plan?.next ?? null, then: Array.isArray(state.plan?.then) ? state.plan.then.map(String) : [] },
    recent_events: events,
    transcript_window: transcript,
    trigger: state.trigger ?? null,
  };
  fitBudget(ctx, o.maxTokens);
  return ctx;
}

/** Estimated tokens of the context as sent (compact JSON). */
export function contextTokens(ctx) {
  return estimateTokens(JSON.stringify(ctx));
}

function fitBudget(ctx, maxTokens) {
  const over = () => contextTokens(ctx) > maxTokens;
  if (!over()) return;
  while (ctx.transcript_window.length > 2 && over()) ctx.transcript_window.shift();
  while (ctx.recent_events.length > 3 && over()) ctx.recent_events.shift();
  if (over()) {
    for (const e of ctx.transcript_window) e.text = clipTail(e.text, 160);
    for (const e of ctx.recent_events) if (typeof e.text === 'string') e.text = clipTail(e.text, 60);
    if (ctx.host.last_utterance) ctx.host.last_utterance = clipTail(ctx.host.last_utterance, 100);
  }
  while (ctx.transcript_window.length > 1 && over()) ctx.transcript_window.shift();
  while (ctx.recent_events.length > 1 && over()) ctx.recent_events.shift();
}

function compactSpeaker(speaker, nowValue) {
  if (!speaker) return null;
  let sinceS = Number.isFinite(speaker.since_s) ? Math.round(speaker.since_s) : null;
  if (sinceS === null && speaker.since != null) {
    const a = toMs(speaker.since);
    const b = toMs(nowValue);
    if (a !== null && b !== null) sinceS = Math.max(0, Math.round((b - a) / 1000));
  }
  return {
    id: speaker.id ?? null,
    conf: speaker.conf ?? 'unknown',
    since_s: sinceS,
    silence_ms: Number.isFinite(speaker.silence_ms) ? Math.round(speaker.silence_ms) : null,
  };
}

// Events keep scalar fields only (nested objects are dropped); texts are clipped.
function compactEvent(e) {
  const out = { t: fmtTime(e?.t ?? e?.ts) };
  for (const [key, value] of Object.entries(e ?? {})) {
    if (key === 't' || key === 'ts' || value == null) continue;
    if (typeof value === 'string') out[key] = clipTail(value, EVENT_TEXT_MAX);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[key] = value.slice(0, 12);
  }
  return out;
}

function toMs(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

/** Date / epoch ms -> Moscow "HH:MM:SS"; strings pass through. */
function fmtTime(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  const ms = toMs(v);
  return ms === null ? null : formatMsk(new Date(ms), 'HH:mm:ss');
}

/** Seconds since Moscow midnight for Date / epoch ms / "HH:MM[:SS[.mmm]]"; null if unknown. */
function secOfDay(v) {
  const ms = toMs(v);
  if (ms !== null) {
    const p = mskParts(new Date(ms));
    return p.hour * 3600 + p.minute * 60 + p.second + p.ms / 1000;
  }
  if (typeof v === 'string') {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(v.trim());
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0) + (m[4] ? Number(`0.${m[4]}`) : 0);
  }
  return null;
}

function clipTail(text, max) {
  const s = String(text);
  return s.length <= max ? s : `…${s.slice(s.length - max + 1).trimStart()}`;
}
