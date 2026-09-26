// Offline tests for src/audio/{realtime_ws,ears,mouth}.js against an in-process fake Realtime server.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { deepMerge, loadSettings } from '../../src/config.js';
import { AudioTimeline, createEars } from '../../src/audio/ears.js';
import { buildReadoutEvent, compareVerbatim, createMouth, normalizeSpoken } from '../../src/audio/mouth.js';
import {
  VERBATIM_RULE,
  RealtimeSession,
  buildKeywords,
  buildSessionConfig,
  buildTranscriptionPrompt,
  findRejectedOptionalField,
  loadPeople,
} from '../../src/audio/realtime_ws.js';

const SETTINGS = loadSettings();
const PEOPLE = [
  { display: 'Тимур Ткач', aliases: ['Тимур', 'Тима', 'Timur Tkach'], spoken: 'Ти́ма' },
  { display: 'Ярослав Орлов', aliases: ['Слава Орлов'], spoken: 'Яросла́в', vocative: 'Слава' },
];
const API_KEY = 'test-key-0123456789abcdef';
const USAGE = {
  total_tokens: 126,
  input_tokens: 67,
  output_tokens: 59,
  input_token_details: { text_tokens: 67, audio_tokens: 0, cached_tokens: 0 },
  output_token_details: { text_tokens: 24, audio_tokens: 35 },
};

// ---- fake server ------------------------------------------------------------------------------

class FakeRealtimeServer {
  constructor() {
    this.conns = [];
    this.responses = new Map();
    this.timers = new Set();
    this.respSeq = 0;
    this.rejectParams = new Set(); // e.g. 'session.audio.input.transcription.keywords'
    this.echoPatch = null; // (echo) => void, mutates the session.updated payload
    this.holdUpdate = false; // keep session.updated until releaseUpdate(i)
    this.refuse = 0; // HTTP status for new upgrades (0 = accept)
    this.upgrades = 0;
    this.plan = () => ({}); // (text, ev) => overrides of DEFAULT_PLAN
    this.wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      autoPong: false,
      verifyClient: (_info, cb) => {
        this.upgrades++;
        if (this.refuse) cb(false, this.refuse);
        else cb(true);
      },
    });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    this.listening = new Promise((resolve) => this.wss.once('listening', resolve));
  }

  get url() {
    return `ws://127.0.0.1:${this.wss.address().port}/v1/realtime`;
  }

  send(conn, ev) {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(ev));
  }

  later(ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  releaseUpdate(i) {
    const conn = this.conns[i];
    conn.release?.();
    conn.release = null;
  }

  /** Emit input_audio_buffer.committed and remember the item (for conversation.item.delete). */
  commit(conn, itemId) {
    conn.items.add(itemId);
    this.send(conn, { type: 'input_audio_buffer.committed', item_id: itemId, previous_item_id: null });
  }

  types(i) {
    return this.conns[i].events.map((e) => e.type);
  }

  async close() {
    for (const timer of this.timers) clearTimeout(timer);
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise((resolve) => this.wss.close(resolve));
  }

  _onConnection(ws, req) {
    const conn = { ws, idx: this.conns.length, headers: req.headers, url: req.url, events: [], audio: [], items: new Set(), session: {}, noPong: false, release: null };
    this.conns.push(conn);
    ws.on('ping', (data) => {
      if (!conn.noPong) ws.pong(data);
    });
    ws.on('message', (data) => this._onMessage(conn, JSON.parse(data.toString())));
    this.send(conn, {
      type: 'session.created',
      session: { id: `sess_${conn.idx}`, expires_at: 4102444800, audio: { input: { turn_detection: { type: 'server_vad', create_response: true, interrupt_response: true } } } },
    });
  }

  _onMessage(conn, ev) {
    conn.events.push(ev);
    switch (ev.type) {
      case 'session.update': {
        for (const param of this.rejectParams) {
          if (hasPath({ session: ev.session }, param)) {
            this.send(conn, { type: 'error', error: { type: 'invalid_request_error', code: 'unknown_parameter', message: `Unknown parameter: '${param}'.`, param, event_id: ev.event_id } });
            return;
          }
        }
        conn.session = deepMerge(conn.session, ev.session);
        const echo = structuredClone(conn.session);
        if (echo.audio?.input?.transcription) delete echo.audio.input.transcription.keywords; // like the real server
        this.echoPatch?.(echo);
        const reply = () => this.send(conn, { type: 'session.updated', session: { id: `sess_${conn.idx}`, ...echo } });
        if (this.holdUpdate && conn.idx > 0) conn.release = reply;
        else reply();
        return;
      }
      case 'input_audio_buffer.append':
        conn.audio.push(Buffer.from(ev.audio, 'base64'));
        return;
      case 'response.create':
        this._startResponse(conn, ev);
        return;
      case 'response.cancel':
        this._cancelResponse(conn, ev);
        return;
      case 'conversation.item.delete':
        if (conn.items.delete(ev.item_id)) this.send(conn, { type: 'conversation.item.deleted', item_id: ev.item_id });
        else this.send(conn, { type: 'error', error: { type: 'invalid_request_error', code: 'item_delete_invalid_item_id', message: 'no such item', param: null, event_id: ev.event_id } });
        return;
      default:
    }
  }

  _startResponse(conn, ev) {
    const text = JSON.parse(ev.response.input[0].content[0].text).response_text;
    const plan = { createdDelayMs: 5, firstDelayMs: 15, intervalMs: 5, chunks: [pcm(960, 1), pcm(960, 2)], transcript: text, cancelDelayMs: 10, inflightAfterCancel: 0, error: null, ...this.plan(text, ev) };
    if (plan.error) {
      this.send(conn, { type: 'error', error: { type: 'invalid_request_error', code: plan.error, message: 'rejected', param: null, event_id: ev.event_id } });
      return;
    }
    const id = `resp_${++this.respSeq}`;
    const metadata = ev.response.metadata ?? null;
    const resp = { id, conn, metadata, active: true, sent: 0, plan };
    this.responses.set(id, resp);
    this.later(plan.createdDelayMs, () => {
      this.send(conn, { type: 'response.created', response: { id, object: 'realtime.response', status: 'in_progress', metadata, conversation_id: null } });
      plan.chunks.forEach((chunk, i) => {
        this.later(plan.firstDelayMs + i * plan.intervalMs, () => {
          if (!resp.active) return;
          this.send(conn, { type: 'response.output_audio.delta', response_id: id, item_id: `item_${id}`, output_index: 0, content_index: 0, delta: chunk.toString('base64') });
          resp.sent++;
        });
      });
      this.later(plan.firstDelayMs + plan.chunks.length * plan.intervalMs + 2, () => {
        if (!resp.active) return;
        resp.active = false;
        this.send(conn, { type: 'response.output_audio_transcript.done', response_id: id, item_id: `item_${id}`, transcript: plan.transcript });
        this.send(conn, { type: 'response.done', response: { id, status: 'completed', status_details: null, metadata, usage: USAGE } });
      });
    });
  }

  _cancelResponse(conn, ev) {
    const resp = this.responses.get(ev.response_id);
    if (!resp || !resp.active) {
      this.send(conn, { type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'Cancellation failed: no active response found', param: null, event_id: ev.event_id } });
      return;
    }
    resp.active = false;
    for (let i = 0; i < resp.plan.inflightAfterCancel; i++) {
      // deltas that were already on the wire when the cancel arrived
      this.send(conn, { type: 'response.output_audio.delta', response_id: resp.id, item_id: `item_${resp.id}`, output_index: 0, content_index: 0, delta: pcm(480, 9).toString('base64') });
    }
    this.later(resp.plan.cancelDelayMs, () => {
      this.send(conn, { type: 'response.done', response: { id: resp.id, status: 'cancelled', status_details: { type: 'cancelled', reason: 'client_cancelled' }, metadata: resp.metadata, usage: USAGE } });
    });
  }
}

