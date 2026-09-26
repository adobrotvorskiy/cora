// src/core/agent_host.js with fakes for browser, page audio, player, Telemost and the ElevenLabs
// agent: connect timing, nudges and contextual updates, silence notes, Orlov joining, client tools,
// the leave sequence (farewell seal, linger, cancel) and the stop gate (kill phrase in a transcript,
// temp STOP file) which must silence her within 1 s.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, test } from 'node:test';
import * as clock from '../../src/clock.js';
import { createAgentHost, isAgentKillPhrase } from '../../src/core/agent_host.js';
import { loadRoster } from '../../src/core/state.js';
import { fakePlayer } from '../helpers/fake_eleven_server.js';

clock.setSimulatedStart('09:50'); // timers stay away; ready() moves the meeting clock to 09:59:40, tests to 10:00 when needed

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'people_test.json');
const SETTINGS = {
  meeting_url: 'https://telemost.360.yandex.ru/j/000',
  display_name: 'Кора (ИИ-ведущая)',
  times: { join: '09:58', start: '10:00', wait_lead_until: '10:02', soft_deadline: '10:28', hard_deadline: '10:30', force_leave: '10:35', transcription_cutoff: '10:40' },
  voice: { provider: 'elevenlabs_agent', eleven_agent_id: 'agent_test', eleven_voice_id: 'v1', eleven_llm: 'gemini-3.5-flash-lite', eleven_tts_model: 'eleven_flash_v2_5', eleven: { record_audio: 'none', speaker_note_min_ms: 50, chunk_ms: 50 } },
  keys: { openai: 'X_OPENAI', openrouter: 'X_OR', elevenlabs: 'X_EL', telegram: 'X_TG' },
  browser: {},
  telegram: {},
  avatar: null,
};
const ASSETS = { personaBlock: 'ПЕРСОНА-ТЕСТ', playbook: '## Роль\nПЛЕЙБУК-ТЕСТ', phrases: null, hostDisplayName: null, warnings: [] };
const tile = (name) => ({ name, isSelf: false, muted: false, cameraOn: false, speaking: false, trackId: 't', visible: true });
const dirs = [];
const hosts = [];
after(async () => {
  for (const h of hosts) {
    h.host.finish('cleanup');
    await h.run.catch(() => {});
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function fakeAgent(opts) {
  const em = new EventEmitter();
  Object.assign(em, {
    opts,
    connected: false,
    state: 'idle',
    conversationId: null,
    pushed: 0,
    contextual: [],
    userMessages: [],
    toolResults: [],
    closes: [],
    inits: [],
    async connect() {
      const init = await opts.init({ reconnect: false });
      em.inits.push(init);
      em.connected = true;
      em.state = 'open';
      em.conversationId = 'conv_1';
      setImmediate(() => em.emit('open', { conversation_id: 'conv_1', reconnect: false, formats: { in: 'pcm_24000', out: 'pcm_24000' } }));
      return { conversation_id: 'conv_1', formats: { in: 'pcm_24000', out: 'pcm_24000' }, state: 'open' };
    },
    pushAudio(pcm) {
      if (!em.connected) return false;
      em.pushed += pcm.length;
      return true;
    },
    sendContextualUpdate(text) {
      if (!em.connected) return false;
      em.contextual.push(text);
      return true;
    },
    sendUserMessage(text) {
      if (!em.connected) return false;
      em.userMessages.push(text);
      return true;
    },
    sendToolResult(id, result, o = {}) {
      em.toolResults.push({ id, result, is_error: Boolean(o.isError) });
      return true;
    },
    async close(o) {
      em.closes.push(o?.reason ?? null);
      em.connected = false;
      em.state = 'closed';
    },
    stats: () => ({ connected_ms: 90_000, sessions: 1, conversation_ids: ['conv_1'] }),
  });
  return em;
}

function makeHost({ present = [], flags = {}, onDemand = false, deps: extraDeps = {} } = {}) {
  const t = { now: 1_000_000 };
  const now = () => t.now;
  const events = [];
  const log = { event: (type, fields = {}) => (events.push({ type, ...fields }), { type }), path: 'test', close() {} };
  const player = fakePlayer({ now });
  const dir = mkdtempSync(join(tmpdir(), 'agent-host-'));
  dirs.push(dir);
  const stopFile = join(dir, 'STOP');
  let tiles = present.map(tile);
  let observerCb = null;
  let onAudio = null;
  let audioOpts = null;
  let agent = null;
  const deps = {
    now,
    stopFile,
    stopIntervalMs: 50,
    apiKey: 'test-key',
    recorderDir: false,
    launchBrowser: async () => ({ context: { on() {} }, page: { on() {}, evaluate: async () => ({}) }, userDataDir: '', close: async () => {} }),
    attachPageAudio: async (page, { onAudio: cb, opts }) => {
      onAudio = cb;
      audioOpts = opts;
      return { play: async () => ({}), playEnd: async () => ({}), flush: async () => ({ played_ms: 0, dropped_ms: 0 }) };
    },
    serveAssets: async () => ({}),
    telemost: {
      join: async () => ({ status: 'joined', tookMs: 1 }),
      installObservers: async (page, cb) => {
        observerCb = cb;
        return async () => {};
      },
      getParticipants: async () => tiles,
      leave: async () => ({ ok: true }),
      setHideIncomingVideo: async () => ({}),
      closePanels: async () => {},
    },
    loadPlayer: async () => player,
    sendAlert: async () => ({ ok: true }),
    roster: loadRoster({ path: FIXTURE }),
    assets: ASSETS,
    rest: { subscription: async () => ({ tier: 'free', character_count: 0, character_limit: 10_000 }), conversation: async () => ({}) },
    createAgent: (opts) => (agent = fakeAgent(opts)),
    ...extraDeps,
  };
  const settings = onDemand ? { ...SETTINGS, times: null } : SETTINGS;
  const host = createAgentHost({ settings, flags: { alert: false, ...flags }, log, deps });
  const run = host.run();
  const api = {
    host,
    player,
    events,
    t,
    run,
    stopFile,
    agent: () => agent,
    async settle(ms = 120) {
      await sleep(ms);
      await host._test.idle();
    },
    /** Advance the fake wall clock and let at least one 200 ms host tick run. */
    async advance(ms) {
      t.now += ms;
      await api.settle(260);
    },
    setTiles(names) {
      tiles = names.map(tile);
      observerCb?.({ type: 'participants', t: Date.now(), list: tiles });
    },
    speakers(names) {
      observerCb?.({ type: 'speaker', t: Date.now(), names });
    },
    audio(bytes = 2400, mix = [-30]) {
      onAudio?.(Buffer.alloc(bytes), [], { mix });
    },
    audioOpts: () => audioOpts,
    types: (re) => events.filter((e) => re.test(e.type)).map((e) => e.type),
    find: (type) => events.filter((e) => e.type === type),
    async ready() {
      const t0 = Date.now();
      while (!observerCb && Date.now() - t0 < 3000) await sleep(20);
      assert.ok(observerCb, 'host set up');
      assert.ok(!agent?.connected, 'no agent connection before 09:58');
      clock.setSimulatedStart('09:59:40'); // past the connect time (start − 120 s), before the 10:00 timer
      while (!agent?.connected && Date.now() - t0 < 3000) await sleep(20);
      assert.ok(agent?.connected, 'agent connected once the meeting clock passed 09:58');
      api.setTiles(present);
      await api.settle(900); // participant notes are batched (800 ms)
    },
    /** Move the meeting clock to 10:00 and wait for the start nudge. */
    async start() {
      clock.setSimulatedStart('10:00:00');
      const t0 = Date.now();
      const opened = () => agent.userMessages.some((m) => m.includes('Пора открывать стендап'));
      while (!opened() && Date.now() - t0 < 3000) await sleep(40);
      assert.ok(opened(), 'start nudge');
      await api.settle(60);
    },
    async finish() {
      host.finish('test');
      return run;
    },
  };
  hosts.push(api);
  return api;
}

describe('agent host: connect, init, context, nudges', () => {
  test('init carries the rendered prompt and dynamic variables; joins/leaves and speakers become host notes; 10:00 nudge', async () => {
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'] });
    await h.ready();
    const a = h.agent();
    const init = a.inits[0];
    assert.equal(init.override.agent.language, 'ru');
    assert.equal(init.override.agent.first_message, '');
    assert.ok(init.override.agent.prompt.prompt.includes('# Кто ты') && init.override.agent.prompt.prompt.includes('# Когда говорить'), 'compact prompt');
    assert.ok(!init.override.agent.prompt.prompt.includes('ПЕРСОНА-ТЕСТ') && !init.override.agent.prompt.prompt.includes('ПЛЕЙБУК-ТЕСТ'), 'compact mode does not embed persona.md/playbook.md');
    assert.ok(!init.override.agent.prompt.prompt.includes('{{'), 'override prompt is fully rendered');
    assert.ok(init.override.agent.prompt.prompt.includes('Сейчас на связи: пока никого. Ярослав Орлов: не на связи.'));
    assert.equal(init.dynamicVariables.lead_status, 'не на связи');
    // participants who join after the agent connected become one batched note (roster order)
    assert.ok(a.contextual.some((c) => c.includes('Подключился Глеб.') && c.includes('Подключился Тимур.') && c.includes('На связи: Глеб, Тимур.')), `notes: ${a.contextual}`);
    h.setTiles(['Тимур Ткач', 'Глеб Невский', 'Ярослав Орлов']);
    await h.settle(900);
    assert.ok(a.contextual.at(-1).includes('Подключился Ярослав.') && a.contextual.at(-1).includes('Ярослав Орлов: на связи'), a.contextual.at(-1));
    h.setTiles(['Тимур Ткач', 'Ярослав Орлов']);
    await h.settle(900);
    assert.ok(a.contextual.at(-1).includes('Вышел Глеб.'));
    // active speaker -> «Говорит: …», throttled and not repeated for the same person
    h.speakers(['Тимур Ткач']);
    await h.advance(300);
    h.speakers([]);
    h.speakers(['Тимур Ткач']);
    await h.advance(300);
    const said = a.contextual.filter((c) => c.includes('Говорит:'));
    assert.equal(said.length, 1, `speaker notes: ${said}`);
    assert.match(said[0], /^\[хост \d\d:\d\d:\d\d\] Говорит: Тимур\.$/);
    h.speakers(['Ярослав Орлов']);
    await h.advance(300);
    assert.equal(a.contextual.filter((c) => c.includes('Говорит:')).length, 2);
    assert.ok(h.find('agent.transcript').length === 0);
    // page audio is forwarded while connected; the page adapter was asked for 50 ms chunks
    assert.equal(h.audioOpts().chunkMs, 50);
    h.audio();
    h.audio();
    assert.equal(a.pushed, 4800);
    // the 10:00 timer -> a user-message nudge
    assert.equal(a.userMessages.length, 0, 'nothing before 10:00');
    clock.setSimulatedStart('10:00:00');
    const t0 = Date.now();
    while (!a.userMessages.length && Date.now() - t0 < 3000) await sleep(50);
    assert.equal(a.userMessages.length, 1);
    assert.match(a.userMessages[0], /^\[хост 10:00:\d\d\] Пора открывать стендап\. Ярослав Орлов: на связи\. На связи: Ярослав, Тимур\./);
    assert.ok(a.userMessages[0].includes('фокус на неделю') || a.userMessages[0].includes('план на день'));
    assert.equal(h.find('timer')[0].name, 'start');
    const code = await h.finish();
    assert.equal(code, 0);
    assert.deepEqual(a.closes, ['shutdown:test']);
    const cost = h.find('cost.summary')[0];
    assert.equal(cost.mode, 'elevenlabs_agent');
    assert.equal(cost.credits_est, Math.round(1.5 * 900));
    assert.deepEqual(cost.settings, { llm: 'gemini-3.5-flash-lite', turn_eagerness: 'normal', prompt_mode: 'compact', tools_blocking: false, chunk_ms: 50, reasoning_effort: 'minimal', temperature: 0.3 });
    assert.equal(cost.turn_latency_ms.n, 0);
    assert.equal(init.override.agent.prompt.prompt.length < 8500, true, 'compact prompt in the override');
  });

  test('deferred nudges: overflow evicts the oldest non-start nudge (logged), the start nudge survives the flush', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    const marker = (k) => `MARKER-${k}-test`;
    h.host._test.nudge(marker('start'), 'start');
    h.host._test.nudge(marker('a'), 'wait_lead');
    h.host._test.nudge(marker('b'), 'hard_deadline');
    h.host._test.nudge(marker('c'), 'max_time');
    h.host._test.nudge(marker('d'), 'lead_joined'); // 5th, over the cap: 'a' (the oldest non-start) is evicted
    h.host._test.nudge(marker('e'), 'x_custom'); // 6th: 'b' is evicted
    assert.deepEqual(
      h.find('agent.nudge_dropped').map((e) => e.kind),
      ['wait_lead', 'hard_deadline'],
    );
    await h.ready(); // connects -> the deferred queue flushes
    const got = h.agent().userMessages.map((m) => /MARKER-(\w+)-/.exec(m)?.[1]).filter(Boolean);
    assert.deepEqual(got, ['start', 'c', 'd', 'e'], `flushed: ${got}`);
    await h.finish();
  });

  test('turn latency: room speech end (page levels) -> first agent audio chunk; p50/p90 in cost.summary', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    // someone talks for a while (loud frames), then the room goes quiet
    for (let i = 0; i < 20; i++) {
      h.audio(2400, [-28]);
      h.t.now += 50;
    }
    h.audio(2400, [-95]); // quiet frame at t
    h.t.now += 1200;
    h.audio(2400, [-95]);
    a.emit('transcript', { text: 'у меня всё', event_id: 1, t: Date.now() });
    h.t.now += 400; // LLM + TTS
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 2, t: Date.now() });
    await h.settle(60);
    const lat = h.find('agent.turn_latency');
    assert.equal(lat.length, 1);
    assert.equal(lat[0].turn_ms, 1650, `turn latency = 50 (last loud frame offset) + 1200 + 400 = ${lat[0].turn_ms}`);
    assert.equal(lat[0].since_transcript_ms, 400);
    a.emit('response_complete', { event_id: 3 });
    await h.settle(50);
    // a second utterance much later without room speech in between: not counted
    h.t.now += 40_000;
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 4, t: Date.now() });
    await h.settle(50);
    assert.equal(h.find('agent.turn_latency')[1].turn_ms, null);
    await h.finish();
    const cost = h.find('cost.summary')[0];
    assert.deepEqual(cost.turn_latency_ms, { n: 1, p50: 1650, p90: 1650, max: 1650, since_transcript_p50: 400, since_transcript_p90: 400 });
  });
});

