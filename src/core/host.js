// The host (WP6): wires browser, page audio, voice, clips, player, brain and guards into one
// event loop that joins the Telemost room and runs the standup (PLAN.md §2–§5).
//
//   runHost(settings, flags) -> exit code      (main.js startHost)
//
// Flow: voice.connect() -> launch Chrome -> attachPageAudio (avatar camera) -> join -> DOM
// observers -> clips warmup (background) -> event loop (DOM participants/active speaker, ears,
// page events, floor events, 50 ms tick with timers) -> fast path or brain -> actions (clip via
// ClipStore + Player, or live mouth.say -> Player) -> open floor -> closing phrase + dev-sync
// handoff -> leave -> cost summary. Failures go to Telegram (sendAlert, never awaited).
//
// Turn taking (after the first live test, 18.09):
// - A turn ends ONLY on an explicit closer or the «всё?» cycle (floor.js). A VAD stop is a signal,
//   never a decision. The end of a turn is acted on as: ack clip («Спасибо, Серёжа!») -> handoff
//   clip («Дальше Тима.»), or open floor when the plan is empty.
// - Any barge-in during one of those playbacks (ack, handoff, open floor, closing, «всё?») means
//   the end was FALSE: phase and speaker are restored, queued follow-ups dropped, no apology.
// - open_floor -> closing needs 6 s of silence after the question; if anyone spoke in between the
//   brain decides (`leave`), scripted mode waits 12 s. The closing is interruptible like all
//   speech: a barge-in on it returns to open_floor and the host stays until confirmed.
// - Questions without her name: in a room of <= 2 people every question is hers; in a bigger
//   group only questions with «ты» right after her own line or about AI/the host.
// - The brain never writes recaps; duplicate answers (same intent within 10 s) are dropped.
// Every state transition happens inside the Serializer; speech runs as a background task whose
// completion re-enters the serializer, so barge-in is handled while we talk. The kill switch
// (state/STOP, «Кора, стоп») bypasses the serializer: silence never waits behind queued handlers.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as clock from '../clock.js';
import { APP_ROOT } from '../env.js';
import { CONFIG_DIR, PROFILE_DIR, contentPath } from '../config.js';
import { openLog } from '../log.js';
import { launchBrowser } from '../browser/launch.js';
import { attachPageAudio, serveAssets } from '../browser/page_inject.js';
import * as telemost from '../browser/telemost.js';
import { buildContext } from '../brain/context.js';
import { sendAlert } from '../ops/telegram.js';
import { createAttribution } from './attribution.js';
import { loadClips, loadPlayer, loadVoice, NO_VOICE_KIND } from './deps.js';
import { AsyncQueue, RingLog, Serializer, Transcript } from './events.js';
import { createFloor } from './floor.js';
import { createGuards, realRoomAllowed } from './guards.js';
import { createState, loadRoster } from './state.js';

const EXIT = Object.freeze({ ok: 0, error: 1, usage: 64, sigint: 130 });
const TICK_MS = 50;
const DOM_POLL_MS = 3000;
const PLAN_REFRESH_MS = 15_000;
const OPEN_FLOOR_SILENCE_MS = 6000;
const OPEN_FLOOR_AFTER_SPEECH_SILENCE_MS = 12_000;
const PROPOSAL_SILENCE_MS = 6000;
const PROPOSE_AGAIN_MS = 120_000;
const GREETING_GRACE_MS = 45_000;
const SILENCE_THINK_MIN_MS = 10_000;
const SPEAK_WAIT_MS = 8000;
const ADDRESSED_FORCE_MS = 2000; // yandex_cascade: asked by name -> at most this long waiting for a quiet room
const LEAVE_TIMEOUT_MS = 8000;
const CLOSE_TIMEOUT_MS = 10_000;
const SIGINT_BUDGET_MS = 9000;
const ALERT_FLUSH_MS = 8000; // shutdown gives fire-and-forget alerts a bounded window to deliver
const SPEECH_QUEUE_MAX = 4;
const ACK_GAP_MS = 150;
const SHORT_TURN_MS = 6000;
const RECENT_SAID_MS = 10_000;
const OWN_UTTERANCE_WINDOW_MS = 8000;
const BRAIN_ON_BARGE_KINDS = new Set(['answer', 'speak', 'greeting', 'proposal']);
const COST = Object.freeze({ usd_rub: 90, realtime_audio_in_per_m: 32, realtime_audio_out_per_m: 64, realtime_text_in_per_m: 4, realtime_text_out_per_m: 16, transcribe_per_min: 0.006 });
const BLOCKER_RE = /(?:^|[^\p{L}])(?:блокер|блокир|застрял|мешает|проблем|риск|не могу|не получается|не успева|тормозит|горит|нужна помощь|нужна поддержка|стопор)/iu;
const QUESTION_RE = /\?\s*$|^(?:а\s+|и\s+|ну\s+|слушай[, ]+)?(?:кто|что|чего|как|какой|какая|какие|какое|почему|зачем|где|когда|откуда|куда|сколько|чем|чей|можешь|умеешь|расскажи|скажи)(?![\p{L}])/iu;
const YOU_RE = /(?:^|[^\p{L}])(?:ты|тебя|тебе|тобой|твой|твоя|твоё|твое|твои)(?![\p{L}])/iu;
const AI_RE = /(?:^|[^\p{L}])(?:ии|искусствен|нейросет|бот|робот|модель|ведущ|алгоритм|нейронк|железяк)/iu;

/** config/stt_fixes.json -> [{re, to}] (canonical form -> STT variants, whole words, case-insensitive). */
export function loadSttFixes(path = contentPath('stt_fixes.json')) {
  let data;
  try {
    let text = readFileSync(path, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const out = [];
  for (const [to, variants] of Object.entries(data ?? {})) {
    if (to.startsWith('_') || !Array.isArray(variants)) continue;
    const alts = variants.filter((v) => typeof v === 'string' && v.trim()).map(esc);
    if (!alts.length) continue;
    out.push({ to, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'giu') });
  }
  return out;
}

/** Apply the corrections to a transcript. */
export function applySttFixes(text, fixes) {
  let s = String(text ?? '');
  if (!s || !fixes?.length) return s;
  for (const f of fixes) s = s.replace(f.re, f.to);
  return s;
}

/** Does the line look like a question (for questions to the host without her name)? */
export function looksLikeQuestion(text) {
  const s = String(text ?? '').trim();
  return Boolean(s) && QUESTION_RE.test(s);
}

/** Same line modulo case/punctuation/ё, one being the start of the other, or the same first sentence. */
export function sameLine(a, b) {
  const fold = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length < y.length ? x : y;
  const long = x.length < y.length ? y : x;
  if (short.length >= 24 && long.startsWith(short)) return true;
  const head = (s) => fold(String(s ?? '').split(/[.!?]/)[0]);
  const ha = head(a);
  const hb = head(b);
  return ha.split(' ').length >= 3 && ha === hb;
}

const foldWords = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length >= 2);
const INTERRUPT_RE = /(?:^|[^\p{L}])(?:подожди|погоди|стоп|стой|секунду|минутку|извини|прости)(?![\p{L}])/iu;

/**
 * Is a recognized line (mostly) her own voice coming back from someone's speakers? True when at
 * least 60% of its words are in one of the lines she said recently. Short lines count too: an echo
 * of «привет» is still an echo.
 */
export function isOwnEcho(text, saidLines) {
  const words = foldWords(text);
  if (!words.length) return false;
  for (const said of saidLines ?? []) {
    const bag = new Set(foldWords(said));
    if (!bag.size) continue;
    const hit = words.filter((w) => bag.has(w)).length;
    if (hit / words.length >= 0.6) return true;
  }
  return false;
}

/** Recognized speech that should stop her (yandex_cascade barge-in): two words that are not her echo, or «подожди»/«стоп». */
export function interruptsHost(text, saidLines) {
  if (isOwnEcho(text, saidLines)) return false;
  return foldWords(text).length >= 2 || INTERRUPT_RE.test(String(text ?? ''));
}

/** Entry point used by main.js. */
export async function runHost(settings, flags) {
  const log = openLog({ verbose: flags.verbose });
  const host = createHost({ settings, flags, log });
  try {
    return await host.run();
  } finally {
    log.close();
  }
}

/**
 * @param {object} o
 * @param {object} o.settings  merged settings (main.js: --url already applied)
 * @param {object} o.flags     {shadow, verbose, brain, live, maxMinutes, alert, url, at, day}
 * @param {{event: Function, path: string}} o.log
 * @param {object} [o.deps]    test injection: {launchBrowser, attachPageAudio, serveAssets, telemost, loadVoice, loadPlayer, loadClips, createBrain, sendAlert, roster, sttFixes, now, stopFile, stopIntervalMs}
 */
