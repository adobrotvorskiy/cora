// Log replay for the agent (docs/agent_plan.md, step 4): a host log (logs/*.jsonl) becomes a timeline
// of what people said and did; the timeline goes through the conductor (src/agent/conductor.js) on a
// virtual clock with any agent — the real one (tools/replay_log.js) or a scripted one (tests).
//
//   const tl = timelineOf(parseLog(text));
//   const report = await replayTimeline(tl, { agent, roster, mode: 'forced' });
//
// mode 'forced' (teacher forcing): people's lines AND her original lines play at their times; the
//   phase and the speaker follow the log (turn.start, round.open_floor_asked, round.closing). The
//   agent's calls are only checked and recorded: what would she have decided at each point.
// mode 'free': her original lines are dropped; the agent's calls change the state and her lines
//   «play» for a length estimated from the text. People's lines keep their times, so the talk may
//   stop making sense — it still shows lines to an empty room, interruptions, repeats.
// Time: while a real request is in flight the virtual clock waits for it, then the decision lands at
// wake + latency (measured, or a fixed latencyMs) — so aborts by newer lines happen as they would live.
//
// toScenarioDraft(): a window of the timeline as a draft for src/agent/scenarios.js, with the people
// mapped to the fictional team (ids and names in texts). The draft needs expectations written by hand
// and a check for real data before it goes to git.

import { mentionsHost } from '../core/guards.js';
import { createState } from '../core/state.js';
import { createConductor } from './conductor.js';

const HER_KINDS_CUT = new Set(['speech.abort']);
const MS_PER_CHAR = 65; // her speech ~15 chars/s at speed 1.1
const TTFA_MS = 300;

/** jsonl text -> records (bad lines skipped). */
export function parseLog(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r.type === 'string') out.push(r);
    } catch {
      // a torn last line of a crashed run
    }
  }
  return out;
}

/**
 * Records -> {events: [{at, type, ...}], duration, names: {id: telemost name}}; `at` in ms from the first record.
 * types: joined {who, name} · left {who} · heard {who, text, t0?} · her_start {text, kind} · her {text, cut, kind}
 *        · turn {who} · open_floor · closing · end {reason}
 */
export function timelineOf(records) {
  const ts = (r) => Date.parse(r.ts);
  const first = records.find((r) => Number.isFinite(ts(r)));
  const base = first ? ts(first) : 0;
  const events = [];
  const names = {};
  for (const r of records) {
    const at = Number.isFinite(ts(r)) ? ts(r) - base : null;
    if (at === null) continue;
    switch (r.type) {
      case 'presence.joined':
        if (r.name) names[r.who] = r.name;
        events.push({ at, type: 'joined', who: r.who, name: r.name ?? null });
        break;
      case 'presence.left':
        events.push({ at, type: 'left', who: r.who });
        break;
      case 'transcript':
        if (r.text && r.who !== 'host') events.push({ at, type: 'heard', who: r.who ?? '?', text: r.text, ...(Number.isFinite(r.t0) && Number.isFinite(r.t1) ? { speech_ms: r.t1 - r.t0 } : {}) });
        break;
      case 'speech.start':
        events.push({ at, type: 'her_start', text: r.text ?? '', kind: r.kind ?? null });
        break;
      case 'speech.end':
      case 'speech.abort':
        if (r.text && (r.status === 'completed' || r.status === 'aborted' || HER_KINDS_CUT.has(r.type))) events.push({ at, type: 'her', text: r.text, cut: r.status === 'aborted' || r.type === 'speech.abort', kind: r.kind ?? null });
        break;
      case 'speech.shadow':
        if (r.text) events.push({ at, type: 'her', text: r.text, cut: false, kind: r.kind ?? null });
        break;
      case 'turn.start':
        events.push({ at, type: 'turn', who: r.who });
        break;
      case 'round.open_floor_asked':
        events.push({ at, type: 'open_floor' });
        break;
      case 'round.closing':
        events.push({ at, type: 'closing' });
        break;
      case 'host.finish':
        events.push({ at, type: 'end', reason: r.reason ?? null });
        break;
      default:
        break;
    }
  }
  return { events, duration: events.at(-1)?.at ?? 0, names };
}

const speechMs = (text) => Math.max(600, String(text ?? '').length * MS_PER_CHAR);