describe('agent host: balance', () => {
  const rest = (used, limit) => ({ subscription: async () => ({ tier: 'starter', character_count: used, character_limit: limit }), conversation: async () => ({}) });
  test('at connect: less than a standup left -> agent.low_balance (Telegram when alerts are on); enough -> nothing', async () => {
    const h = makeHost({ present: ['Тимур Ткач'], deps: { checkBalance: true, rest: rest(20_000, 30_000) } });
    await h.ready();
    const low = h.find('agent.low_balance');
    assert.equal(low.length, 1);
    assert.deepEqual({ ...low[0], type: undefined }, { type: undefined, tier: 'starter', remaining: 10_000, minutes_left: 11, credits_per_min: 900 });
    await h.finish();
    const g = makeHost({ present: ['Тимур Ткач'], deps: { checkBalance: true, rest: rest(0, 30_000) } });
    await g.ready();
    assert.equal(g.find('agent.balance')[0].remaining, 30_000);
    assert.equal(g.find('agent.low_balance').length, 0, '30 000 credits ≈ 33 min at 900/min');
    await g.finish();
  });
});

describe('agent host: client tools and leaving', () => {
  test('give_word / turn_done / set_phase update the state; leave_meeting waits for the farewell audio, then leaves', async () => {
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский', 'Ярослав Орлов'] });
    await h.ready();
    const a = h.agent();
    a.emit('tool_call', { tool_name: 'give_word', tool_call_id: 'c1', parameters: { person_id: 'orlov_y' }, expects_response: true });
    await h.settle();
    assert.equal(h.host.state.current, 'orlov_y');
    assert.equal(h.host.meeting.phase, 'round');
    assert.deepEqual(a.toolResults[0].result.not_spoken_yet, ['Глеб', 'Тимур']);
    a.emit('tool_call', { tool_name: 'turn_done', tool_call_id: 'c2', parameters: { person_id: 'Ярослав' }, expects_response: true });
    a.emit('tool_call', { tool_name: 'give_word', tool_call_id: 'c3', parameters: { person_id: 'tkach_t' }, expects_response: true });
    await h.settle();
    assert.equal(h.host.state.get('orlov_y').status, 'spoke');
    assert.equal(h.host.state.current, 'tkach_t');
    assert.deepEqual(a.toolResults[2].result.not_spoken_yet, ['Глеб']);
    a.emit('tool_call', { tool_name: 'set_phase', tool_call_id: 'c4', parameters: { phase: 'open_floor' }, expects_response: true });
    a.emit('tool_call', { tool_name: 'set_phase', tool_call_id: 'c5', parameters: { phase: 'nope' }, expects_response: true });
    a.emit('tool_call', { tool_name: 'nothing', tool_call_id: 'c6', parameters: {}, expects_response: true });
    await h.settle();
    assert.equal(h.host.meeting.phase, 'open_floor');
    assert.equal(a.toolResults[4].is_error, true);
    assert.equal(a.toolResults[5].is_error, true);
    // non-blocking calls (expects_response false): no result is sent, the model gets a roster note instead; guests by name
    h.t.now += 1500;
    h.audio(2400, [-28]); // Тимур speaks
    const before = a.toolResults.length;
    const notes = a.contextual.length;
    a.emit('tool_call', { tool_name: 'give_word', tool_call_id: 'g1', parameters: { person_name: 'Нина' }, expects_response: false });
    await h.settle();
    assert.equal(a.toolResults.length, before, 'no client_tool_result for a non-blocking tool');
    assert.ok(h.host.state.current.startsWith('guest_'), `guest id: ${h.host.state.current}`);
    assert.equal(h.find('agent.guest')[0].name, 'Нина');
    assert.ok(a.contextual[notes].includes('Слово у: Нина.') && a.contextual[notes].includes('Ещё не выступали: Глеб.'), a.contextual[notes]);
    a.emit('tool_call', { tool_name: 'turn_done', tool_call_id: 'g2', parameters: { person_id: 'vera' }, expects_response: false });
    await h.settle();
    assert.equal(h.host.state.current, null, 'the guest turn ended (name matched case-insensitively)');
    assert.ok(a.contextual.at(-1).includes('Закончил: Нина.'));
    assert.equal(h.find('agent.tool_result').filter((e) => e.is_error).length, 2, 'guest calls are not errors');
    assert.equal(h.find('agent.guest').length, 1, 'one guest registered');
    // a roster person who LEFT the room never gets the floor (Орлов goes offline)
    h.setTiles(['Тимур Ткач', 'Глеб Невский']);
    await h.settle(900); // participant notes are batched
    a.emit('tool_call', { tool_name: 'give_word', tool_call_id: 'gx', parameters: { person_id: 'orlov_y' }, expects_response: true });
    await h.settle();
    const rej = a.toolResults.at(-1);
    assert.equal(rej.is_error, true, 'give_word to an absent person is rejected');
    assert.match(rej.result.error, /не на связи/);
    assert.notEqual(h.host.state.current, 'orlov_y', 'the floor did not move');
    // farewell: tool call first, audio a little later, leave only after the audio drained
    a.emit('tool_call', { tool_name: 'leave_meeting', tool_call_id: 'c7', parameters: {}, expects_response: true });
    await h.settle();
    assert.ok(h.host._test.leaving(), 'leave requested');
    assert.equal(h.find('host.finish').length, 0, 'not gone yet: waiting for the farewell');
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 1, t: Date.now() });
    await h.advance(300); // a tick sees the audio playing
    assert.equal(h.player.plays.length, 1);
    assert.equal(h.find('host.finish').length, 0, 'still speaking');
    a.emit('response_complete', { event_id: 2 });
    await h.advance(7000);
    const code = await h.run;
    assert.equal(code, 0);
    assert.equal(h.find('host.finish')[0].reason, 'leave:tool:leave_meeting');
    assert.equal(h.player.plays[0].bytes, 4800);
  });

  test('the server closing the conversation (end_call) also ends the run', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    h.agent().emit('closed', { reason: 'end_call' });
    await h.settle(200);
    // no audio ever started: leaves after the wait for audio (6 s)
    await h.advance(7000);
    const code = await h.run;
    assert.equal(code, 0);
    assert.match(h.find('host.finish')[0].reason, /^leave:agent_closed/);
  });

  test('--max-minutes nudges a farewell; leave_meeting ends the run', async () => {
    const h = makeHost({ present: ['Тимур Ткач'], flags: { maxMinutes: 1 } });
    await h.ready();
    const a = h.agent();
    await h.advance(61_000);
    assert.ok(a.userMessages.some((m) => m.includes('Лимит времени')), `nudges: ${a.userMessages}`);
    assert.equal(h.find('host.finish').length, 0);
    a.emit('tool_call', { tool_name: 'leave_meeting', tool_call_id: 'x', parameters: {}, expects_response: true });
    await h.settle();
    await h.advance(7000);
    const code = await h.run;
    assert.equal(code, 0);
  });
});

