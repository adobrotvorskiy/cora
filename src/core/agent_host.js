// Host in the `elevenlabs_agent` mode (WP15, docs/eleven_agent.md §5): the ElevenLabs agent is the
// whole conversation engine (hearing, turn taking, deciding, speaking); this host only supplies the
// physics and the context and keeps the hard limits.
//
//   runAgentHost(settings, flags) -> exit code       (main.js / tools/run_testroom.js)
//
// Physics: Chrome + Telemost join/leave, page audio (mix of remote tracks -> agent, agent audio ->
// page player, `interruption` -> flush), avatar camera, DOM observers (participants, active speaker).
// Context: contextual updates «[хост HH:MM:SS] …» (joins/leaves, who is speaking now, 10:28) and
// user-message nudges on the timers (10:00 open, 10:02 no Orlov, 10:30 close, --max-minutes), when
// Orlov joins a meeting that waits for him, and on room silence («Тишина 7 с …»: the model has no
// clock, so the host tells it that nobody answered «всё?» / the open floor / «никто не против?»).
// Client tools: give_word / turn_done / set_phase / leave_meeting (bookkeeping in
// state.js, leave sequence). The farewell is sealed: only the text said before
// leave_meeting reaches the room (live test 19.09 added «нельзя передавать слова…» after it), then a
// short linger; an interruption or a line addressed to her during the goodbye keeps her in (once).
// Guards (code, never the LLM): kill phrases in the agent's transcripts («Кора, уйди из встречи») and
// state/STOP make her LEAVE the meeting at once; plus 10:35 force leave, --max-minutes, Ctrl+C.

import { setTimeout as sleep } from 'node:timers/promises';
import * as clock from '../clock.js';
import { APP_ROOT, requireKey } from '../env.js';
import { PROFILE_DIR } from '../config.js';
import { openLog } from '../log.js';
import { launchBrowser } from '../browser/launch.js';
import { attachPageAudio, serveAssets } from '../browser/page_inject.js';
import * as telemost from '../browser/telemost.js';
import { ElevenAgent, attachPlayer, balanceOf, elevenRest, fetchConversationCost } from '../audio/eleven_agent.js';
import { AGENT_PHASES, buildAgentPrompt, dayModeText, dynamicVariables, elevenSettings, estimateTokens, hostNote, loadAgentAssets } from '../audio/eleven_prompt.js';
import { PcmRecorder } from '../audio/pcm_recorder.js';
import { YandexAgent, buildYandexTools } from '../audio/yandex_rt.js';
import { sendAlert } from '../ops/telegram.js';
import { loadPlayer } from './deps.js';
import { Serializer } from './events.js';
import { SOFT_STOP_RE, createGuards, isKillPhrase, isQuietPhrase, mentionsHost, realRoomAllowed } from './guards.js';
import { createState, loadRoster } from './state.js';

const EXIT = Object.freeze({ ok: 0, error: 1, usage: 64, sigint: 130 });
const TICK_MS = 200;
const DOM_POLL_MS = 3000;
const NOTE_BATCH_MS = 800;
const LEAVE_WAIT_AUDIO_MS = 6000; // after leave_meeting: how long we wait for the farewell audio to start (LLM + TTS latency)
const LEAVE_DRAIN_MS = 15_000; // and how long we let it play
const MAX_MINUTES_GRACE_MS = 45_000;
const LEAVE_TIMEOUT_MS = 8000;
const CLOSE_TIMEOUT_MS = 10_000;
const SIGINT_BUDGET_MS = 9000;
const ALERT_FLUSH_MS = 8000; // shutdown gives fire-and-forget alerts a bounded window to deliver
const SPEAKER_ATTRIBUTION_MS = 6000;
const SAME_SPEAKER_REPEAT_MS = 20_000;
const DEFERRED_NUDGES_MAX = 4; // start/wait_lead/soft+hard deadline/--max-minutes all queue before a late reconnect
const COST_FETCH = { tries: 2, delayMs: 2500 };
const SHORT_UTTERANCE_WORDS = 5;
const LATENCY_MAX_MS = 30_000; // a turn latency is only counted when someone spoke within the last 30 s
const SPEECH_ABOVE_FLOOR_DB = 12;
const SPEECH_MIN_DB = -62;
const FLOOR_RISE_DB_PER_S = 0.5;
const MIN_FAREWELL_CHARS = 10; // text said before leave_meeting shorter than this is not a farewell yet
const FRESH_RESPONSE_MS = 3000; // a response text this recent belongs to the turn that called leave_meeting
const EST_MS_PER_CHAR = 70; // Nastya at speed 1.0 (19.09: 67–74 ms per character), until measured in the session
const GOODBYE_RE = /(?:^|[^\p{L}])(?:пока|спасибо|до завтра|до встречи|хорош(?:его|ей)|удачи|и тебе|взаимно)(?![\p{L}])/iu;
const SILENCE_DEFAULTS = Object.freeze({ round: 7, idle: 5, open_floor: 7, waiting: 6, waiting_long: 20 });
const WAIT_RE = /(?:^|[^\p{L}])(?:подожди|погоди|постой|стой|секунду)(?![\p{L}])/iu; // «подожди!» after her farewell

/** p-th percentile (0..1) of a numeric array (nearest rank), null when empty. */
export function percentile(values, p) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1))];
}

/**
 * Kill phrase for the agent mode: «Кора/Кара/Корра/Карат…, стоп|хватит…» (guards.KILL_RE) always;
 * the soft phrases («мы сами», «дальше без тебя») only when the line is addressed to the host or is
 * a short standalone remark, so «мы сами это задеплоим» inside an update does not silence her.
 */
export function isAgentKillPhrase(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  if (isKillPhrase(s)) return true;
  if (!SOFT_STOP_RE.test(s)) return false;
  return mentionsHost(s) || s.trim().split(/\s+/).length <= SHORT_UTTERANCE_WORDS;
}

function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `…${s.slice(-(max - 1))}` : s;
}

/** Entry point used by main.js. */
export async function runAgentHost(settings, flags) {
  const log = openLog({ verbose: flags.verbose });
  const host = createAgentHost({ settings, flags, log });
  try {
    return await host.run();
  } finally {
    log.close();
  }
}

/**
 * @param {object} o
 * @param {object} o.settings  merged settings (voice.provider = elevenlabs_agent)
 * @param {object} o.flags     {shadow, verbose, live, maxMinutes, alert, url, at, day}
 * @param {{event: Function, path: string}} o.log
 * @param {object} [o.deps]    test injection: {launchBrowser, attachPageAudio, serveAssets, telemost, loadPlayer,
 *                             sendAlert, roster, assets, now, createAgent, rest, apiKey, agentId, recorderDir,
 *                             stopFile, stopIntervalMs}
 */
