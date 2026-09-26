// Offline tests for the OpenRouter voice provider (WP3b): src/audio/{vad,or_ears,or_mouth,voice}.js.
// No network, no real keys: fetch is mocked, the ears get a fake transcriber that answers from the
// audio position ("с<N>", Cyrillic «с»: the word spoken during [N*250, N*250+250) ms of the stream).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadSettings } from '../../src/config.js';
import { APP_ROOT } from '../../src/env.js';
import { Ears } from '../../src/audio/ears.js';
import { Mouth } from '../../src/audio/mouth.js';
import {
  OrEars,
  OrError,
  cleanTranscript,
  createOrEars,
  encodeWav,
  fixLatinShort,
  isForeignScript,
  stitchText,
  stripAnchor,
  transcribeOnce,
} from '../../src/audio/or_ears.js';
import { OrMouth, buildTtsRequest, createOrMouth } from '../../src/audio/or_mouth.js';
import { buildInstructions } from '../../src/audio/realtime_ws.js';
import { EnergyVad, VAD_DEFAULTS, pcmLevelDb } from '../../src/audio/vad.js';
import { VOICE_DEFAULTS, createVoice, selectVoiceProvider } from '../../src/audio/voice.js';

// This suite exercises the openrouter/openai_realtime cascade; the elevenlabs_agent provider has no
// ears/mouth surface (agent_host drives it). settings.local.json may switch the machine default, so pin it.
const loadedSettings = loadSettings();
const SETTINGS = { ...loadedSettings, voice: { ...loadedSettings.voice, provider: 'openrouter' } };
const SR = 24_000;
const KEY = 'sk-or-test-0123456789abcdef';
const PEOPLE = [{ display: 'Тимур Ткач', aliases: ['Тима'] }];

// ---- signals ------------------------------------------------------------------------------------

function tone(ms, db, freq = 440) {
  const n = Math.round((SR * ms) / 1000);
  const amp = 10 ** (db / 20) * 32767 * Math.SQRT2;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * freq * i) / SR)), i * 2);
  return buf;
}

function noise(ms, db, seed = 7) {
  const n = Math.round((SR * ms) / 1000);
  const amp = 10 ** (db / 20) * 32767 * Math.sqrt(3);
  let x = seed >>> 0 || 1;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf.writeInt16LE(Math.round(amp * ((x / 4294967296) * 2 - 1)), i * 2);
  }
  return buf;
}

/** Syllable-like speech: 250 ms tone + 100 ms noise-level dip, repeated; the last dip is dropped. */
function speech(ms, db = -20, floorDb = -60) {
  const parts = [];
  let left = ms;
  let seed = 11;
  while (left > 0) {
    const t = Math.min(250, left);
    parts.push(tone(t, db, 300 + (seed % 5) * 40));
    left -= t;
    if (left <= 0) break;
    const g = Math.min(100, left);
    parts.push(noise(g, floorDb, seed++));
    left -= g;
  }
  return Buffer.concat(parts);
}

const cat = (...bufs) => Buffer.concat(bufs);
const msOf = (buf) => buf.length / 48;

function chunked(buf, ms = 100) {
  const size = ms * 48;
  const out = [];
  for (let off = 0; off < buf.length; off += size) out.push(buf.subarray(off, off + size));
  return out;
}

function vadEvents(buf, opts = {}, chunkBytes = 4800) {
  const vad = new EnergyVad(opts);
  const events = [];
  for (let off = 0; off < buf.length; off += chunkBytes) events.push(...vad.pushPcm(buf.subarray(off, off + chunkBytes)));
  return { vad, events };
}

function readWavPcm(path) {
  const b = readFileSync(path);
  let off = 12;
  while (off < b.length - 8) {
    const id = b.toString('ascii', off, off + 4);
    const len = b.readUInt32LE(off + 4);
    if (id === 'data') return { sr: b.readUInt32LE(24), pcm: b.subarray(off + 8, off + 8 + len) };
    off += 8 + len;
  }
  throw new Error('no data chunk');
}

