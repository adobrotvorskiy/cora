// Host event loop (WP6) with fakes for browser, page audio, voice, player, clips and brain.
// The wall clock is injected (deps.now) so the floor timing is driven by the test; the host's
// 50 ms tick runs for real, so each step waits a little for the serializer to catch up.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, test } from 'node:test';
import * as clock from '../../src/clock.js';
import { createHost, applySttFixes, loadSttFixes, looksLikeQuestion, sameLine } from '../../src/core/host.js';
import { loadRoster } from '../../src/core/state.js';

clock.setSimulatedStart('09:50'); // the 10:00 timers stay out of the way
clock.setSimulatedDay('tue'); // pin the weekday: phrase keys (closing_monday vs closing_daily) must not depend on the real calendar
const tmpDirs = [];
const hosts = [];
after(async () => {
  for (const h of hosts) h.host.finish('test_cleanup'); // a failed assertion must not leave a host ticking
  await Promise.all(hosts.map((h) => h.run));
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'people_test.json');
const SETTINGS = {
  meeting_url: 'https://telemost.360.yandex.ru/j/000',
  display_name: 'Кора (ИИ-ведущая)',
  times: { join: '09:58', start: '10:00', wait_lead_until: '10:02', soft_deadline: '10:28', hard_deadline: '10:30', force_leave: '10:35', transcription_cutoff: '10:40' },
  floor: {},
  brain: { openrouter_model: 'x', timeout_ms: 1000, min_interval_ms: 0 },
  keys: { openai: 'X_OPENAI', openrouter: 'X_OR', telegram: 'X_TG' },
  browser: {},
  telegram: {},
  avatar: null,
  engagement: { ack: true },
};
const LOUD = [-30, -30];
const QUIET = [-100, -100];
const tile = (name) => ({ name, isSelf: false, muted: false, cameraOn: false, speaking: false, trackId: 't', visible: true });

function fakePlayer(now) {
  const em = new EventEmitter();
  const plays = [];
  let current = null;
  const p = {
    plays,
    auto: 30,
    abortDelayMs: 0, // > 0: a slow page flush, done resolves that much after abort()
    play(src, { meta } = {}) {
      const u = { meta, t: now(), finished: false, aborts: [] };
      u.done = new Promise((r) => {
        u.resolve = r;
      });
      const end = (result) => {
        if (u.finished) return;
        u.finished = true;
        if (current === u) current = null;
        em.emit('state', { speaking: false });
        u.resolve(result);
      };
      u.abort = async (reason) => {
        u.aborts.push({ reason, at: Date.now() }); // the real player cuts the audio here, before the flush
        if (p.abortDelayMs) await sleep(p.abortDelayMs);
        end({ status: 'aborted', reason, played_ms: 10, total_ms: 100, played_ratio: 0.1 });
        return u.done;
      };
      u.complete = () => end({ status: 'completed', played_ms: 100, total_ms: 100, played_ratio: 1 });
      current = u;
      plays.push(u);
      em.emit('state', { speaking: true });
      if (p.auto) setTimeout(u.complete, p.auto);
      return { id: `u${plays.length}`, done: u.done, abort: u.abort };
    },
    isSpeaking: () => current !== null,
    on: (t, fn) => em.on(t, fn),
    onPageEvent() {},
    stats: () => ({ plays: plays.length }),
    close() {},
    current: () => current,
  };
  return p;
}

function fakeMouth() {
  return {
    say(text, { onAudio, onEnd } = {}) {
      const done = (async () => {
        await sleep(5);
        onAudio?.(Buffer.alloc(4800).toString('base64'));
        await sleep(5);
        const r = { status: 'completed', audio_ms: 100 };
        onEnd?.(r);
        return r;
      })();
      return { id: 'say', done, cancel: () => done };
    },
    renderClip: async () => Buffer.alloc(0),
    cancelAll: async () => [],
    identity: null,
    close() {},
    stats: () => ({}),
  };
}

function makeHost({ present = [], brainScript = null, brainHang = false, flags = {}, voiceConnectError = false, onDemand = false, prefetch = false, agent = null, deps: extraDeps = {} } = {}) {
  const t = { now: 1_000_000 };
  const now = () => t.now;
  const events = [];
  const log = { event: (type, fields = {}) => (events.push({ type, ...fields, t_real: Date.now() }), { type }), path: 'test', close() {} };
  // never the real state/STOP: a test host must not clear or obey the flag of a live host
  const stateDir = mkdtempSync(join(tmpdir(), 'standup-host-'));
  tmpDirs.push(stateDir);
  const stopFile = join(stateDir, 'STOP');
  const player = fakePlayer(now);
  const ears = new EventEmitter();
  Object.assign(ears, { pushAudio: () => true, close() {}, stats: () => ({}), flush() {} });
  const mouth = fakeMouth();
  const prefetched = [];
  if (prefetch) mouth.prefetch = (text) => (prefetched.push(text), true);
  const voice = {
    kind: 'fake',
    ears,
    mouth,
    connect: voiceConnectError ? async () => { throw new Error('voice connect boom'); } : async () => ({}),
    close: async () => {},
    stats: () => ({ kind: 'fake' }),
  };
  const joins = [];
  const alerts = [];
  const clips = {
    phrases: { ack: 1, ack_short: 1, ack_blocker: 1 },
    get: (key, { person } = {}) => ({ pcm: Buffer.alloc(4800), text: `${key}:${person?.id ?? person ?? ''}`, duration_ms: 100, key, source: 'clip' }),
    text: (key, { person } = {}) => `${key}:${person?.id ?? person ?? ''}`,
    has: () => false,
    hash: () => 'x',
    getByHash: () => null,
    setPresent() {},
    warmup: async () => ({ rendered: 0, failed: 0, planned: 0 }),
    stats: () => ({}),
    identity: {},
    dir: '',
  };
  let tiles = present.map(tile);
  let observerCb = null;
  const brainCalls = [];
  const brain = brainScript || brainHang
    ? {
        decide: async (ctxFn, { trigger, onText } = {}) => {
          const ctx = typeof ctxFn === 'function' ? ctxFn() : ctxFn;
          brainCalls.push({ trigger, ctx });
          if (brainHang) return new Promise(() => {}); // a brain that never answers
          const action = brainScript(trigger, ctx) ?? { why: '', action: 'wait', to: null, text: null, plan: null };
          if (action.text) onText?.({ action: action.action, to: action.to, text: action.text, trigger }); // streamed `text` before `plan`
          return { status: 'ok', action, latency_ms: 1, usage: {} };
        },
        warmup: async () => ({ status: 'ok', latency_ms: 1 }),
        stats: () => ({ cost_usd: 0 }),
        close() {},
        provider: 'fake',
        model: 'fake',
      }
    : null;
  const deps = {
    now,
    launchBrowser: async () => ({ context: { on() {} }, page: { on() {}, evaluate: async () => ({}) }, userDataDir: '', close: async () => {} }),
    attachPageAudio: async () => ({ play: async () => ({}), playEnd: async () => ({}), flush: async () => ({ played_ms: 0, dropped_ms: 0 }) }),
    serveAssets: async () => ({}),
    telemost: {
      join: async (...a) => {
        joins.push(a);
        return { status: 'joined', tookMs: 1 };
      },
      installObservers: async (page, cb) => {
        observerCb = cb;
        return async () => {};
      },
      getParticipants: async () => tiles,
      leave: async () => ({ ok: true }),
      setHideIncomingVideo: async () => ({}),
      closePanels: async () => {},
    },
    loadVoice: async () => voice,
    loadPlayer: async () => player,
    loadClips: async () => clips,
    createBrain: brain ? () => brain : null,
    sendAlert: async (text, o) => {
      alerts.push({ text, level: o?.level });
      return { ok: true };
    },
    roster: loadRoster({ path: FIXTURE }),
    sttFixes: loadSttFixes(),
    stopFile, // the production poll interval (250 ms) stays
    ...(agent ? { createAgent: () => agent } : {}),
    ...extraDeps,
  };
  let settings = onDemand ? { ...SETTINGS, times: null } : SETTINGS;
  if (agent) settings = { ...settings, voice: { host: 'agent' } };
  const host = createHost({ settings, flags: { brain: Boolean(brain || agent), alert: false, ...flags }, log, deps });
  const run = host.run();
  const api = {
    host,
    player,
    ears,
    events,
    brainCalls,
    prefetched,
    joins,
    alerts,
    t,
    run,
    stopFile,
    /** advance the fake wall clock in 100 ms steps feeding level frames, letting the host tick between steps */
    async advance(ms, mix = QUIET) {
      const end = t.now + ms;
      while (t.now < end) {
        t.now += 100;
        host.floor.onLevels(mix, { t: t.now });
        await sleep(12);
      }
      await sleep(80);
      await host._test.idle();
    },
    async settle(ms = 120) {
      await sleep(ms);
      await host._test.idle();
    },
    setTiles(names) {
      tiles = names.map(tile);
      observerCb?.({ type: 'participants', list: tiles });
    },
    /** Telemost's active-speaker marker: the tiles lit now */
    lit(names) {
      observerCb?.({ type: 'speaker', names });
    },
    types: (re) => events.filter((e) => re.test(e.type)).map((e) => e.type),
    find: (type) => events.filter((e) => e.type === type),
    async ready() {
      const t0 = Date.now();
      while (!observerCb && Date.now() - t0 < 3000) await sleep(20);
      assert.ok(observerCb, 'host set up');
      api.setTiles(present);
      await api.settle();
    },
    async finish() {
      host.finish('test');
      return run;
    },
  };
  hosts.push(api);
  return api;
}

describe('host: turn end = ack + handoff, false ends revert', () => {
  test('closer -> ack clip -> handoff clip -> next speaker; statuses updated', async () => {
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'] });
    await h.ready();
    h.host._test.beginRound('tkach_t');
    assert.equal(h.host.state.current, 'tkach_t');
    await h.advance(8000, LOUD);
    h.host.floor.onSttDelta({ so_far: 'сегодня тесты, у меня всё', t: h.t.now });
    await h.advance(1000, QUIET); // > closer_handoff_ms of silence -> candidate -> ack -> handoff
    await h.settle(400);
    const keys = h.player.plays.map((p) => p.meta.key);
    assert.deepEqual(keys, ['ack', 'handoff_plain'], `plays: ${keys}`);
    assert.equal(h.player.plays[0].meta.person, 'tkach_t');
    assert.equal(h.player.plays[1].meta.person, 'nevsky_g');
    assert.equal(h.host.state.current, 'nevsky_g');
    assert.equal(h.host.state.get('tkach_t').status, 'spoke');
    assert.ok(h.find('turn.end').length === 1 && h.find('turn.end')[0].reason === 'closer');
    const code = await h.finish();
    assert.equal(code, 0);
  });

  test('a VAD stop mid-pause never ends the turn: silence leads to «всё?» instead', async () => {
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'] });
    await h.ready();
    h.host._test.beginRound('tkach_t');
    h.host.floor.onVad({ type: 'start', t: h.t.now });
    await h.advance(8000, LOUD);
    h.host.floor.onVad({ type: 'stop', t: h.t.now });
    await h.advance(1500, QUIET);
    assert.deepEqual(h.player.plays.map((p) => p.meta.key), [], 'no handoff after a vad stop');
    assert.equal(h.host.state.current, 'tkach_t');
    await h.advance(1500, QUIET); // 3 s of silence -> check_done
    await h.settle(200);
    assert.deepEqual(h.player.plays.map((p) => p.meta.key), ['check_done']);
    // «да» -> turn ends -> ack + handoff
    await h.advance(300, LOUD);
    h.host.floor.onSttDelta({ so_far: 'да', t: h.t.now });
    await h.advance(1000, QUIET);
    await h.settle(500);
    assert.deepEqual(h.player.plays.map((p) => p.meta.key), ['check_done', 'ack', 'handoff_plain']);
    assert.equal(h.host.state.current, 'nevsky_g');
    await h.finish();
  });

  test('barge-in during the ack = false end: speaker keeps the floor, no handoff, later closer works', async () => {
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'] });
    await h.ready();
    h.host._test.beginRound('tkach_t');
    h.player.auto = 0; // manual completion so the ack is "playing" when the speaker resumes
    await h.advance(8000, LOUD);
    h.host.floor.onSttDelta({ so_far: 'у меня всё', t: h.t.now });
    await h.advance(1000, QUIET);
    await h.settle(200);
    assert.equal(h.player.plays.length, 1, 'ack is playing');
    assert.equal(h.player.plays[0].meta.key, 'ack');
    // the speaker goes on: VAD start while we speak -> barge-in
    h.host.floor.onVad({ type: 'start', t: h.t.now });
    await h.settle(200);
    assert.equal(h.player.plays.length, 1, 'no handoff after the false end');
    assert.equal(h.player.plays[0].finished, true, 'ack aborted');
    assert.equal(h.host.state.current, 'tkach_t');
    assert.equal(h.host.state.get('tkach_t').status, 'speaking');
    assert.equal(h.host.phase, 'round');
    assert.equal(h.find('turn.end_reverted').length, 1);
    assert.equal(h.find('turn.end_reverted')[0].why, 'barge_in_during_ack');
    // he finishes for real
    h.player.auto = 30;
    await h.advance(2000, LOUD);
    h.host.floor.onVad({ type: 'stop', t: h.t.now });
    h.host.floor.onSttDelta({ so_far: 'вот как-то так', t: h.t.now });
    await h.advance(2000, QUIET); // after a barge-in the host waits 1.5 s of silence before speaking
    await h.settle(500);
    assert.deepEqual(h.player.plays.slice(1).map((p) => p.meta.key), ['ack', 'handoff_plain']);
    assert.equal(h.host.state.current, 'nevsky_g');
    await h.finish();
  });
});

describe('host: open floor and closing', () => {
  test('empty plan -> open floor; 6 s of silence -> closing; speech in between defers; barge-in on the closing returns to open floor', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    h.host._test.beginRound('tkach_t');
    await h.advance(8000, LOUD);
    h.host.floor.onSttDelta({ so_far: 'у меня всё', t: h.t.now });
    await h.advance(1000, QUIET);
    await h.settle(400);
    assert.deepEqual(h.player.plays.map((p) => p.meta.key), ['ack', 'open_floor']);
    assert.equal(h.host.phase, 'open_floor');
    assert.equal(h.host.state.get('tkach_t').status, 'spoke');
    await h.advance(3000, QUIET);
    assert.equal(h.host.phase, 'open_floor', 'not yet');
    await h.advance(1000, LOUD); // someone speaks after the question
    await h.advance(7000, QUIET);
    assert.equal(h.player.plays.length, 2, 'no closing 7 s after speech (scripted mode waits 12 s)');
    h.player.auto = 0;
    await h.advance(6000, QUIET);
    await h.settle(200);
    assert.equal(h.player.plays.length, 3, 'closing started');
    assert.equal(h.player.plays[2].meta.key, 'closing_daily');
    assert.equal(h.host.phase, 'closing');
    h.host.floor.onVad({ type: 'start', t: h.t.now }); // interrupted farewell
    await h.settle(200);
    assert.equal(h.host.phase, 'open_floor');
    assert.equal(h.find('round.closing_reverted').length, 1);
    assert.equal(h.find('host.finish').length, 0, 'did not leave');
    h.host.floor.onVad({ type: 'stop', t: h.t.now });
    h.player.auto = 30;
    await h.advance(13_000, QUIET);
    await h.settle(200);
    assert.equal(h.player.plays.length, 4, 'closing again after 12 s of silence');
    const code = await h.run;
    assert.equal(code, 0);
    assert.match(h.find('host.finish')[0].reason, /closing/);
  });
});

