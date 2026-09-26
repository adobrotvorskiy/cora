import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';
import { clearSimulation, formatMsk, setSimulatedStart } from '../../src/clock.js';
import { openLog } from '../../src/log.js';

// Set before the first log line so the redaction cache sees it.
const FAKE_TOKEN = 'unit-test-token-0123456789';
process.env.STANDUP_UNIT_TEST_TOKEN = FAKE_TOKEN;

const dir = mkdtempSync(join(tmpdir(), 'standup-log-'));
after(() => {
  delete process.env.STANDUP_UNIT_TEST_TOKEN;
  rmSync(dir, { recursive: true, force: true });
});
const readRecords = (path) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('JSONL lines: {ts, t_msk, type, ...fields}, framed by log.open/log.close', () => {
  const log = openLog({ name: 'shape', dir });
  assert.equal(basename(log.path), `shape_${formatMsk(new Date(), 'YYYY-MM-DD')}.jsonl`);
  log.event('stt.final', { who: 'timur', text: 'у меня всё', type: 'ignored' });
  log.close();
  log.event('after.close'); // no-op for the file

  const records = readRecords(log.path);
  assert.deepEqual(records.map((r) => r.type), ['log.open', 'stt.final', 'log.close']);
  const e = records[1];
  assert.deepEqual(Object.keys(e).slice(0, 3), ['ts', 't_msk', 'type']);
  assert.match(e.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(e.t_msk, formatMsk(new Date(e.ts)));
  assert.equal(e.text, 'у меня всё');
  assert.equal(records[0].run, log.run);
});

test('appends across opens of the same daily file', () => {
  const first = openLog({ name: 'append', dir });
  first.event('one');
  first.close();
  const second = openLog({ name: 'append', dir });
  second.event('two');
  second.close();
  assert.equal(first.path, second.path);
  const records = readRecords(first.path);
  assert.deepEqual(records.map((r) => r.type), ['log.open', 'one', 'log.close', 'log.open', 'two', 'log.close']);
  assert.notEqual(records[0].run, records[3].run);
});

test('survives awkward values and masks secrets', () => {
  const log = openLog({ name: 'values', dir });
  const circular = { name: 'loop' };
  circular.self = circular;
  log.event('odd', {
    pcm: Buffer.alloc(4800),
    err: Object.assign(new Error('boom'), { code: 'E_TEST' }),
    big: 10n,
    circular,
    url: `https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`,
  });
  log.close();
  const text = readFileSync(log.path, 'utf8');
  assert.ok(!text.includes(FAKE_TOKEN));
  const odd = readRecords(log.path)[1];
  assert.equal(odd.pcm, '<Buffer 4800B>');
  assert.equal(odd.err.message, 'boom');
  assert.equal(odd.err.code, 'E_TEST');
  assert.equal(odd.big, '10');
  assert.equal(odd.circular.self, '[Circular]');
  assert.equal(odd.url, 'https://api.telegram.org/bot[REDACTED]/sendMessage');
});

test('t_msk follows the simulated clock, ts stays real', () => {
  try {
    setSimulatedStart('09:58');
    const log = openLog({ name: 'sim', dir });
    const record = log.event('tick');
    log.close();
    assert.match(record.t_msk, /^09:58:0\d\.\d{3}$/);
    assert.ok(Math.abs(Date.parse(record.ts) - Date.now()) < 5000);
  } finally {
    clearSimulation();
  }
});
