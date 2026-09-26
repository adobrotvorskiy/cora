// Floor controller (WP6): simulated time, no audio, no network.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyCheckDoneAnswer, createFloor, detectCloser } from '../../src/core/floor.js';

const LOUD = [-30, -30];
const QUIET = [-100, -100];

/** Drives a floor with 100 ms level chunks and 50 ms ticks; records events. */
function sim() {
  let t = 0;
  const floor = createFloor({ settings: { floor: {} }, now: () => t });
  const events = [];
  for (const type of ['turn_end_candidate', 'check_done_answered', 'no_speech', 'barge_in', 'speech_start', 'speech_end', 'quiet']) {
    floor.on(type, (e) => events.push({ type, ...e }));
  }
  const step = (ms, mix) => {
    const end = t + ms;
    while (t < end) {
      t += 50;
      if (t % 100 === 0 && mix) floor.onLevels(mix, { t });
      floor.tick({ t });
    }
  };
  return { floor, events, step, now: () => t, set: (v) => (t = v) };
}

describe('closers', () => {
  test('detectCloser matches the usual endings and ignores mid-sentence «всё»', () => {
    assert.equal(detectCloser('Сегодня делаю тесты, у меня всё'), 'у меня все');
    assert.ok(detectCloser('У меня всё, спасибо.'));
    assert.equal(detectCloser('вот как-то так'), 'как то так');
    assert.equal(detectCloser('на этом всё'), 'на этом все');
    assert.equal(detectCloser('всё, спасибо'), 'все спасибо');
    assert.equal(detectCloser('передаю слово Тиме'), 'передаю слово тиме');
    assert.equal(detectCloser('у меня всё готово к релизу, дальше тесты'), null);
    assert.equal(detectCloser('сегодня всё сломалось, чиню'), null);
    assert.equal(detectCloser(''), null);
  });

  test('classifyCheckDoneAnswer', () => {
    assert.equal(classifyCheckDoneAnswer('Да'), 'yes');
    assert.equal(classifyCheckDoneAnswer('да, всё'), 'yes');
    assert.equal(classifyCheckDoneAnswer('Нет, ещё один момент'), 'no');
    assert.equal(classifyCheckDoneAnswer('И ещё я хотел сказать про релиз в пятницу'), null);
  });
});

