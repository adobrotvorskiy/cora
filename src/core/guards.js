// Deterministic guardrails outside the LLM (WP6, PLAN.md §2 «Детерминировано (код)»):
// kill switch (voice phrase, state/STOP file) = she LEAVES the meeting, the optional schedule
// (--start: 10:00 / 10:02 / 10:28 / 10:30 / 10:35 as defaults), on-demand start by name, brain
// budget (calls, cost, no calls while we speak), answer length, shadow mode, and the refusal to
// join the real standup room without --live.

import * as clock from '../clock.js';
import { sanitizeText, TEXT_LIMITS } from '../brain/actions.js';
import { loadSettings } from '../config.js';
import { clearStopFlag, requestStop, watchStopFlag } from '../ops/stopflag.js';
import { TIMER_NAMES } from './events.js';

/**
 * The meeting links are not in the code: settings.real_room_url (the standup room, joined only with
 * --live) and settings.test_room_url live in config/settings.local.json (never in git).
 */
function localSettings() {
  try {
    return loadSettings();
  } catch {
    return {};
  }
}

/** Telemost meeting id of a link (…/j/<digits>), or null. */
export function meetingIdOf(url) {
  const m = /\/j\/(\d{6,})/.exec(String(url ?? ''));
  return m ? m[1] : null;
}

/** The test room link from settings.test_room_url, or null. */
export function testRoomUrl(settings = localSettings()) {
  const url = settings?.test_room_url;
  return typeof url === 'string' && url ? url : null;
}

const DEFAULT_BUDGET = Object.freeze({ max_brain_calls: 400, max_brain_cost_usd: 1.5, max_live_readouts: 60 });

// «Кора, уйди из встречи» and what STT makes of the name: Кара, Корра, Карат, Карра, Cora…
// (config/stt_fixes.json maps the same variants to «Кора»; kept here too in case it fails to load)
const HOST_NAMES = '(?:кора|кара|корра|карра|карат|кору|кару|коре|коры|кора́|cora|kora|core|кор|ведущая|ведущей|ведущую)';
const LEAVE_WORDS = '(?:уйди|уходи|выйди|выходи|покинь|отключись|исчезни|пошла|leave)';
export const KILL_RE = new RegExp(`(?:^|[^\\p{L}])${HOST_NAMES}(?![\\p{L}])[^\\p{L}]{0,3}(?:\\p{L}+[^\\p{L}]{1,3}){0,2}?${LEAVE_WORDS}(?![\\p{L}])|(?:^|[^\\p{L}])${LEAVE_WORDS}[^\\p{L}]{1,3}${HOST_NAMES}(?![\\p{L}])`, 'iu');
/** «мы сами», «дальше без тебя»: the team continues without her — she leaves. */
export const SOFT_STOP_RE = /(?:^|[^\p{L}])(?:дальше без тебя|мы сами|без тебя дальше)(?![\p{L}])/iu;
export const HOST_NAME_RE = new RegExp(`(?:^|[^\\p{L}])${HOST_NAMES}(?![\\p{L}])`, 'iu');

function fold(text) {
  return String(text ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[̀́]/g, '');
}

/** True for «Кора, уйди из встречи» / «уйди, Кора» and the STT variants of the name. */
export function isKillPhrase(text) {
  return KILL_RE.test(fold(text));
}
/** «Кора, стоп|хватит|замолчи…»: the soft tier — she stops talking and listens, back when addressed by name. */
const QUIET_WORDS = '(?:стоп|хватит|помолчи|замолчи|тихо|молчи|стой|заткнись|stop)';
export const QUIET_RE = new RegExp(`(?:^|[^\\p{L}])${HOST_NAMES}(?![\\p{L}])[^\\p{L}]{0,3}(?:\\p{L}+[^\\p{L}]{1,3}){0,2}?${QUIET_WORDS}(?![\\p{L}])|(?:^|[^\\p{L}])${QUIET_WORDS}[^\\p{L}]{1,3}${HOST_NAMES}(?![\\p{L}])`, 'iu');
/** True for «Кора, стоп» — quiet (stay in the meeting), unlike isKillPhrase (leave the meeting). */
export function isQuietPhrase(text) {
  return QUIET_RE.test(fold(text));
}