describe('host: questions and duplicate answers', () => {
  test('the brain line is prefetched from the stream (limited like the spoken one), never for clip lines or in shadow', async () => {
    const long = 'Я тут, всё слышу хорошо. Начнём, когда соберутся все. Пока расскажу, как я устроена, это займёт минуту.';
    const script = (trigger) => (trigger === 'question_to_host' ? { why: '', action: 'answer', to: null, text: long, plan: null } : null);
    const h = makeHost({ present: ['Сергей Белозерский'], brainScript: script, prefetch: true });
    await h.ready();
    h.ears.emit('stt_final', { item_id: 'p1', text: 'Кора, ты тут?', t: h.t.now, t_speech_start: h.t.now - 900, t_speech_end: h.t.now });
    await h.settle(300);
    assert.equal(h.prefetched.length, 1);
    assert.equal(h.prefetched[0], h.player.plays[0].meta.text, 'the prefetched text is exactly the spoken one');
    assert.ok(h.prefetched[0].length < long.length, 'limited like applyAction does');
    assert.equal(h.find('speech.prefetch')[0].trigger, 'question_to_host');
    await h.finish();

    const shadow = makeHost({ present: ['Сергей Белозерский'], brainScript: script, prefetch: true, flags: { shadow: true } });
    await shadow.ready();
    shadow.ears.emit('stt_final', { item_id: 'p2', text: 'Кора, ты тут?', t: shadow.t.now, t_speech_start: shadow.t.now - 900, t_speech_end: shadow.t.now });
    await shadow.settle(300);
    assert.equal(shadow.brainCalls.length > 0, true);
    assert.deepEqual(shadow.prefetched, []);
    await shadow.finish();
  });

  test('a question without her name in a 1:1 goes to the brain; a second answer to the same question is dropped', async () => {
    const script = (trigger) => (trigger === 'question_to_host' || trigger === 'timer' ? { why: '', action: 'answer', to: 'belozersky_s', text: 'Я Кора, ИИ-ведущая стендапов. Ждём остальных.', plan: null } : null);
    const h = makeHost({ present: ['Сергей Белозерский'], brainScript: script });
    await h.ready();
    h.ears.emit('stt_final', { item_id: 'i1', text: 'Ты кто?', t: h.t.now, t_speech_start: h.t.now - 1000, t_speech_end: h.t.now });
    await h.settle(300);
    assert.deepEqual(h.brainCalls.map((c) => c.trigger).filter((x) => x === 'question_to_host'), ['question_to_host']);
    assert.equal(h.find('host.question')[0].how, 'small_group');
    assert.equal(h.player.plays.length, 1);
    assert.equal(h.player.plays[0].meta.kind, 'answer');
    await h.host._test.applyAction({ why: '', action: 'answer', to: 'belozersky_s', text: 'Я Кора, ИИ-ведущая стендапов. Сергей, начнём, когда придёт Ярослав.', plan: null }, 'timer');
    await h.settle(100);
    assert.equal(h.player.plays.length, 1, 'duplicate answer dropped');
    assert.ok(h.find('host.action_ignored').some((e) => e.action === 'answer'));
    // a plain statement in a bigger group is not a question to her
    h.setTiles(['Сергей Белозерский', 'Тимур Ткач', 'Глеб Невский']);
    await h.settle();
    h.ears.emit('stt_final', { item_id: 'i2', text: 'Сегодня релиз, потом ревью.', t: h.t.now });
    h.ears.emit('stt_final', { item_id: 'i3', text: 'А кто вообще ведёт?', t: h.t.now });
    await h.settle(200);
    assert.equal(h.brainCalls.filter((c) => c.trigger === 'question_to_host').length, 1, 'group question without a hint is not hers');
    h.ears.emit('stt_final', { item_id: 'i4', text: 'Кара, а ты кто?', t: h.t.now });
    await h.settle(200);
    assert.equal(h.brainCalls.filter((c) => c.trigger === 'question_to_host').length, 2, 'her name (misheard) is hers');
    assert.equal(h.find('host.question').at(-1).how, 'name');
    await h.finish();
  });

  test('STT fixes are applied to transcripts (Акме -> Acme, дев синк -> дев-синк)', async () => {
    const h = makeHost({ present: ['Сергей Белозерский'] });
    await h.ready();
    h.ears.emit('stt_final', { item_id: 'i1', text: 'У меня Акме, потом дев синк.', t: h.t.now });
    await h.settle(150);
    const line = h.find('transcript')[0];
    assert.equal(line.text, 'У меня Acme, потом дев-синк.');
    assert.equal(line.raw, 'У меня Акме, потом дев синк.');
    await h.finish();
  });
});

