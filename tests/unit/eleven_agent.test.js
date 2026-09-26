// Offline tests for src/audio/eleven_agent.js against the fake ElevenLabs WebSocket server.
import assert from 'node:assert/strict';
import { after, afterEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { ElevenAgent, attachPlayer, balanceOf, describeError, elevenRest, fetchConversationCost, pcmRate, resamplePcm16 } from '../../src/audio/eleven_agent.js';
import { FakeElevenServer, fakePlayer, fakeRest } from '../helpers/fake_eleven_server.js';

const servers = [];
const agents = [];
async function server(opts) {
  const s = new FakeElevenServer(opts);
  await s.listening;
  servers.push(s);
  return s;
}
function events() {
  const list = [];
  return { list, event: (type, fields = {}) => (list.push({ type, ...fields }), { type }), types: (re) => list.filter((e) => re.test(e.type)) };
}
function makeAgent(s, extra = {}) {
  const log = events();
  const rest = fakeRest(s);
  const a = new ElevenAgent({ agentId: 'agent_1', rest, log, reconnectDelaysMs: [30, 30, 30], connectTimeoutMs: 2000, ...extra });
  agents.push(a);
  return { agent: a, log, rest };
}
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close().catch(() => {});
});
after(async () => {
  for (const s of servers.splice(0)) await s.close();
});

