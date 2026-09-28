// The agent's side of the host (src/agent/conductor.js, docs/agent_plan.md step 3): wakes, epoch and
// abort, the silence ladder, the executor with invariants + `rejected`, the output filter, the budget —
// and every scenario of src/agent/scenarios.js replayed through it with its ideal decisions.
// Fake clock, fake agent, fake host io; real state.js on the fictional team.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ASK_DONE_MIN_SILENCE_MS, LIT_HOLD_MAX_MS, LIT_HOLD_MS, MAX_PREEMPTS, SILENCE_REPEAT_MS, SPEAKER_START_MS, createConductor } from '../../src/agent/conductor.js';
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
        call.fail = (e = Object.assign(new Error('503 high demand'), { status: 503 })) => {
          call.answered = true;
          reject(e);
        };
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        calls.push(call);
      });
    },
    open: () => calls.filter((c) => !c.answered && !c.signal.aborted),
  };
}

function makeWorld({ present, phase = 'waiting', speaker = null, queue = [], agent = manualAgent(), budget, dialog, names = {}, roster = ROSTER } = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const state = createState({ roster, now });
  const display = Object.fromEntries(roster.people.map((p) => [p.id, p.display]));
  const nameOf = (id) => display[id] ?? names[id] ?? id; // guests: their Telemost name (guest_1 is the first unknown one)
  state.applyParticipants(present.map((id) => ({ name: nameOf(id) })), { t: now() });
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
    litIds: [], // Telemost tiles lit now
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
    lit: () => io.litIds,
    hostBusy: () => io.busy,
    canSpeak: () => !io.room,
    alert: (t) => alerts.push(t),
  };
  // the conductor gets io with quiet() as a function; the flags stay on `io`
  const c = createConductor({ state, agent, io: { ...io, quiet: () => io.quiet }, now, log, leadId: roster.firstAlways, mentionsHost, budget });
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
      const diff = state.applyParticipants(ids.map((id) => ({ name: nameOf(id) })), { t: clock.t });
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
    assert.deepEqual(next.input.events, [{ type: 'rejected', tool: 'give_word', reason: 'not_present', person: 'orlov_y', can: ['nevsky_g'] }], 'who can get the word instead');
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
    await w.wait(500);
    w.heard('orlov_y', 'глеб ты тут'); // a colleague's line wakes her; Gleb has not said a word
    await flush();
    const first = w.agent.calls[0];
    assert.equal(first.input.ask_done, false, 'the tool is not offered');
    assert.ok(!first.input.can_give.includes('nevsky_g'));
    first.answer([{ action: 'ask_done', person: 'nevsky_g' }]); // a model that calls it anyway (plain tools)
    await flush();
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['not_started'], '«Глеб, всё?» before Gleb said a word');
    await w.wait(5000);
    assert.equal(w.agent.calls.length, 1, 'no 1 s / 2.5 s wakes while the speaker has not started (review 28.09)');
    await w.wait(1100);
    assert.equal(w.agent.calls.length, 2, 'the 6 s stage');
    w.agent.calls[1].answer([{ action: 'give_word', person: 'orlov_y', text: '' }]);
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

