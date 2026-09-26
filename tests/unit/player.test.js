// Offline tests for src/audio/player.js against a fake page (evaluate stub that simulates the WP2 page player).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { BYTES_PER_MS, ChunkStream, PAGE_FN, Player, pageErrorReason } from '../../src/audio/player.js';

const ms = (frames) => Math.round(frames / 24);

/** Simulates window.__host_* of page_inject.js: a PCM queue consumed at `speed` x real time. */
class FakePage extends EventEmitter {
  constructor({ speed = 1, forward = null, evalDelayMs = 0 } = {}) {
    super();
    this.speed = speed;
    this.forward = forward; // (ev) => void: the host's onEvent -> player.onPageEvent
    this.evalDelayMs = evalDelayMs;
    this.calls = [];
    this.events = [];
    this.received = [];
    this.queueFrames = 0;
    this.playing = false;
    this.eos = false;
    this.utt = 0;
    this.playedFrames = 0;
    this.underrunFrames = 0;
    this.maxQueuedMs = 0;
    this.closed = false;
    this.failNext = null;
    this.flushPending = false;
    this.lostPushes = 0; // pushes that landed while a flush fade was running (the worklet drops them)
    this.last = Date.now();
    this.timer = setInterval(() => this._tick(), 5);
  }

  _tick() {
    const now = Date.now();
    const frames = Math.round((now - this.last) * 24 * this.speed);
    this.last = now;
    if (!frames) return;
    if (this.queueFrames > 0) {
      if (!this.playing) {
        this.playing = true;
        this.utt += 1;
        this.playedFrames = 0;
        this._emit({ type: 'player.started', utt: this.utt, queued_ms: ms(this.queueFrames) });
      }
      const n = Math.min(frames, this.queueFrames);
      this.queueFrames -= n;
      this.playedFrames += n;
      this.underrunFrames = 0;
      if (this.queueFrames === 0 && this.eos) this._drain('eos');
    } else if (this.playing) {
      if (this.underrunFrames === 0) this._emit({ type: 'player.underrun', utt: this.utt, played_ms: ms(this.playedFrames) });
      this.underrunFrames += frames;
      if (this.underrunFrames >= 24 * 250) this._drain('timeout');
    }
  }

  _drain(reason) {
    this.playing = false;
    this.eos = false;
    this.underrunFrames = 0;
    this._emit({ type: 'player.drained', utt: this.utt, played_ms: ms(this.playedFrames), reason });
  }

  _emit(ev) {
    this.events.push(ev);
    if (this.forward) setImmediate(() => this.forward(ev)); // bindings are async
  }

  state() {
    return { queued_ms: ms(this.queueFrames), playing: this.playing, played_ms: ms(this.playedFrames), utt: this.utt, underruns: 0, ctx_state: 'running', worklet: 'ready' };
  }

  async evaluate(fn, arg) {
    if (this.closed) throw new Error('page.evaluate: Target page, context or browser has been closed');
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    if (this.evalDelayMs) await sleep(this.evalDelayMs);
    else await new Promise((r) => setImmediate(r));
    const t = Date.now();
    if (fn === PAGE_FN.play) {
      const buf = Buffer.from(arg, 'base64');
      this.calls.push({ fn: 'play', bytes: buf.length, t });
      if (this.flushPending) this.lostPushes++;
      this.received.push(buf);
      this.queueFrames += buf.length >> 1;
      this.eos = false;
      this.maxQueuedMs = Math.max(this.maxQueuedMs, ms(this.queueFrames));
      return this.state();
    }
    if (fn === PAGE_FN.playEnd) {
      this.calls.push({ fn: 'playEnd', t });
      this.eos = true;
      if (this.playing && this.queueFrames === 0) this._drain('eos');
      return this.state();
    }
    if (fn === PAGE_FN.flush) {
      this.calls.push({ fn: 'flush', t });
      this.flushPending = true;
      await sleep(3); // the fade-out ends at the next render quantum
      this.flushPending = false;
      const dropped = this.queueFrames;
      const played = this.playedFrames;
      const was = this.playing;
      this.queueFrames = 0;
      this.playing = false;
      this.eos = false;
      if (was || dropped) this._emit({ type: 'player.aborted', utt: this.utt, played_ms: ms(played), dropped_ms: ms(dropped) });
      return { played_ms: ms(played), dropped_ms: ms(dropped) };
    }
    if (fn === PAGE_FN.state) {
      this.calls.push({ fn: 'state', t });
      return this.state();
    }
    throw new Error(`unexpected page function: ${fn}`);
  }

