// The agent's side of the host (docs/agent_plan.md, step 3): one owner of the conversation — an LLM
// with tools — instead of the old turn automaton + one-shot JSON brain. The core host
// (src/core/host.js, voice.host = "agent") keeps the room, the ears, the floor gate, the speech queue,
// the kill switch, deadlines and the empty room; it feeds this module events and executes its calls.
//
//   const c = createConductor({ state, agent, io, now, log, leadId, mentionsHost });
//   c.heard({who, text, t})          a final line (after stt_fixes, her echo filtered, speaker attributed)
//   c.herLine({text, cut, kind, t})  her line ended (completed, or cut by a barge-in)
//   c.interrupted({text}) · c.chorus({who}) · c.joined(id) · c.left(id) · c.timer(name)
//   c.undone({what, why})            the host undid her turn change / opening line (the agent hears it)
//   c.tick(t)                        every host tick: the silence ladder, re-wakes, the end of a held wake
//
// Wake -> agent.decide(input, {signal}) -> tool calls -> executor: invariants (src/agent/invariants.js
// and the host's own checks below); a refused call is logged (agent.rejected) and the agent hears
// `rejected {tool, reason}` on its next wake. Every content event (a line, someone left) raises the
// epoch: the request in flight is aborted and her lines still waiting with an older epoch are dropped
// (io.drop). After MAX_PREEMPTS aborts in a row the decision in flight is kept and applied if the
// room is quiet when it arrives. Log: agent.wake / agent.decision / agent.aborted / agent.rejected /
// agent.dropped / agent.text_only / agent.error / agent.budget.
//
// io (the host): say({text, how, epoch}) · startRound({person, text, how, epoch}) · giveWord({person, text, epoch,
// said, silentPrev}) · askDone({person, epoch}) · openFloor({epoch, said, silentPrev}) · leave({text, epoch})
// -> {ok, reason?} (said: she has just said something in this decision — no ack clip on top; silentPrev: the
// speaker never spoke in the turn — no ack, marked skipped); drop(epoch, person?) -> n
// (her lines still waiting with an older epoch; with `person`: only the lines to that person — someone left);
// lineEpoch: her lines older than it are stale (a new line raises it, a leave does not); roomSpeaking() · hostBusy() · canSpeak() · quiet(); alert(text);
// lit() -> ids whose Telemost tile is lit now (a final while its author's tile is lit holds the wake: LIT_HOLD_MS).
// `how` (src/core/addressing.js mayAnswer): was one of the lines she answers addressed to her ('name' = by name).

import { mayAnswer } from '../core/addressing.js';
import { violation } from './invariants.js';

/** Silence ladder (docs/agent_plan.md): when silence wakes the agent, ms from max(people's speech end, her line end). */
export const SILENCE_LADDER = Object.freeze({ round: Object.freeze([1000, 2500, 6000]), open_floor: Object.freeze([2500, 6000]) });
/** After the last stage of the ladder: another wake every SILENCE_REPEAT_MS, at most SILENCE_REPEATS times. */
export const SILENCE_REPEAT_MS = 10_000;
export const SILENCE_REPEATS = 3;
export const ASK_DONE_MIN_SILENCE_MS = 2500;
/**
 * A final while its author's tile is still lit: the person may be mid-thought. Telemost's marker hangs ~0.7 s
 * after the voice; SpeechKit closes a phrase on a ~0.5 s pause (28.09, 4 runs, 86 finals: 20 were followed by
 * more of the same person within 1.5 s, one sentence came in five finals). The wake waits until the tile goes
 * dark, at most LIT_HOLD_MS; while the next piece is being recognized (roomSpeaking) it keeps waiting — the
 * piece's final holds again — up to LIT_HOLD_MAX_MS from the first held final. On those logs: 12 of the 20
 * pieces merge, a finished phrase waits +0.13 s (p50; p90 0.43 s, 1.5 s at most).
 */
export const LIT_HOLD_MS = 1500;
export const LIT_HOLD_MAX_MS = 8000;
/**
 * The speaker has not said a word since she gave it: no give_word to another and no open_floor until this
 * much has passed since her line (live 28.09: open_floor 1.7 s after «Дальше, X.», the guest had not
 * started yet — «ты мне не дала сказать»). Asked by the room (a line addressed to her) — no wait.
 */