export function createAgentHost({ settings, flags = {}, log, deps = {} }) {
  const D = {
    launchBrowser,
    attachPageAudio,
    serveAssets,
    telemost,
    loadPlayer,
    sendAlert,
    roster: null,
    assets: null,
    now: null,
    createAgent: null,
    rest: null,
    apiKey: null,
    agentId: null,
    recorderDir: null,
    ...deps,
  };
  const ev = (type, fields) => {
    try {
      return log.event(type, fields);
    } catch {
      return null;
    }
  };
  const nowMs = () => clock.now().getTime(); // meeting clock (timers, notes)
  const wall = D.now ?? (() => Date.now()); // audio/agent timeline
  const msk = () => clock.formatMsk(new Date(nowMs()), 'HH:mm:ss');
  const serial = new Serializer({ onError: (e) => ev('error.handler', { message: e?.message ?? String(e), stack: e?.stack?.split('\n').slice(0, 4).join(' | ') }) });

  const dayMode = flags.day ? (flags.day === 'mon' ? 'monday_focus' : 'daily_plans') : clock.dayMode() === 'off' ? 'daily_plans' : clock.dayMode();
  const roster = D.roster ?? loadRoster();
  const el = elevenSettings(settings);
  const times = settings.times ?? {};
  const state = createState({ roster, settings, dayMode, now: nowMs, hostName: settings.display_name });
  const guards = createGuards({ settings, flags, log, now: nowMs, stopFile: D.stopFile, stopIntervalMs: D.stopIntervalMs });
  const leadId = state.firstAlways;
  const leadDisplay = leadId ? state.displayName(leadId) : 'руководитель';
  const meeting = {
    phase: 'waiting',
    roundStarted: false,
    lastSpeaker: null,
    lastSpeakerAt: 0,
    speakerPending: null,
    lastSpeakerNoted: null,
    lastSpeakerNoteAt: 0,
    startNudged: false, // the 10:00 nudge went out
    waitNudged: false, // the 10:02 «start without him?» nudge went out
    deadlineClose: false, // 10:30 / --max-minutes asked her to close: the leave is final
    gaveWordAt: 0, // wall time of the last give_word
    leaveCancels: 0,
  };
  const guests = new Map(); // guest id -> informal name (participants the roster does not know, named by the agent)
  const room = { floorDb: -60, lastSpeechEndAt: 0, lastTranscriptAt: 0, lastTentativeAt: 0 }; // remote speech tracker (page mix levels): turn latency, silence notes
  const latencies = []; // {utt, turn_ms, since_transcript_ms}
  const silence = { ...SILENCE_DEFAULTS, ...(el.silence_s ?? {}) };
  const quiet = { agentAt: 0, stateAt: 0, nudgeAt: 0, count: 0, countFrom: 0, nudges: 0 }; // silence-note bookkeeping (wall ms)
  const talk = { texts: new Map(), lastText: '', lastEventId: null, lastAt: 0, lastPromptAt: 0, interruptedUpTo: -1, rate: { chars: 0, ms: 0 } }; // the agent's own lines; lastPromptAt = last user turn or nudge
  let farewell = null; // {eventId, chars, pending, preChars, extra}

  let assets = D.assets ?? null;
  let browser = null;
  let page = null;
  let audio = null;
  let player = null;
  let agent = null;
  let playback = null;
  let rest = null;
  let recorder = null;
  let roomRecorder = null;
  let stopObservers = null;
  let tickTimer = null;
  let domPollTimer = null;
  let noteTimer = null;
  let done = null;
  let resolveDone = null;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let shuttingDown = false;
  let leaving = null; // {source, at, sawAudio}
  let muted = false; // «Кора, стоп»: she keeps listening but the room must not hear her until addressed by name
  let addressedPending = null; // {text, at}: a final line addressed to her with no answer yet (cleared on her speech; a skip_turn on it triggers a nudge)
  let agentStarted = false;
  let maxMinutesFired = false;
  const pendingNotes = [];
  let pendingLeadJoin = false;
  const deferredNudges = [];
  const startedAt = wall();
  const runDeadline = flags.maxMinutes ? startedAt + flags.maxMinutes * 60_000 : null;
  const balance = { before: null, after: null };
  const conversations = [];
  const usage = { alerts: 0, transcript_lines: 0 };
  const pendingAlerts = new Set(); // in-flight sendAlert promises, flushed (bounded) in shutdown
  const startAt = guards.timerAt('start');
  const connectAt = startAt === null ? nowMs() : startAt - (el.connect_before_start_s ?? 30) * 1000;

  // ----------------------------------------------------------------------------------- helpers

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
    ev('host.finish', { reason, code, phase: meeting.phase, ...state.summary() });
    resolveDone(done);
  }

  function vocativeOf(id) {
    if (guests.has(id)) return guests.get(id);
    return String(state.vocative(id) ?? id).replace(/[̀́]/g, '');
  }

  function presentNames() {
    return state.presentIds().map(vocativeOf);
  }

  function presentText() {
    const names = presentNames();
    return names.length ? names.join(', ') : 'никого';
  }

  function pendingNames() {
    return state.pendingIds({ includeSkipped: true, includeGuests: true }).map(vocativeOf);
  }

  function leadStatus() {
    return `${leadDisplay}: ${state.leadPresent() ? 'на связи' : 'не на связи'}`;
  }

  function loadAssets() {
    if (assets) return assets;
    assets = loadAgentAssets({ roster });
    for (const w of assets.warnings ?? []) ev('agent.assets_warning', { warning: w });
    return assets;
  }

  /** Init data for every (re)connect: rendered prompt override + dynamic variables (+ resume note). */
  function buildInit({ reconnect = false } = {}) {
    const a = loadAssets();
    const vars = dynamicVariables({ dayMode, presentNames: presentNames(), leadPresent: state.leadPresent(), phrases: a.phrases, leadName: leadId ? vocativeOf(leadId) : 'руководитель' });
    const prompt = buildAgentPrompt({
      mode: el.prompt_mode,
      personaBlock: a.personaBlock,
      playbook: a.playbook,
      roster,
      dayMode,
      llm: el.llm,
      phrases: a.phrases,
      hostDisplayName: settings.display_name ?? a.hostDisplayName,
      times,
      values: vars,
    });
    ev('agent.init', { reconnect, mode: el.prompt_mode, prompt_chars: prompt.length, prompt_tokens_est: estimateTokens(prompt), vars });
    return {
      override: { agent: { prompt: { prompt }, first_message: '', language: el.language } },
      dynamicVariables: vars,
      resume: reconnect ? resumeNote() : null,
    };
  }

  function resumeNote() {
    const spoke = state.all().filter((r) => r.status === 'spoke').map((r) => vocativeOf(r.id));
    const cur = state.current ? vocativeOf(state.current) : null;
    const parts = [
      'Связь восстановилась, это продолжение того же стендапа: не здоровайся заново.',
      `Этап: ${meeting.phase}.`,
      cur ? `Слово у: ${cur}.` : 'Слово сейчас ни у кого.',
      spoke.length ? `Уже выступили: ${spoke.join(', ')}.` : 'Никто ещё не выступал.',
      `Ещё не выступали: ${pendingNames().join(', ') || 'никто'}.`,
      `${leadStatus()}. На связи: ${presentText()}.`,
    ];
    return hostNote(parts.join(' '), { time: msk() });
  }

  /** Background context for the agent (no reply). */
  function note(text, kind) {
    if (!agent?.connected || done) return false;
    const line = hostNote(text, { time: msk() });
    const ok = agent.sendContextualUpdate(line);
    ev('agent.context', { kind, text: line, sent: ok });
    return ok;
  }

  /** A user-message nudge: the agent takes a turn (deferred until the agent is connected). */
  function nudge(text, kind) {
    if (done) return false;
    if (!agent?.connected) {
      deferredNudges.push({ text, kind });
      if (deferredNudges.length > DEFERRED_NUDGES_MAX) {
        // the model has no clock: the start nudge is the one it cannot reconstruct — never evict it
        const startIdx = deferredNudges.findIndex((n) => n.kind === 'start');
        let dropIdx = deferredNudges.findIndex((n, i) => i !== startIdx && n.kind !== 'start');
        if (dropIdx === -1) dropIdx = deferredNudges.length - 1;
        const [dropped] = deferredNudges.splice(dropIdx, 1);
        ev('agent.nudge_dropped', { kind: dropped.kind, text: dropped.text, queued: deferredNudges.length });
      }
      ev('agent.nudge_deferred', { kind, text });
      return false;
    }
    const line = hostNote(text, { time: msk() });
    const ok = agent.sendUserMessage(line);
    if (ok) talk.lastPromptAt = wall();
    ev('agent.nudge', { kind, text: line, sent: ok });
    return ok;
  }

  function flushDeferredNudges() {
    for (const n of deferredNudges.splice(0)) nudge(n.text, n.kind);
  }

  // ------------------------------------------------------------------------------------- agent

  // Yandex AI Studio Realtime: ears + brain + voice in one WS session. Same prompt and tool
  // contract as the ElevenLabs agent; notes go in as text items (sendUserMessage/ContextualUpdate).
  function createYandexAgent() {
    const assets = loadAssets();
    const vars = dynamicVariables({
      dayMode,
      presentNames: presentNames(),
      leadPresent: state.leadPresent(),
      phrases: assets.phrases,
      leadName: leadId ? vocativeOf(leadId) : 'руководитель',
    });
    const prompt = buildAgentPrompt({
      mode: 'compact',
      roster,
      dayMode,
      llm: null,
      phrases: assets.phrases,
      hostDisplayName: settings.display_name ?? assets.hostDisplayName,
      times,
      values: vars,
    }).replace(/Слух и голос от ElevenLabs[^»]*/, 'Слух, голос и решения — Yandex AI Studio Realtime, правила ведения написала команда');
    ev('agent.init', { reconnect: false, mode: 'yandex_rt', prompt_chars: prompt.length, prompt_tokens_est: estimateTokens(prompt), vars });
    const opts = {
      apiKey: requireKey(settings.keys.yandex),
      folderId: settings.yandex?.folder ?? requireKey(settings.keys.yandex_folder),
      instructions: prompt,
      voice: settings.yandex?.voice ?? 'alena',
      tools: buildYandexTools(),
      log, now: wall,
    };
    return D.createAgent ? D.createAgent(opts) : new YandexAgent(opts);
  }

  function createAgent(apiKey) {
    const a = settings.voice?.provider === 'yandex_rt' ? createYandexAgent() : (() => {
      rest = D.rest ?? elevenRest({ apiKey });
      const opts = { agentId: D.agentId ?? el.agent_id, rest, log, now: wall, init: buildInit };
      return D.createAgent ? D.createAgent(opts) : new ElevenAgent(opts);
    })();
    a.on('open', (info) => serial.run(() => onAgentOpen(info)));
    // transcripts are checked for the kill phrase at once, never behind the serial queue
    a.on('transcript', ({ text, event_id }) => onTranscript(text, 'final', event_id));
    a.on('tentative_transcript', ({ text }) => onTranscript(text, 'tentative'));
    // response texts and leave_meeting are handled at once too: the farewell seal must be in place
    // before the next audio chunk of that response reaches the page
    a.on('response', ({ text, event_id }) => {
      ev('agent.response', { text, event_id });
      onResponseText(text, event_id);
    });
    a.on('correction', ({ original, corrected, event_id }) => {
      ev('agent.correction', { original, corrected });
      onCorrection(corrected, event_id, original);
    });
    a.on('response_complete', ({ event_id } = {}) => {
      ev('agent.response_complete', {});
      measureRate(event_id);
    });
    a.on('interruption', ({ event_id }) => {
      ev('agent.interruption', { event_id, speaking: playback?.current() ?? null });
      if (Number.isFinite(event_id)) talk.interruptedUpTo = Math.max(talk.interruptedUpTo, event_id);
      if (leaving) serial.run(() => cancelLeave('interruption', null));
    });
    a.on('tool_call', (call) => {
      if (call.tool_name === 'leave_meeting') onLeaveCall(call);
      serial.run(() => onToolCall(call));
    });
    a.on('tool_response', (r) => {
      ev('agent.tool_response', { name: r.tool_name ?? null, status: r.status ?? null, is_error: r.is_error ?? null });
      // a direct address must never stay unanswered: if she skipped it, ask again (the model may miss the rule; the host must not)
      if (r.tool_name === 'skip_turn' && addressedPending && !leaving && !done && wall() - addressedPending.at <= 15_000) {
        const p = addressedPending;
        addressedPending = null;
        ev('host.addressed_skip', { text: p.text });
        nudge(`К тебе обратились: «${p.text}». Это прямое обращение по имени — ответь, коротко.`, 'addressed');
      }
    });
    a.on('client_error', (e) => ev('agent.client_error', e));
    a.on('context_usage', (c) => ev('agent.context_usage', { model: c.model, context_tokens: c.context_tokens, context_limit_tokens: c.context_limit_tokens }));
    a.on('disconnected', ({ code, reason }) => ev('agent.disconnected', { code, reason, phase: meeting.phase }));
    a.on('reconnected', (r) => ev('agent.reconnected', r));
    a.on('failed', ({ error, attempts }) => serial.run(() => onAgentFailed(error, attempts)));
    a.on('closed', ({ reason }) => serial.run(() => onAgentClosed(reason)));
    a.on('audio', ({ pcm }) => {
      quiet.agentAt = wall();
      recorder?.write(pcm);
    });
    return a;
  }

  async function connectAgent() {
    if (agentStarted || done) return;
    agentStarted = true;
    ev('agent.connecting', { at: msk(), present: state.presentIds() });
    if (rest?.subscription && (D.checkBalance ?? !D.rest)) {
      try {
        balance.before = balanceOf(await rest.subscription());
        ev('agent.balance', { when: 'before', ...balance.before });
        warnLowBalance(balance.before);
      } catch (e) {
        ev('agent.balance_error', { when: 'before', message: e?.message ?? String(e) });
      }
    }
    try {
      const t0 = wall();
      const info = await agent.connect();
      ev('agent.connected', { ...info, took_ms: wall() - t0 });
    } catch (e) {
      ev('agent.connect_error', { message: e?.message ?? String(e), status: e?.status ?? null });
      alert(`агент ElevenLabs не подключился: ${String(e?.message ?? e).slice(0, 160)}, лог ${log.path}`);
      finish('agent_connect_failed', EXIT.error);
    }
  }

  /**
   * Starter = 75 agent minutes ≈ 3 standups; past the quota ElevenLabs ends the call unless Pay As You Go
   * credits are on the account. Warn (Telegram) when what is left will not cover a standup.
   */
  function warnLowBalance(b) {
    const perMin = el.credits_per_min;
    if (!b || !perMin || !Number.isFinite(b.remaining)) return;
    const minutes = Math.floor(b.remaining / perMin);
    if (minutes >= (el.low_balance_minutes ?? 30)) return;
    ev('agent.low_balance', { tier: b.tier, remaining: b.remaining, minutes_left: minutes, credits_per_min: perMin });
    alert(`ElevenLabs: осталось ${b.remaining} кредитов ≈ ${minutes} мин разговора (тариф ${b.tier ?? '?'}). Этого меньше, чем на стендап: пополни (Pay As You Go), иначе звонок оборвётся посреди встречи.`, 'warn');
  }

  function onAgentOpen(info) {
    if (info?.conversation_id && !conversations.includes(info.conversation_id)) conversations.push(info.conversation_id);
    quiet.stateAt = wall(); // silence is counted from the moment she can hear, not from the epoch
    if (info?.reconnect) {
      flushDeferredNudges();
      return;
    }
    flushDeferredNudges();
  }

  function onTranscript(text, kind, eventId = null) {
    const t = wall();
    const who = t - meeting.lastSpeakerAt <= SPEAKER_ATTRIBUTION_MS && meeting.lastSpeaker ? meeting.lastSpeaker : null;
    if (kind === 'final') {
      usage.transcript_lines++;
      room.lastTranscriptAt = t;
      talk.lastPromptAt = t;
      ev('agent.transcript', { who: who ?? '?', name: who ? vocativeOf(who) : null, text, since_speech_end_ms: room.lastSpeechEndAt ? Math.round(t - room.lastSpeechEndAt) : null });
    } else if (text.trim()) room.lastTentativeAt = t;
    if (!text.trim()) return;
    if (isAgentKillPhrase(text)) {
      ev('guard.kill_phrase', { text, via: kind });
      guards.stop('voice', text, () => leaveNow('voice')); // guards logs guard.stop; leaveNow cuts the audio at once
      return;
    }
    if (isQuietPhrase(text)) {
      setQuiet('voice', text, kind);
      return;
    }
    if (kind === 'final' && !leaving && !done && !meeting.startNudged && !meeting.roundStarted && guards.isStartRequest(text)) {
      requestStart(text); // on-demand mode: «Кора, начинай» opens the standup
      return;
    }
    if (muted && kind === 'final' && mentionsHost(text)) liftQuiet('voice', text);
    if (kind === 'final' && !leaving && !done && mentionsHost(text)) addressedPending = { text: clip(text, 160), at: wall() };
    // during the goodbye a line addressed to her that is not a goodbye («Кора, подожди, вопрос») keeps her in
    if (kind === 'final' && leaving && !GOODBYE_RE.test(text) && (mentionsHost(text) || (WAIT_RE.test(text) && text.trim().split(/\s+/).length <= SHORT_UTTERANCE_WORDS + 1))) serial.run(() => cancelLeave('addressed', text));
  }

  /** On-demand start: people asked her by name to open the standup (no --start schedule). */
  function requestStart(text) {
    if (meeting.startNudged || meeting.roundStarted) return;
    meeting.startNudged = true;
    quiet.stateAt = wall();
    if (muted) {
      muted = false;
      ev('host.quiet_lifted', { source: 'start_request', text: clip(text, 120) });
    }
    nudge(`«${clip(text, 100)}» — просят начать стендап. ${leadStatus()}. На связи: ${presentText()}. Тема дня: ${dayModeText(dayMode)}`, 'start');
  }

  // ------------------------------------------------------------------------------ her own lines

  /** Text of one agent response (several segments when tools are called in between). Direct handler. */
  function onResponseText(text, eventId) {
    const key = eventId ?? 'none';
    const prev = talk.texts.get(key) ?? '';
    const full = prev ? `${prev} ${text}` : text;
    talk.texts.set(key, full);
    if (talk.texts.size > 64) talk.texts.delete(talk.texts.keys().next().value);
    talk.lastText = full;
    talk.lastEventId = eventId;
    talk.lastAt = wall();
    if (!farewell) return;
    if (farewell.pending) {
      // leave_meeting came before any farewell text: the first text after it is the farewell
      if (farewell.eventId !== null && eventId !== null && eventId < farewell.eventId) return;
      sealFarewell(eventId, full.length, 'text_after_call');
      return;
    }
    if (eventId === farewell.eventId || (eventId !== null && farewell.eventId !== null && eventId > farewell.eventId)) {
      farewell.extra = `${farewell.extra ? `${farewell.extra} ` : ''}${text}`;
      ev('host.farewell_extra', { text, event_id: eventId, farewell_event_id: farewell.eventId });
      const info = playback?.eventInfo?.(farewell.eventId);
      // no character alignment from the server: cut the farewell response by its estimated length
      if (eventId === farewell.eventId && info && !info.aligned) playback.seal({ eventId: farewell.eventId, chars: farewell.chars, maxMs: estimateSpeechMs(farewell.chars) });
    }
  }

  function onCorrection(corrected, eventId, original = '') {
    if (typeof corrected !== 'string') return;
    // a line cut early: tell her what the room heard (the platform truncates her history, flash-lite still tends to go on with its plan)
    if (original && corrected.replace(/[.…\s]+$/, '').length < original.length * 0.8 && !done) {
      note(`Тебя перебили: из твоей реплики услышали только «${clip(corrected, 80)}».`, 'interrupted');
    }
    const key = eventId ?? talk.lastEventId ?? 'none';
    if (talk.texts.has(key)) talk.texts.set(key, corrected);
    if (key === (talk.lastEventId ?? 'none')) talk.lastText = corrected; // what the room actually heard («Все…»)
  }

  /** Session speech rate (ms per character) from responses that played to the end. */
  function measureRate(eventId) {
    if (!Number.isFinite(eventId) || eventId <= talk.interruptedUpTo) return;
    const text = talk.texts.get(eventId);
    const info = playback?.eventInfo?.(eventId);
    if (!text || !info || info.ms < 500) return;
    talk.rate.chars += text.length;
    talk.rate.ms += info.ms;
  }

  function estimateSpeechMs(chars) {
    const perChar = talk.rate.chars >= 150 ? talk.rate.ms / talk.rate.chars : EST_MS_PER_CHAR;
    return Math.round(chars * perChar * 1.05 + 250);
  }

  /** leave_meeting (direct handler): seal the room to the farewell said so far, or to the next text. */
  function onLeaveCall(call) {
    const own = Number.isFinite(call.event_id) ? call.event_id : null;
    const eid = own ?? talk.lastEventId;
    const pre = talk.texts.get(eid ?? 'none') ?? '';
    // the text belongs to this turn: the latest response, after the latest user turn or nudge, a moment ago
    const fresh = eid === talk.lastEventId && talk.lastAt >= talk.lastPromptAt && wall() - talk.lastAt <= FRESH_RESPONSE_MS;
    if (fresh && pre.length >= MIN_FAREWELL_CHARS) sealFarewell(eid, pre.length, 'text_before_call');
    else {
      farewell = { eventId: own, chars: null, pending: true, preChars: 0, extra: '' };
      ev('host.farewell_pending', { event_id: own, last_event_id: talk.lastEventId, last_text_age_ms: talk.lastAt ? Math.round(wall() - talk.lastAt) : null });
    }
  }

  function sealFarewell(eventId, chars, how) {
    farewell = { eventId, chars, pending: false, preChars: chars, extra: '' };
    const info = playback?.seal?.({ eventId, chars }) ?? null;
    ev('host.farewell_seal', { event_id: eventId, chars, how, text: talk.texts.get(eventId ?? 'none') ?? null, aligned: info?.aligned ?? null });
  }

  /** A known id -> itself; a name of someone present -> their id; any other name -> a registered guest id. */
  function resolvePerson({ person_id: pid, person_name: pname } = {}) {
    const id = typeof pid === 'string' ? pid.trim() : '';
    const name = typeof pname === 'string' ? pname.trim() : '';
    if (id && (state.get(id) || guests.has(id))) return id;
    for (const candidate of [id, name].filter(Boolean)) {
      const norm = candidate.toLowerCase().replace(/ё/g, 'е');
      for (const rid of [...state.presentIds(), ...guests.keys()]) {
        const names = [vocativeOf(rid), state.displayName(rid), state.get(rid)?.telemost_name].filter(Boolean).map((s) => String(s).toLowerCase().replace(/ё/g, 'е'));
        if (names.includes(norm) || names.some((n) => n.split(/\s+/)[0] === norm)) return rid;
      }
    }
    const guestName = name || (/\p{L}/u.test(id) && !/^[a-z0-9_]+$/i.test(id) ? id : '');
    if (!guestName) return null;
    return registerGuest(guestName);
  }

  /** Someone the roster does not know (Нина at Серёжа's computer): bookkeeping under a guest id. */
  function registerGuest(rawName) {
    const name = rawName.replace(/\s+/g, ' ').trim();
    const first = name.split(' ')[0];
    const display = first[0].toUpperCase() + first.slice(1);
    let gid = state.idForName(name) ?? null;
    if (!gid) gid = `guest_${guests.size + 1}_${display.toLowerCase()}`;
    if (!guests.has(gid)) {
      guests.set(gid, display);
      ev('agent.guest', { name, id: gid });
    }
    return gid;
  }

  function onToolCall({ tool_name: name, tool_call_id: id, parameters: params = {}, expects_response: expects, event_id: eventId = null }) {
    ev('agent.tool_call', { name, id, params, event_id: eventId, phase: meeting.phase });
    let result;
    let isError = false;
    let followUp = null; // contextual note that replaces the tool result when the model does not wait for it
    if (name === 'give_word' || name === 'turn_done' || name === 'set_phase') quiet.stateAt = wall(); // the floor changed: silence counts anew
    switch (name) {
      case 'give_word': {
        const pid = resolvePerson(params);
        if (!pid) {
          isError = true;
          result = { ok: false, error: `no person_id / person_name (${JSON.stringify(params)})`, present: presentNames() };
          break;
        }
        // never give the floor to someone absent: the round runs over people who are on the
        // call. Guests have no presence flag — they are here by definition.
        const prec = state.get(pid);
        if (prec && prec.present === false) {
          isError = true;
          result = { ok: false, error: `${vocativeOf(pid)} не на связи`, present: presentNames(), not_spoken_yet: pendingNames() };
          break;
        }
        // the previous speaker never spoke after getting the word («вернусь к тебе в конце»): still pending
        if (state.current && state.current !== pid && !spokeSince(meeting.gaveWordAt)) state.finishTurn({ t: nowMs(), status: 'skipped' });
        meeting.gaveWordAt = wall();
        const rec = state.giveWord(pid, { t: nowMs() });
        if (guests.has(pid) && rec) rec.name = rec.telemost_name = guests.get(pid);
        meeting.roundStarted = true;
        if (meeting.phase === 'waiting') meeting.phase = 'round';
        result = { ok: true, speaker: vocativeOf(pid), guest: guests.has(pid) || undefined, not_spoken_yet: pendingNames(), present: presentNames() };
        followUp = `Слово у: ${vocativeOf(pid)}. Ещё не выступали: ${pendingNames().join(', ') || 'никто'}.`;
        break;
      }
      case 'turn_done': {
        const pid = resolvePerson(params) ?? state.current;
        if (!pid) {
          isError = true;
          result = { ok: false, error: `no person_id / person_name (${JSON.stringify(params)})` };
          break;
        }
        if (state.current === pid) state.finishTurn({ t: nowMs() });
        else state.setStatus(pid, 'spoke');
        result = { ok: true, done: vocativeOf(pid), guest: guests.has(pid) || undefined, not_spoken_yet: pendingNames() };
        followUp = `Закончил: ${vocativeOf(pid)}. Ещё не выступали: ${pendingNames().join(', ') || 'никто'}.`;
        break;
      }
      case 'set_phase': {
        const phase = String(params.phase ?? '');
        if (!AGENT_PHASES.includes(phase)) {
          isError = true;
          result = { ok: false, error: `unknown phase ${phase}`, phases: [...AGENT_PHASES] };
          break;
        }
        meeting.phase = phase;
        if (phase === 'round') meeting.roundStarted = true;
        if (phase === 'open_floor' || phase === 'closing') meeting.roundStarted = true;
        result = { ok: true, phase, not_spoken_yet: pendingNames() };
        break;
      }
      case 'leave_meeting':
        result = { ok: true, note: 'Договори, что хотела: хост выведет тебя из встречи, когда ты закончишь.' };
        break;
      case 'skip_turn':
        // silence is a valid move: acknowledge, change nothing (the Eleven agent had this built in)
        result = { ok: true };
        break;
      case 'silent_mode':
        // legacy tool on an agent not yet re-pushed: the kill switch is «leave the meeting», not «go quiet»
        result = { ok: true, note: 'Ухожу из встречи.' };
        break;
      default:
        isError = true;
        result = { ok: false, error: `unknown tool ${name}` };
    }
    if (expects !== false) agent.sendToolResult(id, result, { isError, continueTurn: name !== 'leave_meeting' && name !== 'skip_turn' });
    else if (followUp && !isError) note(followUp, 'roster'); // non-blocking tools: the model learns the roster state from a note
    ev('agent.tool_result', { name, id, is_error: isError, awaited: expects !== false, result, ...state.summary() });
    if (isError && name === 'give_word' && /не на связи/.test(result?.error ?? '')) {
      // the model offered the floor to someone absent: correct it in plain text
      note(`На связи только: ${presentNames().join(', ') || 'никого'}. Слово давай только присутствующим; отсутствующих не называй.`, 'roster');
    }
    if (name === 'leave_meeting' && !isError) requestLeave('tool:leave_meeting');
    if (name === 'silent_mode' && !isError) guards.stop('agent', 'silent_mode tool', () => leaveNow('agent'));
  }

  function onAgentFailed(error, attempts) {
    ev('agent.failed', { message: error?.message ?? String(error), attempts, phase: meeting.phase });
    if (done || leaving) return;
    alert(`агент ElevenLabs отвалился и не переподключился (${String(error?.message ?? error).slice(0, 120)}), выхожу; лог ${log.path}`);
    finish('agent_failed', EXIT.error);
  }

  function onAgentClosed(reason) {
    ev('agent.closed', { reason, phase: meeting.phase, leaving: Boolean(leaving) });
    if (done || leaving) return;
    // the server ended the conversation itself (end_call, max duration): say nothing more, leave when the audio is out
    requestLeave(`agent_closed:${reason ?? 'server'}`);
  }

  function requestLeave(source) {
    if (leaving || done) return;
    const final = !source.startsWith('tool:') || meeting.deadlineClose || meeting.leaveCancels >= (el.leave_cancels_max ?? 3);
    leaving = { source, at: wall(), sawAudio: playback?.isSpeaking() === true, lastSpeakingAt: null, final };
    ev('host.leave_requested', { source, phase: meeting.phase, speaking: leaving.sawAudio, final });
  }

  function leaveTick(t) {
    const l = leaving;
    if (!l || done) return;
    const speaking = playback?.isSpeaking() === true;
    if (speaking) {
      l.sawAudio = true;
      l.lastSpeakingAt = t;
    }
    const waited = t - l.at;
    if (speaking && waited < LEAVE_DRAIN_MS) return;
    if (!l.sawAudio && waited < LEAVE_WAIT_AUDIO_MS && agent?.connected) return; // the farewell may still be on its way
    // the farewell is out: stay ~5 s after she was last heard (someone may say something after her), then leave
    const linger = l.source.startsWith('tool:') && agent?.connected ? (el.leave_linger_ms ?? 5000) : 0;
    if (t - (l.lastSpeakingAt ?? l.at) < linger && waited < LEAVE_DRAIN_MS + linger) return;
    finish(`leave:${l.source}`);
  }

  /** Someone interrupted the goodbye or spoke to her during it: she stays (up to leave_cancels_max; never after 10:30). */
  function cancelLeave(why, text) {
    if (!leaving || leaving.final || done) return false;
    meeting.leaveCancels++;
    ev('host.leave_canceled', { why, text, source: leaving.source, farewell_event_id: farewell?.eventId ?? null });
    leaving = null;
    farewell = null;
    playback?.unseal?.();
    meeting.phase = 'open_floor';
    quiet.stateAt = wall();
    note('Тебя остановили на прощании: ты остаёшься и слушаешь. Когда всё закончится, попрощайся заново и вызови leave_meeting.', 'leave_canceled');
    return true;
  }

  /** The kill switch: no farewell, no lingering tile — cut the audio, close the agent and leave. Direct, never behind the serial queue. */
  function leaveNow(source) {
    if (done) return;
    ev('host.kill_leave', { source, phase: meeting.phase });
    try {
      playback?.stop('kill_switch');
    } catch {
      // page may be gone
    }
    if (agent) void agent.close({ reason: `kill_switch:${source}` }).catch(() => {});
    finish('kill_switch', EXIT.ok);
  }

  /** «Кора, стоп»: cut the current line; she keeps listening and is back when addressed by name. */
  function setQuiet(source, phrase, kind = 'final') {
    if (muted || done) return;
    muted = true;
    ev('host.quiet', { source, phrase: clip(phrase, 120), via: kind });
    try {
      playback?.stop('quiet');
    } catch {
      // page may be gone
    }
    note(`Тебя попросили замолчать («${clip(phrase, 80)}»). До обращения к тебе по имени не начинай реплик: слушай встречу. Если встреча встала или кто-то обратился к тебе — вернёшься к ведению.`, 'quiet');
  }

  /** A final line addressed to her by name lifts the quiet. */
  function liftQuiet(source, text) {
    if (!muted || done) return;
    muted = false;
    ev('host.quiet_lifted', { source, text: clip(text, 120) });
    nudge(`К тебе обратились: «${clip(text, 100)}». Продолжай вести встречу.${meeting.roundStarted ? '' : ' Стендап ещё не начат — открой его сейчас.'}`, 'quiet_lift');
  }

  // ---------------------------------------------------------------------------------- context

  function onParticipants(list, source) {
    if (done || leaving) return;
    const diff = state.applyParticipants(list, { t: nowMs() });
    if (!diff.changed) return;
    for (const id of diff.joined) {
      ev('presence.joined', { who: id, name: state.get(id)?.telemost_name, known: state.get(id)?.known, source, present: state.presentIds() });
      pendingNotes.push(`Подключился ${vocativeOf(id)}${state.get(id)?.known ? '' : ` (гость, в Телемосте «${state.get(id)?.telemost_name ?? ''}»)`}.`);
      if (id === leadId) pendingLeadJoin = true;
    }
    for (const id of diff.left) {
      ev('presence.left', { who: id, source, present: state.presentIds() });
      pendingNotes.push(`Вышел ${vocativeOf(id)}.`);
    }
    if (!noteTimer) {
      noteTimer = setTimeout(() => {
        noteTimer = null;
        serial.run(flushNotes);
      }, NOTE_BATCH_MS);
      noteTimer.unref?.();
    }
  }

  function flushNotes() {
    if (!pendingNotes.length) return;
    const lines = pendingNotes.splice(0);
    const leadJoined = pendingLeadJoin;
    pendingLeadJoin = false;
    if (!agent?.connected) return; // the roster at connect time goes into the init prompt
    const base = `${lines.join(' ')} На связи: ${presentText()}. ${leadStatus()}.`;
    if (leadJoined && state.leadPresent() && !leaving) {
      const lead = vocativeOf(leadId);
      // the meeting waits for him: she must act now, a contextual note alone gives her no turn
      if (meeting.startNudged && !meeting.roundStarted) {
        nudge(`${base} Стендап ещё не начат, его ждали.`, 'lead_joined');
        return;
      }
      if (meeting.roundStarted && state.get(leadId)?.status !== 'spoke') {
        const text = `${base} ${lead} ещё не выступал.`;
        if (!state.current && !playback?.isSpeaking()) nudge(text, 'lead_joined');
        else note(text, 'lead_joined');
        return;
      }
    }
    note(base, 'presence');
  }

  /** Did the room speak (remote audio, not her) after wall time t0? A second of margin for the tail of the previous line. */
  function spokeSince(t0) {
    return room.lastSpeechEndAt > t0 + 1000 || room.lastTranscriptAt > t0 + 1000;
  }

  // ------------------------------------------------------------------------------ silence notes

  /**
   * The model has no clock: when nobody answers her question or the speaker falls silent, the host
   * says so («Тишина 7 с после …»), and the prompt maps it to «всё?» / next speaker / farewell /
   * consent. Only after the start, never while she speaks or leaves; at most silence_nudges_max per
   * quiet stretch (human speech or a floor change resets the count).
   */
  function silenceTick(t) {
    if (!agent?.connected || leaving || done || muted) return;
    if (playback?.isSpeaking()) {
      quiet.agentAt = t;
      return;
    }
    const human = Math.max(room.lastSpeechEndAt, room.lastTranscriptAt, room.lastTentativeAt);
    const fresh = Math.max(human, quiet.stateAt);
    if (fresh > quiet.countFrom) {
      quiet.count = 0;
      quiet.countFrom = fresh;
    }
    if (quiet.count >= (el.silence_nudges_max ?? 2)) return;
    const rule = silenceRule(human);
    if (!rule || (rule.once && quiet.count >= 1)) return;
    const last = Math.max(human, quiet.agentAt, quiet.stateAt, quiet.nudgeAt, talk.lastAt, talk.lastPromptAt);
    if (t - last < rule.ms) return;
    quiet.nudgeAt = t;
    quiet.count++;
    quiet.nudges++;
    nudge(`Тишина ${Math.round(rule.ms / 1000)} с ${rule.after}. ${rule.floor}`, 'silence');
  }

  /** What the silence follows and whose floor it is; null = no note in this phase. */
  function silenceRule(human) {
    const herLast = Math.max(quiet.agentAt, talk.lastAt) > human && Boolean(talk.lastText);
    const hers = herLast ? `после твоей реплики «${clip(talk.lastText, 100)}»` : null;
    switch (meeting.phase) {
      case 'waiting': {
        // on-demand mode (no --start): no small talk into an empty room
        if (!times.start && state.presentIds().length === 0) return null;
        // her «никто не против?» is answered by the silence; any other long pause she may break (small talk), once
        const asked = meeting.startNudged && herLast && /\?\s*$/.test(talk.lastText) && (meeting.waitNudged || /против/i.test(talk.lastText));
        const status = meeting.startNudged
          ? `Стендап ещё не начат. ${leadStatus()}.`
          : times.start
            ? `Стендап ещё не начат, старт в ${times.start}.`
            : `Стендап ещё не начат, начнёшь, когда попросят по имени. ${leadStatus()}.`;
        if (asked) return { ms: silence.waiting * 1000, after: hers, floor: status };
        return { ms: silence.waiting_long * 1000, after: hers ?? 'после последней реплики', floor: status, once: true };
      }
      case 'round': {
        const cur = state.current;
        if (!cur) return { ms: silence.idle * 1000, after: hers ?? 'после последней реплики', floor: `Слово сейчас ни у кого. Ещё не выступали: ${pendingNames().join(', ') || 'никто'}.` };
        const name = vocativeOf(cur);
        if (!spokeSince(meeting.gaveWordAt)) return { ms: silence.round * 1000, after: hers ?? 'после передачи слова', floor: `Слово у: ${name}; после передачи слова ${name} не слышно.` };
        return { ms: silence.round * 1000, after: hers ?? 'после реплики того, у кого слово', floor: `Слово у: ${name}.` };
      }
      case 'open_floor':
        return { ms: silence.open_floor * 1000, after: hers ?? 'после реплик коллег', floor: 'Идёт открытое слово.' };
      default:
        return null;
    }
  }

  function onSpeakers(names) {
    const t = wall();
    const ids = (Array.isArray(names) ? names : []).map((n) => state.idForName(n)).filter(Boolean);
    ev('page.speaker', { names, ids });
    const id = ids[0] ?? null;
    if (!id) return;
    meeting.lastSpeaker = id;
    meeting.lastSpeakerAt = t;
    meeting.speakerPending = id;
  }

  function speakerTick(t) {
    const id = meeting.speakerPending;
    if (!id || !agent?.connected) return;
    if (t - meeting.lastSpeakerNoteAt < (el.speaker_note_min_ms ?? 2000)) return;
    meeting.speakerPending = null;
    if (id === meeting.lastSpeakerNoted && t - meeting.lastSpeakerNoteAt < SAME_SPEAKER_REPEAT_MS) return;
    meeting.lastSpeakerNoted = id;
    meeting.lastSpeakerNoteAt = t;
    note(`Говорит: ${vocativeOf(id)}.`, 'speaker');
  }

  function onAudioChunk(pcm, levels, meta) {
    if (done) return;
    trackRoomSpeech(meta?.mix, wall());
    try {
      agent?.pushAudio?.(pcm);
    } catch (e) {
      ev('error.agent_push', { message: e?.message ?? String(e) });
    }
    roomRecorder?.write(pcm);
  }

  /** Remote speech end from the page mix levels (dBFS per 50 ms frame): a slow-rising noise floor + 12 dB. */
  function trackRoomSpeech(mix, t) {
    if (!Array.isArray(mix) || !mix.length) return;
    const frameMs = (el.chunk_ms ?? 100) / mix.length;
    for (let i = 0; i < mix.length; i++) {
      const db = Number(mix[i]);
      if (!Number.isFinite(db)) continue;
      room.floorDb = Math.max(-70, Math.min(-30, Math.min(db, room.floorDb + (FLOOR_RISE_DB_PER_S * frameMs) / 1000)));
      if (db > Math.max(room.floorDb + SPEECH_ABOVE_FLOOR_DB, SPEECH_MIN_DB)) room.lastSpeechEndAt = t - (mix.length - 1 - i) * frameMs;
    }
  }

  /** First audio chunk of an agent utterance: turn latency = time since the room fell silent. */
  function onAgentUtteranceStart(u) {
    addressedPending = null; // she is speaking: any pending address is being answered
    const t = wall();
    const turn = room.lastSpeechEndAt && t - room.lastSpeechEndAt <= LATENCY_MAX_MS ? Math.round(t - room.lastSpeechEndAt) : null;
    const sinceTranscript = room.lastTranscriptAt && t - room.lastTranscriptAt <= LATENCY_MAX_MS ? Math.round(t - room.lastTranscriptAt) : null;
    if (turn !== null) latencies.push({ utt: u.id, turn_ms: turn, since_transcript_ms: sinceTranscript });
    ev('agent.turn_latency', { utt: u.id, turn_ms: turn, since_transcript_ms: sinceTranscript });
  }

  function onPageEvent(e) {
    if (!e || typeof e.type !== 'string') return;
    try {
      player?.onPageEvent?.(e);
    } catch (err) {
      ev('error.player_event', { message: err?.message ?? String(err) });
    }
    if (e.type === 'worklet.error') {
      ev('error.worklet', { message: e.message });
      alert(`аудио-адаптер страницы не запустился (worklet.error: ${String(e.message).slice(0, 120)}), лог ${log.path}`);
      return finish('worklet_error', EXIT.error);
    }
    const quiet = /^(player\.|audio\.state|capture\.)/.test(e.type);
    if (!quiet) ev(`page.${e.type}`, { ...e, type: undefined });
    else if (e.type === 'player.underrun' || e.type === 'player.aborted') ev(`page.${e.type}`, { ...e, type: undefined });
  }

  // ------------------------------------------------------------------------------------ timers

  function onTimer({ name, late_ms }) {
    ev('timer', { name, late_ms, phase: meeting.phase, lead_present: state.leadPresent(), present: state.presentIds() });
    if (done) return;
    switch (name) {
      case 'start':
        if (muted) return; // «Кора, стоп»: люди ведут; вернётся по обращению (lift-nudge откроет стендап)
        meeting.startNudged = true;
        quiet.stateAt = wall();
        if (meeting.roundStarted) return; // the team asked to start earlier and she did
        nudge(`Пора открывать стендап. ${leadStatus()}. На связи: ${presentText()}. Тема дня: ${dayModeText(dayMode)}`, 'start');
        return;
      case 'wait_lead_until':
        if (meeting.roundStarted || state.leadPresent() || muted) return;
        meeting.waitNudged = true;
        quiet.stateAt = wall();
        nudge(`${times.wait_lead_until ?? '10:02'}: ${leadDisplay} не подключился, стендап ещё не начат. На связи: ${presentText()}.`, 'wait_lead');
        return;
      case 'soft_deadline':
        note(`${times.soft_deadline ?? '10:28'}: время поджимает, ускоряйся: связки короче, оставшихся проси о самом главном. Ещё не выступали: ${pendingNames().join(', ') || 'никто'}.`, 'soft_deadline');
        return;
      case 'hard_deadline':
        if (muted) return;
        meeting.deadlineClose = true;
        nudge(`${times.hard_deadline ?? '10:30'}: завершай стендап, даже если кто-то не успел: предложи досказать на дев-синке, попрощайся, передай слово на дев-синк и вызови leave_meeting.`, 'hard_deadline');
        return;
      case 'force_leave':
        ev('guard.force_leave', {});
        try {
          playback?.stop('force_leave');
        } catch {
          // ignore
        }
        finish('force_leave');
        return;
      default:
    }
  }

  function tick() {
    if (done) return;
    const t = wall();
    serial.run(() => {
      if (done) return;
      for (const timer of guards.dueTimers(nowMs())) onTimer(timer);
      if (guards.stopped) leaveNow('file');
      if (!agentStarted && nowMs() >= connectAt) void connectAgent();
      speakerTick(t);
      silenceTick(t);
      leaveTick(t);
      if (runDeadline !== null && t >= runDeadline && !maxMinutesFired) {
        maxMinutesFired = true;
        ev('guard.max_minutes', { minutes: flags.maxMinutes, phase: meeting.phase, connected: agent?.connected === true });
        if (leaving || !agent?.connected || flags.shadow) finish('max_minutes');
        else {
          meeting.deadlineClose = true;
          nudge('Лимит времени: попрощайся одной фразой, передай слово на дев-синк и вызови leave_meeting.', 'max_minutes');
          setTimeout(() => serial.run(() => finish('max_minutes_hard')), MAX_MINUTES_GRACE_MS).unref?.();
        }
      }
    });
  }

  // ------------------------------------------------------------------------------------- setup

  async function setup() {
    const url = settings.meeting_url;
    const gate = realRoomAllowed({ url, flags, realUrl: settings.real_room_url ?? null });
    ev('host.start', {
      mode: 'elevenlabs_agent',
      url,
      display_name: settings.display_name,
      day_mode: dayMode,
      shadow: Boolean(flags.shadow),
      live: Boolean(flags.live),
      max_minutes: flags.maxMinutes ?? null,
      simulated: clock.simulation(),
      real_room: !gate.allowed || gate.reason === 'live window',
      agent_id: D.agentId ?? el.agent_id ?? null,
      llm: el.llm,
      voice_id: el.voice_id,
      turn_eagerness: el.turn_eagerness,
      prompt_mode: el.prompt_mode,
      tools_blocking: Boolean(el.tools_blocking),
      chunk_ms: el.chunk_ms,
      connect_at: clock.formatMsk(new Date(connectAt), 'HH:mm:ss'),
      log: log.path,
    });
    if (!gate.allowed) {
      ev('guard.room_refused', { url, reason: gate.reason });
      console.error(`refused: ${gate.reason}`);
      return EXIT.usage;
    }
    if (flags.shadow) {
      ev('host.shadow_unsupported', { reason: 'the agent mode has no shadow: use the openrouter provider with --shadow' });
      console.error('the elevenlabs_agent provider has no --shadow mode');
      return EXIT.usage;
    }
    if (!(D.agentId ?? el.agent_id)) {
      ev('agent.missing', { reason: 'settings.voice.eleven_agent_id is empty: run node tools/eleven_agent_setup.js' });
      console.error('no agent: run node tools/eleven_agent_setup.js first (settings.voice.eleven_agent_id)');
      return EXIT.usage;
    }
    let apiKey = D.apiKey;
    if (!apiKey && !D.rest) {
      try {
        apiKey = requireKey(settings.keys?.elevenlabs);
      } catch (e) {
        ev('agent.key_missing', { key: settings.keys?.elevenlabs ?? null, message: e?.message });
        console.error(`ElevenLabs key ${settings.keys?.elevenlabs ?? '(settings.keys.elevenlabs)'} is absent`);
        return EXIT.usage;
      }
    }
    guards.watchStop(() => leaveNow('file')); // at once: the leave must not wait behind queued handlers
    loadAssets();
    agent = createAgent(apiKey);

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
        alert(`браузер закрылся во время стендапа (фаза ${meeting.phase}), лог ${log.path}`);
        finish('browser_closed', EXIT.error);
      }
    });
    page.on?.('pageerror', (e) => ev('page.error', { message: String(e).slice(0, 300) }));
    page.on?.('dialog', async (d) => {
      ev('page.dialog', { message: d.message() });
      await d.dismiss().catch(() => {});
    });

    const avatar = avatarOpts();
    if (avatar?.mode === 'segments') await D.serveAssets(page, { prefix: '/__host_assets/', dir: `${APP_ROOT}/assets/live` });
    audio = await D.attachPageAudio(page, { onAudio: onAudioChunk, onEvent: onPageEvent, opts: { avatar, chunkMs: el.chunk_ms ?? 100 }, baseDir: APP_ROOT });
    player = await D.loadPlayer({ page, audio, log });
    playback = attachPlayer(agent, player, { log, now: wall, onStart: onAgentUtteranceStart, gate: () => muted });
    openRecorders();

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
    tickTimer = setInterval(tick, TICK_MS);
    return null;
  }

  function avatarOpts() {
    const a = settings.avatar;
    if (!a || a.enabled === false || !a.path) return null;
    const base = { path: a.path, fps: a.fps ?? 12, width: a.width ?? 640, height: a.height ?? 480, label: 'Аватар' };
    if (a.mode === 'segments' && a.video) {
      return { ...base, mode: 'segments', video: `/__host_assets/${a.video}`, segments: a.segments, fps: a.fps ?? 15, crossfadeMs: a.crossfadeMs ?? 250, loopFadeMs: a.loopFadeMs ?? 400 };
    }
    return base;
  }

  function openRecorders() {
    const mode = el.record_audio;
    if (!mode || mode === 'none' || D.recorderDir === false) return;
    const dir = D.recorderDir ?? `${APP_ROOT}/_internal`;
    const stamp = clock.formatMsk(new Date(), 'YYYY-MM-DD_HHmmss');
    try {
      recorder = new PcmRecorder({ path: `${dir}/eleven_agent_${stamp}.wav` });
      if (mode === 'both') roomRecorder = new PcmRecorder({ path: `${dir}/eleven_room_${stamp}.wav` });
      ev('agent.recording', { agent: recorder.path, room: roomRecorder?.path ?? null });
    } catch (e) {
      ev('agent.recording_error', { message: e?.message ?? String(e) });
    }
  }

  // ---------------------------------------------------------------------------------- shutdown

  async function shutdown(reason) {
    shuttingDown = true;
    clearInterval(tickTimer);
    clearInterval(domPollTimer);
    clearTimeout(noteTimer);
    guards.close();
    try {
      playback?.stop('shutdown');
    } catch {
      // page may be gone
    }
    if (agent) await agent.close({ reason: `shutdown:${reason}` }).catch(() => {});
    const rec = recorder?.close() ?? null;
    const room = roomRecorder?.close() ?? null;
    if (rec || room) ev('agent.recorded', { agent: rec, room });
    if (page) {
      const t0 = wall();
      try {
        const r = await Promise.race([D.telemost.leave(page, { log: (e) => ev(e.type ?? 'leave', { ...e, type: undefined }) }), sleep(LEAVE_TIMEOUT_MS).then(() => ({ ok: false, detail: 'timeout' }))]);
        ev('leave.result', { ...r, took_ms: wall() - t0, reason });
      } catch (e) {
        ev('leave.error', { message: e?.message ?? String(e) });
      }
      state.setPhase('left');
      meeting.phase = 'left';
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
    if (browser) await Promise.race([browser.close(), sleep(CLOSE_TIMEOUT_MS)]).catch(() => {});
    await costSummary(reason);
    await flushAlerts(); // a crash alert is the whole point of the crash path: give it up to ALERT_FLUSH_MS
  }

  async function costSummary(reason) {
    const a = agent?.stats?.() ?? null;
    const costs = [];
    if (rest?.conversation && conversations.length && !D.rest) {
      for (const id of conversations) {
        const c = await fetchConversationCost(rest, id, COST_FETCH).catch((e) => ({ error: e?.message ?? String(e) }));
        costs.push({ conversation_id: id, ...c });
      }
      try {
        balance.after = balanceOf(await rest.subscription());
        ev('agent.balance', { when: 'after', ...balance.after });
      } catch (e) {
        ev('agent.balance_error', { when: 'after', message: e?.message ?? String(e) });
      }
    }
    const minutes = a ? a.connected_ms / 60_000 : 0;
    const creditsEst = Math.round(minutes * (el.credits_per_min ?? 0));
    const creditsUsed = balance.before && balance.after ? balance.after.used - balance.before.used : null;
    const turns = latencies.map((l) => l.turn_ms);
    const llmTts = latencies.map((l) => l.since_transcript_ms).filter((v) => Number.isFinite(v));
    ev('cost.summary', {
      reason,
      mode: 'elevenlabs_agent',
      duration_min: Math.round((wall() - startedAt) / 6000) / 10,
      turn_latency_ms: { n: turns.length, p50: percentile(turns, 0.5), p90: percentile(turns, 0.9), max: turns.length ? Math.max(...turns) : null, since_transcript_p50: percentile(llmTts, 0.5), since_transcript_p90: percentile(llmTts, 0.9) },
      settings: { llm: el.llm, turn_eagerness: el.turn_eagerness, prompt_mode: el.prompt_mode, tools_blocking: Boolean(el.tools_blocking), chunk_ms: el.chunk_ms, reasoning_effort: el.reasoning_effort, temperature: el.temperature },
      guests: Object.fromEntries(guests),
      silence_nudges: quiet.nudges,
      leave_cancels: meeting.leaveCancels,
      farewell: farewell ? { event_id: farewell.eventId, chars: farewell.chars, extra: farewell.extra || null } : null,
      speech_ms_per_char: talk.rate.chars ? Math.round(talk.rate.ms / talk.rate.chars) : null,
      agent: a,
      connected_min: Math.round(minutes * 100) / 100,
      credits_est: creditsEst,
      credits_used: creditsUsed,
      credits_remaining: balance.after?.remaining ?? balance.before?.remaining ?? null,
      conversations: costs,
      playback: playback?.stats?.() ?? null,
      player: player?.stats?.() ?? null,
      guards: guards.stats(),
      transcript_lines: usage.transcript_lines,
      alerts: usage.alerts,
      ...state.summary(),
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
      alert(`ошибка хоста (агент): ${String(e?.message ?? e).slice(0, 160)}, лог ${log.path}`);
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
    guards,
    meeting,
    get phase() {
      return meeting.phase;
    },
    /** Test hooks. */
    _test: {
      idle: () => serial.idle(),
      agent: () => agent,
      playback: () => playback,
      leaving: () => leaving,
      quiet: () => muted,
      buildInit,
      nudge,
      note,
    },
  };
}