// «Кора, начинай / поехали / начнём…» — on-demand mode: people ask her by name to open the
// standup. Start verbs only on purpose: a bare «давай» / «вперёд» is too easy to say by accident.
const START_WORDS = '(?:начинай|начинайте|начнём|начнем|начинаем|начать|начинать|запускай|поехали|погнали|стартуем|стартуй|открывай|открывайте)';
export const START_RE = new RegExp(`(?:^|[^\\p{L}])${START_WORDS}(?![\\p{L}])`, 'iu');
/** True for «Кора, начинай» — the name plus an explicit start verb. */
export function isStartRequest(text) {
  return mentionsHost(text) && START_RE.test(fold(text));
}

/** True when the text addresses the host by name (question_to_host candidates). */
export function mentionsHost(text) {
  return HOST_NAME_RE.test(fold(text));
}

/** Does the URL point at the real standup room? */
export function isRealRoom(url, { realUrl = localSettings()?.real_room_url } = {}) {
  const real = meetingIdOf(realUrl);
  return Boolean(real) && meetingIdOf(url) === real;
}

/**
 * The real room requires --live; any room is joinable at any time of day (the rigid
 * morning window was removed with the fixed schedule — the operator decides when she runs).
 * @returns {{allowed: boolean, reason: string}}
 */
export function realRoomAllowed({ url, flags = {}, realUrl } = {}) {
  if (!isRealRoom(url, realUrl === undefined ? {} : { realUrl })) return { allowed: true, reason: 'not the real room' };
  if (flags.live !== true) return { allowed: false, reason: 'real standup room: pass --live to join it (tests use --url <test room>)' };
  return { allowed: true, reason: 'live' };
}

/** Speakable, bounded text (URLs/keys stripped, ≤ 2 sentences / 220 chars, feminine forms). */
export function limitText(text, limits = {}) {
  const r = sanitizeText(text, { maxChars: limits.maxChars ?? TEXT_LIMITS.maxChars, maxSentences: limits.maxSentences ?? TEXT_LIMITS.maxSentences });
  return r.text;
}

/**
 * @param {object} opts
 * @param {object} opts.settings  times, guards (budget), brain (max_text_*)
 * @param {object} [opts.flags]   {shadow, live, brain}
 * @param {{event: Function}} [opts.log]
 * @param {() => Date|number} [opts.now]  default clock.now() (simulated clock)
 */