describe('agent host: kill switch = leave the meeting (direct, ~1–2 s)', () => {
  test('kill phrase in a transcript: player flushed, agent closed, audio no longer forwarded, she leaves', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 1, t: Date.now() });
    await h.settle(50);
    assert.equal(h.player.isSpeaking(), true);
    const t0 = Date.now();
    a.emit('transcript', { text: 'Карат, уйди из встречи!', event_id: 5, t: Date.now() });
    assert.deepEqual(h.player.stops, ['kill_switch']);
    assert.deepEqual(a.closes, ['kill_switch:voice']);
    assert.ok(Date.now() - t0 < 1000);
    h.audio();
    assert.equal(a.pushed, 0, 'no audio forwarded after the stop');
    await h.settle();
    assert.equal(h.find('guard.kill_phrase')[0].text, 'Карат, уйди из встречи!');
    assert.equal(h.find('guard.stop')[0].source, 'voice');
    assert.equal(h.find('host.kill_leave')[0].source, 'voice');
    // late audio events are not played either (player.play would create a new playback)
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 9, t: Date.now() });
    await h.settle(50);
    // the stop file was written by guards.stop('voice') into the temp file, never the real state/STOP
    assert.ok(h.find('guard.stop').length === 1);
    const code = await h.run;
    assert.equal(code, 0);
    assert.equal(h.host.phase, 'left');
    assert.equal(h.find('host.finish')[0].reason, 'kill_switch');
  });

  test('tentative transcript with the soft phrase addressed to her; an update mentioning «мы сами» does not stop', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    a.emit('transcript', { text: 'сегодня мы сами задеплоим сборку и посмотрим на прод', event_id: 1, t: Date.now() });
    await h.settle();
    assert.equal(h.find('host.kill_leave').length, 0);
    assert.equal(h.host.phase, 'waiting');
    a.emit('tentative_transcript', { text: 'Кора, дальше без тебя', t: Date.now() });
    assert.deepEqual(h.agent().closes, ['kill_switch:voice']);
    assert.equal(h.find('guard.kill_phrase')[0].via, 'tentative');
    const code = await h.run;
    assert.equal(code, 0);
    assert.equal(h.find('host.finish')[0].reason, 'kill_switch');
  });

  test('STOP file (temp path) makes her leave within ~1 s', async () => {
    const h = makeHost({ present: ['Тимур Ткач'], flags: { maxMinutes: 5 } });
    await h.ready();
    const a = h.agent();
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 1, t: Date.now() });
    await h.settle(50);
    const t0 = Date.now();
    writeFileSync(h.stopFile, 'test stop\n');
    while (h.host.phase !== 'left' && Date.now() - t0 < 3000) await sleep(20);
    const took = Date.now() - t0;
    assert.equal(h.host.phase, 'left');
    assert.ok(took <= 2000, `leave took ${took} ms`);
    assert.equal(a.closes[0], 'kill_switch:file');
    assert.ok(a.closes.includes('shutdown:kill_switch'), 'shutdown closes the agent again (idempotent)');
    assert.equal(h.player.stops[0], 'kill_switch');
    assert.ok(h.player.stops.includes('shutdown'), 'shutdown stops the playback again');
    assert.equal(h.find('guard.stop')[0].source, 'file');
    assert.equal(h.find('host.kill_leave')[0].source, 'file');
    const code = await h.run;
    assert.equal(code, 0);
    assert.equal(h.find('host.finish')[0].reason, 'kill_switch');
  });

  test('isAgentKillPhrase', () => {
    for (const s of ['Кора, уйди из встречи', 'Карат уйди', 'Кара, уходи', 'мы сами', 'Кора, мы сами', 'дальше без тебя']) assert.equal(isAgentKillPhrase(s), true, s);
    for (const s of ['мы сами это задеплоим сегодня после обеда', 'у меня всё, Кора', 'выйдет релиз завтра', 'Кора, стоп', 'стоп-лист обсудим', '']) assert.equal(isAgentKillPhrase(s), false, s);
  });
});

