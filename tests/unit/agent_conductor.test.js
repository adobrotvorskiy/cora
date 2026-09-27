// The agent's side of the host (src/agent/conductor.js, docs/agent_plan.md step 3): wakes, epoch and
// abort, the silence ladder, the executor with invariants + `rejected`, the output filter, the budget —
// and every scenario of src/agent/scenarios.js replayed through it with its ideal decisions.
// Fake clock, fake agent, fake host io; real state.js on the fictional team.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ASK_DONE_MIN_SILENCE_MS, MAX_PREEMPTS, SILENCE_REPEAT_MS, createConductor } from '../../src/agent/conductor.js';
import { SCENARIOS } from '../../src/agent/scenarios.js';
import { createState, loadRoster } from '../../src/core/state.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'people_test.json');
const ROSTER = loadRoster({ path: FIXTURE });
const DISPLAY = Object.fromEntries(ROSTER.people.map((p) => [p.id, p.display]));
const flush = () => new Promise((r) => setImmediate(r));
const mentionsHost = (t) => /(^|\s)кора(\s|$|,)/i.test(t);

/** An agent whose calls the test answers: calls[i] = {input, signal, answer(actions)}. */
function manualAgent() {
  const calls = [];
  return {
    calls,
    decide(input, { signal } = {}) {
      return new Promise((resolve, reject) => {
        const call = { input, signal, answered: false };
        call.answer = (actions, extra = {}) => {
          call.answered = true;
          resolve({ actions, ...extra });
        };
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        calls.push(call);
      });
    },
    open: () => calls.filter((c) => !c.answered && !c.signal.aborted),
  };
}

function makeWorld({ present, phase = 'waiting', speaker = null, queue = [], agent = manualAgent(), budget, dialog } = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const state = createState({ roster: ROSTER, now });
  state.applyParticipants(present.map((id) => ({ name: DISPLAY[id] })), { t: now() });
  if (phase !== 'waiting') {
    state.setPhase(phase);
    for (const id of present) if (id !== speaker && !queue.includes(id)) state.setStatus(id, 'spoke');
    if (speaker) state.giveWord(speaker);
    state.setPlan({ next: queue[0] ?? null, then: queue.slice(1) });
  }
  const events = [];
  const log = { event: (type, f = {}) => events.push({ type, ...f }) };
  const calls = [];
  const alerts = [];
  const io = {
    room: false,
    busy: false,
    quiet: false,
    queued: [], // {kind, epoch, dropped}
    say(o) {
      calls.push({ tool: 'say', ...o });
      io.queued.push({ kind: 'say', epoch: o.epoch });
      return { ok: true };
    },
    startRound(o) {
      calls.push({ tool: 'startRound', ...o });
      state.setPhase('round');
      state.giveWord(o.person);
      return { ok: true };
    },
    giveWord(o) {
      calls.push({ tool: 'giveWord', ...o });
      if (state.phase === 'open_floor') state.setPhase('round');
      state.giveWord(o.person);
      return { ok: true };
    },
    askDone(o) {
      calls.push({ tool: 'askDone', ...o });
      return { ok: true };
    },
    openFloor(o) {
      calls.push({ tool: 'openFloor', ...o });
      state.finishTurn();
      state.setPhase('open_floor');
      return { ok: true };
    },
    leave(o) {
      calls.push({ tool: 'leave', ...o });
      return { ok: true };
    },
    drop(epoch) {
      let n = 0;
      for (const q of io.queued) if (!q.dropped && q.epoch < epoch) (q.dropped = true), n++;
      return n;
    },
    roomSpeaking: () => io.room,
    hostBusy: () => io.busy,
    canSpeak: () => !io.room,
    alert: (t) => alerts.push(t),
  };
  // the conductor gets io with quiet() as a function; the flags stay on `io`
  const c = createConductor({ state, agent, io: { ...io, quiet: () => io.quiet }, now, log, leadId: ROSTER.firstAlways, mentionsHost, budget });
  const w = {
    c,
    state,
    agent,
    io,
    calls,
    alerts,
    events,
    clock,
    find: (type) => events.filter((e) => e.type === type),
    /** advance the clock in 100 ms steps, ticking; answered decisions land between the ticks */
    async wait(ms) {
      const end = clock.t + ms;
      while (clock.t < end) {
        await flush();
        clock.t = Math.min(end, clock.t + 100);
        c.tick(clock.t);
      }
      await flush();
    },
    heard(who, text) {
      c.heard({ who, text, t: clock.t });
    },
    her(text, o = {}) {
      c.herLine({ text, t: clock.t, ...o });
    },
    setPresent(ids) {
      const before = new Set(state.presentIds());
      const diff = state.applyParticipants(ids.map((id) => ({ name: DISPLAY[id] })), { t: clock.t });
      for (const id of diff.joined) c.joined(id);
      for (const id of diff.left) c.left(id);
      return { before, diff };
    },
  };
  if (dialog) c.seedDialog(dialog);
  return w;
}