  close() {
    this.closed = true;
    this.emit('close');
  }

  /** A new document: the adapter re-installs with an empty player (utt restarts). */
  navigate() {
    this.queueFrames = 0;
    this.playing = false;
    this.eos = false;
    this.utt = 0;
    this.playedFrames = 0;
    this._emit({ type: 'host.installed', top: true, version: 'wp2-1' });
  }

  dispose() {
    clearInterval(this.timer);
  }

  fnCalls(name) {
    return this.calls.filter((c) => c.fn === name);
  }
}

function tone(msLen, hz = 440, amp = 0.3) {
  const n = Math.round(msLen * 24);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / 24000) * amp * 32767), i * 2);
  return buf;
}

function makeLog() {
  const events = [];
  return { events, event: (type, fields = {}) => events.push({ type, ...fields }), of: (type) => events.filter((e) => e.type === type) };
}

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function setup({ speed = 4, forward = true, ...opts } = {}) {
  const log = makeLog();
  const page = new FakePage({ speed });
  const player = new Player({ page, log, ...opts });
  if (forward) page.forward = (ev) => player.onPageEvent(ev);
  const states = [];
  player.on('state', (s) => states.push(s.state));
  cleanups.push(() => {
    player.close();
    page.dispose();
  });
  return { page, player, log, states };
}

