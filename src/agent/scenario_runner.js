// Runs conversation scenarios (src/agent/scenarios.js) through any `decide(input) -> {actions}`.
//
//   const report = await runScenarios(SCENARIOS, decide, { rounds: 1 });
//   report = {results: [{id, ok, steps: [{i, ok, level, kind, actions, why, ms}]}], must: {ok, total}, soft: {ok, total}, violations}
//
// Every action is also checked against src/agent/invariants.js (the same list the host enforces);
// a violation or a forbidden action fails the step and is counted in `violations`.
// Teacher forcing: the conversation follows the script, not the agent's answers — her lines come
// from her_line_done events, state changes from `state` events — so every step is checked in the
// situation the scenario describes, whatever the agent said one step earlier.

/** Apply one scripted event to the running situation. */
export function applyEvent(sit, e) {
  switch (e.type) {
    case 'heard':
      sit.dialog.push({ who: e.who ?? '?', text: e.text });
      break;
    case 'her_line_done':
      sit.dialog.push({ who: 'host', text: e.text, ...(e.cut ? { cut: true } : {}) });
      break;
    case 'joined':
      if (!sit.present.includes(e.who)) sit.present.push(e.who);
      break;
    case 'left':
      sit.present = sit.present.filter((id) => id !== e.who);
      break;
    case 'state':
      for (const k of ['phase', 'speaker', 'queue']) if (k in e) sit[k] = e[k];
      break;
    default:
      break;
  }
}

/** The agent's input after a step's events (names: id -> short name, as the host gives them). */
export function inputOf(sit, events, { names = null, leadId = null } = {}) {
  return {
    phase: sit.phase,
    speaker: sit.speaker ?? null,
    queue: [...(sit.queue ?? [])],
    present: [...sit.present],
    ...(names ? { names: Object.fromEntries(sit.present.map((id) => [id, names[id] ?? id])) } : {}),
    ...(leadId && sit.present.includes(leadId) ? { lead: leadId } : {}),
    dialog: sit.dialog.map((l) => ({ ...l })),
    events: events.filter((e) => e.type !== 'state').map((e) => ({ ...e })),
  };
}

const list = (v) => (v == null ? null : Array.isArray(v) ? v : [v]);

/** Does one action satisfy a matcher? */
export function matches(action, m) {
  if (!list(m.action).includes(action.action)) return false;
  if (m.person != null && !list(m.person).includes(action.person)) return false;
  if (m.text && !m.text.test(action.text ?? '')) return false;
  if (m.notText && m.notText.test(action.text ?? '')) return false;
  return true;
}

import { mentionsHost } from '../core/guards.js';
import { violation } from './invariants.js';

/** Actions that count as saying nothing. */
const quiet = (actions) => actions.every((a) => a.action === 'skip');

/**
 * Check one step's actions: invariants (with a situation), forbidden actions, then the expectation.
 * @param {object} step
 * @param {object[]} actions
 * @param {object} [sit]  {phase, speaker, queue, present} at decision time; enables the invariants
 * @param {{leadId?: string|null}} [opts]
 * @returns {{ok: boolean, why: string|null, kind: 'ok'|'violation'|'forbidden'|'expect'}}
 */