describe('conductor: waking the agent', () => {
  test('a final line wakes the agent with the situation, the dialog (her lines as host) and the new events', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.her('Тима, всё?', { kind: 'check_done' });
    w.heard('tkach_t', 'нет подожди ещё одно');
    await flush();
    const [call] = w.agent.calls;
    assert.equal(w.agent.calls.length, 1);
    assert.deepEqual(
      { phase: call.input.phase, speaker: call.input.speaker, queue: call.input.queue, present: call.input.present },
      { phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'], present: ['orlov_y', 'nevsky_g', 'tkach_t'] },
    );
    assert.deepEqual(call.input.dialog, [
      { who: 'host', text: 'Тима, всё?' },
      { who: 'tkach_t', text: 'нет подожди ещё одно' },
    ]);
    assert.deepEqual(call.input.events.map((e) => e.type), ['her_line_done', 'heard']);
    call.answer([{ action: 'skip' }]);
    await flush();
    assert.equal(w.find('agent.decision').length, 1);
    w.heard('tkach_t', 'после обеда созвон');
    await flush();
    assert.deepEqual(w.agent.calls[1].input.events, [{ type: 'heard', who: 'tkach_t', text: 'после обеда созвон' }], 'decided events are not sent again');
  });

  test('«а», «м»: in the dialog, no wake', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.heard('?', 'а');
    await flush();
    assert.equal(w.agent.calls.length, 0);
    w.heard('tkach_t', 'сегодня тесты');
    await flush();
    assert.deepEqual(w.agent.calls[0].input.dialog.map((l) => l.text), ['а', 'сегодня тесты']);
  });

  test('no wakes in an empty room, while quiet («Кора, стоп»), or with no agent', async () => {
    const w = makeWorld({ present: ['tkach_t'], phase: 'open_floor' });
    w.setPresent([]);
    w.heard('?', 'кто-нибудь тут есть');
    await w.wait(20_000);
    assert.equal(w.agent.calls.length, 0);
    const q = makeWorld({ present: ['tkach_t'] });
    q.io.quiet = true;
    q.heard('tkach_t', 'Кора привет');
    await flush();
    assert.equal(q.agent.calls.length, 0);
  });

  test('timer start wakes the agent; joined alone does not', async () => {
    const w = makeWorld({ present: ['tkach_t'] });
    w.setPresent(['tkach_t', 'nevsky_g']);
    await w.wait(3000);
    assert.equal(w.agent.calls.length, 0);
    w.c.timer('start');
    await flush();
    assert.deepEqual(w.agent.calls[0].input.events.map((e) => e.type), ['joined', 'timer']);
  });
});