describe('host: kill switch (state/STOP file, «Кора, уйди из встречи») leaves the meeting', () => {
  const LINE = { why: '', action: 'speak', to: null, text: 'Коллеги, пара слов про порядок сегодня.', plan: null };

  /** Real ms until cond() holds, polled every 10 ms; Infinity after `limit` ms. */
  async function within(limit, cond) {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > limit) return Infinity;
      await sleep(10);
    }
    return Date.now() - t0;
  }

  /** Host in 'waiting' with a quiet room and one line playing (never completes by itself). */
  async function speaking(opts = {}) {
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'], ...opts });
    await h.ready();
    await h.advance(1500, QUIET);
    h.player.auto = 0;
    await h.host._test.applyAction(LINE, 'timer');
    await h.settle(100);
    assert.equal(h.player.plays.length, 1, 'a line is playing');
    assert.equal(h.player.plays[0].finished, false);
    return h;
  }

  test('STOP file while a line plays and the event queue is busy: the line is cut and she leaves within ~1 s; nothing after', async (t) => {
    const h = await speaking();
    const line = h.player.plays[0];
    void h.host._test.run(() => sleep(2500)); // a handler holding the event queue
    writeFileSync(h.stopFile, 'stop-standup.ps1 test');
    const t0 = Date.now();
    const took = await within(1500, () => h.host.phase === 'left');
    assert.ok(took <= 1500, `left the meeting after ${took} ms (queue busy)`);
    t.diagnostic(`state/STOP -> left in ${took} ms (poll 250 ms, queue busy)`);
    const stop = h.find('guard.stop');
    assert.equal(stop.length, 1);
    assert.equal(stop[0].source, 'file');
    assert.ok(stop[0].t_real - t0 <= 1000, `guard.stop after ${stop[0].t_real - t0} ms`);
    assert.equal(h.find('host.kill_leave')[0]?.source, 'file');
    const cut = line.aborts.find((a) => a.reason === 'kill_switch');
    assert.ok(cut && cut.at - t0 <= 1000, 'the playing line is cut within 1 s');
    // the queue drains: nothing new is said, the run finished, the flag stays in place
    void h.host._test.applyAction({ ...LINE, text: 'Ещё одна реплика уже после стопа.' }, 'timer');
    await h.settle(2600);
    assert.equal(h.player.plays.length, 1, 'no speech after STOP');
    assert.equal(h.host.phase, 'left');
    assert.ok(existsSync(h.stopFile), 'a flag created during the run is never removed by the host');
    const code = await h.run;
    assert.equal(code, 0, 'kill switch is a clean exit');
    assert.equal(h.find('host.finish')[0].reason, 'kill_switch');
  });

  test('a line waiting for the room to go quiet never starts after STOP', async () => {
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'] });
    await h.ready();
    await h.advance(1500, QUIET);
    h.host.floor.onVad({ type: 'start', t: h.t.now }); // someone talks: the line waits for the floor
    await h.host._test.applyAction(LINE, 'timer');
    await h.settle(200);
    assert.equal(h.player.plays.length, 0, 'waiting for the floor');
    writeFileSync(h.stopFile, '');
    const took = await within(1500, () => h.host.phase === 'left');
    assert.ok(took <= 1500, `left the meeting after ${took} ms`);
    h.host.floor.onVad({ type: 'stop', t: h.t.now }); // the room goes quiet
    await h.advance(3000, QUIET);
    await h.settle(200);
    assert.equal(h.player.plays.length, 0, 'the waiting line was not played after STOP');
    const code = await h.run;
    assert.equal(code, 0);
  });

  test('«Кара, уйди» over her own line while the barge-in abort hangs (slow flush), brain hung: she leaves within ~1 s', async (t) => {
    const h = await speaking({ brainHang: true });
    h.player.abortDelayMs = 1500; // the page flush hangs: the barge-in handler holds the event queue
    h.host.floor.onVad({ type: 'start', t: h.t.now }); // the speaker talks over her -> barge-in
    await sleep(50);
    const t0 = Date.now();
    h.ears.emit('stt_final', { item_id: 'k1', text: 'Кара, уйди.', t: h.t.now, t_speech_start: h.t.now - 900, t_speech_end: h.t.now });
    const took = await within(1500, () => h.host.phase === 'left');
    assert.ok(took <= 1500, `left the meeting after ${took} ms (barge-in abort pending)`);
    t.diagnostic(`«Кара, уйди.» final -> left in ${took} ms (barge-in abort pending)`);
    assert.equal(h.find('guard.stop')[0]?.source, 'voice');
    assert.ok(h.find('guard.stop')[0].t_real - t0 <= 1000);
    await h.settle(1700);
    assert.deepEqual(h.brainCalls.map((c) => c.trigger), [], 'the brain is neither asked nor awaited');
    assert.equal(h.player.plays.length, 1, 'nothing said after the stop');
    assert.equal(h.host.phase, 'left');
    const code = await h.run;
    assert.equal(code, 0);
  });

  test('STT variants of the leave phrase (final or delta): Кора, Кара, Карра, Карат, Cora -> she leaves, no brain', async () => {
    const variants = [
      ['stt_final', 'Кора, уйди из встречи.'],
      ['stt_delta', 'Кара, уходи'],
      ['stt_final', 'Корра, выйди!'],
      ['stt_delta', 'Карат, уйди'],
      ['stt_final', 'Cora, leave.'],
      ['stt_final', 'Выйди, Кора.'],
    ];
    for (const [kind, phrase] of variants) {
      const h = await speaking({ brainHang: true });
      const line = h.player.plays[0];
      const t0 = Date.now();
      if (kind === 'stt_delta') h.ears.emit('stt_delta', { item_id: 'k1', text: phrase, so_far: phrase, t: h.t.now });
      else h.ears.emit('stt_final', { item_id: 'k1', text: phrase, t: h.t.now, t_speech_start: h.t.now - 900, t_speech_end: h.t.now });
      const took = await within(1500, () => h.host.phase === 'left');
      assert.ok(took <= 1500, `${kind} «${phrase}»: left after ${took} ms`);
      assert.equal(h.find('guard.stop')[0]?.source, 'voice', phrase);
      assert.ok(line.aborts.some((a) => a.reason === 'kill_switch' && a.at - t0 <= 1000), `${phrase}: line cut`);
      assert.ok(existsSync(h.stopFile), `${phrase}: the voice stop persists as the (temp) flag`);
      await h.settle(150);
      assert.deepEqual(h.brainCalls.map((c) => c.trigger), [], `${phrase}: no brain call`);
      const code = await h.run;
      assert.equal(code, 0, phrase);
    }
  });
  test('«Кора, стоп» cuts the line and suppresses speech, but she stays in the meeting; a name-addressed line brings her back', async () => {
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'] });
    await h.ready();
    await h.advance(1500, QUIET);
    h.player.auto = 0;
    const line = { why: '', action: 'speak', to: null, text: 'Коллеги, пара слов про порядок сегодня.', plan: null };
    await h.host._test.applyAction(line, 'timer');
    await h.settle(100);
    assert.equal(h.player.plays.length, 1, 'a line is playing');
    const playing = h.player.plays[0];
    h.ears.emit('stt_final', { item_id: 'q1', text: 'Кора, стоп.', t: h.t.now, t_speech_start: h.t.now - 900, t_speech_end: h.t.now });
    await h.settle(150);
    assert.ok(playing.aborts.some((a) => a.reason === 'quiet'), 'the playing line is cut');
    assert.equal(h.find('host.quiet')[0]?.source, 'voice');
    assert.equal(h.host.phase, 'waiting', 'still in the meeting');
    // nothing new is said while quiet
    await h.host._test.applyAction({ ...line, text: 'Пара слов про время встречи.' }, 'timer');
    await h.settle(200);
    assert.equal(h.player.plays.length, 1, 'speech suppressed while quiet');
    assert.ok(h.find('speech.suppressed').some((e) => e.reason === 'quiet'));
    // addressed by name -> she is back
    h.ears.emit('stt_final', { item_id: 'q2', text: 'Кора, продолжай.', t: h.t.now, t_speech_start: h.t.now - 900, t_speech_end: h.t.now });
    await h.settle(200);
    assert.equal(h.find('host.quiet_lifted').length, 1);
    await h.host._test.applyAction({ ...line, text: 'Так, коллеги, возвращаемся к повестке.' }, 'timer');
    await h.settle(200);
    assert.equal(h.player.plays.length, 2, 'she speaks again after the lift');
    await h.finish();
  });
});