// ---- helpers ------------------------------------------------------------------------------------

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});
const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function pcm(bytes, fill) {
  return Buffer.alloc(bytes, fill);
}

function hasPath(obj, path) {
  let o = obj;
  for (const key of path.split('.')) {
    if (o === null || typeof o !== 'object' || !(key in o)) return false;
    o = o[key];
  }
  return true;
}

async function until(cond, { timeout = 2000, what = 'condition' } = {}) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(5);
  }
}

function memLog() {
  const records = [];
  return { records, event: (type, fields = {}) => records.push({ type, ...fields }), types: () => records.map((r) => r.type) };
}

async function startServer() {
  const server = new FakeRealtimeServer();
  await server.listening;
  cleanups.push(() => server.close());
  return server;
}

function makeSession(server, extra = {}) {
  const log = extra.log ?? memLog();
  const session = new RealtimeSession({
    apiKey: API_KEY,
    session: buildSessionConfig(SETTINGS, { people: PEOPLE }),
    url: server.url,
    log,
    reconnectDelaysMs: [20, 40, 80, 160],
    connectTimeoutMs: 1000,
    pingIntervalMs: 1000,
    idleTimeoutMs: 5000,
    ...extra,
  });
  cleanups.push(() => session.close());
  return { session, log };
}

async function connected(extra = {}) {
  const server = await startServer();
  const { session, log } = makeSession(server, extra);
  await session.connect();
  return { server, session, log };
}

function append(buf) {
  return { type: 'input_audio_buffer.append', audio: buf.toString('base64') };
}

// ---- session config ----------------------------------------------------------------------------