describe('floor: turn end', () => {
  test('closer -> turn_end_candidate 0.7–0.8 s after the last loud frame, even with VAD still open', () => {
    const s = sim();
    s.floor.newTurn({ speaker: 'tkach_t', t: 0 });
    s.floor.onVad({ type: 'start', t: 100 });
    s.step(3000, LOUD); // speech until t=3000
    s.floor.onSttDelta({ so_far: 'сегодня делаю тесты', t: 2500 });
    s.step(400, QUIET); // t=3400: the transcript catches up
    s.floor.onSttDelta({ so_far: 'сегодня делаю тесты, у меня всё', t: 3400 });
    s.step(1500, QUIET);
    const c = s.events.find((e) => e.type === 'turn_end_candidate');
    assert.ok(c, 'candidate fired');
    assert.equal(c.reason, 'closer');
    assert.ok(c.t - 3000 >= 700 && c.t - 3000 <= 800, `handoff ${c.t - 3000} ms after the last loud frame`);
    assert.equal(c.speaker, 'tkach_t');
    assert.equal(s.events.filter((e) => e.type === 'turn_end_candidate').length, 1, 'fires once');
  });

  test('a late closer delta (after 700 ms of silence) fires at once', () => {
    const s = sim();
    s.floor.newTurn({ speaker: 'a', t: 0 });
    s.step(2000, LOUD);
    s.step(1000, QUIET); // t=3000, silence 1000 ms
    s.floor.onSttDelta({ so_far: 'как-то так', t: 3000 });
    s.step(100, QUIET);
    const c = s.events.find((e) => e.type === 'turn_end_candidate');
    assert.ok(c && c.reason === 'closer');
    assert.ok(c.t <= 3100, `fired at ${c.t}`);
  });

  test('closer said mid-speech and then continued speech does not fire later', () => {
    const s = sim();
    s.floor.newTurn({ speaker: 'a', t: 0 });
    s.step(2000, LOUD);
    s.floor.onSttDelta({ so_far: 'у меня всё', t: 2000 });
    s.step(300, LOUD); // keeps talking, no 700 ms gap
    s.floor.onSttDelta({ so_far: 'у меня всё готово, теперь про тесты', t: 2300 });
    s.step(3000, LOUD);
    assert.equal(s.events.filter((e) => e.type === 'turn_end_candidate').length, 0);
  });

  test('no semantic end: 2.5 s of silence -> silence_2500 (not a handoff); «да, всё» after «всё?» ends the turn', () => {
    const s = sim();
    s.floor.newTurn({ speaker: 'a', t: 0 });
    s.floor.onVad({ type: 'start', t: 100 });
    s.step(3000, LOUD);
    s.floor.onVad({ type: 'stop', t: 3850 }); // semantic VAD stops ~0.85 s after the sound (turn too short for a vad_stop handoff)
    s.step(3000, QUIET); // t=6000
    const c = s.events.find((e) => e.type === 'turn_end_candidate');
    assert.ok(c, 'candidate');
    assert.equal(c.reason, 'silence_2500');
    assert.ok(c.t >= 5500 && c.t <= 5600, `at ${c.t}`);
    // the host plays «Тимур, всё?» and tells the floor
    s.floor.checkDoneAsked({ t: 6500 });
    s.set(6500);
    s.step(300, QUIET);
    s.step(300, LOUD); // «да, всё» t=6800..7100
    s.step(100, QUIET);
    s.floor.onSttDelta({ so_far: 'да, всё', t: 7200 });
    s.step(1500, QUIET);
    const a = s.events.find((e) => e.type === 'check_done_answered');
    assert.ok(a, 'answered');
    assert.equal(a.reason, 'closer');
    assert.ok(a.t - 7100 >= 700 && a.t - 7100 <= 800, `answer handoff ${a.t - 7100} ms after speech`);
  });

  test('«всё?» with no answer: 4 s of silence counts as done', () => {
    const s = sim();
    s.floor.newTurn({ speaker: 'a', t: 0 });
    s.step(3000, LOUD);
    s.step(2600, QUIET);
    s.floor.checkDoneAsked({ t: s.now() });
    const asked = s.now();
    s.step(5000, QUIET);
    const a = s.events.find((e) => e.type === 'check_done_answered');
    assert.ok(a && a.reason === 'silence');
    assert.ok(a.t - asked >= 4000 && a.t - asked <= 4100);
  });

  test('a semantic/energy VAD stop NEVER ends a turn by itself, however long the turn: only silence -> «всё?»', () => {
    const s = sim();
    s.floor.newTurn({ speaker: 'a', t: 0 });
    s.floor.onVad({ type: 'start', t: 100 });
    s.step(12_000, LOUD);
    s.step(850, QUIET);
    s.floor.onVad({ type: 'stop', t: 12_850 });
    s.step(1500, QUIET); // 2.35 s of silence: nothing yet
    assert.equal(s.events.filter((e) => e.type === 'turn_end_candidate').length, 0, 'no candidate on vad_stop');
    s.step(300, QUIET);
    const c = s.events.find((e) => e.type === 'turn_end_candidate');
    assert.ok(c, 'candidate');
    assert.equal(c.reason, 'silence_2500');
    assert.ok(c.t >= 14_500 && c.t <= 14_600, `at ${c.t}`);
  });

  test('«так точно» / «угу» count as yes to «всё?»; «подожди» keeps the turn', () => {
    assert.equal(classifyCheckDoneAnswer('Так точно.'), 'yes');
    assert.equal(classifyCheckDoneAnswer('угу'), 'yes');
    assert.equal(classifyCheckDoneAnswer('Подожди, ещё момент'), 'no');
  });

  test('nobody speaks after the word was given -> no_speech after 6 s', () => {
    const s = sim();
    s.floor.newTurn({ speaker: 'a', t: 0 });
    s.step(7000, QUIET);
    const n = s.events.find((e) => e.type === 'no_speech');
    assert.ok(n && n.t >= 6000 && n.t <= 6100);
    assert.equal(s.events.filter((e) => e.type === 'no_speech').length, 1);
  });

  test('resumeTurn re-arms after a rejected candidate', () => {
    const s = sim();
    s.floor.newTurn({ speaker: 'a', t: 0 });
    s.step(2000, LOUD);
    s.floor.onSttDelta({ so_far: 'у меня всё', t: 2000 });
    s.step(1000, QUIET);
    assert.equal(s.events.filter((e) => e.type === 'turn_end_candidate').length, 1);
    s.floor.resumeTurn();
    s.step(3000, QUIET); // silence_2500 path is armed again
    assert.equal(s.events.filter((e) => e.type === 'turn_end_candidate').length, 2);
    assert.equal(s.events.at(-1).reason, 'silence_2500');
  });
});