describe('host: live mode refuses to enter the room without a voice', () => {
  test('live + voice connect failure: error exit before join, alert sent', async () => {
    const h = makeHost({ flags: { live: true, alert: true }, voiceConnectError: true });
    const code = await h.run;
    assert.equal(code, 1);
    assert.equal(h.joins.length, 0, 'never entered the room');
    assert.equal(h.alerts.length, 1);
    assert.equal(h.alerts[0].level, 'error');
    assert.match(h.alerts[0].text, /без слуха и голоса не вхожу/);
    assert.equal(h.find('voice.connect_error').length, 1);
  });

  test('test room + voice connect failure: joins with the stub voice as before', async () => {
    const h = makeHost({ voiceConnectError: true });
    await h.ready();
    assert.equal(h.joins.length, 1, 'the test room still gets the deaf-mute run');
    assert.equal(h.find('voice.connect_error').length, 1);
    await h.finish();
  });
});

describe('host: crash alerts flush before exit', () => {
  const fatalDeps = {
    attachPageAudio: async () => {
      throw new Error('page audio boom');
    },
  };

  test('run() waits for a pending crash alert instead of dropping it', async () => {
    const calls = [];
    let releaseAlert;
    const alertGate = new Promise((r) => (releaseAlert = r));
    const h = makeHost({
      flags: { alert: true },
      deps: { ...fatalDeps, sendAlert: async (text, o) => (calls.push({ text, level: o?.level }), alertGate.then(() => ({ ok: true }))) },
    });
    let exited = false;
    const runDone = h.run.then((c) => {
      exited = true;
      return c;
    });
    await sleep(700); // the fatal fired, the alert is mid-flight, shutdown must be waiting in flushAlerts
    assert.equal(exited, false, 'run() has not exited while the alert is undelivered');
    assert.equal(calls.length, 1);
    releaseAlert();
    const code = await runDone;
    assert.equal(exited, true);
    assert.equal(code, 1);
  });

  test('a hung alert does not hold the exit: run() resolves within the flush cap', async () => {
    const h = makeHost({
      flags: { alert: true },
      deps: { ...fatalDeps, sendAlert: async () => new Promise(() => {}) },
    });
    const t0 = Date.now();
    const code = await h.run;
    const took = Date.now() - t0;
    assert.equal(code, 1);
    assert.ok(took < 15_000, `exit after ${took} ms (flush cap 8 s plus shutdown)`);
  });
});

describe('host helpers', () => {
  test('applySttFixes / looksLikeQuestion / sameLine', () => {
    const fixes = loadSttFixes();
    assert.equal(applySttFixes('кара стоп', fixes), 'Кора стоп');
    assert.equal(applySttFixes('Карат, стоп', fixes), 'Кора, стоп');
    assert.equal(applySttFixes('Карра стоп, Кару спросим, у Коры', fixes), 'Кора стоп, Кора спросим, у Кора');
    assert.equal(applySttFixes('каратэ и карате', fixes), 'каратэ и карате', 'whole words only');
    assert.equal(applySttFixes('Акме и дев синк', fixes), 'Acme и дев-синк');
    assert.equal(applySttFixes('Акмешник занимается', fixes), 'Акмешник занимается', 'whole words only');
    assert.equal(looksLikeQuestion('Ты кто?'), true);
    assert.equal(looksLikeQuestion('А что это ты такое'), true);
    assert.equal(looksLikeQuestion('Сегодня релиз.'), false);
    assert.equal(sameLine('Я Кора, ИИ-ведущая стендапов. Ждём остальных.', 'Я Кора, ИИ-ведущая стендапов. Сергей, давай начнём.'), true);
    assert.equal(sameLine('Доброе утро, коллеги!', 'Спасибо, Тимур!'), false);
  });
});

describe('host: open floor in a 1:1', () => {
  test('after «кто хочет добавить?» the one person is talking to her (no «?» from STT); «нет, спасибо» is not a question; no re-asking within 30 s', async () => {
    const script = (trigger) => (trigger === 'question_to_host' ? { why: '', action: 'answer', to: null, text: 'Нет, кроме тебя никого.', plan: null } : null);
    const h = makeHost({ present: ['Тимур Ткач'], brainScript: script });
    await h.ready();
    h.host._test.beginRound('tkach_t');
    await h.host._test.run(() => h.host._test.endTurnSequence('closer'));
    await h.settle(400);
    assert.equal(h.find('round.open_floor_asked').length, 1);
    h.ears.emit('stt_final', { item_id: 'o1', text: 'а тут кто то есть кроме меня', t: h.t.now, t_speech_start: h.t.now - 2000, t_speech_end: h.t.now });
    await h.settle(300);
    assert.equal(h.find('host.question')[0]?.how, 'open_floor');
    assert.equal(h.player.plays.at(-1).meta.kind, 'answer');
    h.ears.emit('stt_final', { item_id: 'o2', text: 'нет спасибо', t: h.t.now, t_speech_start: h.t.now - 900, t_speech_end: h.t.now });
    await h.settle(300);
    assert.equal(h.find('host.question').length, 1, '«нет, спасибо» is not a question');
    const openFloorText = h.find('speech.start').find((e) => e.kind === 'open_floor').text;
    await h.advance(12_000, LOUD); // > the old 10 s window; a busy room keeps the open floor from closing meanwhile
    assert.equal(h.host.phase, 'open_floor');
    await h.host._test.applyAction({ why: '', action: 'speak', to: null, text: openFloorText, plan: null }, 'silence');
    await h.settle(100);
    assert.ok(h.find('host.action_ignored').some((e) => e.action === 'speak' && e.reason === 'duplicate'), 'no re-asking the open-floor question');
    await h.finish();
  });
});