test('session config: GA shape from settings, VAD never answers, persona + pace + verbatim rule', () => {
  const rt = SETTINGS.realtime;
  const s = buildSessionConfig(SETTINGS, { people: PEOPLE });
  assert.equal(s.type, 'realtime');
  assert.equal(s.model, rt.model);
  assert.deepEqual(s.output_modalities, ['audio']);
  assert.deepEqual(s.reasoning, { effort: rt.reasoning_effort });
  assert.deepEqual(s.audio.input.format, { type: 'audio/pcm', rate: 24000 });
  assert.deepEqual(s.audio.input.noise_reduction, { type: rt.noise_reduction });
  assert.deepEqual(s.audio.input.turn_detection, { type: 'semantic_vad', eagerness: rt.vad_eagerness, create_response: false, interrupt_response: false });
  assert.equal(s.audio.input.transcription.model, rt.transcribe_model);
  assert.deepEqual(s.audio.input.transcription.languages, [rt.language]);
  assert.equal('language' in s.audio.input.transcription, false);
  assert.deepEqual(s.audio.output, { format: { type: 'audio/pcm', rate: 24000 }, voice: rt.voice, speed: 1 });
  assert.ok(s.instructions.startsWith('Ты Кора, ведущая стендапов команды. О себе только в женском роде.'));
  assert.ok(s.instructions.includes(rt.pace_instructions.trim()));
  assert.ok(s.instructions.endsWith(VERBATIM_RULE));
});

