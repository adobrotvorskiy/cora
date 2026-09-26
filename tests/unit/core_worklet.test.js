// PlayerWorklet (WP2 src/browser/worklets.js) run in Node with fake AudioWorklet globals:
// the flush/push race (audio pushed right after a flush must survive the fade) and EOS after a flush.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { PLAYER_WORKLET_SRC } from '../../src/browser/worklets.js';

const SR = 24_000;
const N = 128;

function loadProcessor() {
  const posts = [];
  class AudioWorkletProcessor {
    constructor() {
      this.port = { postMessage: (m) => posts.push(m), onmessage: null };
    }
  }
  let Cls = null;
  const registerProcessor = (name, cls) => {
    Cls = cls;
  };
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', PLAYER_WORKLET_SRC)(AudioWorkletProcessor, registerProcessor, SR);
  assert.ok(Cls, 'processor registered');
  const proc = new Cls({ processorOptions: { fadeMs: 4, drainGraceMs: 250, progressMs: 50 } });
  const send = (m) => proc.port.onmessage({ data: m });
  const push = (frames, value) => send({ type: 'push', pcm: new Int16Array(frames).fill(value) });
  const quantum = () => {
    const out = new Float32Array(N);
    proc.process([], [[out]]);
    return out;
  };
  const run = (quanta) => {
    const outs = [];
    for (let i = 0; i < quanta; i++) outs.push(quantum());
    return outs;
  };
  const types = () => posts.map((p) => p.type).filter((t) => t !== 'progress');
  return { proc, posts, send, push, quantum, run, types };
}

describe('player worklet: flush/push race', () => {
  test('a push right after a flush survives the fade and starts a new utterance', () => {
    const w = loadProcessor();
    w.push(4800, 16000); // 200 ms
    w.run(10); // 1280 frames rendered
    assert.deepEqual(w.types(), ['started']);
    w.send({ type: 'flush', id: 1 });
    w.push(2400, -8000); // the race: pushed before the fade finished
    w.send({ type: 'eos' });
    const outs = w.run(1); // fade quantum: 96 fade frames (4 ms), rest zero
    const flushed = w.posts.find((p) => p.type === 'flushed');
    assert.ok(flushed, 'flushed posted');
    assert.equal(flushed.id, 1);
    assert.equal(flushed.dropped_ms, Math.round(((4800 - 1280 - 96) / SR) * 1000));
    assert.ok(Math.abs(outs[0][0] - 16000 / 32768) < 1e-3, 'fade starts at full gain of the OLD audio');
    assert.equal(outs[0][127], 0, 'silence after the fade in the same quantum');
    // the new chunk plays next, untouched by the flush
    const next = w.run(1)[0];
    assert.ok(Math.abs(next[0] + 8000 / 32768) < 1e-3, 'new audio rendered after the flush');
    const started = w.posts.filter((p) => p.type === 'started');
    assert.equal(started.length, 2, 'second utterance started');
    assert.equal(started[1].utt, 2);
    // EOS sent during the fade is honoured for the new utterance
    w.run(20);
    const drained = w.posts.find((p) => p.type === 'drained');
    assert.ok(drained, 'drained');
    assert.equal(drained.reason, 'eos');
    assert.equal(drained.utt, 2);
    assert.equal(drained.played_ms, 100);
  });

  test('a second flush during the fade also drops what was pushed in between', () => {
    const w = loadProcessor();
    w.push(4800, 16000);
    w.run(4);
    w.send({ type: 'flush', id: 1 });
    w.push(2400, -8000);
    w.send({ type: 'flush', id: 2 });
    w.run(2);
    const flushed = w.posts.filter((p) => p.type === 'flushed');
    assert.equal(flushed.length, 1);
    assert.equal(flushed[0].id, 2);
    assert.equal(w.proc.queuedFrames, 0, 'nothing left');
    const out = w.run(1)[0];
    assert.equal(out[0], 0);
  });

  test('flush while idle answers at once; flush without rendered audio drops the queue immediately', () => {
    const w = loadProcessor();
    w.send({ type: 'flush', id: 7 });
    assert.deepEqual(w.posts.at(-1), { type: 'flushed', id: 7, utt: 0, played_ms: 0, dropped_ms: 0, consumed: 0, idle: true });
    w.push(2400, 1000);
    w.send({ type: 'flush', id: 8 }); // queued but not playing yet
    const f = w.posts.at(-1);
    assert.equal(f.type, 'flushed');
    assert.equal(f.id, 8);
    assert.equal(f.dropped_ms, 100);
    assert.equal(w.proc.queuedFrames, 0);
  });

  test('normal playback still drains on eos and reports underruns', () => {
    const w = loadProcessor();
    w.push(1280, 1000);
    w.run(10);
    w.send({ type: 'eos' });
    assert.equal(w.posts.at(-1).type, 'drained');
    assert.equal(w.posts.at(-1).reason, 'eos');
    w.push(128, 1000);
    w.run(1);
    w.run(3);
    assert.ok(w.posts.some((p) => p.type === 'underrun'), 'underrun reported while starved');
  });
});