describe('agent host: a direct address always gets an answer', () => {
  test('addressed line + skip_turn -> the host nudges her to answer', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    a.emit('transcript', { text: 'Кора, у меня вопрос. Ответишь?', event_id: 11, t: Date.now() });
    a.emit('tool_response', { tool_name: 'skip_turn', status: 'success' });
    await h.settle(150);
    assert.equal(h.find('host.addressed_skip').length, 1);
    assert.ok(a.userMessages.some((m) => m.includes('прямое обращение')), `nudges: ${a.userMessages}`);
    const code = await h.finish();
    assert.equal(code, 0);
  });

  test('a joke addressed to her also gets a reaction (silence is indistinguishable from a malfunction)', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    a.emit('transcript', { text: 'Иди спать, Кора.', event_id: 21, t: Date.now() });
    a.emit('tool_response', { tool_name: 'skip_turn', status: 'success' });
    await h.settle(150);
    assert.equal(h.find('host.addressed_skip').length, 1);
    assert.ok(a.userMessages.some((m) => m.includes('прямое обращение')), 'she is asked to react to the joke');
    const code = await h.finish();
    assert.equal(code, 0);
  });

  test('she answered (audio started) -> a later unrelated skip_turn does not nudge', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    a.emit('transcript', { text: 'Кора, ты здесь?', event_id: 11, t: Date.now() });
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 12, t: Date.now() }); // her answer
    await h.settle(100);
    a.emit('tool_response', { tool_name: 'skip_turn', status: 'success' }); // some later utterance she correctly ignores
    await h.settle(150);
    assert.ok(!a.userMessages.some((m) => m.includes('прямое обращение')), 'no addressed nudge');
    const code = await h.finish();
    assert.equal(code, 0);
  });

  test('an address during the goodbye cancels the leave (she stays) and is not nudged', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    a.emit('tool_call', { tool_name: 'leave_meeting', tool_call_id: 'x', parameters: {}, expects_response: true });
    await h.settle(100);
    a.emit('transcript', { text: 'Кора, а вот вопрос вдогонку.', event_id: 11, t: Date.now() });
    await h.settle(200);
    assert.equal(h.find('host.leave_canceled').length, 1, 'the goodbye is canceled by the address');
    a.emit('tool_response', { tool_name: 'skip_turn', status: 'success' });
    await h.settle(150);
    assert.ok(!a.userMessages.some((m) => m.includes('прямое обращение')), 'canceled leave: no addressed nudge');
    const code = await h.finish();
    assert.equal(code, 0);
  });
});