test('pageErrorReason maps Playwright errors', () => {
  assert.equal(pageErrorReason(new Error('page.evaluate: Target page, context or browser has been closed')), 'page_closed');
  assert.equal(pageErrorReason(new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')), 'navigated');
  assert.equal(pageErrorReason(new Error('page.evaluate: Page crashed')), 'page_crashed');
  assert.equal(pageErrorReason(new Error('TypeError: window.__host_play is not a function')), 'no_adapter');
  assert.equal(pageErrorReason(new Error('something else')), 'page_error');
});

test('play(Buffer): slices <= sliceMs, content intact, completes on player.drained, logs + states', async () => {
  const { page, player, log, states } = setup({ speed: 4 });
  const pcm = tone(1000);
  const h = player.play(pcm, { meta: { source: 'clip', text: 'Спасибо! Дальше Тиму́р.', key: 'handoff' } });
  assert.equal(player.isSpeaking(), true);
  const r = await h.done;
  assert.equal(r.status, 'completed');
  assert.equal(r.completion, 'event');
  assert.equal(r.played_ms, 1000);
  assert.equal(r.pushed_ms, 1000);
  assert.equal(r.total_ms, 1000);
  assert.equal(r.played_ratio, 1);
  assert.ok(Number.isFinite(r.ttfa_ms), 'ttfa for a clip = play() -> page started');
  assert.ok(page.fnCalls('play').every((c) => c.bytes <= 200 * BYTES_PER_MS), 'slices of at most 200 ms');
  assert.equal(page.fnCalls('play').length, 5);
  assert.ok(Buffer.concat(page.received).equals(pcm), 'page got exactly the clip');
  assert.equal(page.fnCalls('playEnd').length, 1);
  assert.equal(page.fnCalls('flush').length, 0);
  assert.deepEqual(states, ['starting', 'speaking', 'idle']);
  assert.equal(player.isSpeaking(), false);
  const start = log.of('speech.start')[0];
  assert.equal(start.source, 'clip');
  assert.equal(start.text, 'Спасибо! Дальше Тиму́р.');
  assert.equal(start.key, 'handoff');
  assert.ok(start.wait_ms >= 0);
  const end = log.of('speech.end')[0];
  assert.equal(end.played_ms, 1000);
  assert.equal(end.completion, 'event');
});

test('completes by polling __host_playerState when page events are not forwarded', async () => {
  const { page, player } = setup({ speed: 4, forward: false, pollMs: 30 });
  const r = await player.play(tone(400)).done;
  assert.equal(r.status, 'completed');
  assert.equal(r.completion, 'poll');
  assert.ok(page.fnCalls('state').length >= 1);
});

test('abort(): page flush + no more feeding; played = pushed - dropped; floor released at once', async () => {
  const { page, player, log, states } = setup({ speed: 1, maxLeadMs: 500 });
  const h = player.play(tone(3000), { meta: { text: 'длинная фраза' } });
  await sleep(300);
  const pending = h.abort('barge_in');
  assert.equal(player.isSpeaking(), false, 'idle right after abort()');
  assert.equal(player.state, 'idle');
  const r = await pending;
  assert.equal(r.status, 'aborted');
  assert.equal(r.reason, 'barge_in');
  const flushAt = page.calls.findIndex((c) => c.fn === 'flush');
  assert.ok(flushAt >= 0, 'flush was called');
  assert.equal(page.calls.slice(flushAt + 1).filter((c) => c.fn === 'play').length, 0, 'nothing fed after the flush');
  assert.equal(page.fnCalls('playEnd').length, 0);
  assert.ok(r.pushed_ms < 3000, `lead limit kept most of the clip in Node (pushed ${r.pushed_ms})`);
  assert.equal(r.played_ms + r.dropped_ms, r.pushed_ms);
  assert.ok(r.played_ms >= 150 && r.played_ms <= 450, `played ${r.played_ms}`);
  assert.ok(r.played_ratio > 0 && r.played_ratio < 0.2, `ratio ${r.played_ratio}`);
  const ab = log.of('speech.abort')[0];
  assert.equal(ab.reason, 'barge_in');
  assert.equal(ab.dropped_ms, r.dropped_ms);
  assert.deepEqual(states, ['starting', 'speaking', 'idle']);
  await sleep(100);
  assert.equal(page.calls.slice(flushAt + 1).filter((c) => c.fn === 'play').length, 0, 'still nothing fed later');
});

test('stream (5x real time): abort stops reading the source and calls onAbort', async () => {
  const { page, player } = setup({ speed: 1 });
  const stream = new ChunkStream();
  let produced = 0;
  const producer = setInterval(() => {
    if (produced >= 4000) return stream.end();
    stream.push(tone(50));
    produced += 50;
  }, 10);
  cleanups.push(() => clearInterval(producer));
  let aborts = 0;
  const h = player.play(stream, { meta: { source: 'live', text: 'живой текст' }, onAbort: () => aborts++ });
  await sleep(200);
  assert.ok(page.fnCalls('play').length > 0);
  const r = await h.abort();
  assert.equal(r.status, 'aborted');
  assert.equal(aborts, 1);
  assert.equal(stream.closed, true, 'iterator.return() closed the stream');
  assert.equal(stream.push(tone(50)), false, 'producer is told to stop');
  const flushAt = page.calls.findIndex((c) => c.fn === 'flush');
  await sleep(100);
  assert.equal(page.calls.slice(flushAt + 1).filter((c) => c.fn === 'play').length, 0);
  assert.equal(r.played_ms + r.dropped_ms, r.pushed_ms);
  assert.ok(r.pushed_ms > r.played_ms, 'audio arrived faster than real time and was queued in the page');
});

test('one playback at a time: busy rejection, queue, interrupt', async () => {
  const { page, player } = setup({ speed: 4 });
  const a = player.play(tone(800), { meta: { text: 'A' } });
  const b = player.play(tone(200), { meta: { text: 'B' } });
  await assert.rejects(b.done, (err) => err.code === 'busy');
  assert.equal(b.rejected, true);

  const c = player.play(tone(200), { meta: { text: 'C' }, queue: true });
  assert.equal(player.queueLength, 1);
  const ra = await a.done;
  assert.equal(ra.status, 'completed');
  const rc = await c.done;
  assert.equal(rc.status, 'completed');
  const playsA = page.calls.filter((cl) => cl.fn === 'play');
  assert.equal(playsA.length, 4 + 1, 'A in 4 slices, then C in one');
  assert.ok(page.calls.findIndex((cl) => cl.fn === 'playEnd') < page.calls.length - 2, 'C started after A ended');

  const d = player.play(tone(3000), { meta: { text: 'D' } });
  await sleep(80);
  const e = player.play(tone(200), { meta: { text: 'E' }, interrupt: true });
  const rd = await d.done;
  assert.equal(rd.status, 'aborted');
  assert.equal(rd.reason, 'interrupted');
  const re = await e.done;
  assert.equal(re.status, 'completed');
  assert.equal(player.stats().busy, 1);
  assert.equal(page.lostPushes, 0, 'E waited for the flush of D before its first push');
});

test('odd-sized stream chunks keep PCM16 sample alignment', async () => {
  const { page, player } = setup({ speed: 4 });
  const pcm = tone(300, 700);
  const cuts = [1, 4801, 3, 2, 999, 4000, 7];
  const chunks = [];
  let off = 0;
  for (const n of cuts) {
    chunks.push(pcm.subarray(off, off + n));
    off += n;
  }
  chunks.push(pcm.subarray(off));
  const r = await player.play(chunks).done;
  assert.equal(r.status, 'completed');
  assert.ok(page.fnCalls('play').every((c) => c.bytes % 2 === 0), 'every slice is whole samples');
  assert.ok(Buffer.concat(page.received).equals(pcm));
});

test('lead limit keeps the page queue near maxLeadMs', async () => {
  const { page, player } = setup({ speed: 1, maxLeadMs: 300, sliceMs: 100 });
  const r = await player.play(tone(1500)).done;
  assert.equal(r.status, 'completed');
  assert.ok(page.maxQueuedMs <= 300 + 100 + 60, `page queue peaked at ${page.maxQueuedMs} ms`);
});

test('page closed mid-play -> failed page_closed; later plays fail fast', async () => {
  const { page, player } = setup({ speed: 1 });
  const h = player.play(tone(2000));
  await sleep(100);
  page.close();
  const r = await h.done;
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'page_closed');
  assert.equal(page.fnCalls('flush').length, 0, 'no flush on a closed page');
  assert.equal(player.isSpeaking(), false);
  const r2 = await player.play(tone(100)).done;
  assert.equal(r2.status, 'failed');
  assert.equal(r2.reason, 'page_closed');
});

test('navigation: host.installed aborts without flush; destroyed context -> navigated; next play works', async () => {
  const { page, player } = setup({ speed: 1 });
  const h = player.play(tone(2000));
  await sleep(100);
  page.navigate();
  const r = await h.done;
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'navigated');
  assert.equal(page.fnCalls('flush').length, 0);

  page.failNext = new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
  const r2 = await player.play(tone(200)).done;
  assert.equal(r2.status, 'failed');
  assert.equal(r2.reason, 'navigated');

  page.speed = 4;
  const r3 = await player.play(tone(200)).done;
  assert.equal(r3.status, 'completed');
});