describe('host: open floor in a group (the target scenario)', () => {
  test('unnamed questions after «кто хочет добавить?» stay with colleagues; by name or «ты» right after her line they are hers', async () => {
    const script = (trigger) => (trigger === 'question_to_host' ? { why: '', action: 'answer', to: null, text: 'Да, завтра как обычно.', plan: null } : null);
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский', 'Ярослав Орлов'], brainScript: script });
    await h.ready();
    h.host._test.beginRound('tkach_t');
    h.host.state.setPlan({ next: null, then: [] });
    for (const id of ['nevsky_g', 'orlov_y']) h.host.state.setStatus(id, 'spoke');
    await h.host._test.run(() => h.host._test.endTurnSequence('closer'));
    await h.settle(400);
    assert.equal(h.find('round.open_floor_asked').length, 1);
    h.ears.emit('stt_final', { item_id: 'g1', text: 'а кто сегодня дежурит', t: h.t.now, t_speech_start: h.t.now - 1500, t_speech_end: h.t.now });
    h.ears.emit('stt_final', { item_id: 'g2', text: 'а тут кто то есть кроме нас', t: h.t.now, t_speech_start: h.t.now - 1500, t_speech_end: h.t.now });
    await h.settle(300);
    assert.equal(h.find('host.question').length, 0, 'a group question without her name is for the colleagues');
    h.ears.emit('stt_final', { item_id: 'g3', text: 'Кора, а завтра стендап будет', t: h.t.now, t_speech_start: h.t.now - 1500, t_speech_end: h.t.now });
    await h.settle(300);
    assert.equal(h.find('host.question')[0]?.how, 'name');
    await h.advance(3000, QUIET);
    h.ears.emit('stt_final', { item_id: 'g4', text: 'а ты во сколько начнёшь', t: h.t.now, t_speech_start: h.t.now - 1500, t_speech_end: h.t.now });
    await h.settle(300);
    assert.equal(h.find('host.question')[1]?.how, 'after_own_utterance');
    await h.finish();
  });

  test('a line cut off by a barge-in may be said again; a completed one is not repeated for 30 s', async () => {
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский', 'Ярослав Орлов'], onDemand: true });
    await h.ready();
    h.player.auto = 0; // playbacks end only when the test says so
    const line = { why: '', action: 'speak', to: null, text: 'Коллеги, кто хочет что-то добавить или спросить?', plan: null };
    await h.host._test.applyAction(line, 'silence');
    await h.advance(500, QUIET);
    const first = h.player.current();
    assert.equal(first?.meta.text, line.text);
    await first.abort('barge_in');
    await h.advance(12_000, QUIET);
    await h.host._test.applyAction(line, 'silence');
    await h.advance(500, QUIET);
    assert.ok(!h.find('host.action_ignored').some((e) => e.reason === 'duplicate'), 'cut off: she may ask again');
    const second = h.player.current();
    assert.equal(second?.meta.text, line.text);
    second.complete();
    await h.advance(12_000, QUIET);
    await h.host._test.applyAction(line, 'silence');
    await h.settle(100);
    assert.ok(h.find('host.action_ignored').some((e) => e.reason === 'duplicate'), 'said to the end 12 s ago: not again');
    await h.finish();
  });
});

describe('host: live test 27.09 (run 2) — dialog in a small group', () => {
  test('a small group: every line goes to the brain; it sees her own lines; from `utterance` only answers are taken', async () => {
    const script = (trigger, ctx) => {
      if (trigger !== 'utterance') return null;
      const last = ctx.transcript_window.at(-1)?.text ?? '';
      if (/вопрос/.test(last)) return { why: '', action: 'answer', to: null, text: 'Ждала, пока попросят начать.', plan: null };
      if (/ревью/.test(last)) return { why: '', action: 'speak', to: null, text: 'Отлично, коллеги!', plan: null };
      return null;
    };
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'], brainScript: script });
    await h.ready();
    h.ears.emit('stt_final', { item_id: 'u1', text: 'я тебе вопрос задал', t: h.t.now, t_speech_start: h.t.now - 1500, t_speech_end: h.t.now });
    await h.settle(300);
    assert.equal(h.find('host.utterance').length, 1);
    assert.equal(h.player.plays.at(-1)?.meta.text, 'Ждала, пока попросят начать.');
    await h.advance(2000, QUIET);
    h.ears.emit('stt_final', { item_id: 'u2', text: 'сегодня делаю ревью', t: h.t.now, t_speech_start: h.t.now - 1500, t_speech_end: h.t.now });
    await h.settle(300);
    const seen = h.brainCalls.at(-1).ctx.transcript_window;
    assert.ok(seen.some((l) => l.who === 'host' && l.text === 'Ждала, пока попросят начать.'), `her line in the context: ${JSON.stringify(seen)}`);
    assert.ok(h.find('host.action_ignored').some((e) => e.reason === 'utterance_answers_only'), 'a speak from an utterance is ignored');
    assert.equal(h.player.plays.length, 1);
    const utterances = () => h.brainCalls.filter((c) => c.trigger === 'utterance').length;
    const before = utterances();
    h.host._test.beginRound('tkach_t');
    for (const [i, phrase] of ['да у меня всё', 'да'].entries()) {
      h.ears.emit('stt_final', { item_id: `c${i}`, text: phrase, t: h.t.now, t_speech_start: h.t.now - 800, t_speech_end: h.t.now });
    }
    await h.settle(300);
    assert.equal(utterances(), before, '«у меня всё» / «да» in the round stay with the turn flow');
    await h.finish();

    const group = makeHost({ present: ['Тимур Ткач', 'Глеб Невский', 'Ярослав Орлов'], brainScript: script });
    await group.ready();
    group.ears.emit('stt_final', { item_id: 'u3', text: 'сегодня делаю ревью', t: group.t.now, t_speech_start: group.t.now - 1500, t_speech_end: group.t.now });
    await group.settle(300);
    assert.equal(group.find('host.utterance').length, 0, 'a bigger group: only the usual addressing rules');
    await group.finish();
  });

  test('a brain line waiting for the floor is dropped by a newer decision or when people spoke after it', async () => {
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский', 'Ярослав Орлов'] });
    await h.ready();
    await h.advance(300, LOUD); // the room is busy: lines wait at the floor gate
    await h.host._test.applyAction({ why: '', action: 'speak', to: null, text: 'Все высказались. Кто хочет что-то добавить?', plan: null }, 'silence');
    await h.advance(500, LOUD);
    await h.host._test.applyAction({ why: '', action: 'answer', to: null, text: 'Да, завтра как обычно.', plan: null }, 'question_to_host');
    await h.advance(3000, QUIET);
    assert.deepEqual(h.player.plays.map((p) => p.meta.text), ['Да, завтра как обычно.'], 'the older line never plays after the newer one');
    assert.ok(h.find('speech.skipped').some((e) => e.reason === 'superseded'));

    await h.advance(300, LOUD);
    await h.host._test.applyAction({ why: '', action: 'speak', to: null, text: 'Коллеги, кто-то ещё?', plan: null }, 'silence');
    await h.advance(300, LOUD);
    h.ears.emit('stt_final', { item_id: 's1', text: 'у меня ещё вопрос про релиз', t: h.t.now, t_speech_start: h.t.now - 1000, t_speech_end: h.t.now });
    await h.advance(3000, QUIET);
    assert.ok(h.find('speech.skipped').some((e) => e.reason === 'context_changed'), 'decided before people spoke again');
    assert.equal(h.player.plays.length, 1);
    await h.finish();
  });

  test('an empty room: no brain calls, no lines, and after the round she leaves once everyone is gone', async () => {
    const script = () => ({ why: '', action: 'answer', to: null, text: 'Привет!', plan: null });
    const empty = makeHost({ present: [], brainScript: script, onDemand: true });
    await empty.ready();
    empty.ears.emit('stt_final', { item_id: 'e1', text: 'Кора, привет', t: empty.t.now, t_speech_start: empty.t.now - 900, t_speech_end: empty.t.now });
    await empty.settle(300);
    assert.equal(empty.brainCalls.length, 0);
    assert.equal(empty.find('brain.skipped').at(-1)?.reason, 'empty_room');
    await empty.host._test.applyAction({ why: '', action: 'speak', to: null, text: 'Есть кто?', plan: null }, 'silence');
    await empty.settle(200);
    assert.equal(empty.player.plays.length, 0);
    assert.equal(empty.find('speech.skipped').at(-1)?.reason, 'empty_room');
    await empty.finish();

    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'] });
    await h.ready();
    h.host._test.beginRound('tkach_t');
    await h.settle(100);
    h.setTiles([]);
    await h.settle(200);
    await h.advance(5000, QUIET);
    assert.equal(h.find('host.finish').length, 0, 'a grace period: people may rejoin');
    await h.advance(12_000, QUIET);
    assert.equal(h.find('host.finish')[0]?.reason, 'empty_room');
    assert.ok(!h.find('speech.start').some((e) => e.t_real > h.find('host.empty_room')[0].t_real), 'nothing said to the empty room');
    assert.equal(await h.run, 0);
  });
});

