// Floor controller (WP6, PLAN.md §3): who has the floor, is the room active, when may the host
// speak, when did a turn end, barge-in.
//
// Signals (all calls carry a wall-clock ms `t`; the host passes Date.now()-based times):
//   onLevels(mixDb[], {t})     50 ms dBFS frames of the remote mix (page adapter meta.mix)
//   onVad({type, t})           VAD start/stop from the ears (semantic or energy VAD)
//   onDomSpeakers(ids, {t})    Telemost active-speaker marker for OTHER participants (self excluded).
//                              It lags ~0.4 s and hangs ~0.7 s, so it never counts as room activity
//                              for silence timing, but it IS a barge-in signal while we speak.
//   onSttDelta / onSttFinal    transcript text -> closer detection («у меня всё», «как-то так», ...)
//   setHostSpeaking(bool, {t}) player state (barge-in is only watched while we speak)
//   newTurn({speaker, t})      the host gave the word: arms turn-end detection for that speaker
//   endTurn()                  turn closed by the host (no more candidates until newTurn)
//   checkDoneAsked({t})        the host asked «всё?»: a short answer or 4 s of silence ends the turn
//   resumeTurn()               a candidate was rejected / reverted: re-arm (fresh silence -> «всё?» again)
//   tick({t})                  time-driven checks; the host calls it every ~50 ms
//
// Events (EventEmitter):
//   speech_start {t}                     room became active after silence
//   speech_end {t, duration_ms}          room became silent (energy + VAD closed)
//   quiet {t, silence_ms}                silence reached settings.floor.silence_ms (once per silence)
//   turn_end_candidate {t, reason, text, turn_ms, speech_ms}   reason: closer | silence_2500
//   check_done_answered {t, reason}      after checkDoneAsked: 'closer' (yes/done), 'silence' (4 s) or 'continue'
//   no_speech {t, waited_ms}             nobody spoke for are_you_here_ms after newTurn
//   barge_in {t, run_ms, source}         someone spoke over us (energy >= barge_in_ms, VAD start or DOM marker)
//
// A turn ends ONLY by an explicit closer or by the «всё?» cycle (silence >= check_done_ms ->
// check_done -> yes / closer / check_done_answer_silence_ms of silence). A VAD stop by itself
// never ends a turn (people pause mid-update). Energy threshold: adaptive, noise floor (minimum
// level of the last floor_window_ms, clamped) + energy_above_floor_db, like the ears' VAD; a fixed
// energy_db can override it. Permission to speak (canSpeak): no energy for silence_ms (or
// post_barge_in_silence_ms after a barge-in), VAD closed, no barge-in backoff.

import { EventEmitter } from 'node:events';

export const DEFAULTS = Object.freeze({
  silence_ms: 700,
  check_done_ms: 2500,
  barge_in_ms: 200,
  barge_in_energy: true, // false: loudness alone never interrupts her; the host reports recognized speech via bargeInFrom('stt')
  // 'energy': the room is busy while the mix is loud (or VAD open). 'speech' (yandex_cascade): only
  // while the host reports recognized speech via onVad; silence counts from the end of the last
  // phrase, so background noise or a TV never keeps her quiet
  activity: 'energy',
  barge_in_backoff_ms: 3000,
  barge_in_double_ms: 10_000,
  post_barge_in_silence_ms: 1500,
  energy_db: null, // fixed dBFS threshold; null = adaptive (noise floor + energy_above_floor_db)
  energy_above_floor_db: 12,
  energy_db_min: -62,
  floor_window_ms: 5000,
  floor_min_db: -70,
  floor_max_db: -35,
  floor_rise_db_per_s: 3,
  energy_hold_ms: 250,
  closer_handoff_ms: 700,
  are_you_here_ms: 6000,
  check_done_answer_silence_ms: 4000,
  frame_ms: 50,
});