/**
 * @param {{events: object[], duration: number, names: object}} tl
 * @param {object} o
 * @param {{decide: Function}} o.agent
 * @param {object} o.roster        loadRoster()
 * @param {'forced'|'free'} [o.mode]
 * @param {number|null} [o.latencyMs]  fixed decision latency; default: the agent's measured timings.done (else 1200)
 * @param {number} [o.tickMs]
 * @param {number} [o.tailMs]     keep the clock running after the last event
 * @param {object} [o.conductor]  extra options for createConductor (budget...)
 * @param {(e: object) => void} [o.onEvent]  every agent.* log event, with its virtual time `at`
 */
export async function replayTimeline(tl, { agent, roster, mode = 'forced', latencyMs = null, tickMs = 100, tailMs = 15_000, conductor: extra = {}, onEvent = null } = {}) {
  const clock = { t: 0 };
  const now = () => clock.t;
  const state = createState({ roster, now });
  const events = [];
  const log = {
    event: (type, f = {}) => {
      const e = { at: clock.t, type, ...f };
      events.push(e);
      onEvent?.(e);
    },
  };
  const names = new Map(Object.entries(tl.names ?? {}));
  const present = new Set();
  const people = tl.events.filter((e) => e.type === 'heard');
  // speech intervals: a final at `at` closes speech that started speech_ms (or a length estimate) earlier
  const spans = people.map((e) => [e.at - (e.speech_ms ?? speechMs(e.text)), e.at]);
  const her = { busyUntil: -1, lines: [], calls: [] };

  const inflight = [];
  const wrapped = {
    decide(input, { signal } = {}) {
      const d = { started: clock.t, due: null, out: null, err: null, aborted: false };
      d.real = Promise.resolve()
        .then(() => agent.decide(input, { signal }))
        .then(
          (out) => {
            d.out = out;
            d.due = d.started + (latencyMs ?? out?.timings?.done ?? 1200);
          },
          (e) => {
            d.err = e;
            d.due = clock.t;
          },
        );
      inflight.push(d);
      return new Promise((resolve, reject) => {
        d.resolve = resolve;
        d.reject = reject;
        signal?.addEventListener('abort', () => {
          d.aborted = true;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    },
  };

  const playHer = (text, kind) => {
    const start = Math.max(clock.t, her.busyUntil) + TTFA_MS;
    her.busyUntil = start + speechMs(text);
    her.lines.push({ at: start, end: her.busyUntil, text, kind, present: state.presentIds().length });
  };
  const vocative = (id) => state.vocative(id);
  const record = (tool, o) => {
    her.calls.push({ at: clock.t, tool, ...o });
    return { ok: true };
  };
  const io =
    mode === 'free'
      ? {
          say: (o) => (record('say', o), playHer(o.text, 'agent_say'), { ok: true }),
          startRound: (o) => {
            record('startRound', o);
            playHer(o.text || `Доброе утро! ${vocative(o.person)}, начнёшь?`, 'start');
            state.setPhase('round');
            state.giveWord(o.person);
            return { ok: true };
          },
          giveWord: (o) => {
            record('giveWord', o);
            const prev = state.current;
            playHer(o.text || `${prev ? `Спасибо, ${vocative(prev)}! ` : ''}Дальше ${vocative(o.person)}.`, 'handoff');
            if (state.phase === 'open_floor') state.setPhase('round');
            state.giveWord(o.person);
            return { ok: true };
          },
          askDone: (o) => (record('askDone', o), playHer(`${vocative(o.person)}, всё?`, 'check_done'), { ok: true }),
          openFloor: (o) => {
            record('openFloor', o);
            playHer('Все высказались. Кто хочет что-то добавить или спросить?', 'open_floor');
            state.finishTurn();
            state.setPhase('open_floor');
            return { ok: true };
          },
          leave: (o) => {
            record('leave', o);
            playHer(o.text || 'Всем хорошего дня!', 'closing');
            state.setPhase('closing');
            return { ok: true };
          },
        }
      : {
          say: (o) => record('say', o),
          startRound: (o) => record('startRound', o),
          giveWord: (o) => record('giveWord', o),
          askDone: (o) => record('askDone', o),
          openFloor: (o) => record('openFloor', o),
          leave: (o) => record('leave', o),
        };
  const c = createConductor({
    state,
    agent: wrapped,
    io: {
      ...io,
      drop: () => 0,
      roomSpeaking: () => spans.some(([a, b]) => clock.t >= a && clock.t < b),
      hostBusy: () => clock.t < her.busyUntil,
      canSpeak: () => !spans.some(([a, b]) => clock.t >= a && clock.t < b),
      quiet: () => false,
      alert: () => {},
    },
    now,
    log,
    leadId: roster?.firstAlways ?? null,
    mentionsHost,
    ...extra,
  });

  const applyPresence = () => state.applyParticipants([...present].map((id) => ({ name: names.get(id) ?? id })), { t: clock.t });
  const flush = () => new Promise((r) => setImmediate(r));
  let i = 0;
  let herLinePending = []; // free mode: her lines whose end is due
  const end = tl.duration + tailMs;
  while (clock.t <= end) {
    while (i < tl.events.length && tl.events[i].at <= clock.t) {
      const e = tl.events[i++];
      switch (e.type) {
        case 'joined':
          if (e.name) names.set(e.who, e.name);
          present.add(e.who);
          for (const id of applyPresence().joined) c.joined(id);
          break;
        case 'left':
          present.delete(e.who);
          for (const id of applyPresence().left) c.left(id);
          break;
        case 'heard':
          c.heard({ who: state.get(e.who) ? e.who : (state.idForName(names.get(e.who) ?? '') ?? '?'), text: e.text, t: clock.t });
          break;
        case 'her_start':
          if (mode === 'forced') her.busyUntil = Infinity;
          break;
        case 'her':
          if (mode === 'forced') {
            her.busyUntil = clock.t;
            her.lines.push({ at: clock.t, end: clock.t, text: e.text, kind: e.kind, original: true });
            c.herLine({ text: e.text, cut: e.cut, kind: e.kind, t: clock.t });
          }
          break;
        case 'turn':
          if (mode === 'forced' && state.get(e.who)) {
            if (state.phase !== 'round') state.setPhase('round');
            state.giveWord(e.who);
          }
          break;
        case 'open_floor':
          if (mode === 'forced') {
            state.finishTurn();
            state.setPhase('open_floor');
          }
          break;
        case 'closing':
          if (mode === 'forced') state.setPhase('closing');
          break;
        default:
          break;
      }
    }
    if (mode === 'free') {
      for (const l of her.lines) {
        if (!l.done && l.end <= clock.t) {
          l.done = true;
          herLinePending.push(l);
        }
      }
      for (const l of herLinePending) c.herLine({ text: l.text, kind: l.kind, t: l.end });
      herLinePending = [];
      if (state.phase === 'closing' && clock.t >= her.busyUntil) break;
    }
    // decisions: the virtual clock waits for a real request, then lands it at its due time
    for (const d of [...inflight]) {
      if (d.aborted) {
        inflight.splice(inflight.indexOf(d), 1);
        continue;
      }
      if (!d.out && !d.err) await d.real;
      if (d.due <= clock.t) {
        inflight.splice(inflight.indexOf(d), 1);
        if (d.err) d.reject(d.err);
        else d.resolve(d.out);
        await flush();
      }
    }
    c.tick(clock.t);
    await flush();
    clock.t += tickMs;
  }
  c.close();
  return summarize(events, her, c.stats());
}

function summarize(events, her, stats) {
  const of = (type) => events.filter((e) => e.type === type);
  const count = (xs, key) => xs.reduce((m, x) => ((m[x[key]] = (m[x[key]] ?? 0) + 1), m), {});
  const decisions = of('agent.decision');
  const actions = decisions.flatMap((d) => d.actions.map((a) => a.action));
  const says = her.calls.filter((c) => c.tool === 'say');
  return {
    events,
    calls: her.calls,
    lines: her.lines,
    summary: {
      wakes: stats.wakes,
      wake_reasons: count(of('agent.wake'), 'reason'),
      decisions: stats.decisions,
      actions: actions.reduce((m, a) => ((m[a] = (m[a] ?? 0) + 1), m), {}),
      rejected: count(of('agent.rejected'), 'reason'),
      dropped: stats.dropped,
      aborted: stats.aborted,
      text_only: stats.text_only,
      says: says.length,
      says_unaddressed: says.filter((c) => !c.how).length,
      lines_to_empty_room: her.lines.filter((l) => !l.original && l.present === 0).length,
      tokens: stats.tokens_in + stats.tokens_out,
    },
  };
}

/** mm:ss of a virtual time. */
export const clockOf = (ms) => `${String(Math.floor(ms / 60_000)).padStart(2, '0')}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}`;

/**
 * A window of a timeline as a scenario draft on the fictional team: ids mapped in order of appearance
 * (the lead to `fakeLead`), every known name form in the texts replaced by the fictional vocative.
 * @param {{events: object[]}} tl
 * @param {{from?: number, to?: number, roster: object, fake: {id: string, vocative: string}[], fakeLead: string, id?: string}} o
 */
export function toScenarioDraft(tl, { from = 0, to = Infinity, roster, fake, fakeLead, id = 'from_log' }) {
  const real = new Map((roster?.people ?? []).map((p) => [p.id, p]));
  const map = new Map();
  const pool = fake.filter((f) => f.id !== fakeLead);
  const fakeOf = (who) => {
    if (!who || who === '?' || who === 'host') return who;
    if (!map.has(who)) {
      const f = who === roster?.firstAlways ? fake.find((x) => x.id === fakeLead) : pool.shift();
      map.set(who, f ?? { id: `guest_${map.size + 1}`, vocative: 'Гость' });
    }
    return map.get(who).id;
  };
  const strip = (s) => String(s ?? '').replace(/́/g, '');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const forms = [];
  for (const [rid, p] of real) {
    const words = [p.display, ...(p.aliases ?? []), p.spoken, p.vocative, p.vocative_gen, p.vocative_acc, p.surname_spoken].filter(Boolean).map(strip);
    for (const w of new Set(words.flatMap((x) => [x, ...x.split(/\s+/)]))) {
      if (w.length < 3) continue;
      // inflected forms too («у Пети», «Анной»): the stem plus a short ending; STT writes names in lower case
      const stem = w.includes(' ') ? esc(w) : w.length >= 4 ? `${esc(w.slice(0, -1))}\\p{L}{0,3}` : `${esc(w.slice(0, 2))}\\p{L}{1,2}`;
      forms.push({ rid, re: new RegExp(`(?<![\\p{L}])${stem}(?![\\p{L}])`, 'giu') });
    }
  }
  const vocOf = (rid) => {
    fakeOf(rid);
    return map.get(rid)?.vocative ?? 'коллега';
  };
  // one pass over the original text: a replaced name is never matched again (a fictional name may equal a real one)
  const scrub = (text) => {
    const src = strip(text);
    const hits = [];
    for (const f of forms) for (const m of src.matchAll(f.re)) hits.push({ start: m.index, end: m.index + m[0].length, rid: f.rid });
    hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
    let out = '';
    let pos = 0;
    for (const h of hits) {
      if (h.start < pos) continue;
      out += src.slice(pos, h.start) + vocOf(h.rid);
      pos = h.end;
    }
    return out + src.slice(pos);
  };
  const inWindow = tl.events.filter((e) => e.at >= from && e.at <= to);
  const before = tl.events.filter((e) => e.at < from);
  const presentAt = new Set();
  let phase = 'waiting';
  let speaker = null;
  for (const e of before) {
    if (e.type === 'joined') presentAt.add(e.who);
    if (e.type === 'left') presentAt.delete(e.who);
    if (e.type === 'turn') (phase = 'round'), (speaker = e.who);
    if (e.type === 'open_floor') (phase = 'open_floor'), (speaker = null);
  }
  const dialog = before
    .filter((e) => e.type === 'heard' || e.type === 'her')
    .slice(-6)
    .map((e) => (e.type === 'her' ? { who: 'host', text: scrub(e.text) } : { who: fakeOf(e.who), text: scrub(e.text) }));
  const steps = [];
  let evs = [];
  let lastAt = from;
  for (const e of inWindow) {
    const gap = e.at - lastAt;
    if (gap >= 1000 && evs.length) evs.push({ type: 'silence', ms: Math.round(gap / 500) * 500 });
    if (e.type === 'heard') evs.push({ type: 'heard', who: fakeOf(e.who), text: scrub(e.text) });
    else if (e.type === 'joined' || e.type === 'left') evs.push({ type: e.type, who: fakeOf(e.who) });
    else if (e.type === 'her') {
      // her line closes a step: what the old host said there is the reference, not the expectation
      if (evs.length) steps.push({ events: evs, expect: [], ideal: [], was: scrub(e.text) });
      evs = [{ type: 'her_line_done', text: scrub(e.text), ...(e.cut ? { cut: true } : {}) }];
    } else continue;
    lastAt = e.at;
  }
  if (evs.length) steps.push({ events: evs, expect: [], ideal: [] });
  return {
    id,
    title: 'TODO: что проверяем',
    source: 'log',
    state: { phase, speaker: fakeOf(speaker), queue: [], present: [...presentAt].map(fakeOf) },
    ...(dialog.length ? { dialog } : {}),
    steps,
  };
}
