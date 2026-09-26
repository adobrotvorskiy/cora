// Guards (WP6): kill phrases, stop file, deadlines, brain budget, shadow, real-room refusal.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, test } from 'node:test';
import * as clock from '../../src/clock.js';
import { Serializer } from '../../src/core/events.js';
import { createGuards, isKillPhrase, isQuietPhrase, isRealRoom, isStartRequest, limitText, meetingIdOf, mentionsHost, realRoomAllowed, testRoomUrl } from '../../src/core/guards.js';

// the real links live in config/settings.local.json; the tests use made-up ones
const REAL = 'https://telemost.yandex.ru/j/11111111111111111111111111111111111111';
const TEST_ROOM_URL = 'https://telemost.360.yandex.ru/j/22222222222222222222222222222222222222';
const settings = { times: { start: '10:00', wait_lead_until: '10:02', soft_deadline: '10:28', hard_deadline: '10:30', force_leave: '10:35' }, guards: { max_brain_calls: 3, max_brain_cost_usd: 0.5 } };
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('kill phrases and host mentions', () => {
  test('«Кора, уйди из встречи» and its STT variants', () => {
    for (const s of ['Кора, уйди из встречи', 'Кора, уйди', 'кара уйди', 'Cora leave', 'Кора, уходи', 'уйди, Кора', 'Корра, выйди пожалуйста', 'Кора уйди', 'ведущая, уходи', 'Кора, давай выходи', 'Карра, покинь встречу', 'Карат, уйди!', 'отключись, Корра']) {
      assert.equal(isKillPhrase(s), true, s);
    }
    for (const s of ['у меня всё, Кора', 'выйдет релиз завтра', 'корабль уйдёт', 'Кора, а ты кто?', 'всё, спасибо', 'выйдем на улицу после', 'Кора, спасибо, теперь Тимур', 'каратэ, уйди', 'карате уйди', 'Кора, стоп', 'стоп, Карра', 'Кора, хватит']) {
      assert.equal(isKillPhrase(s), false, s);
    }
  });

  test('«Кора, стоп» is the QUIET tier (stay in the meeting), never the leave tier', () => {
    for (const s of ['Кора, стоп', 'кара стоп', 'Cora stop', 'Кора, хватит уже', 'хватит, Кора', 'Кора, помолчи', 'Корра, замолчи пожалуйста', 'Кора, тихо', 'стоп, Карра']) {
      assert.equal(isQuietPhrase(s), true, s);
      assert.equal(isKillPhrase(s), false, `${s} must not leave`);
    }
    for (const s of ['Кора, уйди из встречи', 'Кора, отключись', 'стоп-лист обсудим позже', 'корабль стоп', 'Кора, а ты кто?', 'каратэ, стоп']) {
      assert.equal(isQuietPhrase(s), false, s);
    }
  });

  test('mentionsHost', () => {
    assert.equal(mentionsHost('Кора, ты кто?'), true);
    assert.equal(mentionsHost('А ведущая нас записывает?'), true);
    assert.equal(mentionsHost('корабль плывёт'), false);
    assert.equal(mentionsHost('сегодня релиз'), false);
  });

  test('limitText: bounded, sanitized, feminine', () => {
    const long = 'Я понял тебя. '.repeat(30);
    const out = limitText(long);
    assert.ok(out.length <= 220);
    assert.ok(out.startsWith('Я поняла'));
    assert.equal(limitText('Смотри https://example.com/secret тут'), 'Смотри тут');
  });
});