function memLog() {
  const records = [];
  return { records, event: (type, fields = {}) => records.push({ type, ...fields }), types: () => records.map((r) => r.type) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function until(cond, { timeout = 3000, what = 'condition' } = {}) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${what}`);
    await sleep(2);
  }
}

// ---- VAD ------------------------------------------------------------------------------------------

describe('vad: energy VAD with adaptive floor', () => {
  test('noise -> speech -> noise: one utterance, onset/end within a frame, pause before stop', () => {
    const { events } = vadEvents(cat(noise(1000, -60), speech(2000), noise(1500, -60)));
    assert.deepEqual(events.map((e) => e.type), ['start', 'pause', 'stop']);
    const [start, pause, stop] = events;
    assert.ok(Math.abs(start.pos_ms - 1000) <= 20, `onset ${start.pos_ms}`);
    assert.ok(start.at_ms - start.pos_ms >= VAD_DEFAULTS.start_ms, 'start decided after start_ms of loud audio');
    assert.ok(Math.abs(stop.pos_ms - 3000) <= 40, `end ${stop.pos_ms}`);
    assert.equal(pause.pos_ms, stop.pos_ms, 'pause and stop point at the same end of speech');
    assert.ok(Math.abs(stop.at_ms - stop.pos_ms - VAD_DEFAULTS.stop_ms) <= 20, 'stop after the hangover');
    assert.ok(Math.abs(stop.speech_ms - 2000) <= 40);
  });

  test('blips shorter than start_ms never start; a short gap does not split; a long gap does', () => {
    assert.deepEqual(vadEvents(cat(noise(500, -60), tone(100, -20), noise(1500, -60))).events, []);
    const short = vadEvents(cat(noise(500, -60), speech(1000), noise(400, -60), speech(1000), noise(1000, -60))).events;
    assert.deepEqual(short.map((e) => e.type), ['start', 'pause', 'resume', 'pause', 'stop']);
    const long = vadEvents(cat(noise(500, -60), speech(1000), noise(800, -60), speech(1000), noise(1000, -60))).events;
    assert.deepEqual(long.map((e) => e.type), ['start', 'pause', 'stop', 'start', 'pause', 'stop']);
  });

  test('an isolated 20 ms blip inside the hangover does not keep the utterance open', () => {
    const blip = cat(noise(300, -60), tone(20, -20), noise(1000, -60, 3));
    const { events } = vadEvents(cat(noise(500, -60), speech(1000), blip));
    const stop = events.find((e) => e.type === 'stop');
    assert.ok(stop, 'stopped');
    assert.ok(Math.abs(stop.pos_ms - 1500) <= 40, `end ${stop.pos_ms} (blip ignored)`);
  });

  test('floor: learns a new steady noise within floor_window_ms; digital silence clamps at floor_min_db', () => {
    const { vad, events } = vadEvents(cat(noise(2000, -70), noise(9000, -45, 5)));
    const stops = events.filter((e) => e.type === 'stop');
    assert.ok(events.filter((e) => e.type === 'start').length <= 1, 'at most one false start at the step');
    if (stops.length) assert.ok(stops[0].at_ms <= 2000 + VAD_DEFAULTS.floor_window_ms + VAD_DEFAULTS.stop_ms + 200, `false utterance ends at ${stops[0].at_ms}`);
    assert.equal(vad.speaking, false);
    assert.ok(Math.abs(vad.floorDb + 45) <= 3, `floor ${vad.floorDb}`);
    const after = vad.pushPcm(cat(speech(1000, -20, -45), noise(1000, -45, 9))); // syllable dips at the room noise
    assert.deepEqual(after.map((e) => e.type).filter((t) => t !== 'pause'), ['start', 'stop'], 'speech over the new floor is still heard');

    const silent = new EnergyVad();
    silent.pushPcm(Buffer.alloc(48_000));
    assert.equal(silent.floorDb, VAD_DEFAULTS.floor_min_db);
    assert.equal(silent.levelDb, -100);
  });

  test('chunking does not matter (odd byte counts carry over); pushLevel and flush work', () => {
    const sig = cat(noise(700, -60), speech(1500), noise(900, -60));
    const a = vadEvents(sig).events;
    const b = vadEvents(sig, {}, 7).events;
    assert.deepEqual(b, a);
    const lv = new EnergyVad();
    const out = [];
    for (let i = 0; i < 20; i++) out.push(...lv.pushLevel(-60, 50));
    for (let i = 0; i < 10; i++) out.push(...lv.pushLevel(-20, 50));
    assert.equal(out.filter((e) => e.type === 'start').length, 1);
    assert.equal(out[0].pos_ms, 1000);
    const f = lv.flush();
    assert.equal(f.type, 'stop');
    assert.equal(f.reason, 'flush');
    assert.equal(lv.speaking, false);
    assert.equal(lv.flush(), null);
    assert.throws(() => new EnergyVad({ start_db: 6, stop_db: 6 }), /stop_db must be below start_db/);
    assert.ok(Math.abs(pcmLevelDb(tone(200, -20)) + 20) < 0.1);
  });

  const STT_INPUT = join(APP_ROOT, '_internal', 'selftest_stt_input.wav'); // 1.5 s silence + TTS phrase + 1.5 s silence
  test('real speech (WP3 self-test input): one utterance, onset ±60 ms, end within +400 ms', { skip: !existsSync(STT_INPUT) && 'no _internal/selftest_stt_input.wav' }, () => {
    const { pcm } = readWavPcm(STT_INPUT);
    const { events } = vadEvents(pcm);
    const starts = events.filter((e) => e.type === 'start');
    const stops = events.filter((e) => e.type === 'stop');
    assert.equal(starts.length, 1);
    assert.equal(stops.length, 1);
    assert.ok(Math.abs(starts[0].pos_ms - 1500) <= 60, `onset ${starts[0].pos_ms}`);
    const clipEnd = msOf(pcm) - 1500;
    assert.ok(stops[0].pos_ms <= clipEnd + 400, `end ${stops[0].pos_ms} vs clip end ${clipEnd}`);
    assert.ok(stops[0].pos_ms >= clipEnd - 800, `end ${stops[0].pos_ms} not premature`);
  });
});

// ---- text helpers -----------------------------------------------------------------------------------

describe('stitching and transcript hygiene', () => {
  test('stitchText merges the overlap once, repairs cut words, keeps the earlier casing', () => {
    assert.equal(stitchText('вчера закончил интеграцию с', 'интеграцию с трекером'), 'вчера закончил интеграцию с трекером');
    assert.equal(stitchText('вчера закончил интегра', 'интеграцию с трекером'), 'вчера закончил интеграцию с трекером');
    assert.equal(stitchText('вчера закончил интеграцию', 'грацию с трекером'), 'вчера закончил интеграцию с трекером');
    assert.equal(stitchText('Закончил интеграцию с трекером.', 'С трекером. Сегодня отчёт'), 'Закончил интеграцию с трекером. Сегодня отчёт');
    assert.equal(stitchText('раз два', 'три четыре'), 'раз два три четыре');
    assert.equal(stitchText('', 'три'), 'три');
    assert.equal(stitchText('раз', '  '), 'раз');
    assert.equal(stitchText('w1 w2 w3 w4', 'w3 w4 w5'), 'w1 w2 w3 w4 w5');
  });

  test('stitchText tolerates a misheard word or a dropped fragment inside a longer overlap', () => {
    // live 18.09: «отчета» vs «отчетов» in two windows over the same audio
    assert.equal(
      stitchText('вчера я закончил интеграцию с трекером и поправил выгрузку отчета, там была ошибка', 'выгрузку отчетов, там была ошибка с часовыми поясами.'),
      'вчера я закончил интеграцию с трекером и поправил выгрузку отчета, там была ошибка с часовыми поясами.',
    );
    // prev ends on a cut fragment the next window completes
    assert.equal(stitchText('пишу тесты на новый мо', 'новый модуль. Если успею'), 'пишу тесты на новый модуль. Если успею');
    // next starts with the tail of prev's last word («Кторе» from «архитектуре»)
    assert.equal(stitchText('потом созвон с Глебом по архитектуре.', 'Кторе, а после обеда пишу тесты'), 'потом созвон с Глебом по архитектуре. а после обеда пишу тесты');
    // one short common word is not evidence of an overlap
    assert.equal(stitchText('и вот', 'и потом'), 'и вот и потом');
  });

  test('stripAnchor removes the leading «Итак» only', () => {
    assert.equal(stripAnchor('Итак, да.', 'Итак.'), 'Да.');
    assert.equal(stripAnchor('Итак. Всем привет. Вчера закончил.', 'Итак.'), 'Всем привет. Вчера закончил.');
    assert.equal(stripAnchor('И так, Кора, стоп.', 'Итак.'), 'Кора, стоп.');
    assert.equal(stripAnchor('Итак.', 'Итак.'), '');
    assert.equal(stripAnchor('Всем привет, итак, начнём', 'Итак.'), 'Всем привет, итак, начнём');
    assert.equal(stripAnchor('Иван, привет', 'Итак.'), 'Иван, привет');
  });

  test('fixLatinShort maps short Latin answers to Cyrillic; isForeignScript flags other languages', () => {
    assert.equal(fixLatinShort('Da.'), 'Да.');
    assert.equal(fixLatinShort('Cora, stop.'), 'Кора, стоп.');
    assert.equal(fixLatinShort('Net, vsyo.'), 'Нет, всё.');
    assert.equal(fixLatinShort('Segundo'), 'Секунду');
    assert.equal(fixLatinShort('Privetik'), 'Приветик');
    assert.equal(fixLatinShort('Да.'), 'Да.');
    assert.equal(fixLatinShort('задеплоил в GitLab'), 'задеплоил в GitLab', 'mixed text untouched');
    assert.equal(fixLatinShort('Yesterday I finished the integration work'), 'Yesterday I finished the integration work', 'long Latin untouched');
    assert.equal(fixLatinShort('Da.', 'en'), 'Da.');
    assert.equal(isForeignScript('Која а после обеда пишу тесте на нови модул?'), true);
    assert.equal(isForeignScript('Rešujete ste na novej modulj.'), true);
    assert.equal(isForeignScript('오호.'), true);
    assert.equal(isForeignScript('Yesterday I finished the integration'), true);
    assert.equal(isForeignScript('Сегодня задеплоил в GitLab и обновил Jira'), false);
    assert.equal(isForeignScript('Всё, у меня всё.'), false);
    assert.equal(isForeignScript('Која', 'en'), false);
  });

  test('cleanTranscript drops prompt echoes and known silence hallucinations only', () => {
    const prompt = 'Утренний стендап IT-команды Acme: участники по очереди рассказывают планы. Участники: Тимур Ткач.';
    assert.equal(cleanTranscript('  У меня   всё. '), 'У меня всё.');
    assert.equal(cleanTranscript('Продолжение следует...'), '');
    assert.equal(cleanTranscript('Субтитры сделал DimaTorzok'), '');
    assert.equal(cleanTranscript('Участники: Тимур Ткач.', prompt), '');
    assert.equal(cleanTranscript('Тимур, привет', prompt), 'Тимур, привет');
    assert.equal(cleanTranscript('Спасибо, продолжение следует завтра'), 'Спасибо, продолжение следует завтра');
    assert.equal(cleanTranscript('…'), '');
  });

  test('encodeWav writes a 44-byte PCM16 mono header', () => {
    const wav = encodeWav(Buffer.alloc(4800, 1));
    assert.equal(wav.length, 44 + 4800);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(4), 36 + 4800);
    assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
    assert.equal(wav.readUInt16LE(20), 1);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 24_000);
    assert.equal(wav.readUInt32LE(28), 48_000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.toString('ascii', 36, 40), 'data');
    assert.equal(wav.readUInt32LE(40), 4800);
  });
});

// ---- HTTP mocks -------------------------------------------------------------------------------------

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null, signal: init.signal };
    calls.push(call);
    return handler(call, calls.length);
  };
  fn.calls = calls;
  return fn;
}

const json = (status, body, headers = {}) =>
  new Response(Buffer.from(JSON.stringify(body), 'utf8'), { status, headers: { 'content-type': 'application/json', ...headers } });

function sseResponse(items, { split = 0, delayMs = 0, signal } = {}) {
  const enc = new TextEncoder();
  const frames = items.map((it) => enc.encode(typeof it === 'string' ? `${it}\n\n` : `data: ${JSON.stringify(it)}\n\n`));
  let parts = frames;
  if (split) {
    const all = Buffer.concat(frames.map((f) => Buffer.from(f)));
    parts = [];
    for (let off = 0; off < all.length; off += split) parts.push(new Uint8Array(all.subarray(off, off + split)));
  }
  let i = 0;
  const body = new ReadableStream({
    start(c) {
      signal?.addEventListener(
        'abort',
        () => {
          try {
            c.error(signal.reason);
          } catch {
            // already closed
          }
        },
        { once: true },
      );
    },
    async pull(c) {
      if (delayMs) await sleep(delayMs);
      if (signal?.aborted) return;
      if (i >= parts.length) {
        c.close();
        return;
      }
      c.enqueue(parts[i++]);
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const OR_USAGE = { prompt_tokens: 52, completion_tokens: 60, total_tokens: 112, cost: 0.0001752, is_byok: false };

/** OpenRouter-shaped TTS stream: transcript deltas, audio deltas, usage chunk, [DONE]. */
function ttsItems(transcript, audio, { usage = OR_USAGE, errorAfter = null } = {}) {
  const base = { id: 'gen-test-1', object: 'chat.completion.chunk', model: 'openai/gpt-audio-mini', provider: 'OpenAI' };
  const words = transcript.split(' ');
  const items = [': OPENROUTER PROCESSING'];
  words.forEach((w, i) => items.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '', audio: { ...(i ? {} : { id: 'audio_1' }), transcript: i ? ` ${w}` : w } } }] }));
  audio.forEach((b, i) => {
    if (errorAfter === i) items.push({ error: { code: 502, message: 'upstream went away' } });
    items.push({ ...base, choices: [{ index: 0, delta: { audio: { data: b.toString('base64') } } }] });
  });
  items.push({ ...base, choices: [{ index: 0, delta: { audio: { expires_at: 1789754529 } } }] });
  items.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
  items.push('data: [DONE]');
  return items;
}

// ---- transcribeOnce ------------------------------------------------------------------------------

describe('transcribeOnce: OpenRouter /audio/transcriptions', () => {
  test('request shape (WAV base64, model, language, prompt, bearer) and UTF-8 response', async () => {
    const pcm = tone(300, -20);
    const fetch = mockFetch(() => json(200, { text: 'У меня всё, передаю слово.', usage: { cost: 0.00028 } }, { 'x-generation-id': 'gen-stt-1' }));
    const out = await transcribeOnce({ pcm, apiKey: KEY, model: 'openai/gpt-4o-transcribe', language: 'ru', prompt: 'стендап', fetch });
    assert.deepEqual(out, { text: 'У меня всё, передаю слово.', usage: { cost: 0.00028 }, generation_id: 'gen-stt-1' });
    const [call] = fetch.calls;
    assert.equal(call.url, 'https://openrouter.ai/api/v1/audio/transcriptions');
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.body.model, 'openai/gpt-4o-transcribe');
    assert.equal(call.body.language, 'ru');
    assert.equal(call.body.prompt, 'стендап');
    assert.equal(call.body.input_audio.format, 'wav');
    assert.deepEqual(Buffer.from(call.body.input_audio.data, 'base64'), encodeWav(pcm));
    assert.equal('provider' in call.body, false);
  });

  test('errors: 401 auth (final), 402 payment, 503 server (retryable), non-JSON body', async () => {
    const pcm = tone(100, -20);
    const fail = async (res) => {
      try {
        await transcribeOnce({ pcm, apiKey: KEY, fetch: async () => res });
      } catch (e) {
        return e;
      }
      throw new Error('did not throw');
    };
    const auth = await fail(json(401, { error: { message: 'No auth credentials found', code: 401 } }));
    assert.ok(auth instanceof OrError);
    assert.deepEqual([auth.kind, auth.status, auth.retryable], ['auth', 401, false]);
    assert.match(auth.message, /No auth credentials/);
    assert.equal((await fail(json(402, { error: { message: 'Insufficient credits' } }))).kind, 'payment');
    const server = await fail(json(503, { error: { message: 'overloaded' } }));
    assert.deepEqual([server.kind, server.retryable], ['server', true]);
    const bad = await fail(new Response('<html>oops</html>', { status: 200 }));
    assert.deepEqual([bad.kind, bad.retryable], ['bad_response', true]);
    const net = await fail(Promise.reject(new TypeError('fetch failed')));
    assert.deepEqual([net.kind, net.retryable], ['network', true]);
  });
});

// ---- OrEars -----------------------------------------------------------------------------------------

/** Words spoken in [from, to]: с<N> (Cyrillic, so the foreign-script guard stays quiet) for every 250 ms slot fully inside the range and inside speech. */
function wordsIn(from, to, speechRanges) {
  const out = [];
  for (let i = Math.ceil(from / 250 - 1e-6); (i + 1) * 250 <= to + 1e-6; i++) {
    const a = i * 250;
    if (speechRanges.some(([s, e]) => a >= s && a + 250 <= e)) out.push(`с${i}`);
  }
  return out.join(' ');
}

/** «с<a> с<a+1> … с<b>» */
const seq = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => `с${a + i}`).join(' ');

function fakeTranscriber(speechRanges, { delayTicks = 1 } = {}) {
  const calls = [];
  const fn = async (pcm, info) => {
    calls.push({ ...info, bytes: pcm.length });
    for (let i = 0; i < delayTicks; i++) await tick();
    if (info.signal.aborted) throw info.signal.reason;
    return { text: wordsIn(info.from_ms, info.to_ms, speechRanges), usage: { cost: 0.0001 } };
  };
  fn.calls = calls;
  return fn;
}

/** Transcriber the test answers by hand. */
function heldTranscriber() {
  const calls = [];
  const fn = (pcm, info) =>
    new Promise((resolve, reject) => {
      const call = { ...info, resolve, reject };
      calls.push(call);
      info.signal.addEventListener('abort', () => reject(info.signal.reason), { once: true });
    });
  fn.calls = calls;
  return fn;
}

function makeEars({ transcriber, stt = {}, vad = {}, log = memLog(), prompt = false } = {}) {
  const clock = { t: 1_000_000 };
  const ears = createOrEars({ settings: SETTINGS, transcriber, log, now: () => clock.t, stt, vad, prompt, people: PEOPLE });
  const events = [];
  for (const type of ['vad', 'stt_delta', 'stt_final', 'stt_failed', 'reset']) ears.on(type, (e) => events.push({ ev: type, ...e }));
  const T0 = clock.t;
  const feed = async (buf, { ticks = true } = {}) => {
    for (const c of chunked(buf)) {
      clock.t += msOf(c);
      ears.pushAudio(c, { t: clock.t });
      if (ticks) await tick();
    }
  };
  const of = (type) => events.filter((e) => e.ev === type);
  return { ears, events, of, feed, clock, T0, log };
}

describe('OrEars: VAD + OpenRouter STT with the ears.js event contract', () => {
  test('short utterance: vad start/stop on the capture clock, speculative final adopted (one request)', async () => {
    const tr = fakeTranscriber([[1000, 3000]]);
    const { ears, of, feed, T0, log } = makeEars({ transcriber: tr });
    await feed(cat(noise(1000, -60), speech(2000), noise(1500, -60)));
    await until(() => of('stt_final').length === 1, { what: 'final' });
    const [start, stop] = of('vad');
    assert.equal(start.type, 'start');
    assert.ok(Math.abs(start.audio_ms - 1000) <= 20);
    assert.equal(start.t, T0 + start.audio_ms, 'vad.t = capture wall time of the onset');
    assert.equal(stop.type, 'stop');
    assert.ok(Math.abs(stop.audio_ms - 3000) <= 40);
    assert.equal(stop.t, T0 + stop.audio_ms);
    assert.equal(stop.item_id, start.item_id);
    assert.ok(stop.t_rx - stop.t >= 600, 'stop reported after the hangover');
    const [final] = of('stt_final');
    assert.equal(final.item_id, start.item_id);
    assert.equal(final.text, seq(4, 11));
    assert.equal(final.speculative, true);
    assert.equal(final.t_speech_start, start.t);
    assert.equal(final.t_speech_end, stop.t);
    assert.equal(final.latency_ms, final.t - stop.t);
    assert.equal(tr.calls.length, 1, 'the speculative request became the final');
    assert.equal(tr.calls[0].kind, 'spec');
    assert.ok(Math.abs(tr.calls[0].from_ms - (start.audio_ms - 300)) <= 1, 'pre-roll 300 ms');
    assert.ok(Math.abs(tr.calls[0].to_ms - (stop.audio_ms + 150)) <= 1, 'tail pad 150 ms');
    assert.equal(ears.speaking, false);
    assert.deepEqual(log.types().filter((t) => /^(vad|stt)\./.test(t)), ['vad.start', 'vad.stop', 'stt.final']);
    assert.ok(log.records.some((r) => r.type === 'or.stt' && r.kind === 'spec' && r.cost_usd === 0.0001));
    const st = ears.stats();
    assert.equal(st.finals, 1);
    assert.equal(st.spec_hits, 1);
    assert.ok(st.cost_usd > 0);
    ears.close();
  });

  test('long utterance (> full_max_ms): partial windows with overlap -> stitched deltas and final', async () => {
    const tr = fakeTranscriber([[500, 14500]]);
    const { ears, of, feed } = makeEars({ transcriber: tr });
    await feed(cat(noise(500, -60), speech(14_000), noise(1500, -60)));
    await until(() => of('stt_final').length === 1, { what: 'final' });
    const expected = seq(2, 57);
    const [final] = of('stt_final');
    assert.equal(final.text, expected, 'every word exactly once, in order');
    assert.equal(final.stitched, true);
    const partials = tr.calls.filter((c) => c.kind === 'partial');
    assert.ok(partials.length >= 4, `${partials.length} partial windows`);
    for (let i = 1; i < partials.length; i++) {
      assert.ok(partials[i].from_ms <= partials[i - 1].to_ms - 500, 'windows overlap by at least overlap_ms');
      assert.ok(partials[i].to_ms - partials[i].from_ms >= 4000 - 1, 'tail windows carry at least min_context_ms of audio');
    }
    const deltas = of('stt_delta');
    assert.ok(deltas.length >= 4);
    for (let i = 1; i < deltas.length; i++) assert.ok(deltas[i].so_far.startsWith(deltas[i - 1].so_far), 'running text only grows');
    assert.ok(expected.startsWith(deltas.at(-1).so_far));
    const finalCall = tr.calls.find((c) => c.kind === 'spec' || c.kind === 'final');
    assert.ok(finalCall.to_ms - finalCall.from_ms < 7000, 'final sends only the tail, not 14 s');
    ears.close();
  });

  test('language anchor: prepended to onset windows only, stripped from the text', async () => {
    const anchorPcm = tone(500, -20, 200);
    const seen = [];
    const words = fakeTranscriber([[500, 14500]]);
    const tr = async (pcm, info) => {
      seen.push({ kind: info.kind, anchored: info.anchored, bytes: pcm.length, window: Math.round((info.to_ms - info.from_ms) * 48) });
      const out = await words(pcm, info);
      return { ...out, text: info.anchored ? `Итак, ${out.text}` : out.text };
    };
    const { ears, of, feed, log } = makeEars({ transcriber: tr });
    ears.setAnchor({ pcm: anchorPcm, text: 'Итак.' });
    assert.deepEqual(ears.anchor, { text: 'Итак.', ms: 500 });
    await feed(cat(noise(500, -60), speech(14_000), noise(1500, -60)));
    await until(() => of('stt_final').length === 1, { what: 'final' });
    assert.equal(of('stt_final')[0].text, `С2 ${seq(3, 57)}`, 'no «Итак» leaks into the text');
    const first = seen[0];
    assert.equal(first.anchored, true, 'the first window starts at the onset');
    assert.ok(Math.abs(first.bytes - (anchorPcm.length + 200 * 48 + first.window)) <= 2, 'anchor + gap + window');
    assert.ok(seen.slice(1).every((s) => !s.anchored), 'tail windows go without the anchor');
    assert.ok(log.records.some((r) => r.type === 'or.stt' && r.anchored === true));
    assert.throws(() => ears.setAnchor({ pcm: Buffer.alloc(0), text: 'x' }), /required/);
    ears.setAnchor(null);
    assert.equal(ears.anchor, null);
    ears.close();
  });

  test('foreign-script final is requested again once; Latin «Da.» becomes «Да.»; foreign partials are dropped', async () => {
    let n = 0;
    const serbianFirst = async () => ({ text: ++n === 1 ? 'Која а после обеда пишу тесте на нови модул?' : 'А после обеда пишу тесты на новый модуль.' });
    const a = makeEars({ transcriber: serbianFirst });
    await a.feed(cat(noise(500, -60), speech(1500), noise(1000, -60)));
    await until(() => a.of('stt_final').length === 1, { what: 'final' });
    assert.equal(a.of('stt_final')[0].text, 'А после обеда пишу тесты на новый модуль.');
    assert.equal(a.ears.stats().lang_retries, 1);
    a.ears.close();

    const b = makeEars({ transcriber: async () => ({ text: 'Da.' }) });
    await b.feed(cat(noise(500, -60), speech(400), noise(1000, -60)));
    await until(() => b.of('stt_final').length === 1, { what: 'final' });
    assert.equal(b.of('stt_final')[0].text, 'Да.');
    assert.ok(b.log.records.some((r) => r.type === 'or.stt' && r.translit === 'Da.'));
    b.ears.close();

    const c = makeEars({ transcriber: async (pcm, info) => ({ text: info.kind === 'partial' ? 'Rešujete ste na novej modulj' : 'Пишу тесты на новый модуль.' }) });
    await c.feed(cat(noise(500, -60), speech(4000), noise(1000, -60)));
    await until(() => c.of('stt_final').length === 1, { what: 'final' });
    assert.equal(c.of('stt_delta').length, 0, 'no delta from a foreign partial');
    assert.equal(c.of('stt_final')[0].text, 'Пишу тесты на новый модуль.');
    assert.ok(c.ears.stats().foreign >= 1);
    c.ears.close();
  });

  test('speech resumes after a pause: the speculative text becomes a delta, the final covers everything', async () => {
    const tr = fakeTranscriber([[500, 2500], [2900, 4400]]);
    const { ears, of, feed } = makeEars({ transcriber: tr });
    await feed(cat(noise(500, -60), speech(2000), noise(400, -60), speech(1500), noise(1500, -60)));
    await until(() => of('stt_final').length === 1, { what: 'final' });
    assert.equal(of('vad').length, 2, 'one utterance');
    assert.ok(of('stt_delta').some((d) => d.so_far.startsWith(seq(2, 3))), 'first part arrived as a delta');
    const [final] = of('stt_final');
    assert.equal(final.text, `${wordsIn(0, 2500, [[500, 2500]])} ${wordsIn(2900, 4400, [[2900, 4400]])}`);
    assert.equal(tr.calls.filter((c) => c.kind === 'spec').length, 2);
    ears.close();
  });

  test('utterances shorter than min_speech_ms are not transcribed: empty final, skipped too_short', async () => {
    const tr = fakeTranscriber([[500, 680]]);
    const { ears, of, feed } = makeEars({ transcriber: tr });
    await feed(cat(noise(500, -60), tone(180, -20), noise(1200, -60)));
    await until(() => of('stt_final').length === 1, { what: 'final' });
    assert.deepEqual(of('vad').map((v) => v.type), ['start', 'stop']);
    const [final] = of('stt_final');
    assert.equal(final.text, '');
    assert.equal(final.skipped, 'too_short');
    assert.equal(tr.calls.length, 0);
    assert.equal(ears.stats().skipped_short, 1);
    ears.close();
  });

  test('at most `concurrency` requests in flight; finals go before queued partials', async () => {
    const tr = heldTranscriber();
    const { ears, of, feed } = makeEars({ transcriber: tr, stt: { concurrency: 1 } });
    // A: short utterance -> its final is held in the only slot
    await feed(cat(noise(500, -60), speech(800), noise(900, -60)));
    await until(() => tr.calls.length === 1, { what: 'A request' });
    // C: 3 s of speech (partial queued at 2.5 s), then quiet: speculative final queued behind it
    await feed(cat(speech(3000), noise(300, -60)));
    assert.equal(ears.stats().active, 1);
    assert.equal(ears.stats().queued, 2);
    tr.calls[0].resolve({ text: 'а' });
    await until(() => tr.calls.length === 2, { what: 'next request' });
    assert.equal(tr.calls[1].kind, 'spec', 'the final-to-be jumps the queued partial');
    await feed(noise(600, -60));
    tr.calls[1].resolve({ text: 'це' });
    await until(() => of('stt_final').length === 2, { what: 'two finals' });
    assert.deepEqual(of('stt_final').map((f) => f.text), ['а', 'це']);
    assert.equal(tr.calls.length, 2, 'the moot partial never went out');
    ears.close();
  });

  test('final times out twice (1 retry) -> stt_failed; non-retryable auth fails without retry', async () => {
    const tr = heldTranscriber();
    const { ears, of, feed } = makeEars({ transcriber: tr, stt: { timeout_ms: 40, retries: 1, retry_backoff_ms: 5 } });
    await feed(cat(noise(500, -60), speech(1000), noise(1000, -60)), { ticks: false });
    await until(() => of('stt_failed').length === 1, { what: 'stt_failed' });
    assert.equal(tr.calls.length, 2);
    const [failed] = of('stt_failed');
    assert.equal(failed.error.code, 'timeout');
    assert.equal(failed.item_id, of('vad')[0].item_id);
    assert.equal(of('stt_final').length, 0);
    ears.close();

    let n = 0;
    const authFail = async () => {
      n++;
      throw new OrError('auth', 'HTTP 401: bad key', { status: 401 });
    };
    const b = makeEars({ transcriber: authFail });
    await b.feed(cat(noise(500, -60), speech(1000), noise(1000, -60)), { ticks: false });
    await until(() => b.of('stt_failed').length === 1, { what: 'auth failure' });
    assert.equal(n, 1);
    assert.equal(b.of('stt_failed')[0].error.code, 'auth');
    assert.equal(b.of('stt_failed')[0].error.status, 401);
    b.ears.close();
  });

  test('a 400 naming the prompt drops it for the session and retries at once', async () => {
    let n = 0;
    const tr = async () => {
      n++;
      if (n === 1) throw new OrError('bad_request', "HTTP 400: Unsupported parameter: 'prompt'", { status: 400 });
      return { text: 'готово' };
    };
    const { ears, of, feed } = makeEars({ transcriber: tr, prompt: 'Утренний стендап' });
    assert.equal(ears.prompt, 'Утренний стендап');
    await feed(cat(noise(500, -60), speech(1000), noise(1000, -60)), { ticks: false });
    await until(() => of('stt_final').length === 1, { what: 'final' });
    assert.equal(of('stt_final')[0].text, 'готово');
    assert.equal(ears.prompt, null);
    assert.equal(ears.stats().retries, 0, 'adaptation is not a retry');
    ears.close();
  });

  test('stall: no audio mid-utterance closes it (reason stall); close() mid-speech emits reset', async () => {
    const tr = fakeTranscriber([[500, 1500]]);
    const { ears, of, feed, clock } = makeEars({ transcriber: tr, stt: { stall_ms: 100 } });
    await feed(cat(noise(500, -60), speech(1000)));
    assert.equal(ears.speaking, true);
    clock.t += 1000; // the page stopped sending audio
    await until(() => of('vad').length === 2, { what: 'stall stop' });
    assert.equal(of('vad')[1].reason, 'stall');
    await until(() => of('stt_final').length === 1, { what: 'final after stall' });
    ears.close();

    const b = makeEars({ transcriber: heldTranscriber() });
    await b.feed(cat(noise(500, -60), speech(800)));
    b.ears.close();
    assert.deepEqual(b.of('reset').map((r) => r.reason), ['closed']);
    assert.equal(b.ears.pushAudio(Buffer.alloc(4800)), false, 'closed ears refuse audio');
    b.ears.close(); // idempotent
  });

  test('pushAudio: base64, Buffer, Int16Array, odd lengths; invalid input refused; wall-clock mapping', () => {
    const { ears, clock, T0 } = makeEars({ transcriber: fakeTranscriber([]) });
    const a = Buffer.alloc(4800, 1);
    assert.equal(ears.pushAudio(a.toString('base64'), { t: T0 + 100 }), true);
    assert.equal(ears.pushAudio(Buffer.alloc(4800), { t: T0 + 200 }), true);
    assert.equal(ears.pushAudio(new Int16Array(2400), { t: T0 + 300 }), true);
    assert.equal(ears.pushAudio(Buffer.alloc(4801)), true);
    assert.equal(ears.pushAudio(Buffer.alloc(4799)), true);
    assert.equal(ears.pushAudio(Buffer.alloc(0)), false);
    assert.equal(ears.pushAudio({}), false);
    assert.equal(ears.audioMs, 500);
    assert.equal(ears.audioMsToWall(0), T0);
    assert.equal(ears.audioMsToWall(250), T0 + 250);
    assert.equal(ears.sweepItems(), 0);
    assert.equal(ears.stats().pushed_ms, 500);
    assert.ok(clock.t >= T0);
    ears.close();
  });

  test('transcripts that are silence hallucinations become empty finals', async () => {
    const tr = async () => ({ text: 'Продолжение следует...' });
    const { ears, of, feed, log } = makeEars({ transcriber: tr });
    await feed(cat(noise(500, -60), speech(1000), noise(1000, -60)));
    await until(() => of('stt_final').length === 1, { what: 'final' });
    assert.equal(of('stt_final')[0].text, '');
    assert.ok(log.records.some((r) => r.type === 'or.stt' && r.filtered === 'Продолжение следует...'));
    ears.close();
  });

  test('HTTP path: default transcriber posts the utterance WAV to OpenRouter with prompt and language', async () => {
    const fetch = mockFetch((call) => json(200, { text: 'Всем привет', usage: { cost: 0.0002 } }));
    const ears = createOrEars({ settings: SETTINGS, apiKey: KEY, fetch, people: PEOPLE, log: memLog() });
    const finals = [];
    ears.on('stt_final', (f) => finals.push(f));
    for (const c of chunked(cat(noise(500, -60), speech(1000), noise(1000, -60)))) ears.pushAudio(c);
    await until(() => finals.length === 1, { what: 'final' });
    assert.equal(finals[0].text, 'Всем привет');
    const [call] = fetch.calls;
    assert.equal(call.body.model, SETTINGS.voice.stt_model);
    assert.equal(call.body.language, 'ru');
    assert.match(call.body.prompt, /Участники: Тимур Ткач/);
    const wav = Buffer.from(call.body.input_audio.data, 'base64');
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.ok(wav.length - 44 >= 1400 * 48, 'utterance + pre-roll + tail');
    ears.close();
  });

  const STT_INPUT = join(APP_ROOT, '_internal', 'selftest_stt_input.wav');
  test('real speech through the ears: one utterance, one final', { skip: !existsSync(STT_INPUT) && 'no _internal/selftest_stt_input.wav' }, async () => {
    const tr = fakeTranscriber([[0, 1e9]]);
    const { ears, of, feed } = makeEars({ transcriber: tr });
    await feed(readWavPcm(STT_INPUT).pcm);
    await feed(Buffer.alloc(48 * 1000));
    await until(() => of('stt_final').length === 1, { what: 'final' });
    assert.equal(of('vad').length, 2);
    assert.ok(of('stt_final')[0].text.length > 0);
    ears.close();
  });
});

// ---- OrMouth ------------------------------------------------------------------------------------------

function makeMouth(handler, opts = {}) {
  const fetch = mockFetch(handler);
  const log = memLog();
  const mouth = createOrMouth({ settings: SETTINGS, apiKey: KEY, fetch, log, ...opts });
  return { mouth, fetch, log };
}

const pcmChunks = (n, bytes = 960) => Array.from({ length: n }, (_, i) => Buffer.alloc(bytes, (i % 250) + 1));

describe('OrMouth: gpt-audio readouts with the mouth.js contract', () => {
  test('say(): request shape, audio streamed in order, ttfa/audio_ms/usage/cost, verbatim, logs', async () => {
    const text = 'Тима, тебе слово.';
    const audio = pcmChunks(3);
    const { mouth, fetch, log } = makeMouth((call) => sseResponse(ttsItems(text, audio), { signal: call.signal }));
    const got = [];
    const starts = [];
    let ended = null;
    const h = mouth.say(text, { meta: { to: 'timur' }, onAudio: (b64) => got.push(b64), onStart: (i) => starts.push(i), onEnd: (r) => (ended = r) });
    assert.ok(mouth.busy);
    const r = await h.done;
    assert.equal(r.status, 'completed');
    assert.equal(r.id, h.id);
    assert.deepEqual(got.map((b) => Buffer.from(b, 'base64')), audio);
    assert.equal(r.audio_ms, 60);
    assert.ok(r.ttfa_ms >= 0);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].ttfa_ms, r.ttfa_ms);
    assert.equal(r.transcript, text);
    assert.equal(r.verbatim, true);
    assert.deepEqual(r.usage, OR_USAGE);
    assert.equal(r.cost_usd, OR_USAGE.cost);
    assert.equal(r.response_id, 'gen-test-1');
    assert.equal(r.upstream, 'OpenAI');
    assert.equal(ended, r);
    assert.equal(mouth.busy, false);

    const [call] = fetch.calls;
    assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(call.headers.Authorization, `Bearer ${KEY}`);
    assert.deepEqual(call.body, buildTtsRequest(text, { model: 'openai/gpt-audio-mini', voice: 'shimmer', instructions: buildInstructions(SETTINGS) }));
    assert.equal(call.body.model, SETTINGS.voice.tts_model);
    assert.deepEqual(call.body.modalities, ['text', 'audio']);
    assert.deepEqual(call.body.audio, { voice: 'shimmer', format: 'pcm16' });
    assert.equal(call.body.stream, true);
    assert.equal(call.body.messages[0].content, buildInstructions(SETTINGS));
    assert.ok(call.body.messages[0].content.includes(SETTINGS.realtime.pace_instructions.trim()));
    assert.deepEqual(JSON.parse(call.body.messages[1].content), { response_text: text, require_repeat_verbatim: true });
    const rec = log.records.find((x) => x.type === 'or.readout');
    assert.equal(rec.id, h.id);
    assert.equal(rec.cost_usd, OR_USAGE.cost);
    assert.deepEqual(rec.meta, { to: 'timur' });
    assert.ok(!JSON.stringify(log.records).includes(KEY), 'the key never reaches the log');
    assert.equal(mouth.stats().cost_usd, OR_USAGE.cost);
  });

  test('UTF-8 split across network chunks keeps the Cyrillic transcript intact', async () => {
    const text = 'Всем доброе утро! Уже десять, начинаем: Ярослав, тебе слово.';
    const { mouth } = makeMouth((call) => sseResponse(ttsItems(text, pcmChunks(2)), { split: 7, signal: call.signal }));
    const r = await mouth.say(text).done;
    assert.equal(r.transcript, text);
    assert.equal(r.verbatim, true);
  });

  test('odd-length audio deltas are re-aligned to whole samples; format buffer', async () => {
    const raw = Buffer.from(Array.from({ length: 12 }, (_, i) => i + 1));
    const parts = [raw.subarray(0, 3), raw.subarray(3, 8), raw.subarray(8, 12)];
    const { mouth } = makeMouth((call) => sseResponse(ttsItems('Раз.', parts), { signal: call.signal }));
    const got = [];
    const r = await mouth.say('Раз.', { format: 'buffer', onAudio: (b) => got.push(b) }).done;
    assert.ok(got.every((b) => Buffer.isBuffer(b) && b.length % 2 === 0));
    assert.deepEqual(Buffer.concat(got), raw);
    assert.equal(r.audio_ms, Math.round(12 / 48));
  });

  test('verbatim mismatch is logged and reported', async () => {
    const { mouth, log } = makeMouth((call) => sseResponse(ttsItems('Тима, тебе слово, пожалуйста.', pcmChunks(1)), { signal: call.signal }));
    const r = await mouth.say('Тима, тебе слово.').done;
    assert.equal(r.verbatim, false);
    assert.ok(r.similarity > 0.5 && r.similarity < 1);
    const rec = log.records.find((x) => x.type === 'or.verbatim_mismatch');
    assert.equal(rec.expected, 'Тима, тебе слово.');
    assert.equal(rec.got, 'Тима, тебе слово, пожалуйста.');
  });

  test('busy: a second say() rejects; {queue: true} waits; empty text and closed are refused', async () => {
    const { mouth } = makeMouth((call) => sseResponse(ttsItems('x', pcmChunks(2)), { signal: call.signal, delayMs: 2 }));
    const h1 = mouth.say('Раз.');
    await assert.rejects(mouth.say('Два.').done, (err) => err.code === 'busy' && err.message === 'busy: another readout is active');
    mouth.say('Бесхозный.'); // a rejected done nobody awaits must not crash the process
    const h3 = mouth.say('Три.', { queue: true });
    const [r1, r3] = await Promise.all([h1.done, h3.done]);
    assert.equal(r1.status, 'completed');
    assert.equal(r3.status, 'completed');
    assert.ok(r3.t_sent >= r1.t_done);
    assert.ok(r3.wait_ms >= 0);
    assert.equal(mouth.stats().busy_rejects, 2);
    await assert.rejects(mouth.say('   ').done, (err) => err.code === 'bad_text');
    mouth.close();
    await assert.rejects(mouth.say('Ещё.').done, (err) => err.code === 'closed');
    await assert.rejects(mouth.renderClip('Ещё.'), (err) => err.code === 'closed');
  });

  test('cancel mid-stream: fetch aborted, no onAudio after cancel(), status cancelled, idempotent', async () => {
    const { mouth, fetch } = makeMouth((call) => sseResponse(ttsItems('Длинная фраза.', pcmChunks(30)), { signal: call.signal, delayMs: 3 }));
    let audio = 0;
    let atCancel = -1;
    let h;
    h = mouth.say('Длинная фраза.', {
      onAudio: () => {
        audio++;
        if (audio === 2) {
          h.cancel();
          atCancel = audio;
        }
      },
    });
    const r = await h.done;
    await sleep(50);
    assert.equal(r.status, 'cancelled');
    assert.equal(audio, atCancel);
    assert.equal(fetch.calls[0].signal.aborted, true);
    assert.ok(r.cancel_ms >= 0);
    assert.equal(await h.cancel(), r);
    assert.equal(mouth.busy, false);
  });

  test('cancel before audio and while queued', async () => {
    const { mouth, fetch } = makeMouth(
      (call) =>
        new Promise((_, reject) => {
          call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
        }),
    );
    const h1 = mouth.say('Жду заголовков.');
    const h2 = mouth.say('В очереди.', { queue: true });
    await until(() => fetch.calls.length === 1, { what: 'request' });
    const r2 = await h2.cancel();
    assert.deepEqual([r2.status, r2.reason], ['cancelled', 'before_start']);
    const r1 = await h1.cancel();
    assert.deepEqual([r1.status, r1.reason], ['cancelled', 'before_audio']);
    assert.equal(fetch.calls[0].signal.aborted, true);
    await sleep(10);
    assert.equal(fetch.calls.length, 1, 'the queued readout never went out');
  });

  test('errors: 401 -> failed auth; live 503 not retried; clip 503 retried once; stream error; no audio; first-audio timeout', async () => {
    const auth = makeMouth(() => json(401, { error: { message: 'User not found.', code: 401 } }));
    const ra = await auth.mouth.say('Раз.').done;
    assert.deepEqual([ra.status, ra.reason, auth.fetch.calls.length], ['failed', 'auth', 1]);
    assert.equal(ra.error.status, 401);

    const live503 = makeMouth(() => json(503, { error: { message: 'overloaded' } }), { retryBackoffMs: 1 });
    const rl = await live503.mouth.say('Два.').done;
    assert.deepEqual([rl.status, rl.reason, live503.fetch.calls.length], ['failed', 'server', 1]);

    const clip = makeMouth((call, n) => (n === 1 ? json(503, { error: { message: 'overloaded' } }) : sseResponse(ttsItems('Три.', pcmChunks(2)), { signal: call.signal })), { retryBackoffMs: 1 });
    const pcm = await clip.mouth.renderClip('Три.');
    assert.equal(pcm.length, 1920);
    assert.equal(clip.fetch.calls.length, 2);

    const broken = makeMouth((call) => sseResponse(ttsItems('Четыре.', pcmChunks(3), { errorAfter: 1 }), { signal: call.signal }));
    const rb = await broken.mouth.say('Четыре.').done;
    assert.deepEqual([rb.status, rb.reason], ['failed', 'stream_error']);
    assert.equal(rb.audio_ms, 20, 'audio before the error was delivered');

    const silent = makeMouth((call) => sseResponse(ttsItems('Пять.', []), { signal: call.signal }));
    const rs = await silent.mouth.say('Пять.').done;
    assert.deepEqual([rs.status, rs.reason], ['failed', 'no_audio']);

    const hung = makeMouth((call) => sseResponse([': OPENROUTER PROCESSING', ...Array(50).fill(': keep-alive')], { signal: call.signal, delayMs: 5 }), { firstAudioTimeoutMs: 40 });
    const rh = await hung.mouth.say('Шесть.').done;
    assert.deepEqual([rh.status, rh.reason], ['failed', 'no_audio']);
    assert.equal(hung.fetch.calls[0].signal.aborted, true);
  });

  test('a 400 about `usage` drops usage accounting and retries at once', async () => {
    const { mouth, fetch } = makeMouth((call, n) =>
      n === 1 ? json(400, { error: { message: 'Invalid parameter: usage' } }) : sseResponse(ttsItems('Семь.', pcmChunks(1)), { signal: call.signal }),
    );
    const r = await mouth.say('Семь.').done;
    assert.equal(r.status, 'completed');
    assert.equal(fetch.calls.length, 2);
    assert.deepEqual(fetch.calls[0].body.usage, { include: true });
    assert.equal(fetch.calls[1].body.usage, undefined);
  });

  test('renderClip returns the whole PCM (or info) and runs alongside a live readout', async () => {
    const { mouth, fetch } = makeMouth((call) => {
      const t = JSON.parse(call.body.messages[1].content).response_text;
      return sseResponse(ttsItems(t, [Buffer.alloc(480, t.length % 250), Buffer.alloc(960, 5)]), { signal: call.signal, delayMs: 1 });
    });
    const [a, b, live] = await Promise.all([mouth.renderClip('Доброе утро!'), mouth.renderClip('Хорошего дня!', { withInfo: true }), mouth.say('Живая фраза.').done]);
    assert.deepEqual(a, cat(Buffer.alloc(480, 'Доброе утро!'.length), Buffer.alloc(960, 5)));
    assert.equal(b.pcm.length, 1440);
    assert.equal(b.verbatim, true);
    assert.equal(b.audio_ms, 30);
    assert.equal(b.cost_usd, OR_USAGE.cost);
    assert.equal(live.status, 'completed');
    assert.equal(fetch.calls.length, 3);
  });

  test('close(): in-flight readouts aborted (failed closed), queued clips never start', async () => {
    const { mouth, fetch } = makeMouth((call) => sseResponse(ttsItems('x', pcmChunks(50)), { signal: call.signal, delayMs: 5 }), { renderConcurrency: 1 });
    const live = mouth.say('Долгая фраза.');
    const clips = [mouth.renderClip('Первый.'), mouth.renderClip('Второй.')];
    await until(() => fetch.calls.length === 2, { what: 'two requests' });
    mouth.close();
    const r = await live.done;
    assert.deepEqual([r.status, r.reason], ['failed', 'closed']);
    for (const c of clips) await assert.rejects(c, (err) => err.code === 'closed');
    assert.ok(fetch.calls.every((c) => c.signal.aborted));
    await sleep(20);
    assert.equal(fetch.calls.length, 2);
  });

  test('warmup(): GET /key with the bearer, key info without the label; 401 throws auth', async () => {
    const { mouth, fetch, log } = makeMouth(() => json(200, { data: { label: 'sk-or-v1-abc...xyz', usage: 0.12, usage_daily: 0.1, limit_remaining: null, is_free_tier: false } }));
    const info = await mouth.warmup();
    assert.deepEqual(
      { ok: info.ok, usage_usd: info.usage_usd, usage_daily_usd: info.usage_daily_usd, limit_remaining_usd: info.limit_remaining_usd, is_free_tier: info.is_free_tier },
      { ok: true, usage_usd: 0.12, usage_daily_usd: 0.1, limit_remaining_usd: null, is_free_tier: false },
    );
    assert.equal(fetch.calls[0].url, 'https://openrouter.ai/api/v1/key');
    assert.equal(fetch.calls[0].method, 'GET');
    assert.equal(fetch.calls[0].headers.Authorization, `Bearer ${KEY}`);
    assert.ok(!JSON.stringify(log.records).includes('sk-or-v1'), 'key label not logged');
    const bad = makeMouth(() => json(401, { error: { message: 'User not found.' } }));
    await assert.rejects(bad.mouth.warmup(), (err) => err instanceof OrError && err.kind === 'auth');
  });

  test('instructions and cacheKey follow model, voice and pace instructions', () => {
    const { mouth } = makeMouth(() => json(500, {}));
    assert.equal(mouth.instructions, buildInstructions(SETTINGS));
    assert.match(mouth.cacheKey, /^openrouter\|openai\/gpt-audio-mini\|shimmer\|[0-9a-f]{12}$/);
    const other = createOrMouth({ settings: SETTINGS, apiKey: KEY, fetch: async () => json(500, {}), model: 'openai/gpt-audio' });
    assert.notEqual(other.cacheKey, mouth.cacheKey);
  });
});

// ---- voice.js ---------------------------------------------------------------------------------------

describe('voice factory', () => {
  const withVoice = (voice, keys) => ({ ...SETTINGS, voice: { ...SETTINGS.voice, ...voice }, ...(keys ? { keys: { ...SETTINGS.keys, ...keys } } : {}) });

  test('selectVoiceProvider: openrouter by default (Cora_KEY, gpt-audio-mini), realtime alternative, refusals', () => {
    assert.equal(VOICE_DEFAULTS.provider, 'openrouter');
    assert.equal(VOICE_DEFAULTS.tts_model, 'openai/gpt-audio-mini');
    assert.deepEqual(selectVoiceProvider(SETTINGS), {
      provider: 'openrouter',
      keyRole: 'openrouter',
      keyName: 'Cora_KEY',
      tts_model: 'openai/gpt-audio-mini',
      stt_model: SETTINGS.voice.stt_model,
      voice: 'shimmer',
    });
    assert.equal(selectVoiceProvider({ keys: SETTINGS.keys }).provider, 'openrouter', 'no voice section -> openrouter');
    const rt = selectVoiceProvider(withVoice({ provider: 'openai_realtime' }));
    assert.deepEqual([rt.keyName, rt.tts_model, rt.stt_model], ['OPENAI_API_KEY', SETTINGS.realtime.model, SETTINGS.realtime.transcribe_model]);
    assert.throws(() => selectVoiceProvider(withVoice({ provider: 'elevenlabs' })), /unknown provider "elevenlabs"/);
    assert.throws(() => selectVoiceProvider(withVoice({}, { openrouter: 'OPENROUTER_API_KEY' })), /shared OPENROUTER_API_KEY/);
  });

  test('createVoice(openrouter): OrEars + OrMouth, connect() = key check + STT anchor render, stats', async () => {
    const fetch = mockFetch((call) =>
      call.method === 'GET' ? json(200, { data: { usage: 0.2 } }) : sseResponse(ttsItems('Итак.', [Buffer.alloc(9600, 3)]), { signal: call.signal }),
    );
    const log = memLog();
    const voice = createVoice({ settings: SETTINGS, keys: { openrouter: KEY }, fetch, log, people: PEOPLE });
    assert.equal(voice.kind, 'openrouter');
    assert.ok(voice.ears instanceof OrEars);
    assert.ok(voice.mouth instanceof OrMouth);
    assert.equal(voice.cacheKey, voice.mouth.cacheKey);
    assert.equal(voice.instructions, buildInstructions(SETTINGS));
    const info = await voice.connect();
    assert.equal(info.ok, true);
    assert.deepEqual(info.anchor, { text: 'Итак.', ms: 200 });
    assert.deepEqual(voice.ears.anchor, info.anchor);
    assert.equal(fetch.calls[0].headers.Authorization, `Bearer ${KEY}`);
    assert.equal(JSON.parse(fetch.calls[1].body.messages[1].content).response_text, 'Итак.');
    await voice.connect();
    assert.equal(fetch.calls.length, 3, 'the anchor is rendered once');
    assert.equal(voice.stats().kind, 'openrouter');
    assert.ok(log.records.some((r) => r.type === 'voice.init' && r.key === 'Cora_KEY'));
    assert.ok(!JSON.stringify(log.records).includes(KEY));
    await voice.close();

    const noAnchor = createVoice({ settings: { ...SETTINGS, voice: { ...SETTINGS.voice, stt_anchor: false } }, keys: { openrouter: KEY }, fetch: mockFetch(() => json(200, { data: {} })), people: PEOPLE });
    assert.equal((await noAnchor.connect()).anchor, null);
    await noAnchor.close();

    const denied = createVoice({ settings: SETTINGS, keys: { openrouter: KEY }, fetch: mockFetch(() => json(401, { error: { message: 'User not found.' } })), people: PEOPLE });
    await assert.rejects(denied.connect(), (err) => err.kind === 'auth');
    await denied.close();
  });

  test('createVoice(openai_realtime): WP3 Ears + Mouth on one RealtimeSession (not connected)', async () => {
    const voice = createVoice({ settings: withVoice({ provider: 'openai_realtime' }), keys: { openai: 'sk-test-0123456789' }, people: PEOPLE });
    assert.equal(voice.kind, 'openai_realtime');
    assert.ok(voice.ears instanceof Ears);
    assert.ok(voice.mouth instanceof Mouth);
    assert.equal(voice.session.state, 'idle');
    assert.match(voice.cacheKey, /^openai_realtime\|gpt-realtime/);
    await voice.close();
    assert.equal(voice.session.state, 'closed');
  });

  test('keys come from env by name when not given; a missing key is a readable error', () => {
    const env = { Cora_KEY: KEY };
    const voice = createVoice({ settings: SETTINGS, env, fetch: async () => json(200, {}), people: PEOPLE });
    assert.equal(voice.kind, 'openrouter');
    voice.close();
    assert.throws(() => createVoice({ settings: SETTINGS, env: {}, people: PEOPLE }), /missing key Cora_KEY/);
    const fromFn = createVoice({ settings: SETTINGS, keys: (role, name) => (role === 'openrouter' && name === 'Cora_KEY' ? KEY : null), fetch: async () => json(200, {}), people: PEOPLE });
    assert.equal(fromFn.kind, 'openrouter');
    fromFn.close();
  });

  test('both providers expose the same ears/mouth surface', async () => {
    const or = createVoice({ settings: SETTINGS, keys: { openrouter: KEY }, fetch: async () => json(200, {}), people: PEOPLE });
    const rt = createVoice({ settings: withVoice({ provider: 'openai_realtime' }), keys: { openai: 'sk-test-0123456789' }, people: PEOPLE });
    for (const v of [or, rt]) {
      for (const m of ['pushAudio', 'audioMsToWall', 'sweepItems', 'stats', 'close', 'on']) assert.equal(typeof v.ears[m], 'function', `${v.kind} ears.${m}`);
      assert.equal(typeof v.ears.speaking, 'boolean');
      assert.equal(typeof v.ears.audioMs, 'number');
      for (const m of ['say', 'renderClip', 'cancelAll', 'stats', 'close']) assert.equal(typeof v.mouth[m], 'function', `${v.kind} mouth.${m}`);
      assert.equal(typeof v.mouth.busy, 'boolean');
      for (const m of ['connect', 'close', 'stats']) assert.equal(typeof v[m], 'function');
      await v.close();
    }
  });
});