export function createGuards({ settings = {}, flags = {}, log = null, now, stopFile, stopIntervalMs } = {}) {
  const times = settings.times ?? {};
  const stopOpts = { ...(stopFile ? { file: stopFile } : {}), ...(stopIntervalMs ? { intervalMs: stopIntervalMs } : {}) };
  const budget = { ...DEFAULT_BUDGET, ...(settings.guards ?? {}) };
  const nowMs = () => {
    const v = now ? now() : clock.now();
    return v instanceof Date ? v.getTime() : Number(v);
  };
  const emit = (type, fields) => {
    try {
      log?.event?.(type, fields);
    } catch {
      // never
    }
  };

  const fired = new Set();
  let stopped = null; // {source, reason, at}
  let watcher = null;
  let brainCalls = 0;
  let liveReadouts = 0;

  const timeKey = { start: 'start', wait_lead_until: 'wait_lead_until', soft_deadline: 'soft_deadline', hard_deadline: 'hard_deadline', force_leave: 'force_leave' };

  /** Instant (ms) of a timer today (simulated calendar day), or null. */
  function timerAt(name) {
    const hhmm = times[timeKey[name]];
    if (!hhmm) return null;
    return clock.todayAt(hhmm, new Date(nowMs())).getTime();
  }

  /** Timer names that are due and not yet fired, in order. Marks them fired. */
  function dueTimers(t = nowMs()) {
    const due = [];
    for (const name of TIMER_NAMES) {
      if (fired.has(name)) continue;
      const at = timerAt(name);
      if (at !== null && t >= at) {
        fired.add(name);
        due.push({ name, at, late_ms: t - at });
      }
    }
    return due;
  }

  function deadline(t = nowMs()) {
    const soft = timerAt('soft_deadline');
    const hard = timerAt('hard_deadline');
    const force = timerAt('force_leave');
    return { soft: soft !== null && t >= soft, hard: hard !== null && t >= hard, force: force !== null && t >= force, ms_to_hard: hard === null ? null : hard - t };
  }

  /** Start watching state/STOP; cb({source, reason}) once when it appears. */
  function watchStop(cb) {
    try {
      if (clearStopFlag(stopOpts)) emit('guard.stopflag_cleared', {});
    } catch (e) {
      emit('guard.stopflag_error', { message: e.message });
    }
    watcher = watchStopFlag(
      (info) => {
        stop('file', info.reason || 'state/STOP', cb);
      },
      { ...stopOpts, onError: (e) => emit('guard.stopflag_error', { message: String(e?.message ?? e) }) },
    );
    return () => watcher?.stop();
  }

  function stop(source, reason, cb) {
    if (stopped) return stopped;
    stopped = { source, reason, at: nowMs() };
    emit('guard.stop', { source, reason });
    if (source === 'voice') {
      try {
        requestStop(`voice: ${String(reason).slice(0, 120)}`, stopOpts);
      } catch {
        // flag file is best effort
      }
    }
    try {
      cb?.(stopped);
    } catch (e) {
      emit('guard.error', { where: 'stop cb', message: e.message });
    }
    return stopped;
  }

  /** Transcript check: kill phrase -> stop (returns true). */
  function checkTranscript(text, cb) {
    if (!isKillPhrase(text)) return false;
    stop('voice', text, cb);
    return true;
  }

  /** May the host make sound now? */
  function speechAllowed({ phase } = {}) {
    if (flags.shadow) return { ok: false, reason: 'shadow' };
    if (stopped || phase === 'silent') return { ok: false, reason: 'silent_mode' };
    if (phase === 'left') return { ok: false, reason: 'left' };
    return { ok: true, reason: null };
  }

  /** May the brain be called for this trigger? Counts the call when ok. */
  function brainAllowed({ trigger, hostSpeaking = false, costUsd = 0, phase } = {}) {
    if (flags.brain === false) return { ok: false, reason: 'no_brain' };
    if (phase === 'silent' || stopped) return { ok: false, reason: 'silent_mode' };
    if (hostSpeaking && trigger !== 'barge_in' && trigger !== 'question_to_host') return { ok: false, reason: 'host_speaking' };
    if (brainCalls >= budget.max_brain_calls) return { ok: false, reason: 'max_brain_calls' };
    if (costUsd >= budget.max_brain_cost_usd) return { ok: false, reason: 'max_brain_cost' };
    brainCalls++;
    return { ok: true, reason: null };
  }

  function liveReadoutAllowed() {
    if (liveReadouts >= budget.max_live_readouts) return { ok: false, reason: 'max_live_readouts' };
    liveReadouts++;
    return { ok: true, reason: null };
  }

  return {
    budget,
    timerAt,
    dueTimers,
    deadline,
    watchStop,
    stop,
    checkTranscript,
    speechAllowed,
    brainAllowed,
    liveReadoutAllowed,
    limitText: (text) => limitText(text, { maxChars: settings.brain?.max_text_chars, maxSentences: settings.brain?.max_text_sentences }),
    isKillPhrase,
    isQuietPhrase,
    isStartRequest,
    mentionsHost,
    get stopped() {
      return stopped;
    },
    get shadow() {
      return Boolean(flags.shadow);
    },
    stats: () => ({ brain_calls: brainCalls, live_readouts: liveReadouts, timers_fired: [...fired], stopped }),
    close: () => watcher?.stop(),
  };
}