describe('conductor: after the live test of 28.09', () => {
  test('the input carries the people in the room with their names and the lead', async () => {
    const w = makeWorld({ present: ['orlov_y', 'guest_1'], names: { guest_1: 'Зоя Тестова' } });
    w.heard('guest_1', 'Кора привет');
    await flush();
    const inp = w.agent.calls[0].input;
    assert.deepEqual(inp.present, ['orlov_y', 'guest_1']);
    assert.equal(inp.names.guest_1, 'Зоя');
    assert.equal(inp.lead, 'orlov_y');
    assert.ok(inp.names.orlov_y && !/\u0301/.test(inp.names.orlov_y));
  });

  test('the same refused call twice: agent.stuck — the ladder\'s stages still wake her, its 10 s repeats do not, until someone speaks', async () => {
    const w = makeWorld({ present: ['tkach_t', 'guest_1'], phase: 'round', speaker: 'tkach_t', queue: ['guest_1'], names: { guest_1: 'Зоя' } });
    w.heard('tkach_t', 'у меня всё');
    await flush();
    w.agent.calls[0].answer([{ action: 'give_word', person: 'nevsky_g', text: '' }]);
    await w.wait(200);
    const again = w.agent.open()[0];
    assert.deepEqual(again.input.events.at(-1), { type: 'rejected', tool: 'give_word', reason: 'not_present', person: 'nevsky_g', can: ['guest_1'] });
    again.answer([{ action: 'give_word', person: 'nevsky_g', text: '' }]);
    await flush();
    assert.equal(w.find('agent.stuck').length, 1);
    const n = w.agent.calls.length;
    for (let i = 0; i < 200; i++) {
      await w.wait(100);
      for (const c of w.agent.open()) c.answer([{ action: 'skip' }]);
    }
    const late = w.agent.calls.slice(n).map((c) => c.input.events.find((e) => e.type === 'silence')?.ms);
    assert.deepEqual(late, [1000, 2500, 6000], 'review 28.09: the stages are what makes her hand over a silent speaker; only the repeats wait for speech');
    w.heard('tkach_t', 'Кора дальше давай');
    await flush();
    assert.equal(w.agent.calls.length, n + 4, 'speech wakes her again');
  });

  test('ask_done «too early» on every line never marks her stuck: the 2.5 s stage still asks (live 28.09, run 2)', async () => {
    const w = makeWorld({ present: ['tkach_t', 'guest_1'], phase: 'round', speaker: 'guest_1', queue: [], names: { guest_1: 'Зоя' } });
    for (const text of ['буду гулять с кошкой', 'завтра к врачу', 'в четверг к сестре']) {
      w.heard('guest_1', text);
      await flush();
      for (const c of w.agent.open()) c.answer([{ action: 'ask_done', person: 'guest_1' }]);
      await w.wait(300);
      for (const c of w.agent.open()) c.answer([{ action: 'ask_done', person: 'guest_1' }]);
      await flush();
    }
    assert.equal(w.find('agent.stuck').length, 0);
    for (let i = 0; i < 30; i++) {
      await w.wait(100);
      for (const c of w.agent.open()) c.answer([{ action: 'ask_done', person: 'guest_1' }]);
    }
    assert.ok(w.calls.some((c) => c.tool === 'askDone'), '«Зоя, всё?» after 2.5 s of silence');
  });

  test('«Кора, заканчивай» in the round: leave is allowed; without her name it is not', async () => {
    const w = makeWorld({ present: ['tkach_t', 'guest_1'], phase: 'round', speaker: 'tkach_t', queue: ['guest_1'], names: { guest_1: 'Зоя' } });
    w.heard('tkach_t', 'Кора заканчивай встречу');
    await flush();
    w.agent.calls[0].answer([{ action: 'leave', text: 'Хорошо, заканчиваем. Всем хорошего дня!' }]);
    await flush();
    assert.deepEqual(w.calls.map((c) => c.tool), ['leave']);
    const o = makeWorld({ present: ['tkach_t', 'guest_1'], phase: 'round', speaker: 'tkach_t', queue: ['guest_1'], names: { guest_1: 'Зоя' } });
    o.heard('tkach_t', 'походу нам надо уходить');
    await flush();
    o.agent.calls[0].answer([{ action: 'leave', text: 'Пока!' }]);
    await flush();
    assert.deepEqual(o.find('agent.rejected').map((e) => e.reason), ['round_not_finished']);
  });

  test('a handoff text naming someone else is refused (give_word(Тима, «…Дальше, Глеб.»))', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'belozersky_s'] });
    w.heard('belozersky_s', 'Кора начинай');
    await flush();
    w.agent.calls[0].answer([{ action: 'give_word', person: 'tkach_t', text: 'Поняла, спасибо. Дальше, Глеб.' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['text_names_someone_else']);
  });

  test('a line mostly repeating her recent one is refused; a small group chit-chat line is not «addressed»', async () => {
    const w = makeWorld({ present: ['tkach_t', 'guest_1'], names: { guest_1: 'Зоя' } });
    w.her('Тима, когда будешь готов — скажи, начну стендап.', { kind: 'agent_say' });
    w.clock.t += 9000;
    w.heard('tkach_t', 'Кора ты тут');
    await flush();
    w.agent.calls[0].answer([{ action: 'say', text: 'Отлично, Тима, когда будешь готов — скажи, начну стендап.' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['repeat']);
    const c = makeWorld({ present: ['tkach_t', 'guest_1'], names: { guest_1: 'Зоя' } });
    c.heard('guest_1', 'да ну вот с полов три молодец уже хорошо'); // between the two of them
    await flush();
    c.agent.calls[0].answer([{ action: 'say', text: 'Здорово!' }]);
    await flush();
    assert.equal(c.calls.at(-1).how, null, 'not addressed to her');
  });
});