describe('conductor: epoch and abort', () => {
  test('a new line aborts the decision in flight; the next wake gets both lines', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'] });
    w.heard('tkach_t', 'Кора а ты');
    await flush();
    w.heard('tkach_t', 'нас слышишь');
    await flush();
    const [first, second] = w.agent.calls;
    assert.equal(first.signal.aborted, true);
    assert.deepEqual(second.input.events.map((e) => e.text), ['Кора а ты', 'нас слышишь']);
    assert.equal(w.find('agent.aborted').length, 1);
    second.answer([{ action: 'say', text: 'Да, слышу.' }]);
    await flush();
    assert.equal(w.calls.filter((c) => c.tool === 'say').length, 1);
    assert.equal(w.calls[0].how, 'name');
  });

  test(`after ${MAX_PREEMPTS} aborts in a row the decision in flight is kept and applied in a quiet room; then a new wake`, async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'] });
    for (const text of ['Кора', 'а ты', 'кто такая', 'вообще']) {
      w.heard('tkach_t', text);
      await flush();
    }
    assert.equal(w.agent.calls.length, MAX_PREEMPTS + 1);
    assert.equal(w.agent.calls.filter((c) => c.signal.aborted).length, MAX_PREEMPTS);
    const kept = w.agent.calls.at(-1);
    kept.answer([{ action: 'say', text: 'Я Кора, ведущая стендапа.' }]);
    await flush();
    assert.equal(w.calls.filter((c) => c.tool === 'say').length, 1, 'applied although stale');
    assert.equal(w.agent.calls.length, MAX_PREEMPTS + 2, 'the owed wake for the last line');
    assert.deepEqual(w.agent.calls.at(-1).input.events.map((e) => e.type === 'heard' ? e.text : e.type), ['вообще']);
  });

  test('the kept stale decision is dropped when the room is talking; its events go to the next wake', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'] });
    for (const text of ['Кора', 'а ты', 'кто такая', 'вообще']) {
      w.heard('tkach_t', text);
      await flush();
    }
    w.io.room = true;
    w.agent.calls.at(-1).answer([{ action: 'say', text: 'Я Кора.' }]);
    await flush();
    assert.equal(w.calls.length, 0);
    assert.equal(w.find('agent.dropped').at(-1).why, 'stale');
    w.io.room = false;
    await w.wait(200);
    const again = w.agent.calls.at(-1);
    assert.deepEqual(again.input.events.filter((e) => e.type === 'heard').map((e) => e.text), ['Кора', 'а ты', 'кто такая', 'вообще'], 'nothing was decided on them');
  });

  test('her lines still waiting are dropped by a newer line (io.drop with the new epoch)', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'] });
    w.heard('tkach_t', 'Кора привет');
    await flush();
    w.agent.calls[0].answer([{ action: 'say', text: 'Привет, Тима!' }]);
    await flush();
    assert.equal(w.io.queued[0].dropped, undefined);
    w.heard('nevsky_g', 'и меня поприветствуй');
    await flush();
    assert.equal(w.io.queued[0].dropped, true);
    assert.equal(w.find('agent.dropped')[0].count, 1);
  });

  test('someone left: the epoch rises (a handoff to them must not play); a decision made before is re-decided', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.heard('tkach_t', 'у меня всё');
    await flush();
    w.setPresent(['tkach_t', 'orlov_y']);
    w.agent.calls[0].answer([{ action: 'give_word', person: 'nevsky_g', text: '' }]);
    await flush();
    assert.equal(w.calls.length, 0, 'decided before Gleb left: not applied');
    await w.wait(200);
    const again = w.agent.calls[1];
    assert.deepEqual(again.input.events.map((e) => e.type), ['heard', 'left']);
    assert.deepEqual(again.input.present, ['orlov_y', 'tkach_t']);
  });
});