test('transcription prompt and keywords: display names + Cyrillic short forms, no stress marks, no Latin', () => {
  const prompt = buildTranscriptionPrompt(SETTINGS, [...PEOPLE, { display: 'Бот Записи', exclude: true }]);
  assert.match(prompt, /Участники: Тимур Ткач, Ярослав Орлов\./);
  assert.match(prompt, /Обращения: Тима, Слава\./);
  assert.ok(!prompt.includes('Бот Записи'), 'excluded people are not listed');
  assert.ok(!prompt.includes('́'), 'stress marks stripped');
  assert.ok(!/Timur/.test(prompt));
  assert.ok(!/Участники/.test(buildTranscriptionPrompt(SETTINGS, [])), 'no people -> no names line');
  const kw = buildKeywords(SETTINGS, PEOPLE);
  for (const word of ['Кора', 'Тимур', 'Ткач', 'Ярослав', 'Орлов', 'Тима', 'Слава']) assert.ok(kw.includes(word), word);
  assert.equal(new Set(kw.map((w) => w.toLowerCase())).size, kw.length, 'deduplicated');

  const dir = mkdtempSync(join(tmpdir(), 'standup-rt-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'people.json'), `﻿${JSON.stringify({ people: PEOPLE, extra: 1 })}`);
  writeFileSync(join(dir, 'broken.json'), '{ nope');
  assert.deepEqual(loadPeople(join(dir, 'people.json')), PEOPLE);
  assert.deepEqual(loadPeople(join(dir, 'broken.json')), []);
  assert.deepEqual(loadPeople(join(dir, 'missing.json')), []);
});

test('findRejectedOptionalField maps error.param to droppable optional fields only', () => {
  const cfg = buildSessionConfig(SETTINGS, { people: PEOPLE });
  const f = (param, message) => findRejectedOptionalField({ param, message }, cfg);
  assert.equal(f('session.audio.input.transcription.keywords'), 'audio.input.transcription.keywords');
  assert.equal(f('session.audio.input.transcription.keywords[3]'), 'audio.input.transcription.keywords');
  assert.equal(f('session.reasoning.effort'), 'reasoning');
  assert.equal(f(null, "Unknown parameter: 'session.audio.input.noise_reduction'."), 'audio.input.noise_reduction');
  assert.equal(f('session.audio.output.voice'), null);
  assert.equal(f('session.audio.input.turn_detection.eagerness'), null);
});

// ---- connection lifecycle --------------------------------------------------------------------------

test('connect: bearer auth, model in URL, session.update first, early sends queued until session.updated', async () => {
  const server = await startServer();
  const { session, log } = makeSession(server);
  const opened = [];
  session.on('open', (info) => opened.push(info));
  const pending = session.connect();
  const sent = [];
  session.send(append(pcm(4800, 7)), { onSent: (info) => sent.push(info) }); // queued: not open yet
  assert.equal(session.state, 'connecting');
  const info = await pending;
  assert.equal(info.epoch, 1);
  assert.equal(info.session_id, 'sess_0');
  const conn = server.conns[0];
  assert.equal(conn.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(conn.headers['openai-beta'], undefined);
  assert.match(conn.url, /\/v1\/realtime\?model=gpt-realtime/);
  await until(() => conn.audio.length === 1, { what: 'flushed audio' });
  assert.deepEqual(server.types(0), ['session.update', 'input_audio_buffer.append']);
  assert.deepEqual(conn.session.audio.input.turn_detection.create_response, false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].epoch, 1);
  assert.equal(opened.length, 1);
  assert.equal(session.state, 'open');
  assert.ok(log.types().includes('rt.connect'));
  assert.ok(conn.events.every((e) => typeof e.event_id === 'string' && e.event_id), 'every client event has an event_id');
});

test('handshake: a rejected optional field is dropped and the update re-sent (sticks across reconnects)', async () => {
  const server = await startServer();
  server.rejectParams.add('session.audio.input.transcription.keywords');
  const { session, log } = makeSession(server);
  await session.connect();
  assert.deepEqual(session.droppedFields, ['audio.input.transcription.keywords']);
  const updates = server.conns[0].events.filter((e) => e.type === 'session.update');
  assert.equal(updates.length, 2);
  assert.ok(updates[0].session.audio.input.transcription.keywords);
  assert.equal(updates[1].session.audio.input.transcription.keywords, undefined);
  assert.ok(updates[1].session.audio.input.transcription.prompt, 'other fields kept');
  const rec = log.records.find((r) => r.type === 'rt.error' && r.dropped_field);
  assert.equal(rec.dropped_field, 'audio.input.transcription.keywords');
  assert.equal(rec.code, 'unknown_parameter');
});

test('handshake: unsafe echo (create_response true) or a non-optional rejection is fatal, no retries', async () => {
  const server = await startServer();
  server.echoPatch = (echo) => {
    echo.audio.input.turn_detection.create_response = true;
  };
  const { session } = makeSession(server);
  await assert.rejects(session.connect(), (err) => err.code === 'unsafe_session' && err.fatal === true);
  assert.equal(session.state, 'closed');
  assert.equal(server.upgrades, 1);
  assert.equal(session.send(append(pcm(480, 1))), null, 'closed session drops sends');

  const server2 = await startServer();
  server2.rejectParams.add('session.audio.output.voice');
  const { session: s2 } = makeSession(server2);
  await assert.rejects(s2.connect(), (err) => err.code === 'config_rejected');
  assert.equal(server2.upgrades, 1);
});

test('upgrade errors: HTTP 401 fails at once, HTTP 503 is retried maxAttempts times', async () => {
  const server = await startServer();
  server.refuse = 401;
  const { session } = makeSession(server);
  await assert.rejects(session.connect(), (err) => err.status === 401 && err.fatal === true);
  assert.equal(server.upgrades, 1);

  const server2 = await startServer();
  server2.refuse = 503;
  const { session: s2 } = makeSession(server2, { reconnectDelaysMs: [5, 5, 5, 5] });
  await assert.rejects(s2.connect(), (err) => err.status === 503 && err.attempts === 5);
  assert.equal(server2.upgrades, 5);
});

test('unexpected close: reconnect re-sends session.update, flushes fresh audio, drops stale audio and old-session events', async () => {
  const { server, session, log } = await connected({ maxAudioAgeMs: 300 });
  const seen = [];
  session.on('disconnected', (e) => seen.push(['disconnected', e]));
  session.on('reconnected', (e) => seen.push(['reconnected', e]));
  server.holdUpdate = true;
  server.conns[0].ws.terminate();
  await until(() => server.conns.length === 2 && server.conns[1].events.length > 0, { what: 'second handshake' });
  assert.equal(session.state, 'reconnecting');
  const dropped = [];
  session.send(append(pcm(4800, 1)), { onDrop: (d) => dropped.push(d.reason) }); // will be > 300 ms old at flush
  assert.equal(session.send({ type: 'conversation.item.delete', item_id: 'item_old' }), null);
  assert.equal(session.send({ type: 'response.cancel', response_id: 'resp_old' }), null);
  await sleep(400);
  session.send(append(pcm(4800, 2)));
  server.releaseUpdate(1);
  await until(() => seen.some(([k]) => k === 'reconnected'), { what: 'reconnected' });

  const [, rec] = seen.find(([k]) => k === 'reconnected');
  assert.equal(rec.epoch, 2);
  assert.ok(rec.gap_ms >= 400, `gap ${rec.gap_ms}`);
  assert.equal(rec.dropped.audio_chunks, 1);
  assert.deepEqual(rec.dropped.events, { 'conversation.item.delete': 1, 'response.cancel': 1 });
  assert.deepEqual(dropped, ['stale']);
  const conn1 = server.conns[1];
  await until(() => conn1.audio.length === 1, { what: 'fresh audio' });
  assert.equal(conn1.audio[0][0], 2, 'only the fresh chunk arrives');
  assert.deepEqual(server.types(1), ['session.update', 'input_audio_buffer.append']);
  assert.deepEqual(conn1.events[0].session, server.conns[0].events[0].session, 'same config re-sent');
  assert.ok(seen[0][0] === 'disconnected');
  assert.ok(log.types().includes('rt.reconnect'));
  assert.equal(session.state, 'open');
});

test('heartbeat: missing pongs -> terminate -> reconnect', async () => {
  const { server, session, log } = await connected({ pingIntervalMs: 25, idleTimeoutMs: 120 });
  let reconnected = null;
  session.on('reconnected', (e) => {
    reconnected = e;
  });
  server.conns[0].noPong = true;
  await until(() => reconnected, { what: 'heartbeat reconnect' });
  assert.equal(server.conns.length, 2);
  assert.ok(log.records.some((r) => r.type === 'rt.error' && r.phase === 'heartbeat'));
  await until(() => session.stats().rtt_ms !== null, { what: 'rtt from pongs of the new socket' });
});

test('reconnect gives up after maxAttempts: failed event, state closed, later sends dropped', async () => {
  const { server, session } = await connected({ reconnectDelaysMs: [5, 5, 5, 5] });
  let failed = null;
  session.on('failed', (e) => {
    failed = e;
  });
  server.refuse = 503;
  server.conns[0].ws.terminate();
  await until(() => failed, { what: 'failed' });
  assert.equal(failed.attempts, 5);
  assert.equal(server.upgrades, 1 + 5);
  assert.equal(session.state, 'closed');
  assert.equal(session.send(append(pcm(480, 1))), null);
});

// ---- mouth ------------------------------------------------------------------------------------------

test('mouth.say: out-of-band verbatim request, audio streamed in order, ttfa/audio_ms/usage, verbatim ok', async () => {
  const { server, session, log } = await connected();
  const chunks = [pcm(480, 1), pcm(960, 2), pcm(480, 3)];
  server.plan = () => ({ chunks });
  const mouth = createMouth(session, { log });
  const got = [];
  const starts = [];
  let ended = null;
  const h = mouth.say('Тима, тебе слово.', { meta: { to: 'timur' }, onAudio: (b64) => got.push(b64), onStart: (i) => starts.push(i), onEnd: (r) => (ended = r) });
  assert.ok(mouth.busy);
  const r = await h.done;
  assert.equal(r.status, 'completed');
  assert.equal(r.id, h.id);
  assert.deepEqual(got.map((b) => Buffer.from(b, 'base64')), chunks);
  assert.equal(r.audio_ms, 40);
  assert.ok(r.ttfa_ms >= 0 && r.ttfa_ms < 1000);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].ttfa_ms, r.ttfa_ms);
  assert.deepEqual(r.usage, USAGE);
  assert.equal(r.verbatim, true);
  assert.equal(ended, r);
  assert.equal(mouth.busy, false);

  const create = server.conns[0].events.find((e) => e.type === 'response.create');
  assert.equal(create.response.conversation, 'none');
  assert.deepEqual(create.response.output_modalities, ['audio']);
  assert.equal(create.response.metadata.req, h.id);
  assert.equal(create.response.metadata.to, 'timur');
  assert.deepEqual(JSON.parse(create.response.input[0].content[0].text), { response_text: 'Тима, тебе слово.', require_repeat_verbatim: true });
  assert.ok(log.records.some((x) => x.type === 'rt.usage' && x.req === h.id && x.status === 'completed'));
  assert.ok(log.records.some((x) => x.type === 'rt.readout' && x.id === h.id));
});