describe('host: on-demand mode (no schedule)', () => {
  test('--max-minutes: farewell to people in the room, silent exit from an empty one', async () => {
    const empty = makeHost({ present: [], onDemand: true, flags: { maxMinutes: 0.02 } });
    await empty.ready();
    await empty.advance(1500, QUIET);
    await empty.settle(200);
    assert.equal(empty.player.plays.length, 0, 'no closing line into an empty room');
    assert.equal(empty.find('round.closing_skipped')[0]?.why, 'empty_room');
    assert.equal(empty.find('host.finish')[0].reason, 'closing:max_minutes');
    assert.equal(await empty.run, 0);

    const h = makeHost({ present: ['Тимур Ткач'], onDemand: true, flags: { maxMinutes: 0.02 } });
    await h.ready();
    await h.advance(1500, QUIET);
    await h.settle(200);
    assert.equal(h.player.plays[0]?.meta.key, 'closing_daily');
    assert.equal(h.find('round.closing_skipped').length, 0);
    await h.finish();
  });

  test('scripted: nothing starts by the clock; «Кора, начинай» opens the standup once', async () => {
    const h = makeHost({ present: ['Ярослав Орлов', 'Тимур Ткач'], onDemand: true });
    await h.ready();
    await h.advance(60_000, QUIET); // any amount of clock time: no timers exist
    assert.equal(h.host.phase, 'waiting');
    assert.equal(h.player.plays.length, 0, 'no greeting by the clock');
    h.ears.emit('stt_final', { item_id: 's1', text: 'Кора, начинай!', t: h.t.now, t_speech_start: h.t.now - 900, t_speech_end: h.t.now });
    await h.settle(400);
    assert.equal(h.find('host.start_requested').length, 1);
    assert.equal(h.player.plays[0].meta.key, 'start_daily_with_lead', 'day is pinned to tue in this file');
    assert.equal(h.host.phase, 'round');
    h.ears.emit('stt_final', { item_id: 's2', text: 'Кора, поехали', t: h.t.now }); // repeat: no restart
    await h.settle(300);
    assert.equal(h.find('host.start_requested').length, 1);
    await h.finish();
  });

  test('a start word without her name right after her own line is a reply to her; later it is not', async () => {
    const script = (trigger) =>
      trigger === 'question_to_host' ? { why: '', action: 'answer', to: null, text: 'Привет! Начну, когда попросят.', plan: null }
      : trigger === 'start_requested' ? { why: '', action: 'give_word', to: 'tkach_t', text: 'Доброе утро! Тимур, начнёшь?', plan: null }
      : null;
    const h = makeHost({ present: ['Тимур Ткач'], brainScript: script, onDemand: true });
    await h.ready();
    h.ears.emit('stt_final', { item_id: 'r1', text: 'Кора, привет', t: h.t.now, t_speech_start: h.t.now - 800, t_speech_end: h.t.now });
    await h.settle(300);
    assert.equal(h.player.plays[0]?.meta.kind, 'answer');
    await h.advance(5000, QUIET);
    h.ears.emit('stt_final', { item_id: 'r2', text: 'да давай начнём стендап', t: h.t.now, t_speech_start: h.t.now - 1500, t_speech_end: h.t.now });
    await h.settle(300);
    assert.equal(h.find('host.start_requested')[0]?.how, 'reply');
    assert.ok(h.brainCalls.some((c) => c.trigger === 'start_requested'));
    assert.equal(h.host.phase, 'round');
    await h.finish();

    const late = makeHost({ present: ['Тимур Ткач'], brainScript: script, onDemand: true });
    await late.ready();
    late.ears.emit('stt_final', { item_id: 'r1', text: 'Кора, привет', t: late.t.now, t_speech_start: late.t.now - 800, t_speech_end: late.t.now });
    await late.settle(300);
    await late.advance(15_000, QUIET);
    late.ears.emit('stt_final', { item_id: 'r2', text: 'ну что, начнём', t: late.t.now, t_speech_start: late.t.now - 1500, t_speech_end: late.t.now });
    await late.settle(300);
    assert.equal(late.find('host.start_requested').length, 0, 'long after her line: people talking among themselves');
    assert.equal(late.host.phase, 'waiting');
    await late.finish();
  });

  test('scripted: a start word without her name does not open the standup', async () => {
    const h = makeHost({ present: ['Ярослав Орлов'], onDemand: true });
    await h.ready();
    h.ears.emit('stt_final', { item_id: 's1', text: 'ну что, начнём?', t: h.t.now, t_speech_start: h.t.now - 800, t_speech_end: h.t.now });
    await h.settle(300);
    assert.equal(h.find('host.start_requested').length, 0);
    assert.equal(h.host.phase, 'waiting');
    assert.equal(h.player.plays.length, 0);
    await h.finish();
  });
});

describe('host: --record (slot recording for STT / Smart Turn tuning)', () => {
  function recordingDeps() {
    const got = { writes: [], dirs: [], closed: 0, onTrackAudio: null };
    class FakeRecorder {
      constructor({ dir }) {
        got.dirs.push(dir);
      }
      write(trackId, pcm) {
        got.writes.push({ trackId, n: pcm.length });
      }
      close() {
        got.closed++;
        return { dir: got.dirs[0], tracks: { a: { seconds: 1 } } };
      }
    }
    const deps = {
      SlotRecorder: FakeRecorder,
      attachPageAudio: async (page, o) => {
        got.onTrackAudio = o.onTrackAudio ?? null;
        return { play: async () => ({}), playEnd: async () => ({}), flush: async () => ({ played_ms: 0, dropped_ms: 0 }) };
      },
    };
    return { got, deps };
  }

  test('test room: every slot chunk goes to the recorder, closed on exit', async () => {
    const { got, deps } = recordingDeps();
    const h = makeHost({ present: ['Тимур Ткач'], flags: { record: '/tmp/rec_test' }, deps });
    await h.ready();
    assert.equal(h.find('record.start').length, 1);
    assert.deepEqual(got.dirs, ['/tmp/rec_test']);
    assert.equal(typeof got.onTrackAudio, 'function', 'per-slot audio is taken even without cascade ears');
    got.onTrackAudio(new Int16Array(2400), 'slot-1');
    got.onTrackAudio(new Int16Array(2400), 'slot-2');
    assert.deepEqual(got.writes, [
      { trackId: 'slot-1', n: 2400 },
      { trackId: 'slot-2', n: 2400 },
    ]);
    await h.finish();
    assert.equal(got.closed, 1);
    assert.equal(h.find('record.done')[0].tracks, 1);
  });

  test('--live: refused, nothing recorded', async () => {
    const { got, deps } = recordingDeps();
    const h = makeHost({ present: ['Тимур Ткач'], flags: { record: true, live: true, shadow: true }, deps });
    await h.ready();
    assert.equal(h.find('record.refused').length, 1);
    assert.equal(h.find('record.start').length, 0);
    assert.equal(got.dirs.length, 0);
    assert.equal(got.onTrackAudio, null, 'no per-slot tap without cascade ears or a recorder');
    await h.finish();
  });

  test('a failing recorder is dropped with record.error, the call goes on', async () => {
    const { got, deps } = recordingDeps();
    deps.SlotRecorder = class {
      write() {
        throw new Error('disk full');
      }
      close() {
        return { dir: '', tracks: {} };
      }
    };
    const h = makeHost({ present: ['Тимур Ткач'], flags: { record: '/tmp/rec_test' }, deps });
    await h.ready();
    got.onTrackAudio(new Int16Array(10), 'slot-1');
    got.onTrackAudio(new Int16Array(10), 'slot-1');
    assert.equal(h.find('record.error').length, 1);
    await h.finish();
    assert.equal(h.find('record.done').length, 0);
  });
});