describe('agent host: «Кора, стоп» quiet mode (mute, stay in the meeting)', () => {
  test('quiet cuts the line, suppresses her speech, she keeps listening; no STOP file', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 1, t: Date.now() });
    await h.settle(50);
    assert.equal(h.player.isSpeaking(), true);
    a.emit('transcript', { text: 'Кора, стоп.', event_id: 5, t: Date.now() });
    assert.equal(h.host._test.quiet(), true);
    assert.equal(h.find('host.quiet')[0]?.source, 'voice');
    assert.deepEqual(h.player.stops, ['quiet']);
    // she keeps listening
    const pushedBefore = a.pushed;
    h.audio();
    assert.ok(a.pushed > pushedBefore, 'room audio still forwarded to the agent');
    // her next utterance is suppressed by the gate, not played
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 6, t: Date.now() });
    await h.settle(100);
    assert.ok(h.find('agent.speech.suppressed').length >= 1, 'suppressed event logged');
    assert.equal(h.player.plays.length, 1, 'only the pre-quiet utterance played');
    // quiet is not a kill: no STOP flag, still in the meeting
    assert.ok(!existsSync(h.stopFile), 'quiet does not write the STOP file');
    assert.equal(h.find('guard.stop').length, 0);
    assert.equal(h.host.phase, 'waiting');
    const code = await h.finish();
    assert.equal(code, 0);
  });

  test('addressed by name she comes back and speaks again', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    a.emit('transcript', { text: 'Кора, стоп.', event_id: 5, t: Date.now() });
    assert.equal(h.host._test.quiet(), true);
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 6, t: Date.now() });
    await h.settle(50);
    assert.equal(h.player.plays.length, 0, 'quiet: nothing played');
    a.emit('transcript', { text: 'Кора, продолжай, мы готовы.', event_id: 7, t: Date.now() });
    assert.equal(h.host._test.quiet(), false);
    assert.equal(h.find('host.quiet_lifted').length, 1);
    assert.ok(a.userMessages.some((m) => m.includes('Продолжай вести встречу')), 'lift nudge as a user message');
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 8, t: Date.now() });
    await h.settle(50);
    assert.equal(h.player.plays.length, 1, 'she speaks again after the lift');
    const code = await h.finish();
    assert.equal(code, 0);
  });

  test('«уйди из встречи» while quiet still leaves', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    a.emit('transcript', { text: 'Кора, стоп.', event_id: 5, t: Date.now() });
    assert.equal(h.host._test.quiet(), true);
    a.emit('transcript', { text: 'Кора, уйди из встречи.', event_id: 6, t: Date.now() });
    const code = await h.run;
    assert.equal(code, 0);
    assert.equal(h.find('host.finish')[0].reason, 'kill_switch');
    assert.equal(h.host.phase, 'left');
  });
});