describe('ElevenAgent: connect, init, audio, events', () => {
  test('signed URL -> init payload (override + dynamic variables) -> metadata; audio both ways', async () => {
    const s = await server();
    const init = { override: { agent: { prompt: { prompt: 'PROMPT' }, first_message: '', language: 'ru' } }, dynamicVariables: { present: 'Тима' } };
    const { agent, log, rest } = makeAgent(s, { init: () => init });
    const info = await agent.connect();
    assert.equal(info.conversation_id, 'conv_0');
    assert.deepEqual(info.formats, { in: 'pcm_24000', out: 'pcm_24000' });
    assert.deepEqual(rest.calls[0], ['signedUrl', 'agent_1']);
    const conn = s.last;
    assert.equal(conn.url, '/v1/convai/conversation?agent_id=agent_1&token=t');
    assert.equal(conn.init.type, 'conversation_initiation_client_data');
    assert.equal(conn.init.conversation_config_override.agent.prompt.prompt, 'PROMPT');
    assert.deepEqual(conn.init.dynamic_variables, { present: 'Тима' });
    assert.ok(agent.connected);
    // audio in: 100 ms chunks reach the server as base64 pcm
    const chunk = Buffer.alloc(4800, 1);
    assert.equal(agent.pushAudio(chunk), true);
    assert.equal(agent.pushAudio(new Int16Array(2400)), true);
    await s.waitFor(conn, (c) => c.audio.length === 2, { what: 'audio' });
    assert.equal(conn.audioBytes, 9600);
    assert.equal(agent.stats().audio_in_ms, 200);
    // audio out
    const got = [];
    agent.on('audio', (a) => got.push(a));
    s.audio(conn, Buffer.alloc(2400, 2), 7);
    await sleep(60);
    assert.equal(got.length, 1);
    assert.equal(got[0].event_id, 7);
    assert.equal(got[0].pcm.length, 2400);
    assert.equal(agent.stats().audio_out_ms, 50);
    assert.ok(log.types(/^eleven\.connect$/).length === 1);
  });

  test('server events -> typed events; ping -> pong; tool call -> result; context + user messages', async () => {
    const s = await server();
    const { agent } = makeAgent(s);
    await agent.connect();
    const conn = s.last;
    const seen = {};
    for (const t of ['response', 'correction', 'response_complete', 'transcript', 'tentative_transcript', 'interruption', 'tool_call', 'vad', 'ping', 'client_error', 'server_event', 'context_usage']) {
      agent.on(t, (e) => (seen[t] ??= []).push(e));
    }
    s.send(conn, { type: 'context_usage', context_usage_event: { event_id: 3, model: 'gemini-3.5-flash-lite', context_tokens: 1480, context_limit_tokens: 1048576 } });
    s.response(conn, 'Спасибо, Тима!');
    s.correction(conn, 'Спасибо, Тима! Дальше', 'Спасибо, Тима!');
    s.complete(conn);
    s.transcript(conn, 'у меня всё');
    s.tentative(conn, 'у меня');
    s.vad(conn, 0.9);
    const pid = s.ping(conn, 41, 25);
    const call = s.toolCall(conn, 'give_word', { person_id: 'tkach_t' });
    s.clientError(conn, 'bad', 'oops');
    s.send(conn, { type: 'internal_turn_probability', x: 1 });
    await sleep(80);
    assert.equal(seen.response[0].text, 'Спасибо, Тима!');
    assert.equal(seen.correction[0].corrected, 'Спасибо, Тима!');
    assert.equal(seen.response_complete.length, 1);
    assert.equal(seen.transcript[0].text, 'у меня всё');
    assert.equal(seen.tentative_transcript[0].text, 'у меня');
    assert.equal(seen.vad[0].score, 0.9);
    assert.equal(seen.ping[0].ping_ms, 25);
    assert.deepEqual(seen.tool_call[0].parameters, { person_id: 'tkach_t' });
    assert.equal(seen.tool_call[0].tool_call_id, call);
    assert.equal(seen.client_error[0].message, 'oops');
    assert.equal(seen.server_event[0].type, 'internal_turn_probability');
    assert.deepEqual({ ...seen.context_usage[0], t: undefined }, { model: 'gemini-3.5-flash-lite', context_tokens: 1480, context_limit_tokens: 1048576, event_id: 3, t: undefined });
    assert.equal(agent.stats().context_tokens, 1480);
    await s.waitFor(conn, (c) => c.pongs.length === 1, { what: 'pong' });
    assert.equal(conn.pongs[0].event_id, pid);
    agent.sendToolResult(call, { ok: true, next: ['nevsky_g'] });
    agent.sendContextualUpdate('[хост 10:00:01] Говорит: Тима.');
    agent.sendUserMessage('[хост 10:00:00] Пора открывать стендап.');
    await s.waitFor(conn, (c) => c.toolResults.length && c.contextual.length && c.userMessages.length, { what: 'client messages' });
    assert.deepEqual(conn.toolResults[0], { type: 'client_tool_result', tool_call_id: call, result: '{"ok":true,"next":["nevsky_g"]}', is_error: false });
    assert.equal(conn.contextual[0], '[хост 10:00:01] Говорит: Тима.');
    assert.equal(conn.userMessages[0], '[хост 10:00:00] Пора открывать стендап.');
    const st = agent.stats();
    assert.equal(st.responses, 1);
    assert.equal(st.transcripts, 1);
    assert.equal(st.tool_calls, 1);
    assert.equal(st.pings, 1);
    assert.equal(st.context_updates, 1);
    assert.equal(st.user_messages, 1);
  });

  test('interruption drops audio with event_id <= X, later audio is delivered again', async () => {
    const s = await server();
    const { agent } = makeAgent(s);
    await agent.connect();
    const conn = s.last;
    const got = [];
    agent.on('audio', (a) => got.push(a.event_id));
    s.audio(conn, Buffer.alloc(480), 10);
    s.interrupt(conn, 12);
    s.audio(conn, Buffer.alloc(480), 11); // in flight when the interruption happened
    s.audio(conn, Buffer.alloc(480), 12);
    s.audio(conn, Buffer.alloc(480), 13); // next response
    await sleep(80);
    assert.deepEqual(got, [10, 13]);
    assert.equal(agent.stats().interruptions, 1);
  });

  test('refused init -> connect rejects; formats other than 24 kHz are resampled both ways', async () => {
    const s = await server({ inFormat: 'pcm_16000', outFormat: 'pcm_16000' });
    s.refuseInit = { code: 'agent_not_found', message: 'no such agent' };
    const { agent } = makeAgent(s);
    await assert.rejects(agent.connect(), /refused the conversation.*no such agent/);
    assert.equal(agent.state, 'closed');
    s.refuseInit = null;
    const { agent: b } = makeAgent(s);
    const info = await b.connect();
    assert.equal(info.formats.in, 'pcm_16000');
    b.pushAudio(Buffer.alloc(4800)); // 100 ms at 24 kHz -> 3200 bytes at 16 kHz
    const conn = s.last;
    await s.waitFor(conn, (c) => c.audio.length === 1, { what: 'audio' });
    assert.equal(conn.audioBytes, 3200);
    const got = [];
    b.on('audio', (a) => got.push(a.pcm.length));
    s.audio(conn, Buffer.alloc(3200)); // 100 ms at 16 kHz -> 4800 bytes at 24 kHz
    await sleep(60);
    assert.deepEqual(got, [4800]);
  });

  test('unexpected close -> new conversation with reconnect init + resume note; code 1000 -> closed, no reconnect', async () => {
    const s = await server();
    const inits = [];
    const { agent, log } = makeAgent(s, {
      init: ({ reconnect }) => {
        inits.push(reconnect);
        return { override: { agent: { prompt: { prompt: reconnect ? 'AGAIN' : 'FIRST' } } }, resume: reconnect ? '[хост] связь восстановилась' : null };
      },
    });
    await agent.connect();
    const first = s.last;
    const reconnected = [];
    agent.on('reconnected', (r) => reconnected.push(r));
    s.drop(first);
    const second = await s.connection(1);
    await sleep(50);
    assert.deepEqual(inits, [false, true]);
    assert.equal(second.init.conversation_config_override.agent.prompt.prompt, 'AGAIN');
    await s.waitFor(second, (c) => c.contextual.length === 1, { what: 'resume note' });
    assert.equal(second.contextual[0], '[хост] связь восстановилась');
    assert.equal(reconnected.length, 1);
    assert.equal(agent.conversationId, 'conv_1');
    assert.equal(agent.stats().reconnects, 1);
    assert.equal(agent.stats().sessions, 2);
    assert.ok(log.types(/^eleven\.reconnect$/).length === 1);
    // the server ends the conversation itself (end_call): 'closed', no third connection
    const closed = [];
    agent.on('closed', (c) => closed.push(c));
    s.end(second, 1000, 'end_call');
    await sleep(120);
    assert.equal(closed.length, 1);
    assert.equal(agent.state, 'closed');
    assert.equal(s.conns.length, 2);
    assert.equal(agent.pushAudio(Buffer.alloc(480)), false);
    assert.ok(agent.stats().connected_ms >= 0);
  });

  test('gives up after maxReconnects and emits failed', async () => {
    const s = await server();
    const { agent } = makeAgent(s, { maxReconnects: 1 });
    await agent.connect();
    const failed = [];
    agent.on('failed', (f) => failed.push(f));
    await s.close();
    servers.splice(servers.indexOf(s), 1);
    await sleep(400);
    assert.equal(failed.length, 1);
    assert.equal(agent.state, 'closed');
  });
});