describe('real room guard', () => {
  test('the test room is always allowed; the real room needs --live at any time (no window since 21.09)', () => {
    assert.equal(meetingIdOf(`${REAL}?x=1`), '11111111111111111111111111111111111111');
    assert.equal(isRealRoom(REAL, { realUrl: REAL }), true);
    assert.equal(isRealRoom(TEST_ROOM_URL, { realUrl: REAL }), false);
    assert.equal(isRealRoom(REAL, { realUrl: null }), false, 'no real room configured: nothing is the real room');
    assert.equal(testRoomUrl({ test_room_url: TEST_ROOM_URL }), TEST_ROOM_URL);
    assert.equal(testRoomUrl({}), null);
    assert.equal(realRoomAllowed({ url: TEST_ROOM_URL, flags: {}, realUrl: REAL }).allowed, true);
    assert.equal(realRoomAllowed({ url: REAL, flags: {}, realUrl: REAL }).allowed, false);
    const mon10 = clock.todayAt('10:00', new Date('2026-09-21T06:00:00Z')); // Monday
    assert.equal(realRoomAllowed({ url: REAL, flags: { live: true }, realUrl: REAL, realNow: mon10 }).allowed, true);
    const mon11 = clock.todayAt('11:00', new Date('2026-09-21T06:00:00Z'));
    assert.equal(realRoomAllowed({ url: REAL, flags: { live: true }, realUrl: REAL, realNow: mon11 }).allowed, true); // no 10:40 cutoff anymore
    const fri10 = clock.todayAt('10:00', new Date('2026-09-18T06:00:00Z')); // Friday
    assert.equal(realRoomAllowed({ url: REAL, flags: { live: true }, realUrl: REAL, realNow: fri10 }).allowed, true); // no Mon–Thu limit anymore
    assert.match(realRoomAllowed({ url: REAL, flags: { live: false }, realUrl: REAL, realNow: mon10 }).reason, /--live/);
  });

  test('isStartRequest: the name plus an explicit start verb', () => {
    for (const line of ['Кора, начинай', 'Кора, поехали', 'Кора, начнём', 'начинаем, Кора', 'Кора, погнали', 'кара, стартуем']) {
      assert.equal(isStartRequest(line), true, line);
    }
    for (const line of ['ну что, начнём', 'Кора, как дела', 'начинаю отчёт', 'Кора, расскажи про начало', 'поехали дальше без неё']) {
      assert.equal(isStartRequest(line), false, line);
    }
  });
});

describe('timers, deadlines, budget', () => {
  const day = new Date('2026-09-21T06:00:00Z'); // Monday
  const at = (hhmm) => clock.todayAt(hhmm, day).getTime();

  test('dueTimers fire once each, in order, also when several are overdue', () => {
    let t = at('09:59');
    const g = createGuards({ settings, now: () => t });
    assert.deepEqual(g.dueTimers(t), []);
    t = at('10:00') + 500;
    assert.deepEqual(g.dueTimers(t).map((x) => x.name), ['start']);
    assert.deepEqual(g.dueTimers(t), [], 'not twice');
    t = at('10:03');
    assert.deepEqual(g.dueTimers(t).map((x) => x.name), ['wait_lead_until']);
    t = at('10:36');
    assert.deepEqual(g.dueTimers(t).map((x) => x.name), ['soft_deadline', 'hard_deadline', 'force_leave']);
    assert.deepEqual(g.deadline(t), { soft: true, hard: true, force: true, ms_to_hard: t - at('10:30') > 0 ? at('10:30') - t : 0 });
    const g2 = createGuards({ settings, now: () => at('10:05') });
    assert.deepEqual(g2.dueTimers().map((x) => x.name), ['start', 'wait_lead_until'], 'late start: both overdue timers fire');
  });

  test('brainAllowed: budget, silent mode, no calls while we speak (except barge-in / question)', () => {
    const g = createGuards({ settings, flags: {}, now: () => at('10:05') });
    assert.equal(g.brainAllowed({ trigger: 'joined', hostSpeaking: true }).ok, false);
    assert.equal(g.brainAllowed({ trigger: 'barge_in', hostSpeaking: true }).ok, true);
    assert.equal(g.brainAllowed({ trigger: 'question_to_host', hostSpeaking: true }).ok, true);
    assert.equal(g.brainAllowed({ trigger: 'timer' }).ok, true);
    assert.equal(g.brainAllowed({ trigger: 'timer' }).reason, 'max_brain_calls');
    const g3 = createGuards({ settings, flags: {}, now: () => at('10:05') });
    assert.equal(g3.brainAllowed({ trigger: 'timer', costUsd: 0.6 }).reason, 'max_brain_cost');
    assert.equal(g3.brainAllowed({ trigger: 'timer', phase: 'silent' }).reason, 'silent_mode');
    const g4 = createGuards({ settings, flags: { brain: false }, now: () => at('10:05') });
    assert.equal(g4.brainAllowed({ trigger: 'timer' }).reason, 'no_brain');
  });

  test('speechAllowed: shadow and silent mode', () => {
    const shadow = createGuards({ settings, flags: { shadow: true } });
    assert.deepEqual(shadow.speechAllowed({ phase: 'round' }), { ok: false, reason: 'shadow' });
    const g = createGuards({ settings, flags: {} });
    assert.equal(g.speechAllowed({ phase: 'round' }).ok, true);
    assert.equal(g.speechAllowed({ phase: 'silent' }).reason, 'silent_mode');
    g.stop('file', 'test');
    assert.equal(g.speechAllowed({ phase: 'round' }).reason, 'silent_mode');
  });
});