const FILLER_TAIL = /(?:\s+(?:спасибо|наверное|пожалуй|пока|да|вот|так|ну|в общем|в принципе|ребят|ребята|коллеги|всем))+$/u;
const CLOSER_TAIL = new RegExp(
  '(?:' +
    [
      'у меня(?: на (?:этом|сегодня))?(?: пока)?(?: наверное)?(?: пожалуй)? все',
      'все у меня',
      '(?:это|вот и|вот|на этом|на сегодня|пока|пожалуй|наверное|в общем|в принципе|вроде|вроде бы|собственно|в целом|у меня) все',
      'все спасибо',
      'спасибо все',
      'спасибо у меня все',
      'как[ -]?то так',
      'передаю(?: слово)?(?: дальше)?(?: \\p{L}+)?',
      'передам слово',
      'готова? передать(?: слово)?',
      'на этом (?:у меня )?все',
      'закончила?',
      'я все',
    ].join('|') +
    ')$',
  'u',
);
/** Short answers to «всё?» that mean "yes, done". */
const CHECK_DONE_YES = /^(?:да|ага|угу|все|да все|все да|да да|закончила?|да закончила?|все спасибо|да все спасибо|точно|да точно|так точно|да так точно|у меня все|да у меня все|все так|да все так|это все|конец|да конец)$/u;
const CHECK_DONE_NO = /^(?:нет|не|еще|ещё|секунду|минуту|не все|нет не все|подожди|сейчас|погоди|еще нет|нет еще)/u;

/** Text folded for closer matching: lower case, ё=е, no punctuation. */
export function foldText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The closer phrase the text ends with, or null. Trailing fillers («…всё, спасибо») are ignored. */
export function detectCloser(text) {
  let s = foldText(text);
  if (!s) return null;
  s = s.slice(-160);
  const m = CLOSER_TAIL.exec(s) ?? CLOSER_TAIL.exec(s.replace(FILLER_TAIL, ''));
  return m ? m[0].trim() : null;
}

/** For a reply to «всё?»: 'yes' | 'no' | null (unclear / long answer = keeps talking). */
export function classifyCheckDoneAnswer(text) {
  const s = foldText(text);
  if (!s) return null;
  if (CHECK_DONE_YES.test(s)) return 'yes';
  if (CHECK_DONE_NO.test(s)) return 'no';
  return detectCloser(s) ? 'yes' : null;
}