export const SPEAKER_START_MS = 6000;
/** A `say` nobody asked for (no line addressed to her among the ones it answers): at most one per this. */
export const UNSOLICITED_EVERY_MS = 20_000;
/** On the open floor additions are answers to her question («Принято, Глеб. Кто-то ещё?»): a shorter limit. */
export const UNSOLICITED_OPEN_FLOOR_MS = 8000;
/** A line addressed to her stays «addressed» this long, until she has answered (a dropped answer is re-decided). */
export const ADDRESSED_KEEP_MS = 20_000;
export const SAY_REPEAT_MS = 30_000;
export const MAX_PREEMPTS = 2;
export const DEFAULT_BUDGET = Object.freeze({ max_calls: 800, max_tokens: 4_000_000, max_rub: null });
const DIALOG_KEEP = 40;
const TURN_TOOLS = new Set(['give_word', 'ask_done', 'open_floor', 'leave']);
/**
 * «Not yet» refusals: the same call is right a bit later, so repeating it never marks the agent stuck and
 * earns no extra wake right away (live 28.09, run 2: `too_early` on every line silenced the real «всё?»).
 */
const TIMING = new Set(['too_early', 'too_often', 'start_pending', 'turn_change_in_progress', 'closing', 'speaker_not_started', 'not_started', 'already_asked', 'repeat', 'quiet']);
/** Two identical refusals count as «stuck» only this close together (review 28.09: not across minutes of skips). */
const STUCK_WINDOW_MS = 30_000;
/** Before the round, after her own line: one silence wake (review 28.09: «Кора, начинай» answered by a say, then nothing). */
const WAITING_AFTER_HER_MS = 6000;
/** «Кора, начни с Глеба» from the lead counts for a start this long (review 28.09: not only the lines of the same decision). */
const LEAD_ASK_KEEP_MS = 60_000;
/** Case endings of a name form: «Слава» -> «Славы», «Славе»; «Глеб» -> «Глеба», «Глебом» (not «Славно», «митинга»). */
const NAME_ENDINGS = new Set(['', 'а', 'я', 'ы', 'и', 'е', 'у', 'ю', 'о', 'ой', 'ей', 'ою', 'ею', 'ом', 'ем', 'ь']);
const ACTIVE = { waiting: 'waiting', starting: 'waiting', round: 'round', open_floor: 'open_floor' };
/** «повтори», «не расслышал»: saying her line again is what they asked for. */
const REPEAT_ASK_RE = /повтор|ещё раз|еще раз|не расслыш|не услыш|не понял/iu;

const fold = (s) =>
  String(s ?? '')
    .replace(/\u0301/g, '') // stress marks of people.json («Гле́б»): not a word break
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const letters = (s) => (String(s ?? '').match(/\p{L}/gu) ?? []).length;

/**
 * @param {object} o
 * @param {object} o.state        src/core/state.js
 * @param {{decide: Function}|null} o.agent   decide(input, {signal}) -> {actions, timings?, usage?}
 * @param {object} o.io           the host's executor (see the header)
 * @param {() => number} o.now    wall clock, ms (the floor's timeline)
 * @param {{event: Function}} [o.log]
 * @param {string|null} [o.leadId]
 * @param {(text: string) => boolean} [o.mentionsHost]
 * @param {object} [o.budget]     {max_calls, max_tokens, max_rub}
 * @param {object|null} [o.pricing] {rub_per_1k_input, rub_per_1k_output}
 * @param {(fn: Function) => unknown} [o.run]  where decisions are applied (the host's serializer: state changes stay in order)
 */