describe('agent host: silence notes and Orlov joining (facts for a model without a clock)', () => {
  test('round: 7 s of quiet -> «Тишина 7 с …» with whose floor it is; two per quiet stretch; speech resets; a silent new speaker stays pending', async () => {
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'] });
    await h.ready();
    const a = h.agent();
    await h.advance(19_000);
    assert.ok(!a.userMessages.some((m) => m.includes('Тишина')), 'no note before 20 s of quiet');
    await h.advance(1200);
    assert.match(a.userMessages.at(-1), /Тишина 20 с после последней реплики. Стендап ещё не начат, старт в 10:00.$/, 'a long pause before the start: she may break it');
    await h.advance(40_000);
    assert.equal(a.userMessages.filter((m) => m.includes('Тишина')).length, 1, 'once per quiet stretch');
    await h.start();
    const base = a.userMessages.length;
    a.emit('tool_call', { tool_name: 'give_word', tool_call_id: 'g1', parameters: { person_id: 'tkach_t' }, expects_response: false });
    await h.settle();
    h.t.now += 1500;
    h.audio(2400, [-28]); // Тимур speaks
    await h.advance(3000);
    assert.equal(a.userMessages.length, base, 'nothing before 7 s of quiet');
    await h.advance(4200);
    assert.equal(a.userMessages.length, base + 1);
    assert.match(a.userMessages.at(-1), /^\[хост [\d:]+\] Тишина 7 с после реплики того, у кого слово\. Слово у: Тимур\.$/);
    assert.equal(h.find('agent.nudge').at(-1).kind, 'silence');
    await h.advance(7200);
    assert.equal(a.userMessages.length, base + 2, 'a second note when the first changed nothing');
    await h.advance(20_000);
    assert.equal(a.userMessages.length, base + 2, 'at most two per quiet stretch');
    h.audio(2400, [-28]); // the room speaks again: the count starts over
    await h.advance(7200);
    assert.equal(a.userMessages.length, base + 3);
    // the next speaker says nothing after the handoff
    a.emit('tool_call', { tool_name: 'give_word', tool_call_id: 'g2', parameters: { person_id: 'nevsky_g' }, expects_response: false });
    await h.settle();
    await h.advance(7200);
    assert.match(a.userMessages.at(-1), /Тишина 7 с после передачи слова\. Слово у: Глеб; после передачи слова Глеб не слышно\.$/);
    // she moves on («вернусь к тебе в конце»): Глеб did not speak, so he is still pending
    a.emit('tool_call', { tool_name: 'give_word', tool_call_id: 'g3', parameters: { person_id: 'tkach_t' }, expects_response: false });
    await h.settle();
    assert.equal(h.host.state.get('nevsky_g').status, 'skipped');
    assert.ok(a.contextual.at(-1).includes('Ещё не выступали: Глеб.'), a.contextual.at(-1));
    // nothing while she speaks
    const n = a.userMessages.length;
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 90 });
    await h.advance(8000);
    assert.equal(a.userMessages.length, n, 'no note while her audio plays');
    await h.finish();
    assert.equal(h.find('cost.summary')[0].silence_nudges, 5);
  });

  test('waiting: only her «никто не против?» gets a silence note; open floor: the note quotes her question', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    await h.start();
    let base = a.userMessages.length;
    a.emit('response', { text: 'Доброе утро, коллеги! Ждём Ярослава. Тимур, можешь его пингануть?', event_id: 10 });
    await h.advance(9000);
    assert.equal(a.userMessages.length, base, 'a question that a short silence does not answer: no note');
    a.emit('response', { text: 'Начнём без Ярослава, никто не против?', event_id: 12 });
    await h.advance(6200);
    assert.equal(a.userMessages.length, base + 1);
    assert.match(a.userMessages.at(-1), /Тишина 6 с после твоей реплики «Начнём без Ярослава, никто не против\?»\. Стендап ещё не начат\. Ярослав Орлов: не на связи\.$/);
    // the round, then the open floor after her question
    a.emit('tool_call', { tool_name: 'give_word', tool_call_id: 'g1', parameters: { person_id: 'tkach_t' }, expects_response: false });
    await h.settle();
    h.t.now += 1500;
    h.audio(2400, [-28]);
    h.t.now += 800; // she answers a moment after he stops
    a.emit('tool_call', { tool_name: 'turn_done', tool_call_id: 't1', parameters: { person_id: 'tkach_t' }, expects_response: false });
    a.emit('tool_call', { tool_name: 'set_phase', tool_call_id: 's1', parameters: { phase: 'open_floor' }, expects_response: false });
    a.emit('response', { text: 'Все высказались. Кто хочет что-то добавить или спросить?', event_id: 20 });
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 20 });
    a.emit('response_complete', { event_id: 20 });
    await h.settle();
    base = a.userMessages.length;
    await h.advance(4000);
    assert.equal(a.userMessages.length, base, 'she does not close on a short pause');
    await h.advance(3200);
    assert.equal(a.userMessages.length, base + 1);
    assert.match(a.userMessages.at(-1), /Тишина 7 с после твоей реплики «Все высказались\. Кто хочет что-то добавить или спросить\?»\. Идёт открытое слово\.$/);
    // someone adds something: the next note says the silence follows the colleagues, not her question
    h.audio(2400, [-28]);
    await h.advance(7200);
    assert.match(a.userMessages.at(-1), /Тишина 7 с после реплик коллег\. Идёт открытое слово\.$/);
    await h.finish();
  });

  test('Orlov joins while the meeting waits for him -> a nudge; mid-round -> a note that he has not spoken', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    await h.start();
    const base = a.userMessages.length;
    h.setTiles(['Тимур Ткач', 'Ярослав Орлов']);
    await h.settle(900);
    assert.equal(a.userMessages.length, base + 1, 'she must act now: a contextual note alone gives her no turn');
    assert.match(a.userMessages.at(-1), /Подключился Ярослав\..*Ярослав Орлов: на связи\. Стендап ещё не начат, его ждали\.$/);
    assert.equal(h.find('agent.nudge').at(-1).kind, 'lead_joined');
    await h.finish();

    const g = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'] });
    await g.ready();
    const b = g.agent();
    await g.start();
    b.emit('tool_call', { tool_name: 'give_word', tool_call_id: 'g1', parameters: { person_id: 'tkach_t' }, expects_response: false });
    await g.settle();
    const n = b.userMessages.length;
    g.setTiles(['Тимур Ткач', 'Глеб Невский', 'Ярослав Орлов']);
    await g.settle(900);
    assert.equal(b.userMessages.length, n, 'Тимур has the floor: no nudge');
    assert.match(b.contextual.at(-1), /Подключился Ярослав\..*Ярослав ещё не выступал\.$/);
    await g.finish();
  });
});