test('stall: the page never drains -> failed stall with a flush', async () => {
  const { page, player } = setup({ speed: 0, stallMarginMs: 150, pollMs: 30 });
  const r = await player.play(tone(100)).done;
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'stall');
  assert.equal(page.fnCalls('flush').length, 1);
});

test('source errors: before audio -> failed source_error; after audio -> completed partial', async () => {
  const { player } = setup({ speed: 4 });
  const s1 = new ChunkStream();
  const h1 = player.play(s1, { meta: { source: 'live' } });
  s1.fail(new Error('readout failed: disconnected'));
  const r1 = await h1.done;
  assert.equal(r1.status, 'failed');
  assert.equal(r1.reason, 'source_error');
  assert.equal(r1.played_ms, 0);

  const s2 = new ChunkStream();
  const h2 = player.play(s2, { meta: { source: 'live' } });
  s2.push(tone(200));
  await sleep(20);
  s2.fail(new Error('readout failed: timeout'));
  const r2 = await h2.done;
  assert.equal(r2.status, 'completed');
  assert.equal(r2.partial, true);
  assert.equal(r2.played_ms, 200);
});

test('playLive: ttfa from mouth onStart reaches speech.start; abort cancels the readout', async () => {
  const { player, log } = setup({ speed: 1 });
  let cancelled = 0;
  const mouth = {
    say(text, o) {
      let timer = null;
      let n = 0;
      const start = setTimeout(() => {
        o.onStart({ id: 'say-1', ttfa_ms: 42 });
        timer = setInterval(() => {
          if (++n > 40) {
            clearInterval(timer);
            o.onEnd({ status: 'completed' });
            return;
          }
          o.onAudio(tone(100));
        }, 20);
      }, 30);
      cleanups.push(() => {
        clearTimeout(start);
        clearInterval(timer);
      });
      return {
        id: 'say-1',
        done: Promise.resolve({ status: 'completed' }),
        cancel() {
          cancelled++;
          clearTimeout(start);
          clearInterval(timer);
          o.onEnd({ status: 'cancelled' });
          return Promise.resolve({ status: 'cancelled' });
        },
      };
    },
  };
  const h = player.playLive(mouth, 'Андре́й, тебе слово.', { meta: { trigger: 'turn_end' } });
  assert.equal(player.state, 'starting');
  await sleep(150);
  assert.equal(player.state, 'speaking');
  const start = log.of('speech.start')[0];
  assert.equal(start.source, 'live');
  assert.equal(start.ttfa_ms, 42);
  assert.equal(start.trigger, 'turn_end');
  const r = await h.abort('barge_in');
  assert.equal(r.status, 'aborted');
  assert.equal(r.ttfa_ms, 42);
  assert.equal(cancelled, 1);
  assert.equal(r.text, 'Андре́й, тебе слово.');
});

