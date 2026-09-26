// src/audio/yandex_rt.js against a scripted fake WebSocket: session shape, resampling,
// note/tool plumbing, interruption, reconnect, close.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { YandexAgent, buildYandexTools } from '../../src/audio/yandex_rt.js';

class FakeWS extends EventEmitter {
  constructor(url, opts = {}) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    FakeWS.last = this;
    queueMicrotask(() => this.emit('open'));
  }
  send(line) {
    this.sent.push(JSON.parse(line));
  }
  close(code, reason) {
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', code ?? 1000, Buffer.from(reason ?? '')));
  }
  /** Test helper: feed a server event. */
  server(ev) {
    this.emit('message', JSON.stringify(ev));
  }
  up() {
    this.readyState = 1;
    this.server({ type: 'session.created', session: { id: 's1' } });
  }
}

const mk = (over = {}) =>
  new YandexAgent({
    apiKey: 'k',
    folderId: 'b1folder',
    instructions: 'PROMPT',
    voice: 'alena',
    tools: buildYandexTools(),
    WebSocket: FakeWS,
    ...over,
  });

describe('yandex_rt transport', () => {
  test('connect: model URI with the folder, nested session format, open event', async () => {
    const a = mk();
    const opened = new Promise((r) => a.on('open', r));
    const p = a.connect();
    FakeWS.last.up();
    const info = await p;
    await opened;
    assert.equal(FakeWS.last.url, 'wss://ai.api.cloud.yandex.net/v1/realtime?model=gpt://b1folder/speech-realtime-250923');
    assert.equal(FakeWS.last.opts.headers.Authorization, 'Api-Key k');
    const su = FakeWS.last.sent.find((m) => m.type === 'session.update');
    assert.equal(su.session.output_modalities[0], 'audio');
    assert.equal(su.session.instructions, 'PROMPT');
    assert.equal(su.session.input_audio_transcription.model, 'whisper-1', 'room speech transcripts are on');
    assert.equal(su.session.audio.input.format.rate, 16000);
    assert.equal(su.session.audio.output.voice, 'alena');
    assert.equal(su.session.tools.length, 5);
    assert.equal(info.formats.in, 'pcm_16000');
    assert.equal(a.connected, true);
  });

  test('pushAudio resamples 24k -> 16k and appends; drops when offline', async () => {
    const a = mk();
    assert.equal(a.pushAudio(new Int16Array(2400)), false); // not connected
    const p = a.connect();
    FakeWS.last.up();
    await p;
    assert.equal(a.pushAudio(new Int16Array(2400)), true); // 100 ms @24k
    const appends = FakeWS.last.sent.filter((m) => m.type === 'input_audio_buffer.append');
    assert.equal(appends.length, 1);
    const pcm = Buffer.from(appends[0].audio, 'base64');
    assert.equal(pcm.length, 3200); // 100 ms @16k, 16-bit
  });

  test('sendUserMessage: user text item + response.create; contextual: system item only', async () => {
    const a = mk();
    const p = a.connect();
    FakeWS.last.up();
    await p;
    a.sendUserMessage('Пора открывать стендап');
    a.sendContextualUpdate('Подключился Тима');
    const sent = FakeWS.last.sent;
    const items = sent.filter((m) => m.type === 'conversation.item.create');
    const responses = sent.filter((m) => m.type === 'response.create');
    assert.equal(items.length, 2);
    assert.equal(items[0].item.role, 'user');
    assert.equal(items[0].item.content[0].text, 'Пора открывать стендап');
    assert.equal(items[1].item.role, 'system');
    assert.equal(responses.length, 1, 'only the user message triggers a response');
  });

  test('server events: audio delta -> resampled pcm, text delta -> response, function call -> tool_call', async () => {
    const a = mk();
    const p = a.connect();
    FakeWS.last.up();
    await p;
    const got = { audio: 0, pcmLen: 0, texts: [], tools: [] };
    a.on('audio', ({ pcm }) => { got.audio += 1; got.pcmLen += pcm.length; });
    a.on('response', ({ text }) => got.texts.push(text));
    a.on('tool_call', (c) => got.tools.push(c));
    const ws = FakeWS.last;
    ws.server({ type: 'response.created', response: { id: 'r1' } });
    ws.server({ type: 'response.output_text.delta', delta: 'Начнём' });
    ws.server({ type: 'response.output_audio.delta', delta: Buffer.alloc(3200).toString('base64') }); // 1600 samples @16k
    ws.server({ type: 'response.output_item.done', item: { type: 'function_call', name: 'give_word', call_id: 'c1', arguments: '{"person_name":"Серёжа"}' } });
    ws.server({ type: 'response.completed', response: { id: 'r1' } });
    assert.equal(got.audio, 1);
    assert.equal(got.pcmLen, 2400, '1600 samples @16k resampled to 2400 @24k (x1.5)');
    assert.deepEqual(got.texts, ['Начнём']);
    assert.equal(got.tools.length, 1);
    assert.equal(got.tools[0].tool_name, 'give_word');
    assert.equal(got.tools[0].parameters.person_name, 'Серёжа');
    // tool result: function_call_output; continuation only on demand; synthetic tool_response
    const responses = [];
    a.on('tool_response', (r) => responses.push(r));
    a.sendToolResult('c1', { ok: true, speaker: 'Серёжа' });
    const fco = ws.sent.filter((m) => m.type === 'conversation.item.create').at(-1);
    assert.equal(fco.item.type, 'function_call_output');
    assert.equal(fco.item.call_id, 'c1');
    assert.equal(ws.sent.filter((m) => m.type === 'response.create').length, 0, 'no auto-continuation by default');
    a.sendToolResult('c2', { ok: true }, { continueTurn: true });
    assert.equal(ws.sent.filter((m) => m.type === 'response.create').length, 1, 'continueTurn asks for the next turn');
    assert.equal(responses.length, 2);
    assert.equal(responses[0].tool_name, 'give_word');
    assert.equal(responses[0].is_error, false);
  });

  test('interruption: user speech during a response cancels it', async () => {
    const a = mk();
    const p = a.connect();
    FakeWS.last.up();
    await p;
    const ints = [];
    a.on('interruption', (i) => ints.push(i));
    const ws = FakeWS.last;
    ws.server({ type: 'response.created', response: { id: 'r1' } });
    ws.server({ type: 'input_audio_buffer.speech_started' });
    assert.equal(ints.length, 1);
    assert.equal(ws.sent.filter((m) => m.type === 'response.cancel').length, 1);
    ws.server({ type: 'response.cancelled' }); // the server confirms; between responses user speech is not an interruption
    ws.server({ type: 'input_audio_buffer.speech_started' });
    assert.equal(ints.length, 1);
  });

  test('reconnect after an abnormal close: reconnected + open(reconnect)', async () => {
    const a = mk({ maxReconnects: 2 });
    const p = a.connect();
    FakeWS.last.up();
    await p;
    const events = [];
    a.on('disconnected', (d) => events.push(['disconnected', d.code]));
    a.on('reconnected', (r) => events.push(['reconnected', r.attempts]));
    a.on('open', (i) => events.push(['open', i.reconnect]));
    FakeWS.last.emit('close', 1006, Buffer.from('boom'));
    await new Promise((r) => setTimeout(r, 1100)); // backoff 1 s
    assert.equal(events[0][0], 'disconnected');
    FakeWS.last.up();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(events.map((e) => e[0]), ['disconnected', 'reconnected', 'open']);
    assert.equal(events[2][1], true, 'open carries reconnect=true');
    assert.equal(a.connected, true);
    a.close({ reason: 'test' });
  });

  test('close: clean close emits closed; error event surfaces as client_error', async () => {
    const a = mk();
    const p = a.connect();
    FakeWS.last.up();
    await p;
    const errs = [];
    a.on('client_error', (e) => errs.push(e));
    FakeWS.last.server({ type: 'error', error: { message: 'bad thing', type: 'x', code: 'c' } });
    assert.equal(errs.length, 1);
    assert.equal(errs[0].message, 'bad thing');
    const closed = new Promise((r) => a.on('closed', r));
    a.close({ reason: 'done' });
    const c = await closed;
    assert.equal(c.reason, 'done');
  });

  test('spoken tool names become tool cycles, their audio stays out of the room', async () => {
    const a = mk();
    const p = a.connect();
    FakeWS.last.up();
    await p;
    let lastPcmLen = 0;
    const got = { audio: 0, tools: [], responses: [] };
    a.on('audio', ({ pcm }) => { got.audio += 1; lastPcmLen = pcm.length; });
    a.on('tool_call', (c) => got.tools.push(c));
    a.on('tool_response', (r) => got.responses.push(r));
    const ws = FakeWS.last;
    ws.server({ type: 'response.created', response: { id: 'r9' } });
    ws.server({ type: 'response.output_audio.delta', delta: Buffer.alloc(1600).toString('base64') }); // audio BEFORE the text: must be held, then dropped
    ws.server({ type: 'response.output_text.delta', delta: 'skip' });
    ws.server({ type: 'response.output_text.delta', delta: '_turn' });
    ws.server({ type: 'response.output_audio.delta', delta: Buffer.alloc(1600).toString('base64') });
    ws.server({ type: 'response.done', response: { id: 'r9' } });
    assert.equal(got.audio, 0, 'the tool-name utterance is not played');
    assert.equal(got.tools.length, 1);
    assert.equal(got.tools[0].tool_name, 'skip_turn');
    assert.equal(got.responses.length, 1, 'synthetic tool_response keeps host bookkeeping intact');
    // a spoken chain: «set_phase(closing) leave_meeting…» -> two calls in order
    ws.server({ type: 'response.created', response: { id: 'r10' } });
    ws.server({ type: 'response.output_text.delta', delta: 'set_phase(closing) leave_meeting…' });
    ws.server({ type: 'response.output_audio.delta', delta: Buffer.alloc(1600).toString('base64') });
    ws.server({ type: 'response.done', response: { id: 'r10' } });
    assert.deepEqual(got.tools.slice(1).map((c) => c.tool_name), ['set_phase', 'leave_meeting']);
    assert.deepEqual(got.tools[1].parameters, { phase: 'closing' });
    assert.equal(got.audio, 0);
    // calls embedded in real speech: audio plays, the calls are still executed
    ws.server({ type: 'response.created', response: { id: 'r11' } });
    ws.server({ type: 'response.output_text.delta', delta: 'Всё, ребята, пока! set_phase(closing) leave_meeting…' });
    ws.server({ type: 'response.output_audio.delta', delta: Buffer.alloc(1600).toString('base64') });
    ws.server({ type: 'response.done', response: { id: 'r11' } });
    assert.deepEqual(got.tools.slice(3).map((c) => c.tool_name), ['set_phase', 'leave_meeting'], 'embedded calls execute');
    assert.equal(got.audio, 1, 'embedded-in-speech audio still plays');
    // a JSON-narrated tool call split across deltas must not reach the room and must parse
    ws.server({ type: 'response.created', response: { id: 'r12' } });
    ws.server({ type: 'response.output_audio.delta', delta: Buffer.alloc(1600).toString('base64') });
    ws.server({ type: 'response.output_text.delta', delta: 'give' });
    ws.server({ type: 'response.output_text.delta', delta: '_word {"person_id":"nevsky_g","person_name":"Глеб"}' });
    ws.server({ type: 'response.output_audio.delta', delta: Buffer.alloc(1600).toString('base64') });
    ws.server({ type: 'response.done', response: { id: 'r12' } });
    assert.equal(got.audio, 1, 'the JSON narration is not played');
    const gw = got.tools.at(-1);
    assert.equal(gw.tool_name, 'give_word');
    assert.equal(gw.parameters.person_name, 'Глеб');
    assert.equal(gw.expects_response, false, 'spoken calls are pre-answered; the server never saw them');
    // markers and spoken keys: «set_phase(round) [TOOL_CALL_START]give_word person name Глеб»
    ws.server({ type: 'response.created', response: { id: 'r13' } });
    ws.server({ type: 'response.output_audio.delta', delta: Buffer.alloc(1600).toString('base64') });
    ws.server({ type: 'response.output_text.delta', delta: 'set_phase(round) [TOOL_CALL_START]give_word person name Глеб' });
    ws.server({ type: 'response.done', response: { id: 'r13' } });
    const tail = got.tools.slice(-2).map((c) => c.tool_name);
    assert.deepEqual(tail, ['set_phase', 'give_word']);
    assert.deepEqual(got.tools.at(-1).parameters, { person_name: 'Глеб' });
    assert.equal(got.audio, 1, 'pure narration with markers is not played');
    // a hybrid: narrated call glued to real speech — the call executes, the audio plays
    // MINUS the estimated narration prefix
    ws.server({ type: 'response.created', response: { id: 'r14' } });
    const narr = 'turn_done{"person_id":"dobrtvorsky_a","person_name":"Серёжа"} ';
    for (let i = 0; i < 6; i++) ws.server({ type: 'response.output_audio.delta', delta: Buffer.alloc(48000).toString('base64') }); // 6 s held
    ws.server({ type: 'response.output_text.delta', delta: `${narr}Все высказались. Кто хочет что-то добавить?` });
    ws.server({ type: 'response.done', response: { id: 'r14' } });
    assert.equal(got.tools.at(-1).tool_name, 'turn_done');
    assert.equal(got.audio, 2, 'hybrid audio is released');
    // 6 deltas x 48000 bytes = 24000 samples @16k -> 36000 @24k each = 216000 held
    const expectedTrim = Math.floor((narr.length / 14) * 24_000);
    const released = lastPcmLen;
    assert.ok(Math.abs(released - (216_000 - expectedTrim)) < 24_000, `narration prefix trimmed (~${Math.round(expectedTrim / 24)} s), got ${(released / 24000).toFixed(1)} s of 9 s`);
  });

  test('buildYandexTools: the five-tool contract', () => {
    const tools = buildYandexTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['give_word', 'leave_meeting', 'set_phase', 'skip_turn', 'turn_done']);
    const sw = tools.find((t) => t.name === 'set_phase');
    assert.deepEqual(sw.parameters.required, ['phase']);
  });
});