describe('attachPlayer: agent audio -> Player', () => {
  test('one playback per response; complete ends it; interruption stops the player; next response queues', async () => {
    const s = await server();
    const { agent, log } = makeAgent(s);
    const player = fakePlayer();
    const starts = [];
    const playback = attachPlayer(agent, player, { log, idleEndMs: 300, onStart: (u) => starts.push(u) });
    await agent.connect();
    const conn = s.last;
    s.audio(conn, Buffer.alloc(4800, 1), 1);
    s.audio(conn, Buffer.alloc(4800, 1), 2);
    await sleep(40);
    assert.equal(player.plays.length, 1);
    assert.equal(starts.length, 1, 'onStart once per utterance');
    assert.equal(starts[0].event_id, 1);
    assert.equal(playback.isSpeaking(), true);
    s.complete(conn, 3);
    await sleep(40);
    const r = await player.plays[0].done;
    assert.equal(r.status, 'completed');
    assert.equal(player.plays[0].bytes, 9600);
    assert.equal(playback.isSpeaking(), false);
    // second response, interrupted
    s.audio(conn, Buffer.alloc(4800, 2), 4);
    await sleep(30);
    assert.equal(player.plays.length, 2);
    s.interrupt(conn, 4);
    await sleep(40);
    assert.deepEqual(player.stops, ['interruption']);
    assert.equal((await player.plays[1].done).status, 'aborted');
    s.audio(conn, Buffer.alloc(4800, 3), 4); // stale chunk of the interrupted response
    s.audio(conn, Buffer.alloc(4800, 3), 5); // new response
    await sleep(40);
    assert.equal(player.plays.length, 3);
    // no complete event: the idle timer ends the utterance
    await sleep(400);
    assert.equal((await player.plays[2].done).status, 'completed');
    assert.equal(playback.stats().utterances, 3);
    assert.equal(starts.length, 3);
    const types = log.types(/^agent\.speech\./).map((e) => e.type);
    assert.ok(types.includes('agent.speech.start') && types.includes('agent.speech.end') && types.includes('agent.speech.abort'));
    assert.equal(await playback.waitIdle(200), true);
  });

  test('gate: while closed, responses are suppressed (nothing played, no onStart); open again -> plays', async () => {
    const s = await server();
    const { agent, log } = makeAgent(s);
    const player = fakePlayer();
    const starts = [];
    let open = true;
    const playback = attachPlayer(agent, player, { log, idleEndMs: 300, onStart: (u) => starts.push(u), gate: () => !open });
    await agent.connect();
    const conn = s.last;
    open = false;
    s.audio(conn, Buffer.alloc(4800, 1), 1);
    await sleep(40);
    assert.equal(player.plays.length, 0, 'nothing played while the gate is closed');
    assert.equal(starts.length, 0, 'no onStart for a suppressed utterance');
    assert.ok(log.types(/^agent\.speech\./).some((e) => e.type === 'agent.speech.suppressed'));
    open = true;
    s.audio(conn, Buffer.alloc(4800, 2), 2);
    await sleep(40);
    assert.equal(player.plays.length, 1, 'plays once the gate opens');
    assert.equal(starts.length, 1);
    s.complete(conn, 3);
    await sleep(40);
    assert.equal((await player.plays[0].done).status, 'completed');
    assert.equal(await playback.waitIdle(200), true);
  });
});