describe('conductor: the silence ladder', () => {
  test('round: 1 s, 2.5 s, 6 s after the last speech, then every 10 s three times; `after` names what came last', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.heard('tkach_t', 'сегодня делаю интеграцию');
    await flush();
    w.agent.calls[0].answer([{ action: 'skip' }]);
    const stages = [];
    for (let i = 0; i < 50; i++) {
      await w.wait(1000);
      for (const c of w.agent.open()) {
        const s = c.input.events.find((e) => e.type === 'silence');
        stages.push([s.ms, s.after]);
        c.answer([{ action: 'skip' }]);
      }
    }
    assert.deepEqual(stages, [
      [1000, 'speech'],
      [2500, 'speech'],
      [6000, 'speech'],
      [6000 + SILENCE_REPEAT_MS, 'speech'],
      [6000 + 2 * SILENCE_REPEAT_MS, 'speech'],
      [6000 + 3 * SILENCE_REPEAT_MS, 'speech'],
    ]);
  });

  test('after her «всё?» the silence counts from the end of her line, after = ask_done', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.heard('tkach_t', 'вот так');
    await flush();
    w.agent.calls[0].answer([{ action: 'skip' }]);
    await w.wait(500);
    w.her('Тима, всё?', { kind: 'check_done' });
    await w.wait(900);
    assert.equal(w.agent.open().length, 0);
    await w.wait(100);
    const [c] = w.agent.open();
    assert.deepEqual(c.input.events.at(-1), { type: 'silence', ms: 1000, after: 'ask_done' });
  });

  test('no stage while the room talks or she speaks; the ladder restarts after', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.heard('tkach_t', 'сегодня делаю');
    await flush();
    w.agent.calls[0].answer([{ action: 'skip' }]);
    w.io.room = true;
    await w.wait(8000);
    assert.equal(w.agent.calls.length, 1);
    w.io.room = false;
    await w.wait(900);
    assert.equal(w.agent.calls.length, 1);
    await w.wait(200);
    assert.equal(w.agent.calls.length, 2);
  });

  test('a stage due while a decision is in flight fires after it, with the real silence', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.heard('tkach_t', 'сегодня делаю интеграцию');
    await w.wait(1500);
    assert.equal(w.agent.calls.length, 1);
    w.agent.calls[0].answer([{ action: 'skip' }]);
    await w.wait(100);
    assert.deepEqual(w.agent.calls[1].input.events, [{ type: 'silence', ms: 1600, after: 'speech' }]);
  });

  test('open floor: 2.5 s and 6 s; waiting: no ladder', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'open_floor' });
    w.her('Все высказались. Кто хочет что-то добавить или спросить?', { kind: 'open_floor' });
    const seen = [];
    for (let i = 0; i < 8; i++) {
      await w.wait(1000);
      for (const c of w.agent.open()) {
        seen.push(c.input.events.at(-1).ms);
        c.answer([{ action: 'skip' }]);
      }
    }
    assert.deepEqual(seen, [2500, 6000]);
    const idle = makeWorld({ present: ['tkach_t', 'nevsky_g'] });
    idle.heard('tkach_t', 'привет всем');
    await flush();
    idle.agent.calls[0].answer([{ action: 'skip' }]);
    await idle.wait(30_000);
    assert.equal(idle.agent.calls.length, 1);
  });

  test('joined / left re-arm the ladder: the next tick wakes with the newcomer in the input', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'open_floor' });
    w.her('Все высказались. Кто хочет что-то добавить или спросить?');
    for (let i = 0; i < 40; i++) {
      await w.wait(1000);
      for (const c of w.agent.open()) c.answer([{ action: 'skip' }]);
    }
    const n = w.agent.calls.length;
    w.setPresent(['tkach_t', 'nevsky_g', 'orlov_y']);
    await w.wait(100);
    assert.equal(w.agent.calls.length, n + 1);
    assert.deepEqual(w.agent.calls.at(-1).input.events.map((e) => e.type), ['joined', 'silence']);
    assert.deepEqual(w.agent.calls.at(-1).input.queue, ['orlov_y']);
  });
});

