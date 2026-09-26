import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  clearSimulation,
  dayMode,
  formatMsk,
  mskParts,
  now,
  nowMsk,
  parseHHMM,
  setSimulatedDay,
  setSimulatedStart,
  simulation,
  todayAt,
} from '../../src/clock.js';

const DAY_MS = 86_400_000;
const at = (iso) => new Date(iso);

afterEach(() => clearSimulation());

describe('dayMode', () => {
  test('week of Monday 2026-09-21', () => {
    const week = [
      ['2026-09-21T07:00:00Z', 'monday_focus'],
      ['2026-09-22T07:00:00Z', 'daily_plans'],
      ['2026-09-23T07:00:00Z', 'daily_plans'],
      ['2026-09-24T07:00:00Z', 'daily_plans'],
      ['2026-09-25T07:00:00Z', 'off'],
      ['2026-09-26T07:00:00Z', 'off'],
      ['2026-09-27T07:00:00Z', 'off'],
    ];
    for (const [iso, mode] of week) assert.equal(dayMode(at(iso)), mode, iso);
    assert.equal(mskParts(at('2026-09-21T07:00:00Z')).dow, 'mon');
  });

  test('follows the Moscow calendar day, not UTC', () => {
    assert.equal(dayMode(at('2026-09-20T21:30:00Z')), 'monday_focus'); // Sun 21:30 UTC = Mon 00:30 MSK
    assert.equal(dayMode(at('2026-09-20T20:59:59.999Z')), 'off'); // Sun 23:59:59.999 MSK
    assert.equal(dayMode(at('2026-09-24T20:59:59.999Z')), 'daily_plans'); // Thu 23:59:59.999 MSK
    assert.equal(dayMode(at('2026-09-24T21:00:00Z')), 'off'); // Fri 00:00 MSK
  });
});

describe('formatMsk', () => {
  test('Moscow wall-clock time with tokens', () => {
    const d = at('2026-09-21T07:00:05.123Z');
    assert.equal(formatMsk(d), '10:00:05.123');
    assert.equal(formatMsk(d, 'YYYY-MM-DD HH:mm:ss ddd'), '2026-09-21 10:00:05 Mon');
    assert.equal(formatMsk(at('2026-12-31T21:00:00Z'), 'YYYY-MM-DD HH:mm'), '2027-01-01 00:00');
    assert.equal(formatMsk(at('2026-09-20T21:00:00.007Z'), 'HH:mm:ss.SSS'), '00:00:00.007');
  });

  test('independent of the machine time zone', () => {
    const saved = process.env.TZ;
    const morning = at('2026-09-21T07:00:05.123Z'); // Mon 10:00:05.123 MSK
    const nearMidnight = at('2026-09-20T21:30:00Z'); // Mon 00:30 MSK, still Sunday in UTC and westward
    try {
      for (const tz of ['America/New_York', 'Asia/Tokyo', 'UTC', 'Pacific/Kiritimati', 'Europe/Moscow']) {
        process.env.TZ = tz;
        assert.equal(formatMsk(morning), '10:00:05.123', tz);
        assert.equal(formatMsk(morning, 'YYYY-MM-DD'), '2026-09-21', tz);
        assert.equal(formatMsk(nearMidnight, 'YYYY-MM-DD HH:mm'), '2026-09-21 00:30', tz);
        assert.equal(dayMode(nearMidnight), 'monday_focus', tz);
        assert.equal(todayAt('10:00', nearMidnight).toISOString(), '2026-09-21T07:00:00.000Z', tz);
      }
      process.env.TZ = 'America/New_York';
      assert.equal(morning.getHours(), 3, 'the runtime TZ switch must take effect, otherwise this test proves nothing');
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});

describe('todayAt', () => {
  test('HH:MM on the Moscow calendar day of base', () => {
    assert.equal(todayAt('10:00', at('2026-09-21T05:00:00Z')).toISOString(), '2026-09-21T07:00:00.000Z');
    assert.equal(todayAt('09:58', at('2026-09-20T21:30:00Z')).toISOString(), '2026-09-21T06:58:00.000Z');
    assert.equal(todayAt('00:00', at('2026-09-21T20:59:00Z')).toISOString(), '2026-09-20T21:00:00.000Z');
    assert.equal(todayAt('23:59:30', at('2026-09-21T07:00:00Z')).toISOString(), '2026-09-21T20:59:30.000Z');
    assert.equal(todayAt('9:05', at('2026-09-21T07:00:00Z')).toISOString(), '2026-09-21T06:05:00.000Z');
  });

  test('defaults to today and rejects malformed times', () => {
    assert.equal(formatMsk(todayAt('10:30'), 'YYYY-MM-DD HH:mm:ss'), `${nowMsk().ymd} 10:30:00`);
    for (const bad of ['24:00', '10:60', '1000', 'ab:cd', '', '10:00:61']) {
      assert.throws(() => todayAt(bad), /invalid time/, bad);
    }
    assert.deepEqual(parseHHMM('09:58'), { hour: 9, minute: 58, second: 0 });
  });
});

describe('simulated clock', () => {
  test('setSimulatedStart: now() starts at HH:MM today and time keeps flowing', async () => {
    const realDay = formatMsk(new Date(), 'YYYY-MM-DD');
    const start = setSimulatedStart('09:58');
    assert.equal(nowMsk().hhmm, '09:58');
    assert.ok(Math.abs(now() - todayAt('09:58')) < 1000);
    assert.equal(nowMsk().ymd, realDay);
    assert.deepEqual(simulation(), { active: true, at: '09:58', day: null, offset_ms: simulation().offset_ms });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const flowed = now() - start;
    assert.ok(flowed >= 40 && flowed < 2000, `flowed ${flowed} ms`);
  });

  test('setSimulatedDay: next such weekday, same time of day; composes with --at', () => {
    setSimulatedDay('mon');
    const { offset_ms: offset } = simulation();
    assert.equal(offset % DAY_MS, 0);
    assert.ok(offset >= 0 && offset < 7 * DAY_MS);
    assert.equal(nowMsk().dow, 'mon');
    assert.equal(dayMode(), 'monday_focus');

    setSimulatedStart('10:00');
    assert.equal(nowMsk().hhmm, '10:00');
    assert.equal(dayMode(), 'monday_focus');
    const untilCutoff = todayAt('10:02') - now();
    assert.ok(Math.abs(untilCutoff - 120_000) < 1000, `until 10:02: ${untilCutoff} ms`);

    clearSimulation();
    setSimulatedStart('10:00');
    setSimulatedDay('thu'); // order does not matter
    assert.equal(nowMsk().hhmm, '10:00');
    assert.equal(dayMode(), 'daily_plans');
    assert.throws(() => setSimulatedDay('someday'), /invalid day/);
  });

  test('clearSimulation returns to real time', () => {
    setSimulatedStart('03:00');
    setSimulatedDay('wed');
    clearSimulation();
    assert.ok(Math.abs(now() - Date.now()) < 50);
    assert.equal(simulation().active, false);
  });
});