export function createHost({ settings, flags = {}, log, deps = {} }) {
  const D = {
    launchBrowser,
    attachPageAudio,
    serveAssets,
    telemost,
    loadVoice,
    loadPlayer,
    loadClips,
    createBrain: null,
    sendAlert,
    roster: null,
    sttFixes: null,
    now: null,
    ...deps,
  };
  const ev = (type, fields) => {
    try {
      return log.event(type, fields);
    } catch {
      return null;
    }
  };
  const nowMs = () => clock.now().getTime(); // simulated meeting clock (timers, context)
  const wall = D.now ?? (() => Date.now()); // audio/floor timeline
  const serial = new Serializer({ onError: (e) => ev('error.handler', { message: e?.message ?? String(e), stack: e?.stack?.split('\n').slice(0, 4).join(' | ') }) });

  const dayMode = flags.day ? (flags.day === 'mon' ? 'monday_focus' : 'daily_plans') : clock.dayMode() === 'off' ? 'daily_plans' : clock.dayMode();
  const roster = D.roster ?? loadRoster();
  const sttFixes = D.sttFixes ?? loadSttFixes();
  const engagement = { ack: true, clarify_blockers: false, ...(settings.engagement ?? {}) };
  const state = createState({ roster, settings, dayMode, now: nowMs, hostName: settings.display_name });
  // yandex_cascade: loudness alone never interrupts her (people's speakers echo her voice back);
  // recognized speech that is not her echo does (onSttDelta). settings.floor.barge_in_energy overrides.
  const cascade = settings.voice?.provider === 'yandex_cascade';
  // the room counts as busy only while recognized speech (not her echo) is going on: floor activity 'speech'
  const floorSettings = cascade ? { ...settings, floor: { barge_in_energy: false, activity: 'speech', ...(settings.floor ?? {}) } } : settings;
  const floor = createFloor({ settings: floorSettings, log, now: wall });
  const attribution = createAttribution({
    state,
    log,
    now: wall,
    // yandex_cascade: two SFU slots loud at once = people talking over each other; the brain sees it in recent events
    onChorus: ({ ids }) => note('chorus', { who: ids.length ? ids : ['?'] }),
  });
  const guards = createGuards({ settings, flags, log, now: nowMs, stopFile: D.stopFile, stopIntervalMs: D.stopIntervalMs });
  const recent = new RingLog(60);
  const transcript = new Transcript(300);
  const hostState = { speaking: false, silent_mode: false, last_utterance: null, last_interrupted: false };

  let browser = null;
  let page = null;
  let audio = null;
  let voice = null;
  let player = null;
  let clips = null;
  let brain = null;
  let stopObservers = null;
  let tickTimer = null;
  let domPollTimer = null;
  let planRefreshTimer = null;
  let done = null; // {reason, code}
  let resolveDone = null;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let shuttingDown = false;
  let leaving = false;
  let stateVersion = 0;
  const bump = () => ++stateVersion;
  const startedAt = wall();
  const runDeadline = flags.maxMinutes ? startedAt + flags.maxMinutes * 60_000 : null;
  const flow = {
    joinedAt: null,
    roundStarted: false,
    greetedAt: null,
    pingAsked: false,
    proposeAt: null,
    proposedAt: null,
    proposalPending: false,
    proposalEndedAt: 0,
    holdUntil: 0,
    lastSilenceThinkAt: 0,
    openFloorAt: null,
    openFloorSpeech: false,
    wrapUpPending: false,
    wrapUpDone: false,
    hardDeadline: false,
    closingStarted: false,
    closingBarged: false,
    lastCheckDoneFor: null,
    turnEnd: null, // {at, prev, to, reason, phase} while a turn-end playback (ack/handoff/open floor) is in flight
    maxMinutesFired: false,
    startRequestedAt: null, // on-demand mode: «Кора, начинай» final that opened the standup
    lastSpokenAt: null,
    recentSaid: [], // {text, at}
    openQuestion: null, // {text, at, answered}
    lastAnswerAt: 0,
    killChecked: new Set(),
    remoteTracks: new Set(),
    warmupQueued: new Set(),
  };
  const speechQueue = [];
  let currentSpeech = null;
  let speechPumpRunning = false;
  let quiet = false; // «Кора, стоп»: no speech out, still listening; lifted by a line addressed to her by name
  const usage = { alerts: 0 };
  const pendingAlerts = new Set(); // in-flight sendAlert promises, flushed (bounded) in shutdown

  // ----------------------------------------------------------------------------------- helpers

  function note(type, fields = {}) {
    recent.push({ t: nowMs(), type, ...fields });
  }

  function alert(text, level = 'error') {
    if (flags.alert === false) return;
    usage.alerts++;
    const p = Promise.resolve()
      .then(() => D.sendAlert(text, { level, log, settings }))
      .catch(() => {})
      .finally(() => pendingAlerts.delete(p));
    pendingAlerts.add(p);
  }

  /** The hot path never awaits alerts; before exit they get a bounded window to actually send. */
  async function flushAlerts() {
    if (!pendingAlerts.size) return;
    let timer;
    const cap = new Promise((resolve) => {
      timer = setTimeout(resolve, ALERT_FLUSH_MS);
      timer.unref?.();
    });
    await Promise.race([Promise.all([...pendingAlerts]), cap]);
    clearTimeout(timer);
  }

  function finish(reason, code = EXIT.ok) {
    if (done) return;
    done = { reason, code };
    ev('host.finish', { reason, code, phase: state.phase, ...state.summary() });
    resolveDone(done);
  }

  function clipKeyForStart(id) {
    const lead = state.isLead(id);
    const withGreeting = lead && !flow.greetedAt;
    return `start_${dayMode === 'monday_focus' ? 'monday' : 'daily'}_${withGreeting ? 'with' : 'without'}_lead`;
  }

  function closingKey() {
    return dayMode === 'monday_focus' ? 'closing_monday' : 'closing_daily';
  }

  /** ClipStore person argument: a roster id, or a guest object with its Telemost first name. */
  function personArg(id) {
    if (!id) return undefined;
    const rec = state.get(id);
    if (!rec || rec.known) return id;
    return { id, display: rec.telemost_name, vocative: state.vocative(id) };
  }

  function fixText(text) {
    return applySttFixes(text, sttFixes);
  }

  function speakerContext() {
    const cur = attribution.current({ t: wall() });
    if (!cur.id && !cur.speaking) return null;
    const sil = floor.silenceMs(wall());
    return { id: cur.id, conf: cur.conf, since: cur.since ? cur.since : null, silence_ms: Number.isFinite(sil) ? sil : 60_000 };
  }

  function contextFor(trigger) {
    const snap = state.snapshot({
      trigger,
      speaker: speakerContext(),
      host: { ...hostState, speaking: hostState.speaking || player?.isSpeaking?.() === true },
      recent_events: recent.recent(20),
      transcript_window: transcript.window(45_000, wall()).map((l) => ({ t: l.t_msk, who: l.who, text: l.text })),
    });
    return buildContext(snap, { windowSec: 45, maxEvents: 20, maxTokens: 2500, leadId: state.firstAlways });
  }

  function recentlySaid(text) {
    const t = wall();
    flow.recentSaid = flow.recentSaid.filter((r) => t - r.at <= RECENT_SAID_MS);
    return flow.recentSaid.some((r) => sameLine(text, r.text));
  }

  // ------------------------------------------------------------------------------------ speech

  /**
   * Queue a line. spec: {key, person, text, kind, meta, gapBeforeMs, maxWaitMs, force} — key = phrases.json
   * clip (live fallback on a cache miss), text = live verbatim readout. after(result) runs in the
   * serializer once the playback ended (result.status: completed | aborted | failed | shadow | suppressed | skipped).
   */
  function say(spec, after = null, { front = false } = {}) {
    if (quiet) {
      ev('speech.suppressed', { reason: 'quiet', key: spec.key ?? null, text: spec.text ?? null });
      return;
    }
    if (speechQueue.length >= SPEECH_QUEUE_MAX) {
      ev('speech.dropped', { reason: 'queue_full', key: spec.key ?? null, text: spec.text ?? null });
      return;
    }
    const item = { spec, after };
    if (front) speechQueue.unshift(item);
    else speechQueue.push(item);
    void pumpSpeech();
  }

  async function pumpSpeech() {
    if (speechPumpRunning) return;
    speechPumpRunning = true;
    try {
      while (speechQueue.length && !done) {
        if (quiet) {
          clearSpeechQueue('quiet');
          break;
        }
        const item = speechQueue.shift();
        const result = await speakOne(item.spec);
        // silent mode is final: the flow's follow-ups (revert a closing, open floor...) never undo it
        if (item.after) await serial.run(() => (state.phase === 'silent' ? undefined : item.after(result)));
      }
    } finally {
      speechPumpRunning = false;
    }
  }

  function clearSpeechQueue(reason) {
    if (!speechQueue.length) return;
    ev('speech.dropped', { reason, count: speechQueue.length, keys: speechQueue.map((i) => i.spec.key ?? i.spec.kind ?? 'text') });
    speechQueue.length = 0;
  }

  function queuedKinds() {
    return speechQueue.map((i) => i.spec.kind);
  }

  async function speakOne(spec) {
    const allowed = guards.speechAllowed({ phase: state.phase });
    const present = state.presentIds();
    const person = personArg(spec.person);
    let text = spec.text ?? null;
    let clip = null;
    if (spec.key && clips) {
      try {
        clip = clips.get(spec.key, { person, present });
        if (!clip) text = text ?? clips.text(spec.key, { person, present });
        else text = clip.text;
      } catch (e) {
        ev('clips.error', { key: spec.key, person: spec.person ?? null, message: e?.message ?? String(e) });
      }
    }
    if (!spec.key && text && clips && !clip) {
      // a brain text that equals a phrases.json line: play the cached clip (0 ms instead of ~1.4 s TTFA)
      try {
        if (clips.has(text)) {
          const hit = clips.getByHash(clips.hash(text));
          if (hit?.pcm) clip = { ...hit, text, source: 'clip' };
        }
      } catch {
        // cache lookup is best effort
      }
    }
    if (!text) {
      ev('speech.skipped', { reason: 'no_text', key: spec.key ?? null, person: spec.person ?? null });
      return { status: 'skipped', reason: 'no_text', text: null };
    }
    if (!allowed.ok) {
      ev(allowed.reason === 'shadow' ? 'speech.shadow' : 'speech.suppressed', { reason: allowed.reason, key: spec.key ?? null, kind: spec.kind ?? null, source: clip ? 'clip' : 'live', text });
      if (allowed.reason === 'shadow') {
        hostState.last_utterance = text;
        flow.lastSpokenAt = wall();
        flow.recentSaid.push({ text, at: wall() });
        return { status: 'shadow', text, played_ratio: 1 };
      }
      return { status: 'suppressed', reason: allowed.reason, text, played_ratio: 0 };
    }
    // floor gate: never start while the room is active
    const t0 = wall();
    const maxWait = spec.maxWaitMs ?? SPEAK_WAIT_MS;
    // forceAfterMs: she was addressed by name — a room that never goes quiet (an open mic at home)
    // must not keep the answer back; after that long she speaks anyway
    const forceAt = Number.isFinite(spec.forceAfterMs) ? t0 + spec.forceAfterMs : null;
    const forcedNow = () => forceAt !== null && wall() >= forceAt;
    while (!floor.canSpeak(wall()) && wall() - t0 < maxWait && !done && !spec.force && !forcedNow()) await sleep(TICK_MS);
    const forced = !floor.canSpeak(wall()) && !spec.force && forcedNow();
    if (forced) ev('speech.forced', { waited_ms: wall() - t0, kind: spec.kind ?? null, text, silence_ms: floor.silenceMs(wall()) });
    if (!floor.canSpeak(wall()) && !spec.force && !forced) {
      ev('speech.skipped', { reason: 'room_active', waited_ms: wall() - t0, key: spec.key ?? null, kind: spec.kind ?? null, text, silence_ms: floor.silenceMs(wall()), vad_open: floor.vadOpen });
      return { status: 'skipped', reason: 'room_active', text, played_ratio: 0 };
    }
    if (spec.gapBeforeMs) await sleep(spec.gapBeforeMs);
    if (done) return { status: 'skipped', reason: 'done', text, played_ratio: 0 };
    const late = guards.speechAllowed({ phase: state.phase }); // the kill switch may have fired while we waited
    if (!late.ok) {
      ev('speech.suppressed', { reason: late.reason, key: spec.key ?? null, kind: spec.kind ?? null, source: clip ? 'clip' : 'live', text, waited_ms: wall() - t0 });
      return { status: 'suppressed', reason: late.reason, text, played_ratio: 0 };
    }
    const waitMs = wall() - t0;
    if (!clip) {
      const lim = guards.liveReadoutAllowed();
      if (!lim.ok) {
        ev('speech.skipped', { reason: lim.reason, text });
        return { status: 'skipped', reason: lim.reason, text, played_ratio: 0 };
      }
    }
    hostState.speaking = true;
    floor.setHostSpeaking(true, { t: wall() });
    flow.recentSaid.push({ text, at: wall() });
    const meta = { key: spec.key ?? null, person: spec.person ?? null, kind: spec.kind ?? (spec.key ? 'clip' : 'live'), text, wait_ms: waitMs, ...(spec.meta ?? {}) };
    ev('speech.start', { source: clip ? 'clip' : 'live', key: spec.key ?? null, person: spec.person ?? null, kind: meta.kind, text, wait_ms: waitMs, duration_ms: clip?.duration_ms ?? null });
    let result;
    try {
      const handle = clip
        ? player.play(clip.pcm, { meta: { ...meta, source: 'clip', total_ms: clip.duration_ms }, source: 'clip', interrupt: true })
        : typeof player.playLive === 'function'
          ? player.playLive(voice.mouth, text, { meta: { ...meta, source: 'live' }, interrupt: true })
          : playLive(text, meta);
      currentSpeech = { handle, spec, text, startedAt: wall(), source: clip ? 'clip' : 'live' };
      result = normalizeResult(await handle.done);
    } catch (e) {
      result = { status: 'failed', error: e?.message ?? String(e), played_ratio: 0, code: e?.code ?? null };
      ev('speech.error', { key: spec.key ?? null, text, message: result.error, code: result.code });
    }
    currentSpeech = null;
    hostState.speaking = false;
    floor.setHostSpeaking(false, { t: wall() });
    hostState.last_utterance = text;
    hostState.last_interrupted = result.status === 'aborted';
    if (result.status === 'completed') flow.lastSpokenAt = wall();
    ev(result.status === 'aborted' ? 'speech.abort' : 'speech.end', {
      status: result.status,
      source: clip ? 'clip' : 'live',
      key: spec.key ?? null,
      kind: meta.kind,
      text,
      ttfa_ms: result.ttfa_ms ?? null,
      played_ms: result.played_ms ?? null,
      total_ms: result.total_ms ?? null,
      played_ratio: result.played_ratio ?? null,
      reason: result.reason ?? null,
      ...(result.error ? { error: result.error } : {}),
    });
    return { ...result, text };
  }

  /** Player result -> {status, played_ms, total_ms, played_ratio, ttfa_ms, reason, error}. */
  function normalizeResult(r) {
    if (!r || typeof r !== 'object') return { status: 'failed', error: 'no result', played_ratio: 0 };
    const total = Number.isFinite(r.total_ms) ? r.total_ms : Number.isFinite(r.pushed_ms) ? r.pushed_ms : null;
    const played = Number.isFinite(r.played_ms) ? r.played_ms : r.status === 'completed' ? total : 0;
    let ratio = Number.isFinite(r.played_ratio) ? r.played_ratio : null;
    if (ratio === null) ratio = total > 0 ? Math.min(1, Math.round((played / total) * 1000) / 1000) : r.status === 'completed' ? 1 : 0;
    const status = r.status === 'completed' || r.status === 'aborted' ? r.status : 'failed';
    return { ...r, status, total_ms: total, played_ms: played, played_ratio: ratio, ttfa_ms: r.ttfa_ms ?? r.meta?.ttfa_ms ?? null };
  }

  /** Live verbatim readout (fallback when the player has no playLive): mouth.say streams base64 PCM into the player. */
  function playLive(text, meta) {
    const queue = new AsyncQueue();
    const mouth = voice.mouth;
    const h = mouth.say(text, {
      format: 'b64',
      meta: { kind: meta.kind ?? 'live' },
      onAudio: (chunk) => queue.push(chunk),
      onEnd: (r) => {
        if (r.status !== 'completed') queue.abort();
        else queue.end();
      },
    });
    h.done.catch((e) => {
      ev('speech.error', { where: 'mouth.say', text, message: e?.message ?? String(e), code: e?.code ?? null });
      queue.abort();
    });
    const play = player.play(queue, { meta, source: 'live' });
    return {
      done: play.done.then(async (r) => {
        if (r.status === 'failed' || (r.status === 'completed' && r.total_ms === 0)) {
          const mr = await h.done.catch((e) => ({ status: 'failed', reason: e?.code ?? e?.message }));
          if (mr.status !== 'completed') return { ...r, status: 'failed', error: mr.reason ?? mr.status };
        }
        return r;
      }),
      abort: async (reason) => {
        h.cancel().catch(() => {});
        queue.abort();
        return play.abort(reason);
      },
    };
  }

  async function abortSpeech(reason) {
    clearSpeechQueue(reason);
    const cur = currentSpeech;
    if (!cur) return null;
    try {
      const p = cur.handle.abort(reason);
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return normalizeResult(await Promise.race([cur.handle.done, sleep(3000).then(() => ({ status: 'aborted', reason: 'abort_timeout' }))]));
    } catch (e) {
      ev('speech.error', { where: 'abort', message: e?.message ?? String(e) });
      return null;
    }
  }

  // ------------------------------------------------------------------------------------- brain

  function think(trigger, { priority } = {}) {
    if (!brain) return Promise.resolve(null);
    const allowed = guards.brainAllowed({ trigger, hostSpeaking: hostState.speaking, costUsd: brain.stats().cost_usd, phase: state.phase });
    if (!allowed.ok) {
      ev('brain.skipped', { trigger, reason: allowed.reason });
      return Promise.resolve(null);
    }
    const version = stateVersion;
    return brain
      .decide(() => contextFor(trigger), { trigger, priority })
      .then((result) => {
        if (done) return result;
        if (result.status !== 'ok') {
          ev('brain.unusable', { trigger, status: result.status, why: result.action?.why ?? null });
          return result;
        }
        serial.run(() => applyAction(result.action, trigger, { version }));
        return result;
      })
      .catch((e) => {
        ev('brain.error', { trigger, message: e?.message ?? String(e) });
        return null;
      });
  }

  function applyAction(action, trigger, { version } = {}) {
    if (!action || done) return;
    const stale = version != null && version !== stateVersion;
    ev('host.action', { trigger, action: action.action, to: action.to ?? null, text: action.text ?? null, plan: action.plan ?? null, why: action.why ?? null, stale, phase: state.phase });
    if (action.plan) state.setPlan(action.plan);
    if (trigger === 'plan_refresh') return; // only the plan is taken (never interrupt a monologue)
    if (state.phase === 'silent' || state.phase === 'left') return;
    const turnActive = state.phase === 'round' && state.current && floor.turn && !floor.turn.fired && !flow.turnEnd;
    const talkingKinds = new Set(['speak', 'answer']);
    const busyTalking = (currentSpeech && talkingKinds.has(currentSpeech.spec.kind)) || queuedKinds().some((k) => talkingKinds.has(k));
    switch (action.action) {
      case 'wait':
        return;
      case 'speak': {
        if (turnActive && trigger !== 'question_to_host' && trigger !== 'barge_in') {
          ev('host.action_deferred', { action: 'speak', reason: 'turn_active', text: action.text });
          return;
        }
        const text = guards.limitText(action.text);
        if (busyTalking && trigger !== 'question_to_host') return ev('host.action_ignored', { action: 'speak', reason: 'already_speaking', text });
        if (recentlySaid(text)) return ev('host.action_ignored', { action: 'speak', reason: 'duplicate', text });
        say({ text, kind: 'speak', meta: { trigger } });
        return;
      }
      case 'answer': {
        const text = guards.limitText(action.text);
        const q = flow.openQuestion;
        if (trigger !== 'question_to_host' && (!q || q.answered) && wall() - flow.lastAnswerAt < RECENT_SAID_MS) {
          return ev('host.action_ignored', { action: 'answer', reason: 'no_open_question', text });
        }
        if (busyTalking && (!q || q.answered)) return ev('host.action_ignored', { action: 'answer', reason: 'already_speaking', text });
        if (recentlySaid(text)) return ev('host.action_ignored', { action: 'answer', reason: 'duplicate', text });
        if (q) q.answered = true;
        flow.lastAnswerAt = wall();
        // the floor stays with whoever held it before the question (model quirk guard)
        say({ text, kind: 'answer', meta: { trigger }, ...(cascade && q?.how === 'name' ? { forceAfterMs: ADDRESSED_FORCE_MS } : {}) }, () => {
          if (state.current) {
            attribution.setPresumed(state.current);
            floor.resumeTurn();
          }
        });
        return;
      }
      case 'give_word':
        return giveWordAction(action, trigger, { stale, turnActive });
      case 'check_done':
        if (!state.current) return;
        if (action.to && action.to !== state.current) return ev('host.action_ignored', { action: 'check_done', reason: 'not_current', to: action.to, current: state.current });
        checkDone(action.text ? { text: guards.limitText(action.text) } : null);
        return;
      case 'leave':
        if (state.phase === 'round' && (state.current || state.pendingIds().length) && !flow.hardDeadline && !stale) {
          return ev('host.action_ignored', { action: 'leave', reason: 'round_not_finished', current: state.current, pending: state.pendingIds() });
        }
        startClosing(`brain:${trigger}`, action.text ? guards.limitText(action.text) : null);
        return;
      case 'post_chat':
        ev('host.action_ignored', { action: 'post_chat', reason: 'chat unavailable to guests' });
        return;
      default:
        return;
    }
  }

  function giveWordAction(action, trigger, { stale, turnActive }) {
    const to = action.to;
    const rec = to ? state.get(to) : null;
    if (!rec || !rec.present || rec.status === 'spoke') {
      ev('host.action_ignored', { action: 'give_word', reason: !rec ? 'unknown' : !rec.present ? 'absent' : 'already_spoke', to });
      return;
    }
    if (to === state.current) return;
    if (!flow.roundStarted) {
      // the start: only the lead goes first unless the brain decided otherwise (e.g. Orlov absent)
      if (!state.isLead(to) && state.leadPresent() && state.get(state.firstAlways)?.status !== 'spoke') {
        ev('host.action_ignored', { action: 'give_word', reason: 'lead_present_must_go_first', to });
        return startRound(state.firstAlways, action.text ? guards.limitText(action.text) : null);
      }
      return startRound(to, action.text ? guards.limitText(action.text) : null);
    }
    if ((turnActive || flow.turnEnd) && !stale) {
      // never interrupt: the person becomes next in line instead
      state.planInsert(to, { front: true });
      ev('host.action_deferred', { action: 'give_word', reason: turnActive ? 'turn_active' : 'turn_end_in_progress', to, plan: state.plan });
      return;
    }
    if (state.phase === 'open_floor') {
      state.setPhase('round');
      bump();
    }
    handoff(to, action.text ? guards.limitText(action.text) : null, { reason: `brain:${trigger}` });
  }

  // ------------------------------------------------------------------------------- transitions

  function schedulePlanRefresh(id) {
    clearTimeout(planRefreshTimer);
    if (!brain) return;
    planRefreshTimer = setTimeout(() => {
      if (!done && state.phase === 'round' && state.current === id) void think('plan_refresh');
    }, PLAN_REFRESH_MS);
    planRefreshTimer.unref?.();
  }

  function beginTurn(id) {
    state.giveWord(id, { t: nowMs() });
    state.ensurePlan();
    floor.newTurn({ speaker: id, t: wall() });
    attribution.setPresumed(id, { t: wall() });
    flow.lastCheckDoneFor = null;
    flow.turnEnd = null;
    bump();
    note('turn_start', { who: id });
    ev('turn.start', { who: id, plan: state.plan, ...state.summary() });
    schedulePlanRefresh(id);
  }

  function startRound(id, text = null) {
    if (flow.roundStarted || done) return;
    const key = clipKeyForStart(id);
    flow.roundStarted = true;
    flow.proposalPending = false;
    state.setPhase('round');
    bump();
    ev('round.start', { first: id, key, day_mode: dayMode, lead_present: state.leadPresent() });
    const asked = cascade && flow.startRequestedAt !== null; // «Кора, начинай»: people are waiting for her
    say({ key: text ? null : key, text, person: id, kind: 'start', maxWaitMs: 15_000, ...(asked ? { forceAfterMs: ADDRESSED_FORCE_MS } : {}) }, (r) => {
      if (r.status === 'suppressed' || r.status === 'failed') ev('round.start_unspoken', { status: r.status });
      beginTurn(id);
      if (!flow.greetedAt) flow.greetedAt = nowMs();
    });
  }

  /** Transcript of the current turn (lines since the word was given). */
  function turnText(id) {
    const rec = id ? state.get(id) : null;
    const since = rec?.given_at ?? 0;
    return transcript.lines.filter((l) => (l.who === id || l.who === '?') && (l.t_meeting ?? 0) >= since).map((l) => l.text).join(' ');
  }

  function ackSpecFor(prev) {
    const turn = floor.turn;
    const speechMs = turn?.speechMs ?? 0;
    if (speechMs > 0 && speechMs < SHORT_TURN_MS) return { key: 'ack_short', kind: 'ack' };
    if (BLOCKER_RE.test(turnText(prev)) && clips?.phrases?.ack_blocker) return { key: 'ack_blocker', person: prev, kind: 'ack' };
    return { key: 'ack', person: prev, kind: 'ack' };
  }

  /**
   * A CONFIRMED turn end (closer, «всё?» answered, nobody spoke, speaker left, hard deadline):
   * ack clip -> handoff clip to plan.next, or open floor. Any barge-in during these playbacks
   * means the end was false and reverts everything (revertTurnEnd).
   */
  function endTurnSequence(reason) {
    if (done || state.phase !== 'round' || flow.turnEnd) return;
    const prev = state.current;
    if (flow.hardDeadline) return closingAfterTurn(prev, reason);
    const plan = state.ensurePlan();
    const to = plan.next;
    const withAck = engagement.ack !== false && Boolean(prev) && !['no_speech', 'speaker_left'].includes(reason);
    flow.turnEnd = { at: wall(), prev, to, reason, phase: state.phase };
    note('turn_end', { who: prev, reason, to });
    ev('turn.end', { who: prev, reason, to, ack: withAck, plan });
    const proceed = () => {
      if (flow.wrapUpPending && !flow.wrapUpDone) {
        flow.wrapUpDone = true;
        say({ key: 'wrap_up_soon', kind: 'wrap_up' });
      }
      if (to) handoff(to, null, { reason, plain: withAck || reason === 'no_speech', gap: withAck });
      else openFloor(reason);
    };
    if (!withAck) return proceed();
    say(ackSpecFor(prev), (r) => {
      if (r.status === 'aborted') return revertTurnEnd('barge_in_during_ack');
      proceed();
    });
  }

  function handoffKey(to, plain) {
    const rec = state.get(to);
    if (rec?.status === 'skipped') return 'return_to_skipped';
    if (!plain && state.isLead(to) && rec?.joined && state.roundStartedAt && rec.joined > state.roundStartedAt) return 'handoff_lead_joined';
    return plain ? 'handoff_plain' : 'handoff';
  }

  function handoff(to, text = null, { reason = 'fast_path', plain = false, gap = false } = {}) {
    if (done || state.phase !== 'round') return;
    const prev = state.current;
    if (!flow.turnEnd) flow.turnEnd = { at: wall(), prev, to, reason, phase: state.phase };
    const key = handoffKey(to, plain);
    ev('turn.handoff', { from: prev, to, key, reason, text: text ?? null });
    say({ key: text ? null : key, text, person: to, kind: 'handoff', gapBeforeMs: gap ? ACK_GAP_MS : 0, meta: { from: prev, to } }, (r) => {
      if (r.status === 'aborted') return revertTurnEnd('barge_in_during_handoff');
      if (r.status === 'skipped' && r.reason === 'room_active') return postponeTurnEnd(to);
      const te = flow.turnEnd;
      if (prev && state.current === prev) state.finishTurn({ t: nowMs(), status: te?.reason === 'no_speech' ? 'skipped' : 'spoke' });
      beginTurn(to);
    });
  }

  function openFloor(reason) {
    if (done) return;
    const prev = state.current;
    if (!flow.turnEnd) flow.turnEnd = { at: wall(), prev, to: null, reason, phase: state.phase };
    state.setPhase('open_floor');
    flow.openFloorAt = null;
    flow.openFloorSpeech = false;
    bump();
    ev('round.open_floor', { reason, ...state.summary() });
    say({ key: 'open_floor', kind: 'open_floor', maxWaitMs: 20_000 }, (r) => {
      if (r.status === 'aborted') return revertTurnEnd('barge_in_during_open_floor');
      if (r.status === 'skipped' && r.reason === 'room_active') return revertTurnEnd('room_active_at_open_floor');
      const te = flow.turnEnd;
      if (prev && state.current === prev) state.finishTurn({ t: nowMs(), status: te?.reason === 'no_speech' ? 'skipped' : 'spoke' });
      floor.endTurn();
      attribution.setPresumed(null);
      flow.turnEnd = null;
      flow.openFloorAt = wall();
      flow.openFloorSpeech = false;
      bump();
      ev('round.open_floor_asked', { ...state.summary() });
    });
  }

  /** The turn end was false (someone spoke over the ack / handoff / open floor): restore everything. */
  function revertTurnEnd(why) {
    const te = flow.turnEnd;
    flow.turnEnd = null;
    clearSpeechQueue('turn_end_reverted');
    if (te?.phase && state.phase !== te.phase) state.setPhase(te.phase);
    if (te?.prev) {
      if (state.get(te.prev)?.present && state.current !== te.prev) {
        state.setStatus(te.prev, 'speaking');
      }
      attribution.setPresumed(te.prev);
    }
    if (te?.to && te.to !== state.current) state.planInsert(te.to, { front: true });
    floor.resumeTurn();
    flow.lastCheckDoneFor = null;
    flow.openFloorAt = null;
    flow.closingStarted = false;
    bump();
    note('turn_end_reverted', { who: te?.prev ?? null, why });
    ev('turn.end_reverted', { why, who: te?.prev ?? null, to: te?.to ?? null, phase: state.phase, plan: state.plan });
  }

  function postponeTurnEnd(to) {
    const te = flow.turnEnd;
    flow.turnEnd = null;
    if (to) state.planInsert(to, { front: true });
    floor.resumeTurn();
    ev('turn.end_postponed', { who: te?.prev ?? null, to, reason: 'room_active' });
  }

  function closingAfterTurn(prev, reason) {
    if (prev && state.current === prev) state.finishTurn({ t: nowMs() });
    floor.endTurn();
    startClosing(`hard_deadline:${reason}`);
  }

  function startClosing(reason, text = null) {
    if (done || flow.closingStarted) return;
    flow.closingStarted = true;
    clearTimeout(planRefreshTimer);
    const prevPhase = state.phase;
    const prev = state.current;
    state.setPhase('closing');
    bump();
    ev('round.closing', { reason, text: text ?? null, ...state.summary() });
    say({ key: text ? null : closingKey(), text, kind: 'closing', maxWaitMs: 15_000 }, (r) => {
      if (r.status === 'aborted' || (r.status === 'skipped' && r.reason === 'room_active')) {
        // interrupted farewell: stay, back to the open floor (or the round), leave only when confirmed
        flow.closingStarted = false;
        flow.closingBarged = true;
        const back = prevPhase === 'round' && prev ? 'round' : 'open_floor';
        state.setPhase(back);
        if (back === 'round') {
          floor.resumeTurn();
          attribution.setPresumed(prev);
        } else {
          flow.openFloorAt = flow.openFloorAt ?? wall();
          flow.openFloorSpeech = true;
        }
        bump();
        ev('round.closing_reverted', { reason: r.status === 'aborted' ? 'barge_in' : 'room_active', phase: state.phase });
        return;
      }
      ev('round.closed', { status: r.status });
      finish(`closing:${reason}`);
    });
  }

  function checkDone(spec = null) {
    if (!state.current || done || flow.turnEnd) return;
    const who = state.current;
    if (flow.lastCheckDoneFor === who) {
      ev('turn.check_done_skipped', { who, reason: 'already_asked' });
      return endTurnSequence('check_done_repeat');
    }
    flow.lastCheckDoneFor = who;
    say({ key: spec?.text ? null : 'check_done', text: spec?.text ?? null, person: who, kind: 'check_done' }, (r) => {
      if (r.status === 'completed' || r.status === 'shadow') floor.checkDoneAsked({ t: wall() });
      else {
        flow.lastCheckDoneFor = null;
        floor.resumeTurn();
      }
    });
  }

  /** «Кора, стоп»: she stops talking but stays in the meeting; back when a final line addresses her by name. */
  function setQuiet(source) {
    if (quiet || state.phase === 'left' || done) return;
    quiet = true;
    ev('host.quiet', { source, phase: state.phase });
    void abortSpeech('quiet');
  }

  /** The kill switch (voice phrase, state/STOP): she leaves the meeting at once — no farewell, no lingering tile. */
  function leaveNow(source) {
    if (done || state.phase === 'left') return;
    ev('host.kill_leave', { source, phase: state.phase });
    void abortSpeech('kill_switch');
    finish('kill_switch', EXIT.ok);
  }

  // ------------------------------------------------------------------------------ scripted flow

  function scriptedStart() {
    if (flow.roundStarted) return;
    if (state.leadPresent()) return startRound(state.firstAlways);
    if (!flow.greetedAt) {
      flow.greetedAt = nowMs();
      state.setPhase('starting');
      say({ key: 'greet_waiting_lead', kind: 'greeting', maxWaitMs: 20_000 }, () => {
        if (!flow.pingAsked && !state.leadPresent() && !flow.roundStarted) {
          flow.pingAsked = true;
          say({ key: 'ask_ping_lead', kind: 'greeting' });
        }
      });
    }
  }

  function scriptedPropose() {
    if (flow.roundStarted || state.leadPresent() || done) return;
    flow.proposedAt = nowMs();
    flow.proposalPending = false;
    state.setPhase('starting');
    say({ key: 'propose_start_without_lead', kind: 'proposal', maxWaitMs: 20_000 }, (r) => {
      if (r.status === 'completed' || r.status === 'shadow') {
        flow.proposalPending = true;
        flow.proposalEndedAt = wall();
      }
    });
  }

  function proposalTick() {
    if (!flow.proposalPending || flow.roundStarted || done) return;
    if (state.leadPresent()) {
      flow.proposalPending = false;
      return startRound(state.firstAlways);
    }
    const quiet = !floor.active && floor.energySilenceMs(wall()) >= PROPOSAL_SILENCE_MS;
    if (quiet && wall() - flow.proposalEndedAt >= PROPOSAL_SILENCE_MS) {
      flow.proposalPending = false;
      const first = state.defaultOrder()[0];
      if (!first) {
        ev('round.nobody', { reason: 'no participants to start with' });
        flow.proposeAt = nowMs() + PROPOSE_AGAIN_MS;
        return;
      }
      startRound(first);
    }
  }

  // ---------------------------------------------------------------------------------- handlers

  function onParticipants(list, source) {
    if (done || leaving) return;
    const diff = state.applyParticipants(list, { t: nowMs() });
    if (!diff.changed) return;
    for (const id of diff.joined) {
      note('joined', { who: id });
      ev('presence.joined', { who: id, name: state.get(id)?.telemost_name, known: state.get(id)?.known, source, present: state.presentIds() });
    }
    for (const id of diff.left) {
      note('left', { who: id });
      ev('presence.left', { who: id, source, present: state.presentIds() });
    }
    clips?.setPresent?.(state.presentIds());
    bump();
    queueWarmup(diff.joined);
    for (const id of diff.joined) {
      if (state.phase === 'round' || state.phase === 'open_floor') {
        if (state.isLead(id) && state.get(id)?.status !== 'spoke') {
          state.planInsert(id, { front: true });
          ev('plan.lead_joined', { plan: state.plan });
          if (state.phase === 'open_floor' && !flow.turnEnd && !flow.closingStarted) {
            state.setPhase('round');
            bump();
            handoff(id, null, { reason: 'lead_joined_open_floor' });
          }
        } else if (state.get(id)?.status === 'pending') {
          state.planInsert(id, { front: false });
        }
      }
      if (!flow.roundStarted && state.isLead(id) && (state.phase === 'starting' || flow.greetedAt) && !brain) {
        flow.proposalPending = false;
        startRound(id);
      }
    }
    for (const id of diff.left) {
      if (id === state.current && state.phase === 'round') {
        ev('turn.speaker_left', { who: id });
        floor.endTurn();
        flow.turnEnd = null;
        endTurnSequence('speaker_left');
      }
    }
    if (brain && !flow.roundStarted && startTimerPassed() && (diff.joined.length || diff.left.length)) {
      void think(diff.joined.length ? 'joined' : 'left');
    }
  }

  function startTimerPassed() {
    const at = guards.timerAt('start');
    return at !== null && nowMs() >= at;
  }

  function queueWarmup(ids) {
    if (!clips || flags.shadow || voice?.kind === NO_VOICE_KIND) return;
    const fresh = ids.filter((id) => state.get(id)?.known && !flow.warmupQueued.has(id));
    if (!fresh.length) return;
    for (const id of fresh) flow.warmupQueued.add(id);
    void clips
      .warmup({ present: fresh })
      .then((s) => ev('clips.warmup', { for: fresh, rendered: s.rendered, failed: s.failed, cost_usd: s.cost_usd, elapsed_ms: s.elapsed_ms }))
      .catch((e) => ev('clips.warmup_error', { for: fresh, message: e?.message ?? String(e) }));
  }

  function onSpeakers(names) {
    const t = wall();
    const ids = attribution.onDomSpeakers(names, { t });
    floor.onDomSpeakers(ids, { t });
    ev('page.speaker', { names, ids, presumed: attribution.presumed });
    const cur = attribution.current({ t });
    if (cur.interjection && state.phase === 'round') note('interjection', { who: cur.id, presumed: attribution.presumed });
  }

  function onAudioChunk(pcm, levels, meta) {
    const t = wall();
    floor.onLevels(meta?.mix ?? [], { t });
    attribution.onLevels(levels, meta?.mix ?? [], { t });
    try {
      // yandex_cascade: ears are fed per-track (onTrackAudio); the mix would double-feed
      if (voice?.kind !== 'yandex_cascade') voice?.ears?.pushAudio?.(pcm, { t });
    } catch (e) {
      ev('error.ears_push', { message: e?.message ?? String(e) });
    }
  }

  function onPageEvent(e) {
    if (!e || typeof e.type !== 'string') return;
    try {
      player?.onPageEvent?.(e); // everything, including host.installed and worklet.error
    } catch (err) {
      ev('error.player_event', { message: err?.message ?? String(err) });
    }
    if (e.type === 'worklet.error') {
      ev('error.worklet', { message: e.message });
      alert(`аудио-адаптер страницы не запустился (worklet.error: ${String(e.message).slice(0, 120)}), лог ${log.path}`);
      return finish('worklet_error', EXIT.error);
    }
    if (e.type === 'track.added' && e.track_id) flow.remoteTracks.add(e.track_id);
    if (e.type === 'track.ended' && e.track_id) {
      flow.remoteTracks.delete(e.track_id);
      if (flow.remoteTracks.size === 0 && !done) {
        try {
          voice?.ears?.flush?.();
        } catch {
          // ears may not support flush
        }
      }
    }
    const quiet = /^(player\.|audio\.state|capture\.)/.test(e.type);
    if (!quiet) ev(`page.${e.type}`, { ...e, type: undefined });
    else if (e.type === 'player.underrun' || e.type === 'player.aborted') ev(`page.${e.type}`, { ...e, type: undefined });
  }

  function onVad(v) {
    floor.onVad({ type: v.type, t: v.t ?? wall() });
    if (v.type === 'start') note('vad_start', { who: attribution.current({ t: wall() }).id ?? '?' });
  }

  /** What she said in the last few seconds (echo candidates), including the line she is saying now. */
  function saidRecently(ms = 6000) {
    const t = wall();
    const lines = flow.recentSaid.filter((r) => t - r.at <= ms).map((r) => r.text);
    if (currentSpeech?.text) lines.push(currentSpeech.text);
    return lines;
  }

  // yandex_cascade: tracks with a phrase in progress (last partial time); any open = the room is busy
  const speechOpen = new Map();
  const SPEECH_STALE_MS = 3000; // a phrase whose final never came stops counting after this

  function speechActivity(trackId, t, { final = false } = {}) {
    const was = speechOpen.size > 0;
    if (final) speechOpen.delete(trackId);
    else speechOpen.set(trackId, t);
    if (!was && speechOpen.size) floor.onVad({ type: 'start', t });
    else if (was && !speechOpen.size) floor.onVad({ type: 'stop', t });
  }

  function expireSpeech(t) {
    if (!speechOpen.size) return;
    for (const [track, at] of [...speechOpen]) if (t - at > SPEECH_STALE_MS) speechOpen.delete(track);
    if (!speechOpen.size) floor.onVad({ type: 'stop', t });
  }

  function onSttDelta(d) {
    const soFar = fixText(d.so_far ?? d.text ?? '');
    if (cascade && d.track_id && !isOwnEcho(soFar, saidRecently())) {
      speechActivity(d.track_id, d.t ?? wall());
      if (hostState.speaking && interruptsHost(soFar, saidRecently())) {
        if (floor.bargeInFrom('stt', { t: d.t ?? wall() })) ev('floor.stt_barge_in', { text: soFar.slice(0, 120), track: d.track_id.slice(0, 8) });
      }
    }
    floor.onSttDelta({ so_far: soFar, t: d.t ?? wall() });
    if (d.item_id && !flow.killChecked.has(d.item_id) && guards.isKillPhrase(soFar)) {
      flow.killChecked.add(d.item_id);
      ev('guard.kill_phrase', { text: soFar, via: 'delta' }); // at once, not behind the serializer
      guards.stop('voice', soFar, () => leaveNow('voice'));
    } else if (d.item_id && !flow.killChecked.has(d.item_id) && guards.isQuietPhrase(soFar)) {
      flow.killChecked.add(d.item_id);
      ev('guard.quiet_phrase', { text: soFar, via: 'delta' }); // at once, like the kill phrase
      setQuiet('voice');
    }
  }

  function questionToHost(text) {
    if (guards.mentionsHost(text)) return 'name';
    if (!looksLikeQuestion(text)) return null;
    const present = state.presentIds().length;
    if (present <= 2) return 'small_group';
    if (YOU_RE.test(text) && flow.lastSpokenAt && wall() - flow.lastSpokenAt < OWN_UTTERANCE_WINDOW_MS) return 'after_own_utterance';
    if (AI_RE.test(text)) return 'about_ai';
    return null;
  }

  function onSttFinal(f) {
    const t = f.t ?? wall();
    const text = fixText(f.text ?? '');
    if (cascade && f.track_id) speechActivity(f.track_id, t, { final: true });
    floor.onSttFinal({ text, t });
    const kill = guards.isKillPhrase(text);
    if (kill) {
      ev('guard.kill_phrase', { text, via: 'final' }); // at once, not behind the serializer
      guards.stop('voice', text, () => leaveNow('voice'));
    }
    const quietHit = !kill && guards.isQuietPhrase(text);
    if (quietHit) {
      ev('guard.quiet_phrase', { text, via: 'final' }); // at once, like the kill phrase
      setQuiet('voice');
    }
    serial.run(() => {
      if (!text.trim()) return; // blips under min_speech_ms come as empty finals
      if (cascade && f.track_id && !kill && !quietHit && isOwnEcho(text, saidRecently(8000))) {
        ev('transcript.echo', { text: text.slice(0, 160), track: f.track_id.slice(0, 8) }); // her own voice from someone's speakers
        return;
      }
      // yandex_cascade finals come per SFU slot: the slot + DOM history name the speaker
      const span = { t_start: f.t_speech_start ?? null, t_end: f.t_speech_end ?? t };
      const who = f.track_id ? attribution.speakerForTrack({ track_id: f.track_id, ...span }) : attribution.speakerFor(span);
      const line = { t: f.t_speech_end ?? t, t_meeting: nowMs(), t_msk: clock.formatMsk(new Date(nowMs()), 'HH:mm:ss'), who: who.id ?? '?', conf: who.conf, text };
      transcript.push(line);
      ev('transcript', {
        who: line.who,
        conf: who.conf,
        text,
        ...(text !== (f.text ?? '') ? { raw: f.text } : {}),
        ...(f.track_id ? { track: f.track_id.slice(0, 8), via: who.via, ...(who.alt?.length ? { alt: who.alt } : {}), stt_ms: f.latency_ms ?? null } : {}),
      });
      if (quiet && !kill && !quietHit) {
        quiet = false; // a final line addressed to her by name: she is back (not the quiet phrase itself)
        ev('host.quiet_lifted', { source: 'voice', text: text.slice(0, 120) });
      }
      if (kill || state.phase === 'silent' || state.phase === 'left') return;
      const startReq = flow.startRequestedAt === null && !flow.roundStarted && guards.timerAt('start') === null && guards.isStartRequest(text);
      if (startReq) {
        // on-demand mode (no schedule): «Кора, начинай» opens the standup
        flow.startRequestedAt = nowMs();
        note('start_requested', { who: line.who, text: text.slice(0, 160) });
        ev('host.start_requested', { who: line.who, text: text.slice(0, 160) });
        if (state.phase === 'waiting') state.setPhase('starting');
        if (brain) void think('start_requested', { priority: 'high' });
        else scriptedStart();
        return;
      }
      const how = questionToHost(text);
      if (how && brain) {
        flow.openQuestion = { text, at: wall(), answered: false, how };
        note('question_to_host', { who: line.who, text: text.slice(0, 160), how });
        ev('host.question', { who: line.who, how, text });
        void think('question_to_host', { priority: 'high' });
      }
    });
  }

  function onTurnEnd(e) {
    serial.run(() => {
      if (state.phase !== 'round' || done || flow.turnEnd) return;
      note('turn_end_candidate', { who: e.speaker, reason: e.reason, text: (e.text ?? '').slice(-80) });
      ev('turn.end_candidate', { who: e.speaker, reason: e.reason, text: e.text, turn_ms: e.turn_ms, speech_ms: e.speech_ms });
      if (e.reason === 'silence_2500') return checkDone();
      endTurnSequence(e.reason);
    });
  }

  function onCheckDoneAnswered(e) {
    serial.run(() => {
      if (state.phase !== 'round' || done) return;
      ev('turn.check_done_answered', { who: e.speaker, reason: e.reason });
      if (e.reason === 'continue') {
        flow.lastCheckDoneFor = null;
        return;
      }
      endTurnSequence(`check_done_${e.reason}`);
    });
  }

  function onNoSpeech(e) {
    serial.run(() => {
      if (state.phase !== 'round' || done || !state.current || flow.turnEnd) return;
      const who = state.current;
      ev('turn.no_speech', { who, waited_ms: e.waited_ms });
      note('no_speech', { who });
      say({ key: 'are_you_here', person: who, kind: 'are_you_here' }, (r) => {
        if (r.status === 'aborted') return floor.resumeTurn(); // they started talking after all
        if (state.current !== who) return;
        endTurnSequence('no_speech');
      });
    });
  }

  function onBargeIn(e) {
    serial.run(async () => {
      const cur = currentSpeech;
      const kind = cur?.spec?.kind ?? null;
      ev('speech.barge_in', { run_ms: e.run_ms, source: e.source, kind, text: cur?.text ?? null, backoff_ms: e.backoff_ms });
      note('barge_in', { kind });
      const r = await abortSpeech('barge_in');
      if (r && (r.played_ratio ?? 0) < 0.3 && brain && BRAIN_ON_BARGE_KINDS.has(kind)) void think('barge_in', { priority: 'high' });
    });
  }

  function onQuiet() {
    serial.run(() => {
      if (done) return;
      if (brain && (state.phase === 'waiting' || state.phase === 'starting') && startTimerPassed() && !flow.roundStarted && !flow.proposalPending) {
        if (wall() - flow.lastSilenceThinkAt >= SILENCE_THINK_MIN_MS && nowMs() >= flow.holdUntil) {
          flow.lastSilenceThinkAt = wall();
          void think('silence');
        }
      }
    });
  }

  function onSpeechStart(e) {
    ev('floor.speech_start', { who: attribution.current({ t: e.t }).id ?? '?', phase: state.phase });
    if ((state.phase === 'open_floor' && flow.openFloorAt !== null) || state.phase === 'closing') flow.openFloorSpeech = true;
  }

  function onTimer(timer) {
    const { name, late_ms } = timer;
    note('timer', { name });
    ev('timer', { name, late_ms, phase: state.phase, lead_present: state.leadPresent(), present: state.presentIds() });
    switch (name) {
      case 'start':
        if (flow.roundStarted) return;
        if (state.phase === 'waiting') state.setPhase('starting');
        if (brain) {
          flow.holdUntil = 0;
          void think('timer');
        } else scriptedStart();
        return;
      case 'wait_lead_until':
        if (flow.roundStarted) return;
        flow.proposeAt ??= Math.max(nowMs(), (flow.greetedAt ?? 0) + GREETING_GRACE_MS);
        if (brain) void think('timer');
        return;
      case 'soft_deadline':
        if (state.phase === 'round') flow.wrapUpPending = true;
        if (brain && state.phase !== 'round') void think('timer');
        return;
      case 'hard_deadline':
        flow.hardDeadline = true;
        if (state.phase === 'open_floor' || state.phase === 'starting' || state.phase === 'waiting') startClosing('hard_deadline');
        else if (state.phase === 'round' && !state.current && !flow.turnEnd) closingAfterTurn(null, 'no_speaker');
        return;
      case 'force_leave':
        ev('guard.force_leave', {});
        void abortSpeech('force_leave');
        finish('force_leave');
        return;
      default:
        return;
    }
  }

  function openFloorTick(t) {
    if (state.phase !== 'open_floor' || flow.openFloorAt === null || hostState.speaking || speechQueue.length || flow.closingStarted || flow.turnEnd) return;
    if (floor.active || floor.vadOpen) return;
    const sil = floor.energySilenceMs(t);
    if (sil < OPEN_FLOOR_SILENCE_MS || t - flow.openFloorAt < OPEN_FLOOR_SILENCE_MS) return;
    if (!flow.openFloorSpeech) return startClosing('open_floor_silence');
    // someone spoke after the question: the brain decides; scripted mode waits longer
    if (brain) {
      if (t - flow.lastSilenceThinkAt >= SILENCE_THINK_MIN_MS) {
        flow.lastSilenceThinkAt = t;
        void think('silence');
      }
      return;
    }
    if (sil >= OPEN_FLOOR_AFTER_SPEECH_SILENCE_MS) startClosing('open_floor_silence_after_speech');
  }

  function tick() {
    if (done) return;
    const t = wall();
    if (cascade) expireSpeech(t);
    floor.tick({ t });
    serial.run(() => {
      if (done) return;
      for (const timer of guards.dueTimers(nowMs())) onTimer(timer);
      if (!flow.roundStarted && state.phase !== 'silent') {
        if (flow.proposeAt !== null && nowMs() >= flow.proposeAt && nowMs() >= flow.holdUntil && !flow.proposalPending && !state.leadPresent()) {
          if (!brain || nowMs() >= flow.proposeAt + GREETING_GRACE_MS) {
            flow.proposeAt = nowMs() + PROPOSE_AGAIN_MS;
            scriptedPropose();
          }
        }
        proposalTick();
        if (brain && startTimerPassed() && state.leadPresent() && nowMs() - guards.timerAt('start') >= 3 * GREETING_GRACE_MS && !flow.roundStarted && !hostState.speaking) {
          ev('round.brain_stalled', { reason: 'lead present, no start after 135 s: scripted start' });
          startRound(state.firstAlways);
        }
      }
      openFloorTick(t);
      if (runDeadline !== null && t >= runDeadline && !flow.maxMinutesFired) {
        flow.maxMinutesFired = true;
        ev('guard.max_minutes', { minutes: flags.maxMinutes, phase: state.phase });
        if (state.phase === 'silent' || flow.closingStarted || flags.shadow) finish('max_minutes');
        else startClosing('max_minutes');
        setTimeout(() => finish('max_minutes_hard'), 60_000).unref?.();
      }
    });
  }

  // ------------------------------------------------------------------------------------ setup

  async function setup() {
    const url = settings.meeting_url;
    const gate = realRoomAllowed({ url, flags, realUrl: settings.real_room_url ?? null });
    ev('host.start', {
      url,
      display_name: settings.display_name,
      day_mode: dayMode,
      shadow: Boolean(flags.shadow),
      brain: flags.brain !== false,
      live: Boolean(flags.live),
      max_minutes: flags.maxMinutes ?? null,
      simulated: clock.simulation(),
      real_room: !gate.allowed || gate.reason === 'live window',
      engagement,
      stt_fixes: sttFixes.length,
      log: log.path,
    });
    if (!gate.allowed) {
      ev('guard.room_refused', { url, reason: gate.reason });
      console.error(`refused: ${gate.reason}`);
      return EXIT.usage;
    }
    guards.watchStop(() => leaveNow('file')); // at once: the leave must not wait behind queued handlers

    if (flags.brain !== false) {
      try {
        const { createBrain } = D.createBrain ? { createBrain: D.createBrain } : await import('../brain/client.js');
        brain = createBrain({ settings, log, dayMode });
      } catch (e) {
        ev('brain.disabled', { reason: e?.message ?? String(e) });
        brain = null;
      }
    } else ev('brain.disabled', { reason: '--no-brain' });

    // voice first: a dead voice should not leave a ghost in the room
    voice = await D.loadVoice({ settings, log, purpose: 'host' });
    if (voice.kind === NO_VOICE_KIND && flags.live && !flags.shadow) {
      alert('голос не настроен (нет модуля и ключа): в боевую комнату без слуха и голоса не вхожу', 'error');
      return EXIT.error;
    }
    if (voice.kind !== NO_VOICE_KIND) {
      try {
        const t0 = wall();
        const info = await voice.connect();
        ev('voice.connected', { kind: voice.kind, took_ms: wall() - t0, cache_key: voice.raw?.cacheKey ?? voice.cacheKey ?? null, ...(info && typeof info === 'object' ? { info } : {}) });
      } catch (e) {
        ev('voice.connect_error', { kind: voice.kind, message: e?.message ?? String(e) });
        const why = String(e?.message ?? e).slice(0, 120);
        try {
          await voice.close();
        } catch {
          // ignore
        }
        if (flags.live && !flags.shadow) {
          alert(`голос (${voice.kind}) не подключился: ${why}; в боевую комнату без слуха и голоса не вхожу`, 'error');
          return EXIT.error;
        }
        alert(`голос (${voice.kind}) не подключился: ${why}; продолжаю без слуха и голоса`, 'warn');
        voice = (await import('./deps.js')).stubVoice();
      }
    }
    voice.ears.on('vad', onVad);
    voice.ears.on('stt_delta', onSttDelta);
    voice.ears.on('stt_final', onSttFinal);
    voice.ears.on('reset', (r) => floor.onVad({ type: 'reset', t: r.t ?? wall() }));

    const b = settings.browser ?? {};
    browser = await D.launchBrowser({
      profileDir: `${PROFILE_DIR}/host`,
      offscreen: b.window_offscreen !== false,
      viewport: Array.isArray(b.viewport) ? b.viewport : [640, 480],
      headless: Boolean(b.headless),
      log: (e) => ev(e.type ?? 'browser', { ...e, type: undefined }),
    });
    page = browser.page;
    browser.context.on('close', () => {
      if (!shuttingDown && !done) {
        ev('error.browser_closed', {});
        alert(`браузер закрылся во время стендапа (фаза ${state.phase}), лог ${log.path}`);
        finish('browser_closed', EXIT.error);
      }
    });
    page.on('pageerror', (e) => ev('page.error', { message: String(e).slice(0, 300) }));
    page.on('dialog', async (d) => {
      ev('page.dialog', { message: d.message() });
      await d.dismiss().catch(() => {});
    });

    const avatar = avatarOpts();
    if (avatar?.mode === 'segments') await D.serveAssets(page, { prefix: '/__host_assets/', dir: `${APP_ROOT}/assets/live` });
    audio = await D.attachPageAudio(page, {
      onAudio: onAudioChunk,
      onEvent: onPageEvent,
      // yandex_cascade: каждый трек — своя сессия STT (диаризация); для прочих провайдеров не используется
      onTrackAudio: voice?.kind === 'yandex_cascade' ? (pcm, trackId) => voice?.ears?.pushAudio?.(pcm, trackId) : undefined,
      opts: { avatar },
      baseDir: APP_ROOT,
    });
    player = await D.loadPlayer({ page, audio, log });
    player.on?.('state', (s) => {
      if (!s.speaking && !currentSpeech) hostState.speaking = false;
    });
    clips = await D.loadClips({ settings, mouth: voice.kind === NO_VOICE_KIND ? null : voice.mouth, log });
    if (clips) ev('clips.identity', { ...(clips.identity ?? {}), instructions: undefined, dir: clips.dir ?? null });

    const joinRes = await D.telemost.join(page, url, settings.display_name, {
      mic: true,
      camera: Boolean(avatar),
      waitAdmissionMs: settings.browser?.wait_admission_ms ?? 180_000,
      log: (e) => ev(e.type ?? 'join', { ...e, type: undefined }),
    });
    ev('join.result', joinRes);
    if (joinRes.status !== 'joined') {
      alert(`не удалось войти в комнату: ${joinRes.status} (${String(joinRes.detail ?? '').slice(0, 160)}), лог ${log.path}`);
      return EXIT.error;
    }
    flow.joinedAt = nowMs();
    note('host_joined', {});
    if (settings.browser?.hide_incoming_video) {
      try {
        const r = await D.telemost.setHideIncomingVideo(page, true, { log: (e) => ev(e.type ?? 'settings', { ...e, type: undefined }) });
        ev('page.hide_incoming_video', r);
      } catch (e) {
        ev('page.hide_incoming_video', { error: e?.message ?? String(e) });
        await D.telemost.closePanels(page).catch(() => {});
      }
    }
    stopObservers = await D.telemost.installObservers(page, (e) => {
      if (e.type === 'participants') serial.run(() => onParticipants(e.list, 'observer'));
      else if (e.type === 'speaker') onSpeakers(e.names);
    }, { selfName: settings.display_name });
    domPollTimer = setInterval(() => {
      if (done || !page) return;
      D.telemost.getParticipants(page, { selfName: settings.display_name }).then((list) => serial.run(() => onParticipants(list, 'poll'))).catch(() => {});
    }, DOM_POLL_MS);

    floor.on('turn_end_candidate', onTurnEnd);
    floor.on('check_done_answered', onCheckDoneAnswered);
    floor.on('no_speech', onNoSpeech);
    floor.on('barge_in', onBargeIn);
    floor.on('quiet', onQuiet);
    floor.on('speech_start', onSpeechStart);
    tickTimer = setInterval(tick, TICK_MS);

    if (brain) {
      void brain.warmup().then((r) => ev('brain.warmup', { status: r.status, latency_ms: r.latency_ms, ttft_ms: r.ttft_ms }));
    }
    // clips for people already in the room (background); general phrases + the ack/handoff set
    if (clips && !flags.shadow && voice.kind !== NO_VOICE_KIND) {
      const keys = ['core', 'ack*', 'handoff_plain', 'return_to_skipped', 'open_floor', 'wrap_up_soon', 'propose_start_without_lead', 'ask_ping_lead'].filter((k) => k === 'core' || k.endsWith('*') || clips.phrases?.[k]);
      void clips
        .warmup({ present: state.presentIds().filter((id) => state.get(id)?.known), keys })
        .then((s) => ev('clips.warmup', { core: true, rendered: s.rendered, failed: s.failed, cached: s.planned - s.rendered - s.failed, cost_usd: s.cost_usd, elapsed_ms: s.elapsed_ms }))
        .catch((e) => ev('clips.warmup_error', { message: e?.message ?? String(e) }));
      for (const id of state.presentIds()) flow.warmupQueued.add(id);
    }
    return null;
  }

  function avatarOpts() {
    const a = settings.avatar;
    if (!a || a.enabled === false || !a.path) return null;
    const base = { path: a.path, fps: a.fps ?? 12, width: a.width ?? 640, height: a.height ?? 480, label: 'Аватар' };
    if (a.mode === 'segments' && a.video && existsSync(`${APP_ROOT}/assets/live/${a.video}`)) {
      return { ...base, mode: 'segments', video: `/__host_assets/${a.video}`, segments: a.segments, fps: a.fps ?? 15, crossfadeMs: a.crossfadeMs ?? 250, loopFadeMs: a.loopFadeMs ?? 400 };
    }
    if (a.mode === 'segments') ev('avatar.segments_missing', { video: a.video ?? null, fallback: 'still' });
    return base;
  }

  // --------------------------------------------------------------------------------- shutdown

  async function shutdown(reason) {
    shuttingDown = true;
    clearInterval(tickTimer);
    clearInterval(domPollTimer);
    clearTimeout(planRefreshTimer);
    guards.close();
    await abortSpeech('shutdown').catch(() => {});
    if (page && !leaving) {
      leaving = true;
      const t0 = wall();
      try {
        const r = await Promise.race([D.telemost.leave(page, { log: (e) => ev(e.type ?? 'leave', { ...e, type: undefined }) }), sleep(LEAVE_TIMEOUT_MS).then(() => ({ ok: false, detail: 'timeout' }))]);
        ev('leave.result', { ...r, took_ms: wall() - t0, reason });
      } catch (e) {
        ev('leave.error', { message: e?.message ?? String(e) });
      }
      state.setPhase('left');
    }
    try {
      await stopObservers?.();
    } catch {
      // page may be gone
    }
    try {
      player?.close?.();
    } catch {
      // page may be gone
    }
    if (voice) await voice.close().catch(() => {});
    brain?.close?.();
    if (browser) await Promise.race([browser.close(), sleep(CLOSE_TIMEOUT_MS)]).catch(() => {});
    costSummary(reason);
    await flushAlerts(); // a crash alert is the whole point of the crash path: give it up to ALERT_FLUSH_MS
  }

  function costSummary(reason) {
    const b = brain?.stats?.() ?? null;
    const v = voice?.stats?.() ?? null;
    const c = clips?.stats?.() ?? null;
    const p = player?.stats?.() ?? null;
    const rt = v?.session?.usage ?? null;
    let voiceUsd = 0;
    if (rt) {
      voiceUsd += ((rt.input_audio_tokens ?? 0) * COST.realtime_audio_in_per_m + (rt.output_audio_tokens ?? 0) * COST.realtime_audio_out_per_m + (rt.input_text_tokens ?? 0) * COST.realtime_text_in_per_m + (rt.output_text_tokens ?? 0) * COST.realtime_text_out_per_m) / 1e6;
      voiceUsd += ((rt.transcription?.seconds ?? 0) / 60) * COST.transcribe_per_min;
    }
    if (typeof v?.cost_usd === 'number') voiceUsd += v.cost_usd;
    const brainUsd = b?.cost_usd ?? 0;
    const totalUsd = brainUsd + voiceUsd + (c?.cost_usd ?? 0);
    const rate = settings.cost?.usd_rub ?? COST.usd_rub;
    ev('cost.summary', {
      reason,
      duration_min: Math.round((wall() - startedAt) / 6000) / 10,
      brain: b ? { provider: brain.provider, model: brain.model, calls: b.calls, requests: b.requests, ok: b.ok, invalid: b.invalid, errors: b.errors, prompt_tokens: b.prompt_tokens, cached_tokens: b.cached_tokens, completion_tokens: b.completion_tokens, cost_usd: round4(brainUsd) } : null,
      voice: v ? { kind: voice.kind, ...(rt ? { realtime_usage: rt } : {}), ears: v.ears, mouth: v.mouth, cost_usd: round4(voiceUsd) } : null,
      clips: c,
      player: p,
      floor: floor.stats(),
      guards: guards.stats(),
      attribution_hints: attribution.hints(),
      est_total_usd: round4(totalUsd),
      est_total_rub: Math.round(totalUsd * rate * 10) / 10,
      alerts: usage.alerts,
      transcript_lines: transcript.lines.length,
    });
  }

  async function run() {
    let code = EXIT.ok;
    const onSigint = () => {
      ev('guard.sigint', {});
      const t = setTimeout(() => {
        ev('guard.sigint_timeout', {});
        process.exit(EXIT.sigint);
      }, SIGINT_BUDGET_MS);
      t.unref?.();
      finish('sigint', EXIT.sigint);
    };
    process.once('SIGINT', onSigint);
    try {
      const early = await setup();
      if (early !== null) code = early;
      else {
        const d = await donePromise;
        code = d.code;
      }
    } catch (e) {
      ev('error.fatal', { message: e?.message ?? String(e), stack: e?.stack?.split('\n').slice(0, 6).join(' | ') });
      alert(`ошибка хоста: ${String(e?.message ?? e).slice(0, 160)}, лог ${log.path}`);
      code = EXIT.error;
      if (!done) finish('fatal', EXIT.error);
    }
    process.off('SIGINT', onSigint);
    await shutdown(done?.reason ?? 'setup_failed');
    ev('host.exit', { code, reason: done?.reason ?? null });
    return code;
  }

  return {
    run,
    finish,
    state,
    floor,
    guards,
    attribution,
    transcript,
    get phase() {
      return state.phase;
    },
    /** Test hooks (unit tests drive the round without the start timers). */
    _test: {
      flow,
      beginRound: (id) => {
        flow.roundStarted = true;
        flow.greetedAt = nowMs();
        state.setPhase('round');
        bump();
        beginTurn(id);
      },
      endTurnSequence,
      startClosing,
      openFloor,
      applyAction: (action, trigger) => serial.run(() => applyAction(action, trigger)),
      run: (fn) => serial.run(fn),
      idle: () => serial.idle(),
      current: () => currentSpeech,
      queued: () => queuedKinds(),
    },
  };
}

function round4(x) {
  return Math.round((x ?? 0) * 1e4) / 1e4;
}
