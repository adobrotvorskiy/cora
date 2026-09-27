// Recording per Telemost slot (docs/agent_plan.md step 2): wall-clock timeline with zero-filled gaps,
// index.json for tuning STT / Smart Turn, and the reading script of tools/record_turns.js.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { SlotRecorder } from '../../src/audio/slot_recorder.js';
import { buildScript, CUT_OFF, FINISHED, PAUSED } from '../../tools/record_turns.js';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'slot-rec-'));
  dirs.push(d);
  return d;
};
const chunk = (ms, value = 1000, rate = 24_000) => new Int16Array((rate * ms) / 1000).fill(value);
const samplesOf = (path) => {
  const buf = readFileSync(path);
  return new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) / 2);
};

describe('SlotRecorder', () => {
  test('back-to-back chunks, then a silent stretch filled with zeros on the wall clock', () => {
    const t = { now: 1100 };
    const dir = tmp();
    const rec = new SlotRecorder({ dir, now: () => t.now });
    rec.write('track-a', chunk(100, 1000)); // captured 1000..1100
    t.now = 1200;
    rec.write('track-a', chunk(100, 2000)); // 1100..1200
    t.now = 1600; // the page sent nothing for 300 ms (no sound in the slot)
    rec.write('track-a', chunk(100, 3000)); // 1500..1600
    const idx = rec.close();
    const tr = idx.tracks['track-a'];
    assert.equal(tr.t0, 1000);
    assert.equal(tr.samples, 14_400, '0.6 s from t0 to the last sample');
    assert.equal(tr.gaps_ms, 300);
    const s = samplesOf(join(dir, tr.file));
    assert.equal(s.length, 14_400);
    assert.equal(s[0], 1000);
    assert.equal(s[2400], 2000);
    assert.equal(s[4800], 0, 'the gap is silence');
    assert.equal(s[12_000 - 1], 0);
    assert.equal(s[12_000], 3000, 'the chunk after the gap lands at its wall-clock time (1500 ms)');
    const saved = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
    assert.deepEqual(saved.tracks['track-a'], tr);
    assert.equal(saved.sample_rate, 24_000);
  });

  test('arrival jitter does not put zeros inside continuous speech', () => {
    const t = { now: 1100 };
    const dir = tmp();
    const rec = new SlotRecorder({ dir, now: () => t.now });
    for (const at of [1100, 1230, 1290, 1420, 1500]) {
      t.now = at; // chunks of 100 ms arriving 30 ms late / early
      rec.write('trk', chunk(100));
    }
    const tr = rec.close().tracks.trk;
    assert.equal(tr.gaps_ms, 0);
    assert.ok(samplesOf(join(dir, tr.file)).every((v) => v === 1000));
  });

  test('one file per slot; each slot has its own timeline', () => {
    const t = { now: 1100 };
    const dir = tmp();
    const rec = new SlotRecorder({ dir, now: () => t.now });
    rec.write('slot/1', chunk(100));
    t.now = 2100;
    rec.write('slot/2', chunk(100));
    const idx = rec.close();
    assert.deepEqual(Object.keys(idx.tracks), ['slot/1', 'slot/2']);
    assert.equal(idx.tracks['slot/1'].file, 'slot_slot1.wav');
    assert.equal(idx.tracks['slot/2'].t0, 2000);
    assert.notEqual(idx.tracks['slot/1'].file, idx.tracks['slot/2'].file);
  });

  test('a slot silent for more than 10 minutes goes on without the zeros', () => {
    const t = { now: 1100 };
    const dir = tmp();
    const rec = new SlotRecorder({ dir, now: () => t.now });
    rec.write('trk', chunk(100));
    t.now += 20 * 60_000;
    rec.write('trk', chunk(100));
    const tr = rec.close().tracks.trk;
    assert.equal(tr.samples, 4800);
    assert.equal(tr.restarts, 1);
  });

  test('writes after close and empty chunks are ignored; close is idempotent', () => {
    const dir = tmp();
    const rec = new SlotRecorder({ dir, now: () => 1100 });
    rec.write('trk', new Int16Array(0));
    rec.write('', chunk(100));
    rec.write('trk', Buffer.from(chunk(100).buffer)); // Buffer input as the page sends it
    const a = rec.close();
    rec.write('trk', chunk(100));
    assert.deepEqual(rec.close(), a);
    assert.equal(a.tracks.trk.samples, 2400);
  });
});

describe('tools/record_turns.js: reading script', () => {
  test('all phrases once, labels from the kind, the same order for the same seed', () => {
    const s = buildScript(1);
    assert.equal(s.length, FINISHED.length + CUT_OFF.length + PAUSED.length);
    assert.deepEqual(s.map((x) => x.n), s.map((_, i) => i + 1));
    assert.ok(s.filter((x) => x.kind === 'finished').every((x) => x.label === 'finished'));
    assert.ok(s.filter((x) => x.kind === 'cut_off').every((x) => x.label === 'unfinished' && x.text.endsWith('…')));
    assert.ok(s.filter((x) => x.kind === 'paused').every((x) => x.parts[0].label === 'unfinished' && x.parts[1].label === 'finished'));
    assert.deepEqual(buildScript(1), s);
    assert.notDeepEqual(buildScript(2).map((x) => x.text), s.map((x) => x.text));
    assert.ok(s.every((x) => x.say.includes('«')));
  });

  test('the kinds are mixed, not in blocks', () => {
    const kinds = buildScript(1).map((x) => x.kind);
    const runs = kinds.filter((k, i) => i === 0 || k !== kinds[i - 1]).length;
    assert.ok(runs > kinds.length / 3, `${runs} runs in ${kinds.length}`);
  });
});