test('stop() drops the queue and aborts the active playback', async () => {
  const { player } = setup({ speed: 1 });
  const a = player.play(tone(1000));
  const b = player.play(tone(1000), { queue: true });
  await sleep(50);
  const ra = await player.stop('kill_switch');
  assert.equal(ra.reason, 'kill_switch');
  const rb = await b.done;
  assert.equal(rb.status, 'aborted');
  assert.equal(rb.reason, 'kill_switch');
  assert.equal(rb.played_ms, 0);
  assert.equal((await a.done).status, 'aborted');
  assert.equal(player.isSpeaking(), false);
});

test('WP6 wiring: {page: PageAudio, audio: PageAudio} and a PageAudio without a page both work', async () => {
  const fake = new FakePage({ speed: 4 });
  cleanups.push(() => fake.dispose());
  // shape of page_inject.js PageAudio: {page, play(b64), playEnd(), flush(), state()}
  const audio = { page: fake, play: () => assert.fail('page.evaluate path expected'), playEnd() {}, flush() {}, state() {} };
  const log = makeLog();
  const p1 = new Player({ page: audio, audio, log, logSpeech: false });
  fake.forward = (ev) => p1.onPageEvent(ev);
  const states = [];
  p1.on('state', (st) => states.push(st.speaking));
  const r1 = await p1.play(tone(300), { meta: { key: 'handoff' }, source: 'clip' }).done;
  assert.equal(r1.status, 'completed');
  assert.equal(r1.source, 'clip');
  assert.deepEqual(states, [true, true, false], 'state events carry speaking');
  assert.equal(log.of('speech.start').length + log.of('speech.end').length, 0, 'logSpeech: false');
  p1.close();

  const calls = [];
  const bare = {
    play: (b64) => (calls.push('play'), fake.evaluate(PAGE_FN.play, b64)),
    playEnd: () => (calls.push('playEnd'), fake.evaluate(PAGE_FN.playEnd)),
    flush: () => (calls.push('flush'), fake.evaluate(PAGE_FN.flush)),
    state: () => fake.evaluate(PAGE_FN.state),
  };
  const p2 = new Player({ audio: bare, pollMs: 20 });
  fake.forward = null;
  const r2 = await p2.play(tone(300)).done;
  assert.equal(r2.status, 'completed');
  assert.deepEqual([...new Set(calls)], ['play', 'playEnd']);
  const h = p2.play(tone(2000));
  await sleep(50);
  const r3 = await h.abort('barge_in');
  assert.equal(r3.status, 'aborted');
  assert.ok(calls.includes('flush'));
  p2.close();
  assert.throws(() => new Player({ page: {} }), /PageAudio/);
});
