// The agent's side of the host (docs/agent_plan.md, step 3): one owner of the conversation — an LLM
// with tools — instead of the old turn automaton + one-shot JSON brain. The core host
// (src/core/host.js, voice.host = "agent") keeps the room, the ears, the floor gate, the speech queue,
// the kill switch, deadlines and the empty room; it feeds this module events and executes its calls.
//
//   const c = createConductor({ state, agent, io, now, log, leadId, mentionsHost });
//   c.heard({who, text, t})          a final line (after stt_fixes, her echo filtered, speaker attributed)
//   c.herLine({text, cut, kind, t})  her line ended (completed, or cut by a barge-in)
//   c.interrupted({text}) · c.chorus({who}) · c.joined(id) · c.left(id) · c.timer(name)
//   c.tick(t)                        every host tick: the silence ladder, re-wakes
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
// speaker never spoke in the turn — no ack, marked skipped); drop(epoch) -> n
// (her lines still waiting with an older epoch); roomSpeaking() · hostBusy() · canSpeak() · quiet(); alert(text).
// `how` (src/core/addressing.js mayAnswer): was one of the lines she answers addressed to her ('name' = by name).

import { mayAnswer } from '../core/addressing.js';
import { violation } from './invariants.js';

/** Silence ladder (docs/agent_plan.md): when silence wakes the agent, ms from max(people's speech end, her line end). */
export const SILENCE_LADDER = Object.freeze({ round: Object.freeze([1000, 2500, 6000]), open_floor: Object.freeze([2500, 6000]) });
/** After the last stage of the ladder: another wake every SILENCE_REPEAT_MS, at most SILENCE_REPEATS times. */
export const SILENCE_REPEAT_MS = 10_000;
export const SILENCE_REPEATS = 3;
export const ASK_DONE_MIN_SILENCE_MS = 2500;
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
const ACTIVE = { waiting: 'waiting', starting: 'waiting', round: 'round', open_floor: 'open_floor' };
/** «повтори», «не расслышал»: saying her line again is what they asked for. */
const REPEAT_ASK_RE = /повтор|ещё раз|еще раз|не расслыш|не услыш|не понял/iu;

