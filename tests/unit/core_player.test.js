// Fallback player (core/deps.js) over a fake PageAudio, plus the AsyncQueue/Serializer primitives.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPlayer } from '../../src/core/deps.js';
import { AsyncQueue, Serializer } from '../../src/core/events.js';

function fakeAudio() {
  const calls = [];
  return {
    calls,
    play: async (b64) => {
      calls.push(['play', Buffer.from(b64, 'base64').length]);
      return { queued_ms: 0 };
    },
    playEnd: async () => {
      calls.push(['playEnd']);
      return {};
    },
    flush: async () => {
      calls.push(['flush']);
      return { played_ms: 300, dropped_ms: 900 };
    },
  };
}

const pcm = (ms) => Buffer.alloc(ms * 48);

describe('fallback player', () => {
  test('clip: play + playEnd, completes on player.drained after EOS, ratio 1', async () => {
    const audio = fakeAudio();
    const p = createPlayer({ audio });
    const states = [];
    p.on('state', (s) => states.push(s.speaking));
    const h = p.play(pcm(1200), { meta: { key: 'handoff' } });
    assert.equal(p.isSpeaking(), true);
    await sleep(5);
    p.onPageEvent({ type: 'player.started', utt: 1 });
    p.onPageEvent({ type: 'player.drained', utt: 1, played_ms: 1200, reason: 'eos' });
    const r = await h.done;
    assert.equal(r.status, 'completed');
    assert.equal(r.total_ms, 1200);
    assert.equal(r.played_ms, 1200);
    assert.equal(r.played_ratio, 1);
    assert.ok(r.ttfa_ms >= 0);
    assert.equal(p.isSpeaking(), false);
    assert.deepEqual(audio.calls, [['play', 57600], ['playEnd']]);
    assert.deepEqual(states, [true, false]);
  });

  test('an early drained (underrun timeout before EOS) is ignored', async () => {
    const audio = fakeAudio();
    const p = createPlayer({ audio, doneTimeoutMs: 50 });
    const q = new AsyncQueue();
    const h = p.play(q, { meta: { kind: 'live' } });
    q.push(pcm(100));
    await sleep(5);
    p.onPageEvent({ type: 'player.drained', utt: 1, played_ms: 100, reason: 'timeout' });
    assert.equal(p.isSpeaking(), true, 'still streaming');
    q.push(pcm(200));
    q.end();
    await sleep(10);
    p.onPageEvent({ type: 'player.drained', utt: 2, played_ms: 200, reason: 'eos' });
    const r = await h.done;
    assert.equal(r.status, 'completed');
    assert.equal(r.total_ms, 300);
    assert.equal(r.source, 'live');
  });

  test('abort flushes the page and reports the played ratio', async () => {
    const audio = fakeAudio();
    const p = createPlayer({ audio });
    const h = p.play(pcm(1200));
    await sleep(5);
    p.onPageEvent({ type: 'player.started', utt: 1 });
    const r = await h.abort('barge_in');
    assert.equal(r.status, 'aborted');
    assert.equal(r.played_ms, 300);
    assert.equal(r.played_ratio, 0.25);
    assert.equal(r.reason, 'barge_in');
    assert.ok(audio.calls.some((c) => c[0] === 'flush'));
    assert.equal(p.isSpeaking(), false);
    assert.equal(p.stats().aborted, 1);
  });

  test('a second play pre-empts the first', async () => {
    const audio = fakeAudio();
    const p = createPlayer({ audio });
    const a = p.play(pcm(500));
    await sleep(2);
    const b = p.play(pcm(500));
    const ra = await a.done;
    assert.equal(ra.status, 'aborted');
    await sleep(5);
    p.onPageEvent({ type: 'player.drained', utt: 2, played_ms: 500, reason: 'eos' });
    assert.equal((await b.done).status, 'completed');
  });

  test('the next play waits for a pending flush before pushing audio', async () => {
    const calls = [];
    let releaseFlush;
    const audio = {
      play: async (b64) => calls.push(['play', b64.length]),
      playEnd: async () => calls.push(['playEnd']),
      flush: () => new Promise((r) => {
        calls.push(['flush']);
        releaseFlush = () => r({ played_ms: 100, dropped_ms: 100 });
      }),
    };
    const p = createPlayer({ audio });
    const a = p.play(pcm(200));
    await sleep(5);
    const aborting = a.abort('barge_in');
    await sleep(5);
    const b = p.play(pcm(100));
    await sleep(20);
    assert.deepEqual(calls.map((c) => c[0]), ['play', 'playEnd', 'flush'], 'second push held back until the flush resolves');
    releaseFlush();
    await aborting;
    await sleep(20);
    assert.deepEqual(calls.map((c) => c[0]), ['play', 'playEnd', 'flush', 'play', 'playEnd']);
    p.onPageEvent({ type: 'player.drained', utt: 2, played_ms: 100, reason: 'eos' });
    assert.equal((await b.done).status, 'completed');
  });

  test('page errors make the utterance fail instead of hanging', async () => {
    const p = createPlayer({ audio: { play: async () => { throw new Error('page closed'); }, playEnd: async () => {}, flush: async () => ({}) } });
    const r = await p.play(pcm(100)).done;
    assert.equal(r.status, 'failed');
    assert.match(r.error, /page closed/);
  });
});

describe('primitives', () => {
  test('AsyncQueue delivers pushed chunks in order and finishes on end()/abort()', async () => {
    const q = new AsyncQueue();
    const got = [];
    const consumer = (async () => {
      for await (const x of q) got.push(x);
    })();
    q.push(1);
    q.push(2);
    await sleep(1);
    q.push(3);
    q.end();
    await consumer;
    assert.deepEqual(got, [1, 2, 3]);
    assert.equal(q.push(4), false, 'closed');
    const q2 = new AsyncQueue();
    q2.push('a');
    q2.abort();
    const got2 = [];
    for await (const x of q2) got2.push(x);
    assert.deepEqual(got2, []);
  });

  test('Serializer runs handlers one at a time and survives errors', async () => {
    const errors = [];
    const s = new Serializer({ onError: (e) => errors.push(e.message) });
    const order = [];
    s.run(async () => {
      order.push('a1');
      await sleep(10);
      order.push('a2');
    });
    s.run(() => {
      throw new Error('boom');
    });
    const last = s.run(() => order.push('b'));
    await last;
    assert.deepEqual(order, ['a1', 'a2', 'b']);
    assert.deepEqual(errors, ['boom']);
  });
});