// --------------------------------------------------------------------------- scenarios, host path

describe('conductor: a lit tile holds the wake; a speaker who has not started (28.09)', () => {
  test('a final while its author is lit: no wake until the tile goes dark, then one wake with every piece', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.io.litIds = ['tkach_t'];
    w.heard('tkach_t', 'сегодня доделываю интеграцию');
    await w.wait(600);
    w.heard('tkach_t', 'и потом ревью у Глеба');
    await w.wait(600);
    assert.equal(w.agent.calls.length, 0, 'mid-thought: SpeechKit closed the phrase on a pause, the tile is still lit');
    w.io.litIds = [];
    await w.wait(100);
    assert.equal(w.agent.calls.length, 1);
    assert.deepEqual(w.agent.calls[0].input.events.map((e) => e.text), ['сегодня доделываю интеграцию', 'и потом ревью у Глеба']);
    assert.deepEqual(w.find('agent.hold').map((e) => e.who), ['tkach_t']);
    assert.deepEqual(w.find('agent.held').map((e) => [e.who, e.why]), [['tkach_t', 'dark']]);
    assert.ok(w.find('agent.held')[0].ms >= 1200);
  });

  test(`a tile that stays lit: the wake goes after ${LIT_HOLD_MS} ms; a piece being recognized keeps it, up to ${LIT_HOLD_MAX_MS} ms`, async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.io.litIds = ['tkach_t'];
    w.heard('tkach_t', 'сегодня тесты');
    await w.wait(LIT_HOLD_MS - 200);
    assert.equal(w.agent.calls.length, 0);
    await w.wait(300);
    assert.equal(w.agent.calls.length, 1);
    assert.equal(w.find('agent.held')[0].why, 'timeout');

    const t = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    t.io.litIds = ['tkach_t'];
    t.heard('tkach_t', 'сегодня тесты');
    t.io.room = true; // the next piece: a partial, no final yet
    await t.wait(LIT_HOLD_MAX_MS - 200);
    assert.equal(t.agent.calls.length, 0);
    await t.wait(300);
    assert.equal(t.agent.calls.length, 1);
    assert.equal(t.find('agent.held')[0].why, 'max');
  });

  test('no silence wake during a hold; someone else\'s final wakes at once, with the held line', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.io.litIds = ['tkach_t'];
    w.heard('tkach_t', 'сегодня тесты');
    await w.wait(1400);
    assert.equal(w.agent.calls.length, 0, 'the 1 s stage of the ladder waits too');
    w.heard('nevsky_g', 'кора а ты что думаешь');
    await flush();
    assert.equal(w.agent.calls.length, 1);
    assert.deepEqual(w.agent.calls[0].input.events.map((e) => e.who), ['tkach_t', 'nevsky_g']);
    assert.equal(w.find('agent.held')[0].why, 'other');
  });

  test('no tile info: the final wakes at once, as before', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.io.litIds = ['nevsky_g'];
    w.heard('tkach_t', 'сегодня тесты');
    await flush();
    assert.equal(w.agent.calls.length, 1, 'only the author\'s own tile holds');
    assert.equal(w.find('agent.hold').length, 0);
  });

  test(`open_floor / give_word to another: not while the speaker has not started, ${SPEAKER_START_MS} ms after her handoff at most`, async () => {
    // live 28.09: «Все высказались…» 1.7 s after «Дальше, …», the guest had not started yet
    const f = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'nevsky_g', queue: [] });
    f.her('Дальше, Глеб.', { kind: 'handoff' });
    await f.wait(1000);
    assert.equal(f.agent.calls.length, 0, 'no 1 s wake for a speaker who has not started');
    f.heard('tkach_t', 'угу'); // someone else's line wakes her
    await flush();
    f.agent.open()[0].answer([{ action: 'open_floor' }]);
    await flush();
    assert.deepEqual(f.find('agent.rejected').map((e) => [e.tool, e.reason]), [['open_floor', 'speaker_not_started']]);
    await f.wait(SPEAKER_START_MS);
    const late = f.agent.open()[0];
    assert.deepEqual(late.input.events.find((e) => e.type === 'rejected'), { type: 'rejected', tool: 'open_floor', reason: 'speaker_not_started', speaker: 'nevsky_g', hint: 'слово у него, он ещё не начал: подожди' });
    late.answer([{ action: 'open_floor' }]);
    await flush();
    assert.equal(f.calls.at(-1)?.tool, 'openFloor');

    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'nevsky_g', queue: ['orlov_y'] });
    w.her('Дальше, Глеб.', { kind: 'handoff' });
    await w.wait(1000);
    w.heard('tkach_t', 'угу');
    await flush();
    w.agent.open()[0].answer([{ action: 'give_word', person: 'orlov_y' }]);
    await w.wait(100);
    assert.equal(w.agent.open().length, 0, 'a timing refusal earns no immediate extra wake');
    w.heard('tkach_t', 'ага ага');
    await flush();
    w.agent.open()[0].answer([{ action: 'give_word', person: 'orlov_y' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected').map((e) => [e.tool, e.reason]), [['give_word', 'speaker_not_started'], ['give_word', 'speaker_not_started']]);
    assert.equal(w.find('agent.stuck').length, 0, 'a timing refusal twice: not stuck');
    await w.wait(SPEAKER_START_MS + 100); // the stage counts from the last speech (the colleague's «ага»)
    w.agent.open()[0].answer([{ action: 'give_word', person: 'orlov_y' }]);
    await flush();
    assert.deepEqual([w.calls.at(-1).tool, w.calls.at(-1).person, w.calls.at(-1).silentPrev], ['giveWord', 'orlov_y', true], 'still silent after 6 s: handed over');
  });

  test('the speaker has spoken, or the room asks her by name: open_floor at once', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'nevsky_g', queue: [] });
    w.her('Дальше, Глеб.', { kind: 'handoff' });
    w.heard('nevsky_g', 'я сегодня тесты у меня всё');
    await flush();
    w.agent.calls[0].answer([{ action: 'open_floor' }]);
    await flush();
    assert.equal(w.calls.at(-1)?.tool, 'openFloor');

    const t = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'nevsky_g', queue: [] });
    t.her('Дальше, Глеб.', { kind: 'handoff' });
    t.heard('orlov_y', 'кора давай вопросы глеба нет');
    await flush();
    t.agent.calls[0].answer([{ action: 'open_floor' }]);
    await flush();
    assert.equal(t.calls.at(-1)?.tool, 'openFloor');
  });
});