describe('helpers', () => {
  test('pcmRate / resamplePcm16', () => {
    assert.equal(pcmRate('pcm_24000'), 24000);
    assert.throws(() => pcmRate('ulaw_8000'), /unsupported/);
    const src = Buffer.alloc(8);
    src.writeInt16LE(0, 0);
    src.writeInt16LE(1000, 2);
    src.writeInt16LE(2000, 4);
    src.writeInt16LE(3000, 6);
    const up = resamplePcm16(src, 16000, 24000);
    assert.equal(up.length, 12);
    assert.equal(up.readInt16LE(2), 667); // 2/3 of the way to 1000
    assert.equal(resamplePcm16(src, 24000, 24000), src);
    assert.equal(resamplePcm16(Buffer.alloc(4800), 24000, 16000).length, 3200);
  });

  test('elevenRest: xi-api-key header, query, errors with the API detail; conversation cost; balance', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      if (url.includes('get-signed-url')) return { ok: true, status: 200, text: async () => JSON.stringify({ signed_url: 'wss://x/y?token=1' }) };
      if (url.includes('/conversations/conv_9')) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'processing', metadata: { cost: null, call_duration_secs: 30 } }) };
      if (url.includes('/conversations/conv_done')) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'done', metadata: { cost: 55, call_duration_secs: 30, charging: { llm_charge: 5 } }, transcript: [{}, {}] }) };
      return { ok: false, status: 422, text: async () => JSON.stringify({ detail: { status: 'invalid', message: 'bad voice' } }) };
    };
    const rest = elevenRest({ apiKey: 'sk-test', fetch, baseUrl: 'https://api.test' });
    assert.equal(await rest.signedUrl('a1'), 'wss://x/y?token=1');
    assert.equal(calls[0].headers['xi-api-key'], 'sk-test');
    assert.equal(calls[0].url, 'https://api.test/v1/convai/conversation/get-signed-url?agent_id=a1');
    await assert.rejects(rest.post('/v1/convai/agents/create', { a: 1 }), (e) => e.status === 422 && /bad voice/.test(e.message));
    assert.equal(calls.at(-1).body, '{"a":1}');
    const c = await fetchConversationCost(rest, 'conv_9', { tries: 2, delayMs: 5 });
    assert.equal(c.cost, null);
    assert.equal(c.tries, 2);
    const d = await fetchConversationCost(rest, 'conv_done', { tries: 2, delayMs: 5 });
    assert.equal(d.cost, 55);
    assert.equal(d.llm_charge, 5);
    assert.equal(d.transcript_lines, 2);
    assert.deepEqual(balanceOf({ tier: 'free', character_count: 400, character_limit: 10000 }), { tier: 'free', used: 400, limit: 10000, remaining: 9600, next_reset_unix: null });
    assert.equal(describeError({ detail: { status: 'x', message: 'm' } }), 'x: m');
    assert.equal(describeError('plain'), 'plain');
  });
});
