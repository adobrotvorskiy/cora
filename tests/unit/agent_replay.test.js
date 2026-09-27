// Log replay (src/agent/replay.js, docs/agent_plan.md step 4) on a synthetic log of the fictional team:
// the timeline, forced and free replay through the conductor with a scripted agent, the scenario draft.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { SCENARIO_LEAD, SCENARIO_ROSTER } from '../../src/agent/scenarios.js';
import { parseLog, replayTimeline, timelineOf, toScenarioDraft } from '../../src/agent/replay.js';
import { loadRoster } from '../../src/core/state.js';

const ROSTER = loadRoster({ path: join(import.meta.dirname, '..', 'fixtures', 'people_test.json') });
const T0 = Date.parse('2026-09-27T12:00:00.000Z');
const rec = (s, type, f = {}) => JSON.stringify({ ts: new Date(T0 + s * 1000).toISOString(), t_msk: '15:00:00.000', type, ...f });

/** Two people, a greeting, the start, one update with «у меня всё», then everyone leaves. */
const LOG = [
  rec(0, 'host.start', { url: 'x' }),
  rec(1, 'presence.joined', { who: 'tkach_t', name: 'Тимур Ткач', known: true }),
  rec(1.2, 'presence.joined', { who: 'nevsky_g', name: 'Глеб Невский', known: true }),
  rec(5, 'transcript', { who: 'tkach_t', text: 'Кора привет' }),
  rec(6.5, 'speech.start', { kind: 'speak', text: 'Привет, Тима!' }),
  rec(7.5, 'speech.end', { status: 'completed', kind: 'speak', text: 'Привет, Тима!' }),
  rec(10, 'transcript', { who: 'nevsky_g', text: 'Кора начинай' }),
  rec(11.5, 'speech.start', { kind: 'start', text: 'Доброе утро! Тима, начнёшь?' }),
  rec(13, 'speech.end', { status: 'completed', kind: 'start', text: 'Доброе утро! Тима, начнёшь?' }),
  rec(13, 'turn.start', { who: 'tkach_t' }),
  rec(18, 'transcript', { who: 'tkach_t', text: 'сегодня делаю интеграцию' }),
  rec(18.4, 'transcript', { who: 'tkach_t', text: 'потом ревью' }),
  rec(25, 'transcript', { who: 'tkach_t', text: 'у меня всё' }),
  'not json {',
  rec(40, 'presence.left', { who: 'tkach_t' }),
  rec(41, 'presence.left', { who: 'nevsky_g' }),
  rec(60, 'host.finish', { reason: 'empty_room' }),
].join('\n');

/** Scripted agent: answers greetings, starts on «начинай», hands over on «у меня всё». */
function scripted({ latency = 1000 } = {}) {
  const calls = [];
  return {
    calls,
    async decide(input) {
      calls.push(input);
      const last = input.events.filter((e) => e.type === 'heard').at(-1)?.text ?? '';
      let actions = [{ action: 'skip' }];
      if (/привет/.test(last)) actions = [{ action: 'say', text: 'Привет, Тима!' }];
      else if (/начинай/.test(last)) actions = [{ action: 'give_word', person: 'tkach_t', text: 'Доброе утро! Тима, начнёшь?' }];
      else if (/у меня всё/.test(last) && input.speaker) actions = [{ action: 'give_word', person: input.queue[0] ?? 'nevsky_g', text: '' }];
      return { actions, timings: { done: latency }, usage: { prompt_tokens: 1000, completion_tokens: 20 } };
    },
  };
}

describe('replay: the timeline of a log', () => {
  test('people, her lines, turns and the end; a torn line is skipped', () => {
    const tl = timelineOf(parseLog(LOG));
    assert.deepEqual(
      tl.events.map((e) => [e.at, e.type]),
      [
        [1000, 'joined'],
        [1200, 'joined'],
        [5000, 'heard'],
        [6500, 'her_start'],
        [7500, 'her'],
        [10000, 'heard'],
        [11500, 'her_start'],
        [13000, 'her'],
        [13000, 'turn'],
        [18000, 'heard'],
        [18400, 'heard'],
        [25000, 'heard'],
        [40000, 'left'],
        [41000, 'left'],
        [60000, 'end'],
      ],
    );
    assert.deepEqual(tl.names, { tkach_t: 'Тимур Ткач', nevsky_g: 'Глеб Невский' });
    assert.equal(tl.duration, 60_000);
  });
});