// ------------------------------------------------------------------ agent mode (voice.host = "agent")

/** A fake agent: answers with script(input) -> actions; hang(input) -> never answers until aborted. */
function scriptAgent(script, { hang = () => false } = {}) {
  const calls = [];
  return {
    calls,
    model: 'fake-agent',
    provider: 'fake',
    decide: async (input, { signal } = {}) => {
      const call = { input, signal };
      calls.push(call);
      if (hang(input)) return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      return { actions: script(input) ?? [{ action: 'skip' }], usage: { prompt_tokens: 100, completion_tokens: 10 } };
    },
  };
}
const lastHeard = (input) => input.events.filter((e) => e.type === 'heard').at(-1)?.text ?? '';
const final = (h, id, text) => h.ears.emit('stt_final', { item_id: id, text, t: h.t.now, t_speech_start: h.t.now - 1000, t_speech_end: h.t.now });

describe('host: agent mode (voice.host = "agent")', () => {
  test('the whole standup through the agent: answer, start, handoff with ack, open floor, farewell; no automaton', async () => {
    const agent = scriptAgent((input) => {
      const text = lastHeard(input);
      if (/привет/.test(text)) return [{ action: 'say', text: 'Привет, Тима!' }];
      if (/начинай/.test(text)) return [{ action: 'give_word', person: 'tkach_t', text: 'Доброе утро! Тима, начнёшь?' }];
      if (/у меня всё/.test(text) && input.speaker === 'tkach_t') return [{ action: 'give_word', person: 'nevsky_g', text: '' }];
      if (/у меня всё/.test(text) && input.speaker === 'nevsky_g') return [{ action: 'open_floor' }];
      if (/нет спасибо/.test(text)) return [{ action: 'leave', text: 'Всем хорошего дня!' }];
      return [{ action: 'skip' }];
    });
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'], onDemand: true, agent });
    await h.ready();
    assert.equal(h.find('agent.ready').length, 1);
    final(h, 'a1', 'Кора, привет');
    await h.advance(1500, QUIET);
    assert.deepEqual(h.player.plays.map((p) => p.meta.text), ['Привет, Тима!']);
    final(h, 'a2', 'Кора, начинай');
    await h.advance(1500, QUIET);
    assert.equal(h.player.plays.at(-1).meta.text, 'Доброе утро! Тима, начнёшь?');
    assert.equal(h.host.state.current, 'tkach_t');
    await h.advance(8000, QUIET); // the automaton would ask «всё?» here; the agent (skip) decides
    assert.equal(h.player.plays.length, 2, 'no «всё?» of its own');
    assert.ok(h.find('agent.wake').some((e) => e.reason === 'silence'), 'the silence ladder woke the agent');
    final(h, 'a3', 'сегодня тесты у меня всё');
    await h.advance(1500, QUIET);
    assert.deepEqual(h.player.plays.slice(2).map((p) => p.meta.key), ['ack', 'handoff_plain']);
    assert.equal(h.host.state.current, 'nevsky_g');
    final(h, 'a4', 'сегодня ревью у меня всё');
    await h.advance(1500, QUIET);
    assert.deepEqual(h.player.plays.slice(4).map((p) => p.meta.key), ['ack', 'open_floor']);
    assert.equal(h.host.phase, 'open_floor');
    final(h, 'a5', 'нет спасибо');
    await h.advance(1500, QUIET);
    assert.equal(h.player.plays.at(-1).meta.text, 'Всем хорошего дня!');
    assert.equal(await h.run, 0);
    assert.equal(h.find('host.finish')[0].reason, 'closing:agent');
    assert.equal(h.find('agent.rejected').length, 0);
    assert.equal(h.find('turn.end_candidate').length, 0, 'the turn automaton is off');
    assert.ok(h.find('cost.summary')[0].agent.decisions >= 5);
  });

  test('her lines and cuts reach the agent: dialog with who host + cut, events her_line_done + interrupted', async () => {
    const agent = scriptAgent((input) => (/привет/.test(lastHeard(input)) ? [{ action: 'say', text: 'Привет, Тима! Рада всех слышать, начнём, когда попросите.' }] : [{ action: 'skip' }]));
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'], onDemand: true, agent });
    await h.ready();
    h.player.auto = 0; // her line keeps playing until the barge-in
    final(h, 'b1', 'Кора, привет');
    await h.advance(600, QUIET);
    assert.equal(h.player.plays.length, 1, 'her line is playing');
    h.host.floor.onVad({ type: 'start', t: h.t.now }); // someone talks over her
    await h.settle(200);
    assert.equal(h.find('speech.abort').length, 1);
    h.player.auto = 30;
    await h.advance(300, QUIET);
    final(h, 'b2', 'подожди а ты кто');
    await h.advance(600, QUIET);
    const input = agent.calls.at(-1).input;
    assert.deepEqual(input.events.map((e) => e.type), ['her_line_done', 'interrupted', 'heard']);
    assert.equal(input.events[0].cut, true);
    assert.deepEqual(input.dialog.at(-2), { who: 'host', text: 'Привет, Тима! Рада всех слышать, начнём, когда попросите.', cut: true });
    await h.finish();
  });

  test('a new line aborts the decision in flight; her line waiting for the floor is dropped by a newer line', async () => {
    const agent = scriptAgent(
      (input) => {
        const text = lastHeard(input);
        if (/второй/.test(text)) return [{ action: 'say', text: 'Отвечаю на второй.' }];
        if (/третий/.test(text)) return [{ action: 'say', text: 'Отвечаю на третий.' }];
        if (/четвёртый/.test(text)) return [{ action: 'say', text: 'Отвечаю на четвёртый.' }];
        return [{ action: 'skip' }];
      },
      { hang: (input) => /первый/.test(lastHeard(input)) },
    );
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'], onDemand: true, agent });
    await h.ready();
    final(h, 'c1', 'Кора первый вопрос');
    await h.settle(100);
    final(h, 'c2', 'Кора второй вопрос');
    await h.advance(1200, QUIET);
    assert.equal(agent.calls[0].signal.aborted, true, 'the first decision was aborted');
    assert.deepEqual(agent.calls[1].input.events.filter((e) => e.type === 'heard').map((e) => e.text), ['Кора первый вопрос', 'Кора второй вопрос']);
    assert.deepEqual(h.player.plays.map((p) => p.meta.text), ['Отвечаю на второй.']);

    await h.advance(300, LOUD); // the room is talking: her next line waits at the floor gate
    final(h, 'c3', 'Кора третий вопрос');
    await h.advance(400, LOUD);
    final(h, 'c4', 'Кора четвёртый вопрос'); // a newer line: the answer to the third one is stale
    await h.advance(2500, QUIET);
    assert.ok(h.find('speech.skipped').some((e) => e.reason === 'superseded' && e.text === 'Отвечаю на третий.'));
    assert.deepEqual(h.player.plays.map((p) => p.meta.text), ['Отвечаю на второй.', 'Отвечаю на четвёртый.']);
    await h.finish();
  });

  test('a refused call is logged, nothing plays; --no-brain: no agent, no automaton', async () => {
    const agent = scriptAgent((input) => (/начинай/.test(lastHeard(input)) ? [{ action: 'give_word', person: 'orlov_y', text: '' }] : [{ action: 'skip' }]));
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'], onDemand: true, agent });
    await h.ready();
    final(h, 'd1', 'Кора, начинай');
    await h.advance(1500, QUIET);
    assert.equal(h.player.plays.length, 0);
    assert.equal(h.find('agent.rejected')[0].reason, 'not_present');
    assert.ok(agent.calls.at(-1).input.events.some((e) => e.type === 'rejected'), 'the agent hears why');
    await h.finish();

    const mute = makeHost({ present: ['Тимур Ткач'], onDemand: true, agent: scriptAgent(() => [{ action: 'say', text: 'Привет!' }]), flags: { brain: false } });
    await mute.ready();
    final(mute, 'd2', 'Кора, начинай');
    await mute.advance(3000, QUIET);
    assert.equal(mute.player.plays.length, 0);
    assert.equal(mute.find('agent.disabled')[0].reason, '--no-brain');
    await mute.finish();
  });
});