describe('conductor: the executor', () => {
  async function decide(w, actions, line = ['tkach_t', 'сегодня делаю интеграцию']) {
    if (line) w.heard(...line);
    await flush();
    const [c] = w.agent.open();
    c.answer(actions);
    await flush();
  }

  test('an invariant refuses the call: agent.rejected, the agent hears `rejected` next time, one extra wake for a turn tool', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    await decide(w, [{ action: 'give_word', person: 'orlov_y', text: '' }]);
    assert.equal(w.calls.length, 0);
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['not_present']);
    await w.wait(100);
    const next = w.agent.open()[0];
    assert.deepEqual(next.input.events, [{ type: 'rejected', tool: 'give_word', reason: 'not_present' }]);
    next.answer([{ action: 'ask_done', person: 'nevsky_g' }]);
    await w.wait(300);
    assert.equal(w.agent.open().length, 0, 'only one extra wake until a call is accepted');
  });

  test('text without a tool call is never spoken; an unknown tool is rejected', async () => {
    const w = makeWorld({ present: ['tkach_t'] });
    await decide(w, [{ action: 'none', text: 'Привет! Я тут.' }, { action: 'unknown', name: 'post_chat' }], ['tkach_t', 'Кора привет']);
    assert.equal(w.calls.length, 0);
    assert.equal(w.find('agent.text_only').length, 1);
    assert.equal(w.find('agent.rejected')[0].reason, 'unknown_tool');
  });

  test('group of 3+: a say to a line meant for a colleague is refused; by name, or «ты» right after her line, it goes out', async () => {
    const present = ['tkach_t', 'nevsky_g', 'orlov_y'];
    const w = makeWorld({ present, phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    await decide(w, [{ action: 'say', text: 'Сроки обсудите после стендапа.' }], ['nevsky_g', 'Тима а по срокам интеграции что']);
    assert.equal(w.find('agent.rejected')[0].reason, 'not_addressed');
    const byName = makeWorld({ present, phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    await decide(byName, [{ action: 'say', text: 'Я Кора, ИИ-ведущая.' }], ['nevsky_g', 'Кора а ты вообще кто']);
    assert.equal(byName.calls[0].how, 'name');
    const you = makeWorld({ present, phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    you.her('Тима, всё?', { kind: 'check_done' });
    await decide(you, [{ action: 'say', text: 'Прости, повтори вопрос.' }], ['tkach_t', 'я тебе вопрос задал']);
    assert.equal(you.calls[0].how, 'after_own_utterance');
  });

  test('one say nobody asked for per 20 s; a repeat of her own line only when asked to repeat', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'open_floor' });
    await decide(w, [{ action: 'say', text: 'Принято. Кто-то ещё?' }], ['nevsky_g', 'я добавлю завтра деплой']);
    await decide(w, [{ action: 'say', text: 'Хорошо, записала.' }], ['orlov_y', 'и ретро в пятницу']);
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['too_often']);
    const r = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'open_floor' });
    r.her('Все высказались. Кто хочет что-то добавить или спросить?');
    await decide(r, [{ action: 'say', text: 'Все высказались. Кто хочет что-то добавить или спросить?' }], ['tkach_t', 'не расслышал повтори']);
    assert.equal(r.calls.length, 1);
    r.clock.t += 25_000;
    await decide(r, [{ action: 'say', text: 'Все высказались. Кто хочет что-то добавить или спросить?' }], ['tkach_t', 'угу а дальше']);
    assert.deepEqual(r.find('agent.rejected').map((e) => e.reason), ['repeat']);
  });

  test(`ask_done: not before ${ASK_DONE_MIN_SILENCE_MS} ms of silence, not twice without speech between`, async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    await decide(w, [{ action: 'ask_done', person: 'tkach_t' }]);
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['too_early']);
    await w.wait(2600);
    for (const c of w.agent.open()) c.answer([{ action: 'ask_done', person: 'tkach_t' }]);
    await flush();
    assert.equal(w.calls.filter((c) => c.tool === 'askDone').length, 1);
    w.her('Тима, всё?', { kind: 'check_done' });
    await w.wait(3000);
    for (const c of w.agent.open()) c.answer([{ action: 'ask_done', person: 'tkach_t' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['too_early', 'already_asked']);
  });

  test('one turn action per decision; say + give_word together is fine', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g', 'orlov_y'] });
    await decide(w, [{ action: 'say', text: 'Ждала, пока попросят начать.' }, { action: 'give_word', person: 'nevsky_g', text: '' }, { action: 'give_word', person: 'orlov_y', text: '' }], ['nevsky_g', 'Кора почему ты молчала']);
    assert.deepEqual(w.calls.map((c) => c.tool), ['say', 'giveWord']);
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['one_turn_action_per_decision']);
  });

  test('give_word: before the round it opens the standup, in the round it hands over, never to someone who spoke', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'] });
    await decide(w, [{ action: 'give_word', person: 'tkach_t', text: 'Доброе утро! Тима, начнёшь?' }], ['nevsky_g', 'Кора начинай']);
    assert.deepEqual(w.calls.map((c) => [c.tool, c.person, c.how]), [['startRound', 'tkach_t', 'name']]);
    await decide(w, [{ action: 'give_word', person: 'nevsky_g', text: '' }], ['tkach_t', 'у меня всё']);
    assert.deepEqual(w.calls.at(-1).tool, 'giveWord');
    await decide(w, [{ action: 'give_word', person: 'tkach_t', text: '' }], ['nevsky_g', 'у меня всё']);
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['already_spoke']);
  });

  test('budget: over max_calls the agent is not called any more, one alert', async () => {
    const w = makeWorld({ present: ['tkach_t'], budget: { max_calls: 2 } });
    for (const text of ['Кора привет', 'Кора ты тут', 'Кора ответь']) {
      w.heard('tkach_t', text);
      await flush();
      for (const c of w.agent.open()) c.answer([{ action: 'skip' }]);
      await flush();
    }
    assert.equal(w.agent.calls.length, 2);
    assert.equal(w.find('agent.budget').length, 1);
    assert.equal(w.alerts.length, 1);
    assert.equal(w.c.stats().disabled, 'calls 2 >= 2');
  });

  test('usage and timings land in agent.decision and the stats', async () => {
    const w = makeWorld({ present: ['tkach_t'] });
    w.heard('tkach_t', 'Кора привет');
    await flush();
    w.agent.calls[0].answer([{ action: 'say', text: 'Привет!' }], { usage: { prompt_tokens: 2000, completion_tokens: 30 }, timings: { ttft: 500, first_tool_name: 550, done: 900 } });
    await flush();
    const d = w.find('agent.decision')[0];
    assert.deepEqual([d.ttft_ms, d.name_ms, d.done_ms, d.tokens], [500, 550, 900, 2030]);
    assert.deepEqual([w.c.stats().tokens_in, w.c.stats().tokens_out], [2000, 30]);
  });
});