describe('floor: permission and barge-in', () => {
  test('never speak while the room is active; permission after 700 ms of silence with VAD closed', () => {
    const s = sim();
    assert.equal(s.floor.canSpeak(0), true, 'silent room at start');
    s.step(1000, LOUD);
    assert.equal(s.floor.canSpeak(s.now()), false, 'energy');
    s.step(300, QUIET);
    assert.equal(s.floor.canSpeak(s.now()), false, 'only 300 ms of silence');
    s.step(500, QUIET);
    assert.equal(s.floor.canSpeak(s.now()), true, '800 ms of silence');
    s.floor.onVad({ type: 'start', t: s.now() });
    assert.equal(s.floor.canSpeak(s.now()), false, 'VAD open');
    s.floor.onVad({ type: 'stop', t: s.now() + 100 });
    s.step(1000, QUIET);
    assert.equal(s.floor.canSpeak(s.now()), true);
    assert.ok(s.events.some((e) => e.type === 'speech_start') && s.events.some((e) => e.type === 'speech_end'));
  });

  test('remote speech >= 200 ms during our playback -> barge_in; two in a row -> 3 s backoff', () => {
    const s = sim();
    s.floor.setHostSpeaking(true, { t: 0 });
    s.step(100, LOUD); // 2 frames = 100 ms of run
    assert.equal(s.events.filter((e) => e.type === 'barge_in').length, 0);
    s.step(100, LOUD); // 200 ms
    const b = s.events.find((e) => e.type === 'barge_in');
    assert.ok(b, 'barge-in fired');
    assert.equal(b.source, 'energy');
    assert.ok(b.run_ms >= 200 && b.run_ms <= 250);
    assert.equal(b.backoff_ms, 0);
    s.floor.setHostSpeaking(false, { t: s.now() });
    s.step(1000, QUIET);
    s.floor.setHostSpeaking(true, { t: s.now() });
    s.step(200, LOUD);
    const bs = s.events.filter((e) => e.type === 'barge_in');
    assert.equal(bs.length, 2);
    assert.equal(bs[1].backoff_ms, 3000);
    s.floor.setHostSpeaking(false, { t: s.now() });
    const t1 = s.now();
    s.step(2000, QUIET);
    assert.equal(s.floor.canSpeak(s.now()), false, 'in backoff');
    s.step(1200, QUIET);
    assert.ok(s.now() - t1 > 3000);
    assert.equal(s.floor.canSpeak(s.now()), true, 'backoff over');
  });

  test('a VAD start while we speak counts as barge-in too', () => {
    const s = sim();
    s.floor.setHostSpeaking(true, { t: 0 });
    s.floor.onVad({ type: 'start', t: 300 });
    const b = s.events.find((e) => e.type === 'barge_in');
    assert.ok(b && b.source === 'vad');
  });

  test('the DOM active-speaker marker of another participant while we speak is a barge-in', () => {
    const s = sim();
    s.floor.onDomSpeakers(['belozersky_s'], { t: 0 });
    assert.equal(s.events.filter((e) => e.type === 'barge_in').length, 0, 'not while silent');
    s.floor.setHostSpeaking(true, { t: 100 });
    s.floor.onDomSpeakers([], { t: 200 });
    s.floor.onDomSpeakers(['belozersky_s'], { t: 1200 });
    const b = s.events.find((e) => e.type === 'barge_in');
    assert.ok(b && b.source === 'dom' && b.t === 1200);
  });

  test('adaptive energy threshold: quiet speech (-56 dBFS) over a -70 dBFS floor counts, the floor follows noise', () => {
    const s = sim();
    assert.equal(s.floor.threshold(), -58, 'floor_min + 12');
    s.floor.setHostSpeaking(true, { t: 0 });
    s.step(300, [-56, -56]);
    const b = s.events.find((e) => e.type === 'barge_in');
    assert.ok(b && b.source === 'energy', 'quiet speech is a barge-in');
    const n = sim();
    n.step(6000, [-45, -45]); // a noisy room: fan at -45 dBFS
    assert.ok(n.floor.noiseFloorDb < -60, `the floor rises slowly (${n.floor.noiseFloorDb})`);
    n.step(9000, [-45, -45]); // learned within ~15 s (floor_rise_db_per_s 3)
    assert.ok(n.floor.noiseFloorDb >= -46 && n.floor.noiseFloorDb <= -44, `floor ${n.floor.noiseFloorDb}`);
    assert.equal(n.floor.threshold(), n.floor.noiseFloorDb + 12);
    assert.equal(n.floor.canSpeak(n.now()), true, 'steady noise is not speech');
    const m = sim();
    m.step(12_000, [-30, -30]); // a dip-free monologue: the floor may not climb into the speech
    assert.ok(m.floor.threshold() < -30, `threshold ${m.floor.threshold()} stays under the speech level`);
  });

  test('after a barge-in the host needs 1.5 s of silence before speaking again', () => {
    const s = sim();
    s.floor.setHostSpeaking(true, { t: 0 });
    s.step(300, LOUD);
    assert.ok(s.events.some((e) => e.type === 'barge_in'));
    s.floor.setHostSpeaking(false, { t: s.now() });
    s.step(900, QUIET);
    assert.equal(s.floor.canSpeak(s.now()), false, '0.9 s is not enough after a barge-in');
    s.step(700, QUIET);
    assert.equal(s.floor.canSpeak(s.now()), true, '1.6 s is');
  });
});