describe('agent host: farewell seal, linger, staying on request', () => {
  const al = (text, t0 = 0, step = 10) => ({ chars: [...text], starts: [...text].map((_, i) => t0 + i * step), durations: [...text].map(() => step) });

  test('seal (alignment): only the farewell said before leave_meeting reaches the room; its tail is cut, a later answer is heard; then a ~5 s linger', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    a.emit('response', { text: 'Тогда всем хорошей недели!', event_id: 7 }); // 26 characters
    a.emit('tool_call', { tool_name: 'leave_meeting', tool_call_id: 'l1', parameters: {}, expects_response: false });
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 7, alignment: al('Тогда всем') }); // 10 characters, 100 ms
    await h.advance(300);
    a.emit('audio', { pcm: Buffer.alloc(9600, 1), event_id: 7, alignment: al(' хорошей недели! Нельзя') }); // 27th character at 160 ms
    a.emit('response', { text: 'Нельзя передавать слова.', event_id: 7 });
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 7, alignment: al(' передавать') });
    a.emit('response_complete', { event_id: 7 });
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 8 }); // a later response (she answers someone): heard
    a.emit('response_complete', { event_id: 8 });
    await h.settle();
    assert.equal(h.player.plays.length, 2);
    assert.equal(h.player.plays[0].bytes, 4800 + 160 * 48, 'cut where the 27th character starts');
    assert.equal(h.player.plays[1].bytes, 4800, 'test #3: a sealed later answer made her leave in silence');
    const seal = h.find('host.farewell_seal')[0];
    assert.equal(seal.chars, 26);
    assert.equal(seal.how, 'text_before_call');
    assert.equal(h.find('host.farewell_extra')[0].text, 'Нельзя передавать слова.');
    assert.equal(h.find('agent.speech.sealed').length, 1);
    await h.advance(4000);
    assert.equal(h.find('host.finish').length, 0, 'the audio is out, she lingers ~5 s');
    await h.advance(1500);
    const code = await h.run;
    assert.equal(code, 0);
    assert.equal(h.find('host.finish')[0].reason, 'leave:tool:leave_meeting');
    const cost = h.find('cost.summary')[0];
    assert.equal(cost.farewell.extra, 'Нельзя передавать слова.');
    assert.equal(cost.playback.sealed_drop_ms, 140, 'only the tail of the farewell response: 40 ms of the second chunk + the third chunk');
    assert.ok(h.find('agent.alignment_sample').length >= 1, 'the first aligned chunks are logged');
  });

  test('seal without alignment: extra text cuts the farewell response at its estimated length; leave_meeting before any text seals the next text', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    a.emit('response', { text: 'Тогда всем хорошей недели!', event_id: 9 });
    a.emit('tool_call', { tool_name: 'leave_meeting', tool_call_id: 'l1', parameters: {}, expects_response: false });
    a.emit('audio', { pcm: Buffer.alloc(48_000, 1), event_id: 9 }); // 1000 ms
    await h.advance(300);
    a.emit('response', { text: 'Нельзя передавать слова.', event_id: 9 });
    a.emit('audio', { pcm: Buffer.alloc(96_000, 1), event_id: 9 }); // 2000 ms more
    a.emit('response_complete', { event_id: 9 });
    await h.settle();
    const est = Math.round(26 * 70 * 1.05 + 250);
    assert.equal(h.player.plays[0].bytes, 48_000 + (Math.floor((est - 1000) * 48) & ~1), `kept ${est} ms`);
    await h.finish();

    const g = makeHost({ present: ['Тимур Ткач'] });
    await g.ready();
    const b = g.agent();
    b.emit('tool_call', { tool_name: 'leave_meeting', tool_call_id: 'l2', parameters: {}, expects_response: false });
    await g.settle();
    assert.equal(g.find('host.farewell_pending').length, 1);
    b.emit('response', { text: 'Всем пока!', event_id: 70 });
    assert.equal(g.find('host.farewell_seal')[0].how, 'text_after_call');
    assert.equal(g.find('host.farewell_seal')[0].chars, 10);
    await g.finish();
  });

  test('an interruption during the goodbye keeps her in (up to 3 times: seal lifted, note sent); after that the leave is final', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    const farewell = 'Всё, ребята, хорошей недели! Дальше дев-синк, пока!';
    let id = 30;
    for (let i = 1; i <= 3; i++) {
      a.emit('response', { text: farewell, event_id: id });
      a.emit('tool_call', { tool_name: 'leave_meeting', tool_call_id: `l${i}`, parameters: {}, expects_response: false });
      a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: id });
      await h.advance(300);
      a.emit('interruption', { event_id: id + 1 });
      await h.settle();
      assert.equal(h.host._test.leaving(), null, `she stays after interruption #${i}`);
      id += 10;
    }
    assert.equal(h.find('host.leave_canceled').length, 3);
    assert.equal(h.find('host.leave_canceled')[0].why, 'interruption');
    assert.ok(a.contextual.at(-1).includes('Тебя остановили на прощании'), a.contextual.at(-1));
    assert.equal(h.host.phase, 'open_floor');
    a.emit('response', { text: 'Слушаю, Тимур.', event_id: id });
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: id });
    a.emit('response_complete', { event_id: id });
    await h.settle();
    assert.equal(h.player.plays.at(-1).bytes, 4800, 'heard again after the seal was lifted');
    id += 10;
    a.emit('response', { text: farewell, event_id: id });
    a.emit('tool_call', { tool_name: 'leave_meeting', tool_call_id: 'l4', parameters: {}, expects_response: false });
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: id });
    await h.advance(300);
    a.emit('interruption', { event_id: id + 1 });
    await h.settle();
    assert.ok(h.host._test.leaving()?.final, 'after three cancels the leave is final');
    await h.advance(5500);
    const code = await h.run;
    assert.equal(code, 0);
    assert.equal(h.find('host.leave_canceled').length, 3);
    assert.equal(h.find('cost.summary')[0].leave_cancels, 3);
  });

  test('a line cut early -> a note with what the room heard; a nearly finished line -> no note', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    const q = 'Все высказались. Кто хочет что-то добавить или спросить?';
    a.emit('correction', { original: q, corrected: 'Все...', event_id: 5 });
    await h.settle();
    assert.ok(a.contextual.some((c) => c.endsWith('Тебя перебили: из твоей реплики услышали только «Все...».')), a.contextual.join(' | '));
    const n = a.contextual.length;
    a.emit('correction', { original: q, corrected: 'Все высказались. Кто хочет что-то добавить или спро...', event_id: 6 });
    await h.settle();
    assert.equal(a.contextual.length, n, 'most of it was heard: no note');
    await h.finish();
  });

  test('during the linger «Кора, подожди…» keeps her in; «Пока, Кора!» does not', async () => {
    const h = makeHost({ present: ['Тимур Ткач'] });
    await h.ready();
    const a = h.agent();
    a.emit('response', { text: 'Тогда всем хорошего дня! Передаю слово на дев-синк.', event_id: 30 });
    a.emit('tool_call', { tool_name: 'leave_meeting', tool_call_id: 'l1', parameters: {}, expects_response: false });
    a.emit('audio', { pcm: Buffer.alloc(4800, 1), event_id: 30 });
    await h.advance(300);
    a.emit('response_complete', { event_id: 30 });
    await h.settle();
    a.emit('transcript', { text: 'Пока, Кора!', event_id: 60 });
    await h.settle();
    assert.ok(h.host._test.leaving(), 'a goodbye does not keep her');
    a.emit('transcript', { text: 'Так, дев-синк, кто начнёт?', event_id: 61 });
    await h.settle();
    assert.ok(h.host._test.leaving(), 'the dev-sync talk does not keep her');
    a.emit('transcript', { text: 'Кора, подожди, у меня вопрос', event_id: 62 });
    await h.settle();
    assert.equal(h.host._test.leaving(), null);
    assert.equal(h.find('host.leave_canceled')[0].why, 'addressed');
    await h.finish();
    // «подожди!» without her name right after the farewell works too
    const g = makeHost({ present: ['Тимур Ткач'] });
    await g.ready();
    const b = g.agent();
    b.emit('response', { text: 'Всё, ребята, хорошего дня! Дальше дев-синк, пока!', event_id: 3 });
    b.emit('tool_call', { tool_name: 'leave_meeting', tool_call_id: 'l1', parameters: {}, expects_response: false });
    await g.settle();
    b.emit('transcript', { text: 'Ой, подожди!', event_id: 4 });
    await g.settle();
    assert.equal(g.host._test.leaving(), null);
    await g.finish();
  });

  test('after 10:30 (or --max-minutes) asked her to close, the leave is final', async () => {
    const h = makeHost({ present: ['Тимур Ткач'], flags: { maxMinutes: 1 } });
    await h.ready();
    const a = h.agent();
    await h.advance(61_000);
    a.emit('response', { text: 'Тогда всем хорошего дня! Передаю слово на дев-синк.', event_id: 5 });
    a.emit('tool_call', { tool_name: 'leave_meeting', tool_call_id: 'l1', parameters: {}, expects_response: false });
    await h.settle();
    assert.equal(h.host._test.leaving()?.final, true);
    await h.finish();
  });
});