describe('host: agent mode, a lit tile (28.09)', () => {
  test('a final while its author\'s tile is lit: the agent is woken when the tile goes dark, with every piece', async () => {
    const agent = scriptAgent((input) => (input.events.some((e) => e.type === 'heard' && /привет/.test(e.text)) ? [{ action: 'say', text: 'Привет, Тима!' }] : [{ action: 'skip' }]));
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'], onDemand: true, agent });
    await h.ready();
    h.lit(['Тимур Ткач']);
    await h.advance(1200, QUIET);
    final(h, 'a1', 'Кора, привет');
    await h.advance(600, QUIET);
    final(h, 'a2', 'как у тебя дела');
    await h.advance(600, QUIET);
    assert.equal(agent.calls.length, 0, 'the tile is lit: the person goes on');
    assert.deepEqual(h.find('agent.hold').map((e) => e.who), ['tkach_t']);
    h.lit([]);
    await h.advance(1000, QUIET);
    assert.equal(agent.calls.length, 1);
    assert.deepEqual(agent.calls[0].input.events.filter((e) => e.type === 'heard').map((e) => e.text), ['Кора, привет', 'как у тебя дела']);
    assert.deepEqual(h.player.plays.map((p) => p.meta.text), ['Привет, Тима!']);
    assert.equal(h.find('agent.held')[0].why, 'dark');
    await h.finish();
  });
});

describe('host: agent mode after the review of 27.09', () => {
  const startThen = (rest) => (input) => {
    const text = lastHeard(input);
    if (/начинай/.test(text)) return [{ action: 'give_word', person: 'tkach_t', text: 'Доброе утро! Тима, начнёшь?' }];
    return rest(input, text);
  };

  test('a barge-in drops the queued ack: the turn change is undone, the ladder and give_word work again', async () => {
    const agent = scriptAgent(
      startThen((input, text) => {
        if (/у меня всё/.test(text) && input.speaker === 'tkach_t') return [{ action: 'say', text: 'Поняла, спасибо.' }, { action: 'give_word', person: 'nevsky_g', text: '' }];
        if (/дальше давай/.test(text)) return [{ action: 'give_word', person: 'nevsky_g', text: '' }];
        return [{ action: 'skip' }];
      }),
    );
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'], onDemand: true, agent });
    await h.ready();
    final(h, 'r1', 'Кора, начинай');
    await h.advance(1500, QUIET);
    h.player.auto = 0; // her «Поняла» keeps playing until the barge-in
    final(h, 'r2', 'сегодня тесты у меня всё');
    await h.advance(600, QUIET);
    assert.equal(h.player.plays.at(-1).meta.text, 'Поняла, спасибо.');
    h.host.floor.onVad({ type: 'start', t: h.t.now }); // Tima talks over her: the queued ack goes with the queue
    await h.settle(200);
    await h.advance(400, QUIET);
    h.host.floor.onVad({ type: 'stop', t: h.t.now });
    h.player.auto = 30;
    await h.advance(1500, QUIET);
    assert.equal(h.find('turn.end_reverted').at(-1)?.why, 'orphaned');
    assert.equal(h.host.state.current, 'tkach_t', 'the word stays with Tima');
    const before = h.find('agent.wake').length;
    await h.advance(3000, QUIET);
    assert.ok(h.find('agent.wake').slice(before).some((e) => e.reason === 'silence'), 'the silence ladder is alive');
    final(h, 'r3', 'Кора дальше давай');
    await h.advance(2000, QUIET);
    assert.equal(h.host.state.current, 'nevsky_g');
    assert.ok(!h.find('agent.rejected').some((e) => e.reason === 'turn_change_in_progress'));
    await h.finish();
  });

  test('say + give_word: her words, then a plain handoff — no «Спасибо» clip on top', async () => {
    const agent = scriptAgent(startThen((input, text) => (/у меня всё/.test(text) && input.speaker === 'tkach_t' ? [{ action: 'say', text: 'Спасибо, Тима!' }, { action: 'give_word', person: 'nevsky_g', text: '' }] : [{ action: 'skip' }])));
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'], onDemand: true, agent });
    await h.ready();
    final(h, 's1', 'Кора, начинай');
    await h.advance(1500, QUIET);
    final(h, 's2', 'сегодня тесты у меня всё');
    await h.advance(2500, QUIET);
    assert.deepEqual(h.player.plays.slice(1).map((p) => p.meta.key ?? p.meta.text), ['Спасибо, Тима!', 'handoff_plain']);
    assert.equal(h.host.state.current, 'nevsky_g');
    await h.finish();
  });

  test('a speaker who never speaks: no «всё?», a plain handoff, skipped — the word comes back at the end', async () => {
    const agent = scriptAgent(
      startThen((input, text) => {
        const sil = input.events.filter((e) => e.type === 'silence').at(-1);
        if (/у меня всё/.test(text) && input.speaker === 'tkach_t') return [{ action: 'give_word', person: 'nevsky_g', text: '' }];
        if (input.speaker === 'nevsky_g' && sil?.ms >= 2500 && sil.ms < 6000) return [{ action: 'ask_done', person: 'nevsky_g' }];
        if (input.speaker === 'nevsky_g' && sil?.ms >= 6000) return [{ action: 'say', text: 'Глеб, тебя не слышно, вернусь к тебе в конце.' }, { action: 'give_word', person: 'belozersky_s', text: '' }];
        return [{ action: 'skip' }];
      }),
    );
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский', 'Сергей Белозерский'], onDemand: true, agent });
    await h.ready();
    final(h, 'q1', 'Кора, начинай');
    await h.advance(1500, QUIET);
    final(h, 'q2', 'сегодня тесты у меня всё');
    await h.advance(1500, QUIET);
    assert.equal(h.host.state.current, 'nevsky_g');
    await h.advance(8000, QUIET);
    assert.ok(!h.player.plays.some((p) => p.meta.key === 'check_done'), 'no «Глеб, всё?» to someone silent');
    const silences = agent.calls.filter((c) => c.input.speaker === 'nevsky_g').map((c) => c.input.events.find((e) => e.type === 'silence')?.ms);
    assert.ok(silences.length === 1 && silences[0] >= 6000, `review 28.09: no 1 s / 2.5 s wakes for a speaker who has not started: ${silences}`);
    assert.equal(h.host.state.current, 'belozersky_s');
    assert.equal(h.host.state.get('nevsky_g').status, 'skipped');
    assert.ok(!h.player.plays.slice(-2).some((p) => p.meta.key === 'ack'), 'no «Спасибо» for silence');
    const plan = h.host.state.ensurePlan();
    assert.ok([plan.next, ...plan.then].includes('nevsky_g'), 'Gleb is back in the queue');
    await h.finish();
  });

  test('the opening line is still waiting: a handoff decided meanwhile is refused (the round has not begun)', async () => {
    const agent = scriptAgent((input) => {
      const text = lastHeard(input);
      if (/начинай/.test(text)) return [{ action: 'say', text: 'Привет всем, рада слышать!' }, { action: 'give_word', person: 'tkach_t', text: 'Тима, начнёшь?' }];
      if (/глеб первый/.test(text)) return [{ action: 'give_word', person: 'nevsky_g', text: '' }];
      return [{ action: 'skip' }];
    });
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'], onDemand: true, agent });
    await h.ready();
    h.player.auto = 0;
    final(h, 'g1', 'Кора, начинай');
    await h.advance(600, QUIET);
    assert.deepEqual(h.host._test.queued(), ['start']);
    final(h, 'g2', 'нет глеб первый');
    await h.advance(800, QUIET);
    h.player.plays.at(-1).complete();
    h.player.auto = 30;
    await h.advance(2000, QUIET);
    assert.ok(h.find('agent.rejected').some((e) => e.reason === 'start_pending'));
    assert.ok(h.host.phase !== 'waiting' || !h.host.state.current, `never a speaker while waiting: phase ${h.host.phase}, current ${h.host.state.current}`);
    await h.finish();
  });
});

describe('host: joining', () => {
  test('«Звонки сейчас недоступны»: she joins again from the link instead of giving up', async () => {
    let calls = 0;
    const h = makeHost({
      present: ['Тимур Ткач'],
      deps: {
        joinRetryPauseMs: 10,
        telemost: {
          join: async () => (++calls === 1 ? { status: 'unavailable', detail: 'Звонки сейчас недоступны', tookMs: 5 } : { status: 'joined', tookMs: 5 }),
          installObservers: async () => async () => {},
          getParticipants: async () => [],
          leave: async () => ({ ok: true }),
          setHideIncomingVideo: async () => ({}),
          closePanels: async () => {},
        },
      },
    });
    const t0 = Date.now();
    while (!h.find('join.result').length && Date.now() - t0 < 3000) await sleep(20);
    assert.equal(calls, 2);
    assert.equal(h.find('join.retry').length, 1);
    assert.equal(h.find('join.result')[0].status, 'joined');
    await h.finish();
  });
});