describe('conductor: after the review of 27.09', () => {
  test('an answer to her name dropped by an unrelated line is still hers: the re-decision is not refused', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'nevsky_g', queue: ['orlov_y'] });
    w.heard('tkach_t', 'Кора а ты вообще кто такая');
    await flush();
    w.agent.calls[0].answer([{ action: 'say', text: 'Я Кора, ИИ-ведущая стендапа.' }]);
    await flush();
    w.clock.t += 800;
    w.heard('nevsky_g', 'и ещё сегодня деплой на стейдж'); // the speaker goes on: her waiting answer is dropped
    await flush();
    assert.equal(w.io.queued[0].dropped, true);
    w.agent.open()[0].answer([{ action: 'say', text: 'Я Кора, ИИ-ведущая стендапа.' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected'), []);
    assert.equal(w.calls.at(-1).how, 'name');
    w.her('Я Кора, ИИ-ведущая стендапа.', { kind: 'agent_say' }); // answered: the next unrelated say is hers no more
    w.clock.t += 3000;
    w.heard('nevsky_g', 'потом ревью');
    await flush();
    w.agent.open()[0].answer([{ action: 'say', text: 'Отлично.' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['not_addressed']);
  });

  test('a join after a long silence: one wake, not a burst of the missed repeats', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'open_floor' });
    w.her('Все высказались. Кто хочет что-то добавить или спросить?');
    for (let i = 0; i < 40; i++) {
      await w.wait(1000);
      for (const c of w.agent.open()) c.answer([{ action: 'skip' }]);
    }
    const n = w.agent.calls.length;
    w.setPresent(['tkach_t', 'nevsky_g', 'orlov_y']);
    for (let i = 0; i < 50; i++) {
      await w.wait(100);
      for (const c of w.agent.open()) c.answer([{ action: 'skip' }]);
    }
    assert.equal(w.agent.calls.length - n, 1);
  });

  test('ask_done only once the speaker has said something; a silent speaker is handed over as silentPrev, a thanked one as said', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'nevsky_g', queue: ['orlov_y'] });
    w.her('Дальше Глеб.', { kind: 'handoff' });
    await w.wait(2600);
    w.agent.open()[0].answer([{ action: 'ask_done', person: 'nevsky_g' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['not_started'], '«Глеб, всё?» before Gleb said a word');
    await w.wait(4000);
    for (const c of w.agent.open()) c.answer([{ action: 'give_word', person: 'orlov_y', text: '' }]);
    await flush();
    assert.deepEqual([w.calls.at(-1).tool, w.calls.at(-1).silentPrev, w.calls.at(-1).said], ['giveWord', true, false]);

    const t = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    t.heard('tkach_t', 'сегодня тесты у меня всё');
    await flush();
    t.agent.calls[0].answer([{ action: 'give_word', person: 'nevsky_g', text: '' }, { action: 'say', text: 'Поняла, спасибо.' }]);
    await flush();
    assert.deepEqual(t.calls.map((c) => c.tool), ['say', 'giveWord'], 'the answer goes before the handoff');
    assert.deepEqual([t.calls[1].said, t.calls[1].silentPrev], [true, false]);
  });

  test('the lead asks to start with a colleague: the lead-first rule gives way; someone else asking does not', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'] });
    w.heard('orlov_y', 'Кора начинай давай с Глеба');
    await flush();
    w.agent.calls[0].answer([{ action: 'give_word', person: 'nevsky_g', text: 'Доброе утро! Глеб, начнёшь?' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected'), []);
    const o = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'] });
    o.heard('tkach_t', 'Кора начинай давай с Глеба');
    await flush();
    o.agent.calls[0].answer([{ action: 'give_word', person: 'nevsky_g', text: '' }]);
    await flush();
    assert.deepEqual(o.find('agent.rejected').map((e) => e.reason), ['lead_goes_first']);
  });

  test('open floor: every addition may be acknowledged (8 s apart), not one per 20 s', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'open_floor' });
    w.heard('nevsky_g', 'я добавлю завтра деплой');
    await flush();
    w.agent.calls[0].answer([{ action: 'say', text: 'Принято, Глеб. Кто-то ещё?' }]);
    await flush();
    w.clock.t += 9000;
    w.heard('orlov_y', 'и ретро в пятницу');
    await flush();
    w.agent.open()[0].answer([{ action: 'say', text: 'Принято, Слава. Кто-то ещё?' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected'), []);
    assert.equal(w.calls.length, 2);
  });

  test('scheduled mode: wait_lead_until wakes the agent before the start', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'] });
    w.c.timer('wait_lead_until');
    await flush();
    assert.equal(w.agent.calls.length, 1);
    assert.deepEqual(w.agent.calls[0].input.events.at(-1), { type: 'timer', name: 'wait_lead_until' });
  });
});