describe('conductor: after the code review of 28.09', () => {
  test('a timer while the lead\'s tile is lit waits for the tile; so does a wake owed after a decision', async () => {
    const w = makeWorld({ present: ['orlov_y', 'nevsky_g'] });
    w.io.litIds = ['orlov_y'];
    w.heard('orlov_y', 'так коллеги');
    w.c.timer('start');
    await w.wait(500);
    assert.equal(w.agent.calls.length, 0, 'no wake around the hold');
    w.io.litIds = [];
    await w.wait(200);
    assert.equal(w.agent.calls.length, 1);
    assert.deepEqual(w.agent.calls[0].input.events.map((e) => e.type), ['heard', 'timer']);
  });

  test('a failed request is tried once more (before the round no ladder would pick it up); twice failed — waits for the next line', async () => {
    const w = makeWorld({ present: ['orlov_y', 'nevsky_g'] });
    w.heard('orlov_y', 'кора начинай');
    await flush();
    w.agent.calls[0].fail();
    await w.wait(200);
    assert.equal(w.agent.calls.length, 2, 'one retry');
    assert.deepEqual(w.agent.calls[1].input.events.map((e) => e.text), ['кора начинай']);
    w.agent.calls[1].fail();
    await w.wait(30_000);
    assert.equal(w.agent.calls.length, 2, 'no retry loop');
    assert.deepEqual(w.find('agent.error').map((e) => e.streak), [1, 2]);
  });

  test('before the round: one wake 6 s after her own line, none after people\'s, no repeats', async () => {
    const w = makeWorld({ present: ['orlov_y', 'nevsky_g'] });
    w.heard('orlov_y', 'кора начинай');
    await flush();
    w.agent.calls[0].answer([{ action: 'say', text: 'Начинаем?' }]); // a say instead of give_word (live 28.09, 4 times)
    await flush();
    w.her('Начинаем?', { kind: 'agent_say' });
    await w.wait(5900);
    assert.equal(w.agent.calls.length, 1);
    await w.wait(200);
    assert.equal(w.agent.calls.length, 2);
    assert.deepEqual(w.agent.calls[1].input.events.at(-1), { type: 'silence', ms: 6000, after: 'host' });
    w.agent.calls[1].answer([{ action: 'skip' }]);
    await w.wait(40_000);
    assert.equal(w.agent.calls.length, 2);
  });

  test('a line nobody was attributed to is not the silent speaker\'s in a group; alone in the room it is', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'nevsky_g', queue: [] });
    w.her('Дальше, Глеб.', { kind: 'handoff' });
    w.heard('?', 'слушай а ты созвон перенёс');
    await flush();
    assert.equal(w.agent.calls[0].input.ask_done, false);
    w.agent.calls[0].answer([{ action: 'ask_done', person: 'nevsky_g' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['not_started']);

    const one = makeWorld({ present: ['nevsky_g'], phase: 'round', speaker: 'nevsky_g', queue: [] });
    one.heard('?', 'сегодня делаю ревью');
    await one.wait(2600);
    assert.equal(one.agent.calls.at(-1).input.ask_done !== false || one.agent.calls.length === 1, true);
    for (const c of one.agent.open()) c.answer([{ action: 'skip' }]);
    await one.wait(100);
    assert.equal(one.c.input().ask_done, true, 'alone in the room: the line is his');
  });

  test('a skip ends a refusal streak: the same refusal after it is not «stuck» and earns the extra wake again', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.heard('tkach_t', 'начну с ревью');
    await flush();
    w.agent.calls[0].answer([{ action: 'give_word', person: 'orlov_y', text: '' }]); // spoke already
    await w.wait(100);
    assert.equal(w.agent.open().length, 1, 'the extra wake after a refused turn tool');
    w.agent.open()[0].answer([{ action: 'skip' }]);
    await w.wait(1000); // the 1 s stage, no speech in between
    w.agent.open()[0].answer([{ action: 'give_word', person: 'orlov_y', text: '' }]);
    await w.wait(100);
    assert.equal(w.find('agent.stuck').length, 0, 'a skip between: not stuck');
    assert.equal(w.agent.open().length, 1, 'the extra wake again');
  });

  test('names with stress marks from people.json: «Ти́ма» is Тима in a handoff text', async () => {
    const roster = { ...ROSTER, people: ROSTER.people.map((p) => (p.id === 'tkach_t' ? { ...p, vocative: 'Ти́ма' } : p)) };
    const w = makeWorld({ roster, present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'nevsky_g', queue: ['orlov_y'] });
    w.heard('nevsky_g', 'у меня всё');
    await flush();
    w.agent.calls[0].answer([{ action: 'give_word', person: 'orlov_y', text: 'Спасибо! Тима, потом ты.' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['text_names_someone_else']);
  });

  test('«Принято, Глеб. Кто-то ещё?» then the same to Тимур is not a repeat; the same line to the same person is', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'open_floor' });
    w.heard('nevsky_g', 'у меня вопрос по релизу решили');
    await flush();
    w.agent.calls[0].answer([{ action: 'say', text: 'Принято, Глеб. Кто-то ещё?' }]);
    await flush();
    w.her('Принято, Глеб. Кто-то ещё?', { kind: 'agent_say' });
    await w.wait(9000);
    for (const c of w.agent.open()) c.answer([{ action: 'skip' }]);
    w.heard('tkach_t', 'и я добавлю тесты зелёные');
    await flush();
    w.agent.open()[0].answer([{ action: 'say', text: 'Принято, Тимур. Кто-то ещё?' }]);
    await flush();
    assert.deepEqual(w.calls.filter((c) => c.tool === 'say').map((c) => c.text), ['Принято, Глеб. Кто-то ещё?', 'Принято, Тимур. Кто-то ещё?']);
    w.her('Принято, Тимур. Кто-то ещё?', { kind: 'agent_say' });
    await w.wait(9000);
    for (const c of w.agent.open()) c.answer([{ action: 'skip' }]);
    w.heard('tkach_t', 'и ещё одно');
    await flush();
    w.agent.open()[0].answer([{ action: 'say', text: 'Принято, Тимур. Кто-то ещё?' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['repeat']);
  });

  test('a handoff text: ordinary words and absent people are not «someone else»; a present colleague is', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'guest_1'], phase: 'round', speaker: 'nevsky_g', queue: ['tkach_t'], names: { guest_1: 'Слава' } });
    w.heard('nevsky_g', 'у меня всё');
    await flush();
    w.agent.calls[0].answer([{ action: 'give_word', person: 'tkach_t', text: 'Славно! Тимур, твоя очередь, а Олег потом.' }]);
    await flush();
    assert.equal(w.find('agent.rejected').length, 0, '«Славно» is not Слава; Олег is not in the room');
    assert.equal(w.calls.at(-1).tool, 'giveWord');

    const t = makeWorld({ present: ['tkach_t', 'nevsky_g', 'guest_1'], phase: 'round', speaker: 'nevsky_g', queue: ['tkach_t'], names: { guest_1: 'Слава' } });
    t.heard('nevsky_g', 'у меня всё');
    await flush();
    t.agent.calls[0].answer([{ action: 'give_word', person: 'tkach_t', text: 'Спасибо! Дальше Славе.' }]);
    await flush();
    assert.deepEqual(t.find('agent.rejected').map((e) => e.reason), ['text_names_someone_else']);
  });

  test('not_addressed: not before the round, not for a say next to a handoff', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'] });
    w.heard('tkach_t', 'а кого мы ждём');
    await flush();
    w.agent.calls[0].answer([{ action: 'say', text: 'Все на месте, можно начинать.' }]);
    await flush();
    assert.equal(w.calls.at(-1)?.tool, 'say', 'the playbook: before the start she answers about the meeting');

    const r = makeWorld({ present: ['tkach_t', 'nevsky_g', 'orlov_y'], phase: 'round', speaker: 'nevsky_g', queue: ['tkach_t'] });
    r.her('Дальше, Глеб.', { kind: 'handoff' });
    await r.wait(6100);
    r.agent.open()[0].answer([{ action: 'say', text: 'Глеба не слышно, вернусь к нему в конце.' }, { action: 'give_word', person: 'tkach_t' }]);
    await flush();
    assert.deepEqual(r.calls.map((c) => c.tool), ['say', 'giveWord'], 'the prompt tells her to do exactly this');
  });

  test('the lead asked to start with a colleague a decision ago: the lead-first rule still gives way', async () => {
    const w = makeWorld({ present: ['orlov_y', 'nevsky_g', 'tkach_t'] });
    w.heard('orlov_y', 'кора начни сегодня с глеба');
    await flush();
    w.agent.calls[0].answer([{ action: 'say', text: 'Хорошо.' }]);
    await w.wait(5000);
    w.heard('tkach_t', 'кора начинай');
    await flush();
    w.agent.open()[0].answer([{ action: 'give_word', person: 'nevsky_g', text: 'Доброе утро! Глеб, начнёшь?' }]);
    await flush();
    assert.equal(w.find('agent.rejected').length, 0);
    assert.equal(w.calls.at(-1).tool, 'startRound');
  });

  test('leave before the round is over needs her name in the lines of this decision, not 15 s ago', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.heard('tkach_t', 'кора подожди секунду');
    await flush();
    w.agent.calls[0].answer([{ action: 'skip' }]);
    await w.wait(15_000);
    for (const c of w.agent.open()) c.answer([{ action: 'skip' }]);
    w.heard('tkach_t', 'ну всё пока');
    await flush();
    w.agent.open()[0].answer([{ action: 'leave', text: 'Всем пока!' }]);
    await flush();
    assert.deepEqual(w.find('agent.rejected').map((e) => e.reason), ['round_not_finished']);
  });

  test('close(): no wakes while she leaves; a cut «всё?» is not an asked one', async () => {
    const w = makeWorld({ present: ['tkach_t', 'nevsky_g'], phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'] });
    w.heard('tkach_t', 'сегодня тесты');
    await flush();
    w.agent.calls[0].answer([{ action: 'skip' }]);
    w.her('Тимур, всё?', { kind: 'check_done', cut: true });
    await w.wait(1100);
    assert.deepEqual(w.agent.calls[1].input.events.at(-1), { type: 'silence', ms: 1000, after: 'host' });
    w.agent.calls[1].answer([{ action: 'skip' }]);
    w.c.close();
    w.heard('tkach_t', 'и ещё одно');
    await w.wait(10_000);
    assert.equal(w.agent.calls.length, 2);
  });
});

const isAskDone = (text) => /всё\?\s*$/i.test(text);

describe('conductor: every scenario through the host path with its ideal decisions', () => {
  for (const sc of SCENARIOS) {
    test(`${sc.id}: woken where a decision is due, the ideal decision accepted`, async () => {
      const w = makeWorld({ present: sc.state.present, phase: sc.state.phase, speaker: sc.state.speaker, queue: sc.state.queue ?? [], dialog: sc.dialog, names: sc.names });
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