describe('replay: through the conductor', () => {
  test('forced: her original lines play, the agent is asked at every line and silence stage; its calls are recorded', async () => {
    const agent = scripted();
    const r = await replayTimeline(timelineOf(parseLog(LOG)), { agent, roster: ROSTER, mode: 'forced', tailMs: 3000 });
    assert.deepEqual(r.summary.rejected, {});
    assert.ok(r.summary.wake_reasons.heard >= 4 && r.summary.wake_reasons.silence >= 1, JSON.stringify(r.summary.wake_reasons));
    assert.deepEqual(
      r.calls.map((c) => [c.tool, c.person ?? null]),
      [
        ['say', null],
        ['startRound', 'tkach_t'],
        ['giveWord', 'nevsky_g'],
      ],
    );
    // her original «Привет, Тима!» is in the dialog the agent sees next
    const afterGreeting = agent.calls.find((i) => i.events.some((e) => e.type === 'heard' && /начинай/.test(e.text)));
    assert.ok(afterGreeting.dialog.some((l) => l.who === 'host' && l.text === 'Привет, Тима!'));
    // two lines 400 ms apart with a 1 s decision: the first request was aborted by the second
    assert.equal(r.summary.aborted, 1);
    assert.equal(r.summary.lines_to_empty_room, 0);
    assert.equal(r.summary.tokens, r.summary.decisions * 1020);
  });

  test('free: the agent drives the state and her lines; nothing to the empty room at the end', async () => {
    const agent = scripted({ latency: 800 });
    const r = await replayTimeline(timelineOf(parseLog(LOG)), { agent, roster: ROSTER, mode: 'free', tailMs: 20_000 });
    assert.deepEqual(
      r.lines.map((l) => l.kind),
      ['agent_say', 'start', 'handoff'],
    );
    assert.ok(r.lines[0].at >= 5000 + 800, 'the answer comes after the decision latency');
    assert.equal(r.summary.lines_to_empty_room, 0);
    const lastWake = r.events.filter((e) => e.type === 'agent.wake').at(-1);
    assert.ok(lastWake.at < 41_000, 'no wakes after everyone left');
  });
});

describe('replay: a scenario draft from a log', () => {
  const REAL = {
    firstAlways: 'boss',
    people: [
      { id: 'boss', display: 'Пётр Громов', vocative: 'Петя', aliases: ['Пётр Громов', 'Петр Громов'] },
      { id: 'dev', display: 'Анна Лесная', vocative: 'Аня', aliases: ['Анна Лесная'] },
    ],
  };
  const tl = {
    events: [
      { at: 0, type: 'joined', who: 'dev', name: 'Анна Лесная' },
      { at: 100, type: 'joined', who: 'boss', name: 'Пётр Громов' },
      { at: 5000, type: 'turn', who: 'dev' },
      { at: 9000, type: 'heard', who: 'dev', text: 'сегодня ревью у Пети' },
      { at: 12_000, type: 'heard', who: 'dev', text: 'у меня всё' },
      { at: 14_000, type: 'her', text: 'Спасибо, Аня! Дальше Петя.', cut: false },
      { at: 15_000, type: 'heard', who: 'boss', text: 'Анна а по срокам что' },
    ],
  };

  test('people mapped to the fictional team (the lead to the lead), names in the texts replaced, steps cut at her lines', () => {
    const d = toScenarioDraft(tl, { from: 6000, roster: REAL, fake: SCENARIO_ROSTER, fakeLead: SCENARIO_LEAD, id: 'draft' });
    assert.deepEqual(d.state, { phase: 'round', speaker: 'nevsky_g', queue: [], present: ['nevsky_g', 'orlov_y'] });
    const all = JSON.stringify(d);
    for (const real of ['Пётр', 'Петр', 'Пет', 'пет', 'Громов', 'Анн', 'Аня', 'Лесная', 'boss', '"dev"']) assert.ok(!all.includes(real), `${real} left in the draft: ${all}`);
    assert.equal(d.steps.length, 2);
    assert.deepEqual(d.steps[0].events.map((e) => e.type), ['heard', 'silence', 'heard', 'silence'], 'the silence before her line is the moment of the decision');
    assert.equal(d.steps[0].was, 'Спасибо, Глеб! Дальше Слава.');
    assert.deepEqual(d.steps[1].events.map((e) => e.type), ['her_line_done', 'silence', 'heard']);
    assert.equal(d.steps[1].events[2].text, 'Глеб а по срокам что');
  });

  test('a replaced name is not replaced again when a fictional name equals a real one', () => {
    const same = { events: [
      { at: 0, type: 'joined', who: 'tkach_t', name: 'Тимур Ткач' },
      { at: 0, type: 'joined', who: 'nevsky_g', name: 'Глеб Невский' },
      { at: 1000, type: 'heard', who: 'tkach_t', text: 'у меня всё передаю Глебу' },
    ] };
    const d = toScenarioDraft(same, { roster: ROSTER, fake: SCENARIO_ROSTER, fakeLead: SCENARIO_LEAD });
    // tkach_t -> nevsky_g (first seen), so the real Gleb becomes the fictional tkach_t («Тима»), once
    assert.deepEqual(d.steps[0].events.find((e) => e.type === 'heard'), { type: 'heard', who: 'nevsky_g', text: 'у меня всё передаю Тима' });
  });
});