const fold = (s) =>
  String(s ?? '')
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
  let stuck = false; // the same call refused twice in a row: no silence wakes until someone speaks (live 28.09: 25 identical refusals)
  let lastHumanAt = -Infinity;
  let lastHerEndAt = -Infinity;
  let lastHerKind = null;
  let lastBusyAt = -Infinity;
  let askedDoneFor = null;
  let spokeIn = null; // the speaker who has said something since getting the word (ask_done needs it)
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

  function bump(why) {
    epoch++;
    let n = 0;
    try {
      n = io.drop?.(epoch) ?? 0;
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
    if (state.current && (who === state.current || who === '?')) {
      askedDoneFor = null;
      spokeIn = state.current;
    }
    stuck = false;
    if (letters(s) < 2) return; // «а», «м»: in the dialog, not worth a wake
    bump('heard');
    wake('heard');
  }

  function herLine({ text, cut = false, kind = null, t = now() }) {
    const s = String(text ?? '').trim();
    if (!s) return;
    remember({ who: 'host', text: s, cut: Boolean(cut), t });
    push({ type: 'her_line_done', text: s, ...(cut ? { cut: true } : {}) });
    lastHerEndAt = Math.max(lastHerEndAt, t);
    lastHerKind = kind;
    if (kind === 'check_done' && !cut) askedDoneFor = state.current;
    if (!cut && (kind === 'agent_say' || kind === 'start' || kind === 'handoff') && lastAddressed && lastAddressed.t <= t) lastAddressed = null; // answered
    resetLadder(t);
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
    bump('left'); // a handoff to someone who just left must not play
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
    if (io.roomSpeaking?.() || io.hostBusy?.()) {
      lastBusyAt = t;
      resetLadder(t);
      return;
    }
    if (inflight || stuck) return;
    if (rewake && pending.length) {
      const why = rewake;
      rewake = null;
      return wake(why);
    }
    const stages = SILENCE_LADDER[phase()];
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
    } else if (ladder.fired >= stages.length && ladder.repeats < SILENCE_REPEATS && ms >= stages.at(-1) + (ladder.repeats + 1) * SILENCE_REPEAT_MS) {
      ladder.repeats++;
      due = true;
    }
    if (!due) return;
    const after = lastHerEndAt >= lastHumanAt ? (lastHerKind === 'check_done' ? 'ask_done' : 'host') : 'speech';
    push({ type: 'silence', ms: Math.round(ms / 100) * 100, after });
    wake('silence');
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
    if (!agent || !phase() || !state.presentIds().length || io.quiet?.()) return;
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
    ev('agent.error', { epoch: req.epoch, reason: req.reason, message: String(e?.message ?? e).slice(0, 300) });
  }

  function decided(req, out) {
    if (inflight !== req) return;
    inflight = null;
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
    });
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
    if (a.action === 'ask_done') return sit.speaker ? { speaker: sit.speaker } : { hint: 'круг не начат: сначала give_word' };
    if (a.action === 'leave' || a.action === 'open_floor') return sit.queue.length ? { queue: sit.queue } : {};
    return {};
  }

  function reject(a, why, sit = situation()) {
    stats.rejected++;
    ev('agent.rejected', { tool: a.action, reason: why, ...(a.person ? { person: a.person } : {}), ...(a.text ? { text: a.text } : {}) });
    push({ type: 'rejected', tool: a.action === 'unknown' ? a.name : a.action, reason: why, ...(a.person ? { person: a.person } : {}), ...hintFor(a, why, sit) });
    const key = `${a.action}:${a.person ?? ''}:${why}`;
    if (key === lastRejectKey && !stuck) {
      stuck = true;
      ev('agent.stuck', { tool: a.action, reason: why, ...(a.person ? { person: a.person } : {}) });
    }
    lastRejectKey = key;
    // a refused turn action must not leave the round stuck in silence: one more wake, then the ladder
    if (TURN_TOOLS.has(a.action) && rejectWakes < 1 && !stuck) {
      rejectWakes++;
      rewake ??= 'rejected';
    }
  }

  /** Said to the end within SAY_REPEAT_MS, or most of its words were (live 28.09: «…когда будешь готов — скажи, начну» three times). */
  function saidLately(text, t) {
    const words = fold(text).split(' ').filter((w) => w.length >= 3);
    return dialog.some((l) => {
      if (l.who !== 'host' || l.cut || t - l.t > SAY_REPEAT_MS) return false;
      const bag = new Set(fold(l.text).split(' '));
      return words.length > 0 && words.filter((w) => bag.has(w)).length / words.length >= 0.7;
    });
  }

  /** A handoff text that names someone other than the one getting the word (live 28.09: give_word(Тима, «…Дальше, Глеб.»)). */
  function namesSomeoneElse(text, sit, person) {
    const ids = new Set([...sit.present, ...(state.people ?? []).map((p) => p.id)]);
    for (const id of ids) if (id !== person && id !== sit.speaker && id !== state.current && namesPerson(text, id)) return true;
    return false;
  }

  /** The host's own checks on top of invariants.violation(). */
  function hostCheck(a, sit, ctx) {
    const t = now();
    if (TURN_TOOLS.has(a.action) && ctx.turnDone) return 'one_turn_action_per_decision';
    switch (a.action) {
      case 'say':
        if (!a.text) return 'empty_text';
        if (ctx.said) return 'one_say_per_decision';
        if ((sit.phase === 'waiting' || sit.phase === 'round') && sit.present.length >= 3 && !ctx.how) return 'not_addressed';
        if (!ctx.how && t - lastUnsolicitedAt < (sit.phase === 'open_floor' ? UNSOLICITED_OPEN_FLOOR_MS : UNSOLICITED_EVERY_MS)) return 'too_often';
        if (!ctx.repeatAsked && saidLately(a.text, t)) return 'repeat';
        return null;
      case 'give_word':
        if (state.get(a.person)?.status === 'spoke') return 'already_spoke';
        if (a.text && namesSomeoneElse(a.text, sit, a.person)) return 'text_names_someone_else';
        return null;
      case 'ask_done':
        if (spokeIn !== a.person) return 'not_started'; // «Глеб, всё?» to someone who has not said a word yet
        if (askedDoneFor === a.person) return 'already_asked';
        if (t - Math.max(lastHumanAt, lastHerEndAt) < ASK_DONE_MIN_SILENCE_MS) return 'too_early';
        return null;
      default:
        return null;
    }
  }

  function execute(actions, used) {
    const sit = situation();
    const hows = used.map((p) => p.how).filter(Boolean);
    // by name anywhere: the answer may not wait; a question whose answer was dropped (a newer line) is still hers
    const kept = lastAddressed && now() - lastAddressed.t <= ADDRESSED_KEEP_MS ? lastAddressed.how : null;
    const how = hows.includes('name') ? 'name' : (hows.at(-1) ?? kept);
    const lastHeard = used.filter((p) => p.e.type === 'heard').at(-1)?.e.text ?? '';
    const ctx = { turnDone: false, said: false, how, repeatAsked: REPEAT_ASK_RE.test(lastHeard) };
    let accepted = 0;
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
      const leadAsked = a.action === 'give_word' && sit.phase === 'waiting' && used.some((p) => p.e.type === 'heard' && p.e.who === leadId && namesPerson(p.e.text, a.person));
      const why = violation(a, sit, { leadId: leadAsked ? null : leadId, askedByName: ctx.how === 'name' }) ?? hostCheck(a, sit, ctx);
      if (why) {
        reject(a, why, sit);
        continue;
      }
      const r = run(a, sit, ctx) ?? { ok: true };
      if (!r.ok) reject(a, r.reason ?? 'refused', sit);
      else accepted++;
    }
    if (accepted) {
      rejectWakes = 0;
      lastRejectKey = null;
    }
  }

  /** Does a line name this person (short name or first name, any ending)? */
  function namesPerson(text, id) {
    const words = fold(text).split(' ');
    const forms = [state.vocative?.(id), String(state.displayName?.(id) ?? '').split(/\s+/)[0]].map((x) => fold(x)).filter((x) => x.length >= 3);
    return forms.some((f) => words.some((w) => w.startsWith(f.slice(0, Math.max(3, f.length - 1)))));
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
    interrupted,
    chorus,
    joined,
    left,
    timer,
    tick,
    input,
    situation,
    stats: () => ({ ...stats, epoch, inflight: Boolean(inflight), pending: pending.length }),
    get epoch() {
      return epoch;
    },
    get busy() {
      return Boolean(inflight);
    },
    close() {
      inflight?.controller.abort();
      inflight = null;
    },
  };
}