describe('stop flag', () => {
  test('state/STOP appears -> stop callback within the poll interval; voice kill writes the flag', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'standup-guards-'));
    dirs.push(dir);
    const file = join(dir, 'STOP');
    writeFileSync(file, 'stale'); // left over from an earlier run: cleared at start
    const g = createGuards({ settings, stopFile: file, stopIntervalMs: 20 });
    const seen = [];
    g.watchStop((info) => seen.push(info));
    await sleep(60);
    assert.equal(existsSync(file), false, 'stale flag removed');
    assert.equal(seen.length, 0);
    writeFileSync(file, 'stop-standup.ps1 test');
    const t0 = Date.now();
    while (!seen.length && Date.now() - t0 < 1000) await sleep(10);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].source, 'file');
    assert.ok(Date.now() - t0 < 300, 'detected quickly');
    assert.ok(g.stopped);
    g.close();

    const dir2 = mkdtempSync(join(tmpdir(), 'standup-guards-'));
    dirs.push(dir2);
    const file2 = join(dir2, 'STOP');
    const g2 = createGuards({ settings, stopFile: file2 });
    const hits = [];
    assert.equal(g2.checkTranscript('Тимур, у меня всё', (s) => hits.push(s)), false);
    assert.equal(g2.checkTranscript('Кора, уйди из встречи', (s) => hits.push(s)), true);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].source, 'voice');
    assert.ok(existsSync(file2), 'voice stop persists as the flag file');
    assert.match(readFileSync(file2, 'utf8'), /voice:/);
    assert.equal(g2.checkTranscript('Кора, уйди из встречи', (s) => hits.push(s)), true);
    assert.equal(hits.length, 1, 'stop fires once');
  });

  test('production poll (250 ms): guard.stop and the callback within 1 s while the event queue is blocked; a later flag is never removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'standup-guards-'));
    dirs.push(dir);
    const file = join(dir, 'STOP');
    const events = [];
    const log = { event: (type, fields) => events.push({ type, at: Date.now(), ...fields }) };
    const g = createGuards({ settings, log, stopFile: file }); // default interval, as in the host
    const serial = new Serializer();
    const order = [];
    let calledAt = null;
    g.watchStop((s) => {
      calledAt = Date.now();
      order.push(`stop:${s.source}`);
    });
    void serial.run(async () => {
      order.push('busy');
      await sleep(1200); // e.g. a barge-in waiting for a slow page flush
      order.push('busy_done');
    });
    await sleep(30);
    assert.equal(g.speechAllowed({ phase: 'round' }).ok, true);
    writeFileSync(file, '2026-09-18 21:24:02 stop-standup.ps1 (test)');
    const t0 = Date.now();
    while (calledAt === null && Date.now() - t0 < 1500) await sleep(10);
    assert.ok(calledAt !== null && calledAt - t0 <= 1000, `stop callback after ${calledAt === null ? 'never' : calledAt - t0} ms`);
    const stop = events.filter((e) => e.type === 'guard.stop');
    assert.equal(stop.length, 1);
    assert.equal(stop[0].source, 'file');
    assert.match(stop[0].reason, /stop-standup\.ps1/);
    assert.ok(stop[0].at - t0 <= 1000);
    assert.deepEqual(order, ['busy', 'stop:file'], 'the stop does not wait for the queue');
    assert.equal(g.speechAllowed({ phase: 'round' }).reason, 'silent_mode', 'speech gate closed at once');
    assert.equal(g.brainAllowed({ trigger: 'question_to_host' }).reason, 'silent_mode');
    await sleep(600);
    assert.ok(existsSync(file), 'only a stale flag is cleared (at start)');
    assert.equal(events.filter((e) => e.type === 'guard.stop').length, 1, 'fires once');
    g.close();
    await serial.idle();
  });
});