describe('agent host: on-demand mode (no --start)', () => {
  async function readyOnDemand(h) {
    const t0 = Date.now();
    while (!(h.agent() && h.agent().connected) && Date.now() - t0 < 3000) await sleep(20);
    assert.ok(h.agent()?.connected, 'agent connects at once, without waiting for a start time');
  }

  test('connects at once; passing the old 10:00 fires nothing; «Кора, начинай» opens the standup once', async () => {
    const h = makeHost({ present: ['Тимур Ткач', 'Глеб Невский'], onDemand: true });
    await readyOnDemand(h);
    h.setTiles(['Тимур Ткач', 'Глеб Невский']);
    await h.settle(900);
    clock.setSimulatedStart('10:05'); // past the old start time: no timers exist
    await h.advance(1000);
    assert.ok(!h.agent().userMessages.some((m) => m.includes('Пора открывать стендап')), 'no time-based start nudge');
    h.agent().emit('transcript', { text: 'Кора, начинай.', event_id: 31, t: Date.now() });
    await h.settle(200);
    assert.equal(h.agent().userMessages.filter((m) => m.includes('просят начать стендап')).length, 1, `nudges: ${h.agent().userMessages}`);
    h.agent().emit('transcript', { text: 'Кора, поехали!', event_id: 32, t: Date.now() }); // repeat: no double nudge
    await h.settle(200);
    assert.equal(h.agent().userMessages.filter((m) => m.includes('просят начать стендап')).length, 1);
    const code = await h.finish();
    assert.equal(code, 0);
  });

  test('«Кора, поехали» without her opening counts too; a start word without the name does not', async () => {
    const h = makeHost({ present: ['Тимур Ткач'], onDemand: true });
    await readyOnDemand(h);
    h.setTiles(['Тимур Ткач']);
    await h.settle(900);
    h.agent().emit('transcript', { text: 'ну что, поехали?', event_id: 41, t: Date.now() });
    await h.settle(200);
    assert.ok(!h.agent().userMessages.some((m) => m.includes('просят начать стендап')), 'name required');
    h.agent().emit('transcript', { text: 'Кора, начнём!', event_id: 42, t: Date.now() });
    await h.settle(200);
    assert.ok(h.agent().userMessages.some((m) => m.includes('просят начать стендап')), 'name + start verb opens it');
    const code = await h.finish();
    assert.equal(code, 0);
  });

  test('an empty room gets no silence notes (no small talk into the void)', async () => {
    const h = makeHost({ present: [], onDemand: true });
    await readyOnDemand(h);
    await h.advance(30_000); // far past waiting_long (20 s)
    assert.ok(!h.agent().userMessages.some((m) => m.includes('Тишина')), 'no silence notes without people');
    h.setTiles(['Тимур Ткач']);
    await h.settle(900);
    await h.advance(25_000); // a person is present: the waiting small-talk note may come
    assert.ok(h.agent().userMessages.some((m) => m.includes('Тишина')), 'silence notes resume with people');
    const code = await h.finish();
    assert.equal(code, 0);
  });
});