export function createConductor({ state, agent, io, now, log = null, leadId = null, mentionsHost = () => false, budget = {}, pricing = null, run: runIn = (fn) => fn() }) {
  const limits = { ...DEFAULT_BUDGET, ...(budget ?? {}) };
  const ev = (type, fields) => {
    try {
      log?.event?.(type, fields);
    } catch {
      // logging never breaks the conversation
    }
  };
  const dialog = []; // {who, text, cut?, t}
  let pending = []; // {e, how}: events the agent has not decided on yet
  let epoch = 0;
  let inflight = null; // {epoch, controller, consumed, reason, t}
  let preempts = 0;
  let rewake = null; // reason of a wake owed once nothing is in flight
  let rejectWakes = 0;
  let lastRejectKey = null;
  let lastRejectAt = -Infinity;
  let stuck = false; // the same call refused twice in a row: no repeat wakes (the base ladder still runs) until someone speaks (live 28.09: 25 identical refusals)
  let failStreak = 0;
  let closed = false;
  let lineEpoch = 0; // her lines older than this are stale
  let lastHumanAt = -Infinity;
  let lastHerEndAt = -Infinity;
  let lastHerKind = null;
  let lastHerCut = false;
  let lastBusyAt = -Infinity;
  let askedDoneFor = null;
  let spokeIn = null; // the speaker who has said something since getting the word (ask_done needs it)
  let wordGivenAt = -Infinity; // end of her line that gave the word (start / handoff)
  let hold = null; // {who, since, until}: a wake held while the author's tile is lit (LIT_HOLD_MS)
  let lastAddressed = null; // {how, t}: the last line addressed to her, until she answers
  let lastUnsolicitedAt = -Infinity;
  const ladder = { from: null, fired: 0, repeats: 0 };
  const stats = { wakes: 0, decisions: 0, aborted: 0, errors: 0, rejected: 0, dropped: 0, text_only: 0, tokens_in: 0, tokens_out: 0, rub: 0, disabled: null };

  const phase = () => ACTIVE[state.phase] ?? null;

  function queue() {
    const present = new Set(state.presentIds());
    const p = state.ensurePlan();
    return [p.next, ...p.then].filter((id) => id && id !== state.current && present.has(id) && state.get(id)?.status !== 'spoke');
  }

  /** {phase, speaker, queue, present}: what the agent sees and the invariants check. */
  function situation() {
    const ph = phase();
    return { phase: ph, speaker: ph === 'round' ? state.current : null, queue: ph === 'waiting' ? [] : queue(), present: state.presentIds() };
  }

  /** Short names of the people she may address: present ones only (live 28.09: with the whole roster in the prompt the model called absent people). */
  function names(ids) {
    const out = {};
    for (const id of ids) out[id] = String(state.vocative?.(id) ?? id).replace(/\u0301/g, '');
    return out;
  }

  function input() {
    const sit = situation();
    return {
      ...sit,
      names: names(sit.present),
      ...(leadId && sit.present.includes(leadId) ? { lead: leadId } : {}),
      // what the tools may name now (draft_agent toolsFor): not a refusal after the call, no tool at all
      can_give: sit.present.filter((id) => id !== sit.speaker && state.get(id)?.status !== 'spoke'),
      ask_done: canAskDone(sit, now()),
      dialog: dialog.slice(-12).map(({ who, text, cut }) => ({ who, text, ...(cut ? { cut: true } : {}) })),
      events: pending.map((p) => p.e),
    };
  }

  function push(e, how = null) {
    pending.push({ e, how });
    if (pending.length > 60 && !inflight) pending = pending.slice(-60); // not while a request counts on the indexes
  }

  function remember(line) {
    dialog.push(line);
    if (dialog.length > DIALOG_KEEP) dialog.splice(0, dialog.length - DIALOG_KEEP);
  }

  function resetLadder(from) {
    ladder.from = from;
    ladder.fired = 0;
    ladder.repeats = 0;
  }

  function bump(why, person = null) {
    epoch++;
    if (!person) lineEpoch = epoch;
    let n = 0;
    try {
      n = (person ? io.drop?.(epoch, person) : io.drop?.(epoch)) ?? 0;
    } catch (e) {
      ev('agent.error', { where: 'drop', message: e?.message ?? String(e) });
    }
    if (n) {
      stats.dropped += n;
      ev('agent.dropped', { epoch, why, count: n });
    }
  }

  // ------------------------------------------------------------------------------------- events

  function heard({ who = '?', text, t = now() }) {
    const s = String(text ?? '').trim();
    if (!s) return;
    const how = mayAnswer(s, { mentionsHost, present: state.presentIds().length, sinceOwnLineMs: t - lastHerEndAt });
    remember({ who, text: s, t });
    push({ type: 'heard', who, text: s }, how);
    lastHumanAt = Math.max(lastHumanAt, t);
    resetLadder(t);
    if (how) lastAddressed = { how, t };
    // «?» (nobody attributed) is the speaker's only when nobody else is in the room (review 28.09: a colleague's
    // line made a silent speaker «started» — «Глеб, всё?» and «Спасибо, Глеб» to someone who said nothing)
    if (state.current && (who === state.current || (who === '?' && state.presentIds().length === 1))) {
      askedDoneFor = null;
      spokeIn = state.current;
    }
    stuck = false;
    rejectWakes = 0;
    if (letters(s) < 2) return; // «а», «м»: in the dialog, not worth a wake
    bump('heard');
    if (who !== '?' && lit().includes(who)) {
      if (!hold) ev('agent.hold', { who });
      hold = { who, since: hold?.since ?? t, until: t + LIT_HOLD_MS };
      return;
    }
    if (hold) release(who === hold.who ? 'dark' : 'other', t); // the wake covers the held lines too
    wake('heard');
  }

  function lit() {
    try {
      const ids = io.lit?.();
      return Array.isArray(ids) ? ids : [];
    } catch {
      return [];
    }
  }

  function release(why, t) {
    ev('agent.held', { who: hold.who, ms: Math.round(t - hold.since), why });
    hold = null;
  }

  function herLine({ text, cut = false, kind = null, t = now() }) {
    const s = String(text ?? '').trim();
    if (!s) return;
    remember({ who: 'host', text: s, cut: Boolean(cut), t });
    push({ type: 'her_line_done', text: s, ...(cut ? { cut: true } : {}) });
    lastHerEndAt = Math.max(lastHerEndAt, t);
    lastHerKind = kind;
    lastHerCut = Boolean(cut);
    if (kind === 'check_done' && !cut) askedDoneFor = state.current;
    if ((kind === 'start' || kind === 'handoff') && !cut) wordGivenAt = t;
    if (!cut && (kind === 'agent_say' || kind === 'start' || kind === 'handoff') && lastAddressed && lastAddressed.t <= t) lastAddressed = null; // answered
    resetLadder(t);
  }

  /** The host gave the word to someone who had already started talking (no handoff line): he has spoken in his turn. */
  function speakerStarted(id) {
    if (state.current === id) spokeIn = id;
  }

  /** The host undid what she started (a turn change reverted, the opening line dropped): the agent hears it next time. */
  function undone({ what, why = null } = {}) {
    push({ type: 'undone', what, ...(why ? { why } : {}) });
  }

  function interrupted({ text = '' } = {}) {
    push({ type: 'interrupted', text: String(text ?? '').slice(0, 160) });
  }

  function chorus({ who = [] } = {}) {
    push({ type: 'chorus', who });
  }

  function joined(id) {
    push({ type: 'joined', who: id });
    stuck = false;
    ladder.fired = 0; // stages that already passed fire once more, with the newcomer in the input
    ladder.repeats = 0;
  }

  function left(id) {
    push({ type: 'left', who: id });
    stuck = false;
    if (askedDoneFor === id) askedDoneFor = null;
    bump('left', id); // a handoff to someone who just left must not play; her other lines stay (review 28.09)
    ladder.fired = 0;
    ladder.repeats = 0;
  }

  function timer(name) {
    push({ type: 'timer', name });
    if (name === 'start' || name === 'wait_lead_until') wake('timer'); // before the start there is no silence ladder
  }

  // --------------------------------------------------------------------------------------- wake

  function silenceFrom() {
    return Math.max(lastHumanAt, lastHerEndAt, lastBusyAt, ladder.from ?? -Infinity);
  }

  function tick(t = now()) {
    if (!agent || stats.disabled || !phase()) return;
    if (hold) {
      // no wake of any kind while the author's tile is lit: the line may go on
      const talking = Boolean(io.roomSpeaking?.());
      const dark = !lit().includes(hold.who);
      if (t - hold.since < LIT_HOLD_MAX_MS && (talking || (!dark && t < hold.until))) return;
      release(t - hold.since >= LIT_HOLD_MAX_MS ? 'max' : dark ? 'dark' : 'timeout', t);
      rewake = null; // this wake covers any wake owed during the hold
      return wake('heard');
    }
    if (io.roomSpeaking?.() || io.hostBusy?.()) {
      lastBusyAt = t;
      resetLadder(t);
      return;
    }
    if (inflight) return;
    if (rewake && pending.length) {
      const why = rewake;
      rewake = null;
      return wake(why);
    }
    const stages = ladderNow();
    if (!stages) return;
    const from = silenceFrom();
    if (!Number.isFinite(from)) return;
    const ms = t - from;
    let due = false;
    if (ladder.fired < stages.length && ms >= stages[ladder.fired]) {
      while (ladder.fired < stages.length && ms >= stages[ladder.fired]) ladder.fired++;
      // late (a join re-armed the ladder after a long silence): the repeats already due are not fired in a burst
      ladder.repeats = Math.min(SILENCE_REPEATS, Math.max(ladder.repeats, Math.floor((ms - stages.at(-1)) / SILENCE_REPEAT_MS)));
      due = true;
    } else if (!stuck && phase() !== 'waiting' && ladder.fired >= stages.length && ladder.repeats < SILENCE_REPEATS && ms >= stages.at(-1) + (ladder.repeats + 1) * SILENCE_REPEAT_MS) {
      ladder.repeats++;
      due = true;
    }
    if (!due) return;
    const after = lastHerEndAt >= lastHumanAt ? (lastHerKind === 'check_done' && !lastHerCut ? 'ask_done' : 'host') : 'speech';
    push({ type: 'silence', ms: Math.round(ms / 100) * 100, after });
    wake('silence');
  }

  /**
   * The silence stages now. Round, the word given and not a word yet: only the last stage (review 28.09: the
   * 1 s and 2.5 s wakes could only be skipped or refused — the open floor 1.7 s after a handoff came from the
   * 1 s one). Before the round: one wake WAITING_AFTER_HER_MS after her own line, nothing after people's.
   */
  function ladderNow() {
    const ph = phase();
    if (ph === 'waiting') return lastHerEndAt >= lastHumanAt && Number.isFinite(lastHerEndAt) ? [WAITING_AFTER_HER_MS] : null;
    const stages = SILENCE_LADDER[ph];
    if (ph === 'round' && state.current && spokeIn !== state.current && state.get(state.current)?.present) return [SPEAKER_START_MS];
    return stages;
  }

  /** ask_done makes sense: the speaker has said something, not asked yet, 2.5 s of quiet. */
  function canAskDone(sit, t) {
    return sit.phase === 'round' && Boolean(sit.speaker) && spokeIn === sit.speaker && askedDoneFor !== sit.speaker && t - Math.max(lastHumanAt, lastHerEndAt) >= ASK_DONE_MIN_SILENCE_MS;
  }

  function overBudget() {
    if (stats.disabled) return true;
    const why =
      stats.wakes >= limits.max_calls ? `calls ${stats.wakes} >= ${limits.max_calls}` : stats.tokens_in + stats.tokens_out >= limits.max_tokens ? `tokens >= ${limits.max_tokens}` : limits.max_rub != null && stats.rub >= limits.max_rub ? `rub ${stats.rub.toFixed(2)} >= ${limits.max_rub}` : null;
    if (!why) return false;
    stats.disabled = why;
    ev('agent.budget', { why, ...stats });
    io.alert?.(`агент остановлен по бюджету: ${why}`);
    return true;
  }

  function wake(reason) {
    if (closed || !agent || !phase() || !state.presentIds().length || io.quiet?.()) return;
    if (hold) {
      rewake ??= reason; // the author's tile is lit: tick() wakes when it goes dark (review 28.09: timer / owed wakes went around it)
      return;
    }
    if (overBudget()) return;
    if (inflight) {
      if (inflight.epoch < epoch && preempts < MAX_PREEMPTS) {
        preempts++;
        stats.aborted++;
        ev('agent.aborted', { epoch: inflight.epoch, now: epoch, reason, preempts });
        inflight.controller.abort();
        inflight = null;
      } else {
        rewake = reason;
        return;
      }
    }
    const req = { epoch, controller: new AbortController(), consumed: pending.length, reason, t: now() };
    const inp = input();
    inflight = req;
    stats.wakes++;
    ev('agent.wake', { reason, epoch, phase: inp.phase, speaker: inp.speaker, queue: inp.queue, events: inp.events });
    Promise.resolve()
      .then(() => agent.decide(inp, { signal: req.controller.signal }))
      .then(
        (out) => runIn(() => decided(req, out)),
        (e) => runIn(() => failed(req, e)),
      );
  }

  function failed(req, e) {
    if (inflight !== req) return; // aborted: a newer wake owns the events
    inflight = null;
    preempts = 0;
    stats.errors++;
    failStreak++;
    ev('agent.error', { epoch: req.epoch, reason: req.reason, message: String(e?.message ?? e).slice(0, 300), streak: failStreak });
    // one more try: before the round there is no ladder to pick the lines up (review 28.09: «Кора, начинай» lost)
    if (failStreak === 1) rewake ??= 'retry';
  }

  function decided(req, out) {
    if (inflight !== req) return;
    inflight = null;
    failStreak = 0;
    const used = pending.splice(0, req.consumed);
    const actions = Array.isArray(out?.actions) ? out.actions : [];
    const u = out?.usage ?? {};
    const tin = Number(u.prompt_tokens ?? u.input_tokens ?? 0) || 0;
    const tout = Number(u.completion_tokens ?? u.output_tokens ?? 0) || 0;
    stats.decisions++;
    stats.tokens_in += tin;
    stats.tokens_out += tout;
    if (pricing) stats.rub += (tin / 1000) * (pricing.rub_per_1k_input ?? 0) + (tout / 1000) * (pricing.rub_per_1k_output ?? 0);
    const tm = out?.timings ?? {};
    ev('agent.decision', {
      epoch: req.epoch,
      reason: req.reason,
      actions: actions.map(({ action, person, text, name }) => ({ action, ...(person ? { person } : {}), ...(text ? { text } : {}), ...(name ? { name } : {}) })),
      ttft_ms: tm.ttft ?? null,
      name_ms: tm.first_tool_name ?? null,
      done_ms: tm.done ?? Math.round(now() - req.t),
      tokens: tin + tout || null,
      ...(out?.fallback ? { fallback: out.fallback } : {}),
      ...(out?.finish_reason && !['stop', 'tool_calls'].includes(out.finish_reason) ? { finish_reason: out.finish_reason } : {}), // «length»: arguments cut
    });
    if (out?.fallback) stats.fallbacks = (stats.fallbacks ?? 0) + 1;
    const stale = req.epoch < epoch;
    const protectedStale = stale && preempts >= MAX_PREEMPTS && io.canSpeak?.() !== false;
    preempts = 0;
    if (stale && !protectedStale) {
      const speaking = actions.filter((a) => a.action !== 'skip' && a.action !== 'none');
      if (speaking.length) {
        stats.dropped++;
        ev('agent.dropped', { epoch: req.epoch, now: epoch, why: 'stale', actions: speaking.map((a) => a.action) });
      }
      pending.unshift(...used.filter((p) => p.e.type !== 'silence')); // the newer wake decides on them too
      rewake ??= 'stale';
      return;
    }
    execute(actions, used);
    if (rewake && pending.length && !inflight) {
      const why = rewake;
      rewake = null;
      wake(why);
    }
  }

  // ----------------------------------------------------------------------------------- executor

  /** What the agent may do instead: who can get the word, who is the speaker. */
  function hintFor(a, why, sit) {
    if (a.action === 'give_word') {
      const can = sit.present.filter((id) => id !== sit.speaker && state.get(id)?.status !== 'spoke' && (why !== 'lead_goes_first' || id === leadId));
      return { can };
    }
    if (why === 'speaker_not_started') return { speaker: sit.speaker, hint: 'слово у него, он ещё не начал: подожди' };
    if (why === 'not_addressed') return { hint: 'в группе отвечай, когда к тебе обратились: по имени или «ты» сразу после твоей реплики' };
    if (a.action === 'ask_done') return sit.speaker ? { speaker: sit.speaker } : { hint: 'круг не начат: сначала give_word' };
    if (a.action === 'leave' || a.action === 'open_floor') return sit.queue.length ? { queue: sit.queue } : {};
    return {};
  }

  function reject(a, why, sit = situation()) {
    stats.rejected++;
    ev('agent.rejected', { tool: a.action, reason: why, ...(a.person ? { person: a.person } : {}), ...(a.text ? { text: a.text } : {}) });
    push({ type: 'rejected', tool: a.action === 'unknown' ? a.name : a.action, reason: why, ...(a.person ? { person: a.person } : {}), ...hintFor(a, why, sit) });
    const key = `${a.action}:${a.person ?? ''}:${why}`;
    const t = now();
    if (key === lastRejectKey && t - lastRejectAt <= STUCK_WINDOW_MS && !stuck && !TIMING.has(why)) {
      stuck = true;
      ev('agent.stuck', { tool: a.action, reason: why, ...(a.person ? { person: a.person } : {}) });
    }
    lastRejectKey = key;
    lastRejectAt = t;
    // a refused turn action must not leave the round stuck in silence: one more wake, then the ladder
    if (TURN_TOOLS.has(a.action) && !TIMING.has(why) && rejectWakes < 1 && !stuck) {
      rejectWakes++;
      rewake ??= 'rejected';
    }
  }

  /**
   * Said to the end within SAY_REPEAT_MS, or most of its words were (live 28.09: «…когда будешь готов — скажи,
   * начну» three times). The same words to someone else are not a repeat (review 28.09: «Принято, Глеб. Кто-то
   * ещё?» then «Принято, Слава. Кто-то ещё?»).
   */
  function saidLately(text, t) {
    const words = fold(text).split(' ').filter((w) => w.length >= 3);
    const present = state.presentIds();
    const to = present.filter((id) => namesPerson(text, id));
    return dialog.some((l) => {
      if (l.who !== 'host' || l.cut || t - l.t > SAY_REPEAT_MS) return false;
      if (to.some((id) => !namesPerson(l.text, id))) return false;
      const bag = new Set(fold(l.text).split(' '));
      return words.length > 0 && words.filter((w) => bag.has(w)).length / words.length >= 0.7;
    });
  }

  /** A handoff text that names someone other than the one getting the word (live 28.09: give_word(Тима, «…Дальше, Глеб.»)). */
  function namesSomeoneElse(text, sit, person) {
    // people in the room only (review 28.09: an absent colleague's name form matched ordinary words)
    for (const id of sit.present) if (id !== person && id !== sit.speaker && id !== state.current && namesPerson(text, id)) return true;
    return false;
  }

  /** The word is with someone who has not started yet and she gave it less than SPEAKER_START_MS ago. */
  function speakerNotStarted(sit, ctx, t) {
    return sit.phase === 'round' && Boolean(sit.speaker) && spokeIn !== sit.speaker && Boolean(state.get(sit.speaker)?.present) && !ctx.how && t - wordGivenAt < SPEAKER_START_MS;
  }

  /** The host's own checks on top of invariants.violation(). */
  function hostCheck(a, sit, ctx) {
    const t = now();
    if (TURN_TOOLS.has(a.action) && ctx.turnDone) return 'one_turn_action_per_decision';
    switch (a.action) {
      case 'say':
        if (!a.text) return 'empty_text';
        if (ctx.said) return 'one_say_per_decision';
        // mid-round in a group only; a say next to a handoff is part of it («Глеба не слышно, вернусь к нему в конце»)
        if (sit.phase === 'round' && sit.present.length >= 3 && !ctx.how && !ctx.withTurn) return 'not_addressed';
        if (!ctx.how && t - lastUnsolicitedAt < (sit.phase === 'open_floor' ? UNSOLICITED_OPEN_FLOOR_MS : UNSOLICITED_EVERY_MS)) return 'too_often';
        if (!ctx.repeatAsked && saidLately(a.text, t)) return 'repeat';
        return null;
      case 'give_word':
        if (state.get(a.person)?.status === 'spoke') return 'already_spoke';
        if (a.person !== sit.speaker && speakerNotStarted(sit, ctx, t)) return 'speaker_not_started';
        // the word to someone else: only when the text does not name the one getting it (live 29.09: «Поняла,
        // спасибо, Тима. Глеб, передаю тебе слово!» — a thanks to the last speaker — was refused)
        if (a.text && !namesPerson(a.text, a.person) && namesSomeoneElse(a.text, sit, a.person)) return 'text_names_someone_else';
        return null;
      case 'ask_done':
        if (spokeIn !== a.person) return 'not_started'; // «Глеб, всё?» to someone who has not said a word yet
        if (askedDoneFor === a.person) return 'already_asked';
        if (t - Math.max(lastHumanAt, lastHerEndAt) < ASK_DONE_MIN_SILENCE_MS) return 'too_early';
        return null;
      case 'open_floor':
        return speakerNotStarted(sit, ctx, t) ? 'speaker_not_started' : null;
      default:
        return null;
    }
  }

  function execute(actions, used) {
    const sit = situation();
    const hows = used.map((p) => p.how).filter(Boolean);
    // by name anywhere: the answer may not wait; a question whose answer was dropped (a newer line) is still hers
    const kept = lastAddressed && now() - lastAddressed.t <= ADDRESSED_KEEP_MS ? lastAddressed.how : null;
    // a question by name whose answer was dropped (a barge-in, a newer line) stays «by name» (review 28.09)
    const how = hows.includes('name') || kept === 'name' ? 'name' : (hows.at(-1) ?? kept);
    const lastHeard = used.filter((p) => p.e.type === 'heard').at(-1)?.e.text ?? '';
    const withTurn = actions.some((a) => TURN_TOOLS.has(a?.action) && a.action !== 'leave');
    const ctx = { turnDone: false, said: false, how, withTurn, repeatAsked: REPEAT_ASK_RE.test(lastHeard) };
    let accepted = 0;
    const refusedBefore = stats.rejected;
    // an answer goes before the handoff whatever order the model wrote them in
    const ordered = [...actions].sort((x, y) => (x?.action === 'say' ? 0 : 1) - (y?.action === 'say' ? 0 : 1));
    for (const a of ordered) {
      if (!a?.action || a.action === 'skip') continue;
      if (a.action === 'none') {
        stats.text_only++;
        ev('agent.text_only', { text: a.text ?? null }); // never spoken
        continue;
      }
      if (a.action === 'unknown') {
        reject(a, 'unknown_tool');
        continue;
      }
      // «начнём с Глеба» from the lead himself: the lead-first rule gives way
      const leadAsked = a.action === 'give_word' && sit.phase === 'waiting' && dialog.some((l) => l.who === leadId && now() - l.t <= LEAD_ASK_KEEP_MS && namesPerson(l.text, a.person));
      // leave before the round is over: only when a line of THIS decision named her («Кора, заканчивай»), not any name 20 s ago
      const why = violation(a, sit, { leadId: leadAsked ? null : leadId, askedByName: hows.includes('name') }) ?? hostCheck(a, sit, ctx);
      if (why) {
        reject(a, why, sit);
        continue;
      }
      const r = run(a, sit, ctx) ?? { ok: true };
      if (!r.ok) reject(a, r.reason ?? 'refused', sit);
      else accepted++;
    }
    if (accepted || stats.rejected === refusedBefore) {
      // a decision with nothing refused (a skip included) ends a refusal streak (review 28.09)
      rejectWakes = 0;
      lastRejectKey = null;
    }
  }

  /** Does a line name this person (short name or first name, any ending)? */
  function namesPerson(text, id) {
    const words = fold(text).split(' ');
    const forms = [state.vocative?.(id), String(state.displayName?.(id) ?? '').split(/\s+/)[0]].map((x) => fold(x)).filter((x) => x.length >= 3);
    // the stem without a final vowel / й / ь, then a case ending: «слава» -> «славы», not «славно»
    const stems = forms.map((f) => (/[аяоеиыуюйь]$/.test(f) ? f.slice(0, -1) : f)).filter((f) => f.length >= 3);
    return stems.some((st) => words.some((w) => w.startsWith(st) && NAME_ENDINGS.has(w.slice(st.length))));
  }

  function run(a, sit, ctx) {
    const text = a.text ?? null;
    // the speaker never spoke in the turn: no «Спасибо», and the host marks him skipped (the word comes back at the end)
    const silentPrev = Boolean(sit.speaker) && spokeIn !== sit.speaker;
    switch (a.action) {
      case 'say':
        ctx.said = true;
        if (!ctx.how) lastUnsolicitedAt = now();
        return io.say({ text, how: ctx.how, epoch });
      case 'give_word':
        ctx.turnDone = true;
        return sit.phase === 'waiting' ? io.startRound({ person: a.person, text, how: ctx.how, epoch }) : io.giveWord({ person: a.person, text, epoch, said: ctx.said, silentPrev });
      case 'ask_done':
        ctx.turnDone = true;
        return io.askDone({ person: a.person, epoch });
      case 'open_floor':
        ctx.turnDone = true;
        return io.openFloor({ epoch, said: ctx.said, silentPrev });
      case 'leave':
        ctx.turnDone = true;
        return io.leave({ text, epoch });
      default:
        return { ok: false, reason: 'unknown_tool' };
    }
  }

  /** Lines said before this host started listening (tests, log replay): into the dialog, no events, no wakes. */
  function seedDialog(lines = []) {
    for (const l of lines) if (l?.text) remember({ who: l.who ?? '?', text: String(l.text), ...(l.cut ? { cut: true } : {}), t: now() });
  }

  return {
    seedDialog,
    heard,
    herLine,
    undone,
    speakerStarted,
    interrupted,
    chorus,
    joined,
    left,
    timer,
    tick,
    input,
    situation,
    stats: () => ({ ...stats, epoch, inflight: Boolean(inflight), pending: pending.length, held: Boolean(hold) }),
    get epoch() {
      return epoch;
    },
    get busy() {
      return Boolean(inflight);
    },
    close() {
      closed = true; // no wakes while she leaves (review 28.09)
      hold = null;
      inflight?.controller.abort();
      inflight = null;
    },
    get lineEpoch() {
      return lineEpoch;
    },
  };
}