test('verbatim: normalization ignores case/ё/stress/punctuation; a mismatch is logged', async () => {
  assert.equal(normalizeSpoken('Ти́ма, ВСЁ!  Спасибо…'), 'тима все спасибо');
  assert.deepEqual(compareVerbatim('Ти́ма, всё?', 'тима все'), { match: true, similarity: 1 });
  const cmp = compareVerbatim('Тима, тебе слово', 'Тима, слово');
  assert.equal(cmp.match, false);
  assert.ok(cmp.similarity > 0.5 && cmp.similarity < 1);

  const { server, session, log } = await connected();
  server.plan = () => ({ transcript: 'Тима, тебе слово, пожалуйста.' });
  const r = await createMouth(session, { log }).say('Тима, тебе слово.').done;
  assert.equal(r.status, 'completed');
  assert.equal(r.verbatim, false);
  const rec = log.records.find((x) => x.type === 'rt.verbatim_mismatch');
  assert.equal(rec.expected, 'Тима, тебе слово.');
  assert.equal(rec.got, 'Тима, тебе слово, пожалуйста.');
});

test('busy: a second say() rejects with busy; {queue: true} waits for the active readout', async () => {
  const { session } = await connected();
  const mouth = createMouth(session);
  const h1 = mouth.say('Раз.');
  const h2 = mouth.say('Два.');
  await assert.rejects(h2.done, (err) => err.code === 'busy' && err.message === 'busy: another readout is active');
  mouth.say('Бесхозный.'); // rejected done nobody awaits must not crash the process
  const h3 = mouth.say('Три.', { queue: true });
  const [r1, r3] = await Promise.all([h1.done, h3.done]);
  assert.equal(r1.status, 'completed');
  assert.equal(r3.status, 'completed');
  assert.ok(r3.t_sent >= r1.t_done, 'queued readout starts after the first one finished');
  assert.ok(r3.wait_ms > 0);
  assert.equal(mouth.stats().busy_rejects, 2);
  await assert.rejects(mouth.say('   ').done, (err) => err.code === 'bad_text');
});