export function createFloor({ settings = {}, log = null, now = Date.now } = {}) {
  const cfg = { ...DEFAULTS, ...(settings.floor ?? settings) };
  const em = new EventEmitter();
  const emit = (type, fields) => {
    try {
      log?.event?.(`floor.${type}`, fields);
    } catch {
      // never
    }
    em.emit(type, fields);
  };

  let lastLoudAt = null; // last loud energy frame
  let lastFrameAt = null;
  let vadOpen = false;
  let vadOpenedAt = null;
  let domActive = [];
  let active = false; // room active (speech_start .. speech_end)
  let activeSince = null;
  let quietFired = false;
  let hostSpeaking = false;
  let hostSince = null;
  let loudRunStart = null;
  let bargeFired = false;
  let bargeTimes = [];
  let backoffUntil = 0;
  let quietNeededMs = cfg.silence_ms;
  let turn = null;
  const levelHistory = []; // {t, db} of the last floor_window_ms
  let noiseFloorDb = cfg.floor_min_db;
  const stats = { speech_segments: 0, candidates: 0, barge_ins: 0, no_speech: 0, frames: 0, loud_frames: 0 };

  function threshold() {
    if (Number.isFinite(cfg.energy_db)) return cfg.energy_db;
    return Math.max(noiseFloorDb + cfg.energy_above_floor_db, cfg.energy_db_min);
  }

  // Noise floor = minimum frame level of the last floor_window_ms (clamped). Real speech dips
  // between words every few hundred ms, so the minimum stays at the room's floor while a steady
  // noise (a fan, an open mic) is learned within one window. Until a full window has been seen the
  // floor stays at floor_min_db: a partial window of pure speech must not be mistaken for noise.
  // The floor falls at once but rises at most floor_rise_db_per_s, so a dip-free monologue
  // needs many seconds to push it up while a new steady noise is still learned in ~10 s.
  let firstFrameAt = null;
  let floorUpdatedAt = null;
  function trackFloor(db, t) {
    if (!Number.isFinite(db)) return;
    firstFrameAt ??= t;
    levelHistory.push({ t, db });
    const from = t - cfg.floor_window_ms;
    while (levelHistory.length && levelHistory[0].t < from) levelHistory.shift();
    if (t - firstFrameAt < cfg.floor_window_ms) {
      noiseFloorDb = cfg.floor_min_db;
      floorUpdatedAt = t;
      return;
    }
    let min = Infinity;
    for (const f of levelHistory) if (f.db < min) min = f.db;
    const target = Math.min(cfg.floor_max_db, Math.max(cfg.floor_min_db, min === Infinity ? cfg.floor_min_db : min));
    const dt = Math.max(0, t - (floorUpdatedAt ?? t)) / 1000;
    floorUpdatedAt = t;
    noiseFloorDb = target <= noiseFloorDb ? target : Math.min(target, noiseFloorDb + cfg.floor_rise_db_per_s * dt);
  }

  function energyActive(t) {
    return lastLoudAt !== null && t - lastLoudAt <= cfg.energy_hold_ms;
  }

  function roomActive(t = now()) {
    return energyActive(t) || vadOpen;
  }

  /** Milliseconds since the last loud frame, ignoring VAD (Infinity if nothing was ever heard). */
  function energySilenceMs(t = now()) {
    if (lastLoudAt === null) return Infinity;
    return Math.max(0, t - lastLoudAt);
  }

  /** Room silence for permission to speak: 0 while VAD is open, else energy silence. */
  function silenceMs(t = now()) {
    if (vadOpen) return 0;
    return energySilenceMs(t);
  }

  function inBackoff(t = now()) {
    return t < backoffUntil;
  }

  function canSpeak(t = now()) {
    return !vadOpen && silenceMs(t) >= quietNeededMs && !inBackoff(t);
  }

  function updateActive(t, source) {
    const isActive = roomActive(t);
    if (isActive && !active) {
      active = true;
      activeSince = t;
      quietFired = false;
      stats.speech_segments++;
      if (turn) {
        turn.firstSpeechAt ??= t;
        turn.speechStart = t;
        // new speech after a pause invalidates a previous closer
        if (turn.lastSpeechEndAt !== null && t - turn.lastSpeechEndAt >= cfg.silence_ms) {
          turn.closer = null;
          turn.fired = false;
        }
      }
      emit('speech_start', { t, source });
    } else if (!isActive && active) {
      active = false;
      const dur = t - (activeSince ?? t);
      if (turn) {
        turn.speechMs += dur;
        turn.lastSpeechEndAt = t;
      }
      emit('speech_end', { t, duration_ms: dur });
    }
  }

  function onLevels(mix, { t } = {}) {
    const at = t ?? now();
    lastFrameAt = at;
    const frames = Array.isArray(mix) ? mix : [mix];
    const n = frames.length || 1;
    for (let i = 0; i < frames.length; i++) {
      const ft = at - (n - 1 - i) * cfg.frame_ms; // frame end times inside the chunk
      const db = frames[i];
      stats.frames++;
      trackFloor(db, ft);
      const loud = cfg.activity !== 'speech' && Number.isFinite(db) && db >= threshold();
      if (loud) {
        stats.loud_frames++;
        lastLoudAt = Math.max(lastLoudAt ?? 0, ft);
        if (hostSpeaking) {
          loudRunStart ??= ft - cfg.frame_ms;
          if (cfg.barge_in_energy && !bargeFired && ft - loudRunStart >= cfg.barge_in_ms) bargeIn(ft, 'energy', ft - loudRunStart);
        }
      } else {
        loudRunStart = null;
      }
    }
    updateActive(at, 'energy');
  }

  function onVad({ type, t } = {}) {
    const at = t ?? now();
    if (type === 'start') {
      vadOpen = true;
      vadOpenedAt = at;
      lastLoudAt = Math.max(lastLoudAt ?? 0, at); // VAD start = someone is talking even if the mix is quiet
      // in 'speech' mode the host decides barge-ins itself (it filters out her own echo)
      if (hostSpeaking && !bargeFired && cfg.activity !== 'speech') bargeIn(at, 'vad', 0);
      updateActive(at, 'vad');
    } else if (type === 'stop') {
      vadOpen = false;
      if (cfg.activity === 'speech') lastLoudAt = Math.max(lastLoudAt ?? 0, at); // silence starts at the end of the phrase
      updateActive(at, 'vad');
    } else if (type === 'reset') {
      vadOpen = false;
      updateActive(at, 'vad');
    }
  }

  /** ids of OTHER participants the DOM marks as speaking (self already excluded by the host). */
  function onDomSpeakers(ids, { t } = {}) {
    const at = t ?? now();
    domActive = Array.isArray(ids) ? [...ids] : [];
    if (hostSpeaking && domActive.length && !bargeFired && cfg.activity !== 'speech') bargeIn(at, 'dom', 0);
  }

  function onSttDelta({ so_far, text, t } = {}) {
    const s = so_far ?? text ?? '';
    if (turn) {
      turn.text = s;
      turn.closer = detectCloser(s);
      if (turn.checkAsked && !turn.checkAnswered) turn.checkAnswer = classifyCheckDoneAnswer(s);
      turn.lastTextAt = t ?? now();
    }
  }

  function onSttFinal({ text, t } = {}) {
    if (turn) {
      turn.text = text ?? turn.text;
      turn.closer = detectCloser(text ?? '') ?? (turn.closer && detectCloser(turn.text) ? turn.closer : null);
      if (turn.checkAsked && !turn.checkAnswered) turn.checkAnswer = classifyCheckDoneAnswer(text ?? '');
      turn.lastTextAt = t ?? now();
      turn.finals++;
    }
  }

  function setHostSpeaking(on, { t } = {}) {
    const at = t ?? now();
    hostSpeaking = Boolean(on);
    hostSince = hostSpeaking ? at : null;
    loudRunStart = null;
    bargeFired = false;
    if (hostSpeaking) quietNeededMs = cfg.silence_ms;
  }

  /** A barge-in the host detected itself (recognized speech that is not her own echo). */
  function bargeInFrom(source, { t } = {}) {
    if (!hostSpeaking || bargeFired) return false;
    bargeIn(t ?? now(), source, 0);
    return true;
  }

  function bargeIn(t, source, runMs) {
    bargeFired = true;
    stats.barge_ins++;
    bargeTimes = bargeTimes.filter((x) => t - x <= cfg.barge_in_double_ms);
    bargeTimes.push(t);
    if (bargeTimes.length >= 2) backoffUntil = t + cfg.barge_in_backoff_ms;
    quietNeededMs = Math.max(cfg.silence_ms, cfg.post_barge_in_silence_ms);
    emit('barge_in', { t, run_ms: Math.round(runMs), source, backoff_ms: bargeTimes.length >= 2 ? cfg.barge_in_backoff_ms : 0, host_ms: hostSince != null ? t - hostSince : null });
  }

  function newTurn({ speaker = null, t } = {}) {
    const at = t ?? now();
    turn = {
      speaker,
      startedAt: at,
      firstSpeechAt: null,
      speechStart: null,
      lastSpeechEndAt: null,
      speechMs: 0,
      text: '',
      closer: null,
      fired: false,
      noSpeechFired: false,
      checkAsked: false,
      checkAskedAt: null,
      checkAnswer: null,
      checkAnswered: false,
      finals: 0,
      lastTextAt: null,
    };
    // speech already going on when the turn starts (e.g. the person started before we finished)
    if (active) {
      turn.firstSpeechAt = at;
      turn.speechStart = at;
    }
    return turn;
  }

  function endTurn() {
    const t0 = turn;
    turn = null;
    return t0;
  }

  /** A candidate was rejected or a turn end was reverted: keep the turn, arm the «всё?» cycle afresh. */
  function resumeTurn() {
    if (!turn) return;
    turn.fired = false;
    turn.closer = null;
    turn.noSpeechFired = true;
    turn.checkAsked = false;
    turn.checkAskedAt = null;
    turn.checkAnswer = null;
    turn.checkAnswered = false;
  }

  function checkDoneAsked({ t } = {}) {
    if (!turn) return;
    turn.checkAsked = true;
    turn.checkAskedAt = t ?? now();
    turn.checkAnswer = null;
    turn.checkAnswered = false;
    turn.fired = false;
    turn.closer = null;
    turn.text = '';
  }

  function fire(reason, t) {
    turn.fired = true;
    stats.candidates++;
    const speechMs = turn.speechMs + (active && turn.speechStart != null ? t - turn.speechStart : 0);
    emit('turn_end_candidate', { t, reason, text: turn.text.slice(-200), turn_ms: t - turn.startedAt, speech_ms: Math.round(speechMs), speaker: turn.speaker });
  }

  function tick({ t } = {}) {
    const at = t ?? now();
    updateActive(at, 'tick');
    const sil = silenceMs(at);
    if (!active && !quietFired && sil >= cfg.silence_ms && lastLoudAt !== null) {
      quietFired = true;
      emit('quiet', { t: at, silence_ms: Math.round(sil) });
    }
    if (!turn || hostSpeaking) return;
    // are-you-here: nobody spoke since the word was given
    if (turn.firstSpeechAt === null) {
      if (!turn.noSpeechFired && at - turn.startedAt >= cfg.are_you_here_ms) {
        turn.noSpeechFired = true;
        stats.no_speech++;
        emit('no_speech', { t: at, waited_ms: at - turn.startedAt, speaker: turn.speaker });
      }
      return;
    }
    const esil = energySilenceMs(at);
    // closer fast path: energy silence is enough, semantic VAD may still be open
    if (!turn.fired && !(turn.checkAsked && !turn.checkAnswered) && turn.closer && esil >= cfg.closer_handoff_ms) return fire('closer', at);
    if (active) return;
    // after «всё?»
    if (turn.checkAsked && !turn.checkAnswered) {
      const sinceAsk = at - turn.checkAskedAt;
      if (turn.checkAnswer === 'yes' && esil >= cfg.closer_handoff_ms) {
        turn.checkAnswered = true;
        emit('check_done_answered', { t: at, reason: 'closer', speaker: turn.speaker });
        return;
      }
      if (turn.checkAnswer === 'no') {
        turn.checkAnswered = true;
        turn.checkAsked = false; // keeps talking: a later pause may ask again
        turn.fired = false;
        emit('check_done_answered', { t: at, reason: 'continue', speaker: turn.speaker });
        return;
      }
      if (turn.checkAnswer === null && sil >= cfg.check_done_answer_silence_ms && sinceAsk >= cfg.check_done_answer_silence_ms) {
        turn.checkAnswered = true;
        emit('check_done_answered', { t: at, reason: 'silence', speaker: turn.speaker });
        return;
      }
      if (turn.closer && esil >= cfg.closer_handoff_ms) {
        turn.checkAnswered = true;
        emit('check_done_answered', { t: at, reason: 'closer', speaker: turn.speaker });
      }
      return;
    }
    if (turn.fired) return;
    if (!vadOpen && sil >= cfg.check_done_ms) return fire('silence_2500', at);
    return undefined;
  }

  return {
    cfg,
    on: (type, fn) => {
      em.on(type, fn);
      return () => em.off(type, fn);
    },
    off: (type, fn) => em.off(type, fn),
    once: (type, fn) => em.once(type, fn),
    onLevels,
    onVad,
    bargeInFrom,
    onDomSpeakers,
    onSttDelta,
    onSttFinal,
    setHostSpeaking,
    newTurn,
    endTurn,
    resumeTurn,
    checkDoneAsked,
    tick,
    roomActive,
    silenceMs,
    energySilenceMs,
    canSpeak,
    inBackoff,
    threshold,
    get noiseFloorDb() {
      return noiseFloorDb;
    },
    get vadOpen() {
      return vadOpen;
    },
    get active() {
      return active;
    },
    get hostSpeaking() {
      return hostSpeaking;
    },
    get turn() {
      return turn ? { ...turn } : null;
    },
    get domActive() {
      return [...domActive];
    },
    stats: () => ({ ...stats, backoff_until: backoffUntil, noise_floor_db: Math.round(noiseFloorDb * 10) / 10, threshold_db: Math.round(threshold() * 10) / 10 }),
  };
}