// --------------------------------------------------------------------------- scenarios, host path

const isAskDone = (text) => /всё\?\s*$/i.test(text);

describe('conductor: every scenario through the host path with its ideal decisions', () => {
  for (const sc of SCENARIOS) {
    test(`${sc.id}: woken where a decision is due, the ideal decision accepted`, async () => {
      const w = makeWorld({ present: sc.state.present, phase: sc.state.phase, speaker: sc.state.speaker, queue: sc.state.queue ?? [], dialog: sc.dialog });
      for (const [i, step] of sc.steps.entries()) {
        const before = { rejected: w.find('agent.rejected').length, calls: w.calls.length };
        for (const e of step.events) {
          if (e.type === 'heard') w.heard(e.who, e.text);
          else if (e.type === 'her_line_done') w.her(e.text, { cut: e.cut, kind: isAskDone(e.text) ? 'check_done' : null });
          else if (e.type === 'silence') await w.wait(e.ms);
          else if (e.type === 'joined') w.setPresent([...w.state.presentIds(), e.who]);
          else if (e.type === 'left') w.setPresent(w.state.presentIds().filter((id) => id !== e.who));
          else if (e.type === 'interrupted') w.c.interrupted({ text: e.text });
          else if (e.type === 'chorus') w.c.chorus({ who: e.who });
          else if (e.type === 'state') {
            const sit = w.c.situation();
            for (const k of ['phase', 'speaker', 'queue']) if (k in e) assert.deepEqual(sit[k], e[k], `step ${i}: the host's ${k} matches the scenario`);
          }
          w.clock.t += 50;
          await flush();
        }
        const open = w.agent.open();
        assert.ok(open.length <= 1, `step ${i}: at most one decision in flight`);
        const ideal = step.ideal ?? [];
        const speaks = ideal.filter((a) => a.action !== 'skip');
        if (speaks.length) assert.equal(open.length, 1, `step ${i}: the agent was woken for a decision`);
        if (!open.length) continue;
        const sit = open[0].input;
        assert.equal(sit.phase, w.c.situation().phase);
        open[0].answer(ideal);
        await flush();
        const rejected = w.find('agent.rejected').slice(before.rejected);
        assert.deepEqual(rejected, [], `step ${i}: the host accepts the ideal decision`);
        assert.equal(w.calls.length - before.calls, speaks.length, `step ${i}: each ideal call reached the host`);
      }
    });
  }
});