test('cancel mid-stream: response.cancel with the response id, no onAudio after cancel(), status cancelled', async () => {
  const { server, session } = await connected();
  server.plan = () => ({ chunks: Array.from({ length: 20 }, (_, i) => pcm(480, i)), intervalMs: 15, inflightAfterCancel: 2 });
  const mouth = createMouth(session);
  let audio = 0;
  let atCancel = -1;
  let h;
  h = mouth.say('Длинная фраза, которую перебьют.', {
    onAudio: () => {
      audio++;
      if (audio === 2) {
        h.cancel();
        atCancel = audio;
      }
    },
  });
  const r = await h.done;
  await sleep(100); // anything still on the wire must not reach onAudio
  assert.equal(r.status, 'cancelled');
  assert.equal(audio, atCancel);
  assert.ok(r.dropped_after_cancel >= 2, `dropped ${r.dropped_after_cancel}`);
  const cancel = server.conns[0].events.find((e) => e.type === 'response.cancel');
  assert.equal(cancel.response_id, r.response_id);
  assert.equal(await h.cancel(), r, 'cancel() is idempotent and resolves to the result');
  assert.equal(mouth.busy, false);
});

test('cancel before response.created: the cancel goes out once the response id is known', async () => {
  const { server, session } = await connected();
  server.plan = () => ({ createdDelayMs: 60 });
  const mouth = createMouth(session);
  let audio = 0;
  const h = mouth.say('Отменим до старта.', { onAudio: () => audio++ });
  await until(() => server.conns[0].events.some((e) => e.type === 'response.create'), { what: 'response.create' });
  h.cancel();
  const r = await h.done;
  assert.equal(r.status, 'cancelled');
  assert.equal(audio, 0);
  const types = server.types(0);
  assert.ok(types.indexOf('response.cancel') > types.indexOf('response.create'));
  assert.equal(server.conns[0].events.find((e) => e.type === 'response.cancel').response_id, r.response_id);
});

test('readouts across a reconnect: in-flight -> failed(disconnected); queued -> cancellable or stale', async () => {
  const { server, session } = await connected();
  server.plan = () => ({ chunks: Array.from({ length: 30 }, () => pcm(480, 1)), intervalMs: 20 });
  const mouth = createMouth(session, { liveMaxAgeMs: 150 });
  let started = false;
  const h1 = mouth.say('Эту фразу прервёт сеть.', { onStart: () => (started = true) });
  await until(() => started, { what: 'first audio' });
  server.holdUpdate = true;
  server.conns[0].ws.terminate();
  const r1 = await h1.done;
  assert.equal(r1.status, 'failed');
  assert.equal(r1.reason, 'disconnected');

  await until(() => session.state === 'reconnecting' && server.conns.length === 2, { what: 'reconnecting' });
  const h2 = mouth.say('Отменю, пока ждём сеть.');
  h2.cancel();
  const r2 = await h2.done;
  assert.equal(r2.status, 'cancelled');
  assert.equal(r2.reason, 'before_send');
  const h3 = mouth.say('Устарею, пока ждём сеть.');
  await sleep(250);
  server.releaseUpdate(1);
  const r3 = await h3.done;
  assert.equal(r3.status, 'failed');
  assert.equal(r3.reason, 'stale');
  assert.ok(!server.types(1).includes('response.create'), 'nothing stale was sent to the new session');
  const r4 = await mouth.say('А теперь всё работает.').done;
  assert.equal(r4.status, 'completed');
});

test('server error on response.create fails the readout with the server code', async () => {
  const { server, session } = await connected();
  server.plan = () => ({ error: 'invalid_value' });
  const r = await createMouth(session).say('Ошибка.').done;
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'invalid_value');
});