export function checkStep(step, actions, sit = null, { leadId = null } = {}) {
  const acts = (actions ?? []).filter((a) => a && a.action);
  const askedByName = (step.events ?? []).some((e) => e.type === 'heard' && mentionsHost(e.text));
  if (sit) {
    for (const a of acts) {
      const why = violation(a, sit, { leadId, askedByName });
      if (why) return { ok: false, kind: 'violation', why: `invariant ${why}: ${describe(a)}` };
    }
  }
  for (const m of step.forbid ?? []) {
    const hit = acts.find((a) => matches(a, m));
    if (hit) return { ok: false, kind: 'forbidden', why: `forbidden ${describe(hit)}` };
  }
  if (acts.some((a) => a.action === 'none' || a.action === 'unknown')) {
    const bad = acts.find((a) => a.action === 'none' || a.action === 'unknown');
    return { ok: false, kind: 'expect', why: bad.action === 'none' ? `text instead of a tool call: «${bad.text}»` : `unknown tool ${bad.name}` };
  }
  for (const alt of step.expect ?? []) {
    if (alt.length === 0) {
      if (quiet(acts)) return { ok: true, kind: 'ok', why: null };
      continue;
    }
    if (alt.every((m) => acts.some((a) => matches(a, m)))) return { ok: true, kind: 'ok', why: null };
  }
  const wanted = (step.expect ?? []).map((alt) => (alt.length ? alt.map(describeMatcher).join(' + ') : 'silence')).join(' | ');
  return { ok: false, kind: 'expect', why: `got ${acts.length ? acts.map(describe).join(' + ') : 'nothing'}; expected ${wanted}` };
}

/**
 * @param {object[]} scenarios
 * @param {(input: object) => Promise<{actions: object[], timings?: object}>} decide
 * @param {{rounds?: number, only?: string[], onStep?: Function, now?: () => number}} [opts]
 */
export async function runScenarios(scenarios, decide, { rounds = 1, only = null, onStep = null, leadId = null, names = null, now = () => performance.now() } = {}) {
  const results = [];
  for (let r = 0; r < rounds; r++) {
    for (const sc of scenarios) {
      if (only && !only.includes(sc.id)) continue;
      const sit = {
        phase: sc.state.phase,
        speaker: sc.state.speaker ?? null,
        queue: [...(sc.state.queue ?? [])],
        present: [...(sc.state.present ?? [])],
        dialog: (sc.dialog ?? []).map((l) => ({ ...l })),
      };
      const steps = [];
      for (const [i, step] of sc.steps.entries()) {
        for (const e of step.events) applyEvent(sit, e);
        const input = inputOf(sit, step.events, { names: { ...(names ?? {}), ...(sc.names ?? {}) }, leadId });
        const t0 = now();
        let actions = [];
        let timings = null;
        let error = null;
        try {
          const out = await decide(input, { scenario: sc, step, index: i });
          actions = out?.actions ?? [];
          timings = out?.timings ?? null;
        } catch (e) {
          error = String(e?.message ?? e).slice(0, 300);
        }
        const level = step.level ?? sc.level ?? 'must';
        const verdict = error ? { ok: false, kind: 'error', why: `error: ${error}` } : checkStep(step, actions, input, { leadId });
        const rec = { i, ok: verdict.ok, level, kind: verdict.kind, actions, why: verdict.why, ms: Math.round(now() - t0), timings };
        steps.push(rec);
        onStep?.(sc, rec);
      }
      results.push({ id: sc.id, round: r, title: sc.title, source: sc.source, ok: steps.every((s) => s.ok || s.level === 'soft'), steps });
    }
  }
  const all = results.flatMap((x) => x.steps);
  const must = all.filter((s) => s.level !== 'soft');
  const soft = all.filter((s) => s.level === 'soft');
  return {
    results,
    must: { ok: must.filter((s) => s.ok).length, total: must.length },
    soft: { ok: soft.filter((s) => s.ok).length, total: soft.length },
    violations: all.filter((s) => s.kind === 'violation' || s.kind === 'forbidden').length,
  };
}

export function describe(a) {
  const bits = [a.person, a.text ? `«${a.text}»` : null, a.name].filter(Boolean);
  return `${a.action}${bits.length ? `(${bits.join(', ')})` : ''}`;
}

function describeMatcher(m) {
  const bits = [m.person ? list(m.person).join('/') : null, m.text ? `~${m.text}` : null, m.notText ? `!~${m.notText}` : null].filter(Boolean);
  return `${list(m.action).join('/')}${bits.length ? `(${bits.join(', ')})` : ''}`;
}