test('renderClip returns the whole PCM and runs alongside a live readout', async () => {
  const { server, session } = await connected();
  server.plan = (text) => ({ chunks: [pcm(480, text.length % 256), pcm(960, 5)] });
  const mouth = createMouth(session, { renderConcurrency: 2 });
  const [a, b, live] = await Promise.all([
    mouth.renderClip('Доброе утро!'),
    mouth.renderClip('Хорошего дня!', { withInfo: true }),
    mouth.say('Живая фраза.').done,
  ]);
  assert.ok(Buffer.isBuffer(a));
  assert.deepEqual(a, Buffer.concat([pcm(480, 'Доброе утро!'.length), pcm(960, 5)]));
  assert.equal(b.pcm.length, 1440);
  assert.equal(b.verbatim, true);
  assert.equal(b.audio_ms, 30);
  assert.equal(live.status, 'completed');
  const creates = server.conns[0].events.filter((e) => e.type === 'response.create');
  assert.deepEqual(creates.map((e) => e.response.metadata.kind).sort(), ['clip', 'clip', 'live']);

  server.plan = () => ({ error: 'invalid_value' });
  await assert.rejects(mouth.renderClip('Не выйдет.'), (err) => err.code === 'invalid_value');
});

test('mouth.close: in-flight readouts cancelled + failed, queued renders never start, later calls refused', async () => {
  const { server, session } = await connected();
  server.plan = () => ({ chunks: Array.from({ length: 20 }, () => pcm(480, 1)), intervalMs: 20 });
  const mouth = createMouth(session, { renderConcurrency: 1 });
  const live = mouth.say('Долгая фраза.');
  const clips = [mouth.renderClip('Первый.'), mouth.renderClip('Второй.'), mouth.renderClip('Третий.')];
  const creates = () => server.conns[0].events.filter((e) => e.type === 'response.create').length;
  const cancels = () => server.conns[0].events.filter((e) => e.type === 'response.cancel').length;
  await until(() => creates() === 2 && server.responses.size === 2, { what: 'two responses created' });
  await sleep(20); // response.created reached the client
  mouth.close();
  const r = await live.done;
  assert.equal(r.status, 'failed');
  assert.equal(r.reason, 'closed');
  for (const clip of clips) await assert.rejects(clip, (err) => err.code === 'closed');
  await until(() => cancels() === 2, { what: 'server-side cancels' });
  await sleep(50);
  assert.equal(creates(), 2, 'queued renders never went out');
  await assert.rejects(mouth.say('Ещё.').done, (err) => err.code === 'closed');
  await assert.rejects(mouth.renderClip('Ещё.'), (err) => err.code === 'closed');
});

test('buildReadoutEvent: metadata values are strings, bounded to 16 keys', () => {
  const meta = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
  const ev = buildReadoutEvent('Текст', { req: 'say-1', kind: 'live', meta });
  assert.equal(Object.keys(ev.response.metadata).length, 16);
  assert.ok(Object.values(ev.response.metadata).every((v) => typeof v === 'string'));
  assert.equal(ev.response.max_output_tokens, undefined);
});

// ---- ears ---------------------------------------------------------------------------------------------

test('ears.pushAudio: base64, Buffer and Int16Array reach the server byte-exact', async () => {
  const { server, session } = await connected();
  const ears = createEars(session);
  cleanups.push(() => ears.close());
  const a = pcm(4800, 1);
  const b = pcm(4800, 2);
  const c = new Int16Array(2400).fill(-2);
  assert.equal(ears.pushAudio(a.toString('base64')), true);
  assert.equal(ears.pushAudio(b), true);
  assert.equal(ears.pushAudio(c), true);
  assert.equal(ears.pushAudio(Buffer.alloc(0)), false);
  assert.equal(ears.pushAudio({}), false);
  await until(() => server.conns[0].audio.length === 3, { what: 'audio' });
  assert.deepEqual(server.conns[0].audio[0], a);
  assert.deepEqual(server.conns[0].audio[1], b);
  assert.deepEqual(server.conns[0].audio[2], Buffer.from(c.buffer));
  const st = ears.stats();
  assert.equal(st.pushed_ms, 300);
  assert.equal(st.sent_ms, 300);
  assert.equal(st.session_audio_ms, 300);
});

test('ears: VAD audio_ms mapped to capture wall clock; stt deltas accumulate; final carries latency', async () => {
  const { server, session, log } = await connected();
  const ears = createEars(session, { log });
  cleanups.push(() => ears.close());
  const T0 = Date.now() - 10_000;
  for (let i = 0; i < 10; i++) ears.pushAudio(pcm(4800, i), { t: T0 + 100 * (i + 1) });
  await until(() => server.conns[0].audio.length === 10, { what: 'audio' });
  const vad = [];
  const deltas = [];
  let final = null;
  ears.on('vad', (e) => vad.push(e));
  ears.on('stt_delta', (e) => deltas.push(e));
  ears.on('stt_final', (e) => (final = e));
  const conn = server.conns[0];
  server.send(conn, { type: 'input_audio_buffer.speech_started', audio_start_ms: 250, item_id: 'item_1' });
  await until(() => vad.length === 1, { what: 'vad start' });
  assert.equal(ears.speaking, true);
  server.send(conn, { type: 'input_audio_buffer.speech_stopped', audio_end_ms: 820, item_id: 'item_1' });
  server.commit(conn, 'item_1');
  server.send(conn, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', content_index: 0, delta: 'У меня' });
  server.send(conn, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'item_1', content_index: 0, delta: ' всё' });
  server.send(conn, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'item_1', content_index: 0, transcript: 'У меня всё.', usage: { type: 'duration', seconds: 1 } });
  await until(() => final, { what: 'stt final' });
  assert.deepEqual(vad.map((v) => [v.type, v.audio_ms, v.t, v.item_id]), [
    ['start', 250, T0 + 250, 'item_1'],
    ['stop', 820, T0 + 820, 'item_1'],
  ]);
  assert.equal(ears.speaking, false);
  assert.deepEqual(deltas.map((d) => d.so_far), ['У меня', 'У меня всё']);
  assert.equal(final.text, 'У меня всё.');
  assert.equal(final.t_speech_start, T0 + 250);
  assert.equal(final.t_speech_end, T0 + 820);
  assert.equal(final.latency_ms, final.t - (T0 + 820));
  assert.equal(ears.stats().finals, 1);
  assert.equal(session.stats().usage.transcription.seconds, 1);
  assert.deepEqual(log.types().filter((t) => /^(vad|stt)\./.test(t)), ['vad.start', 'vad.stop', 'stt.final']);
  assert.equal(ears.audioMsToWall(0), T0);
});

test('ears hygiene: committed items older than itemMaxAgeMs are deleted; unknown ids are tolerated', async () => {
  const { server, session } = await connected();
  const ears = createEars(session, { itemMaxAgeMs: 40, hygieneIntervalMs: 15 });
  cleanups.push(() => ears.close());
  const conn = server.conns[0];
  server.commit(conn, 'item_a');
  server.commit(conn, 'item_b');
  // committed on our side, but already gone on the server: the delete fails and is tolerated
  server.send(conn, { type: 'input_audio_buffer.committed', item_id: 'item_ghost', previous_item_id: null });
  await until(() => ears.stats().items_deleted === 2 && ears.stats().delete_errors === 1, { what: 'hygiene' });
  const deletes = conn.events.filter((e) => e.type === 'conversation.item.delete').map((e) => e.item_id).sort();
  assert.deepEqual(deletes, ['item_a', 'item_b', 'item_ghost']);
  assert.equal(ears.stats().items_tracked, 0);
  assert.equal(conn.items.size, 0);
});

test('ears across a reconnect: mid-speech reset, new epoch restarts the audio time base', async () => {
  const { server, session } = await connected();
  const ears = createEars(session);
  cleanups.push(() => ears.close());
  const T0 = Date.now() - 20_000;
  for (let i = 0; i < 5; i++) ears.pushAudio(pcm(4800, 1), { t: T0 + 100 * (i + 1) });
  await until(() => server.conns[0].audio.length === 5, { what: 'audio' });
  const events = [];
  ears.on('vad', (e) => events.push(['vad', e]));
  ears.on('reset', (e) => events.push(['reset', e]));
  server.send(server.conns[0], { type: 'input_audio_buffer.speech_started', audio_start_ms: 100, item_id: 'item_x' });
  await until(() => events.length === 1, { what: 'vad start' });
  let reconnected = false;
  session.on('reconnected', () => (reconnected = true));
  server.conns[0].ws.terminate();
  await until(() => reconnected, { what: 'reconnect' });
  assert.equal(events[1][0], 'reset');
  assert.equal(events[1][1].item_id, 'item_x');
  assert.equal(ears.speaking, false);

  const T1 = Date.now() - 5_000;
  for (let i = 0; i < 3; i++) ears.pushAudio(pcm(4800, 2), { t: T1 + 100 * (i + 1) });
  await until(() => server.conns[1]?.audio.length === 3, { what: 'audio after reconnect' });
  server.send(server.conns[1], { type: 'input_audio_buffer.speech_started', audio_start_ms: 150, item_id: 'item_y' });
  await until(() => events.length === 3, { what: 'vad after reconnect' });
  assert.equal(events[2][1].t, T1 + 150);
  assert.equal(ears.stats().epoch, 2);
  assert.equal(ears.stats().session_audio_ms, 300);
});

test('AudioTimeline maps offsets inside chunks and extrapolates outside', () => {
  const tl = new AudioTimeline(4);
  assert.equal(tl.toWall(0), null);
  tl.add(4800, 1100); // 0..100 ms captured, ends at 1100
  tl.add(4800, 1250); // 100..200 ms (late push: ends at 1250)
  assert.equal(tl.toWall(0), 1000);
  assert.equal(tl.toWall(50), 1050);
  assert.equal(tl.toWall(150), 1200);
  assert.equal(tl.toWall(300), 1350);
  for (let i = 0; i < 10; i++) tl.add(4800, 2000 + i * 100);
  assert.ok(tl.entries.length <= 5);
  assert.equal(tl.ms, 1200);
});
