// yandex_cascade: SpeechKit mouth (fake fetch), SpeechKit ears (fake gRPC client), per-slot
// attribution, the capture worklet's per-track taps, the voice factory and the Yandex brain wiring.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { VOICE_PROVIDERS, createVoice, selectVoiceProvider } from '../../src/audio/voice.js';
import { VOICE_PROVIDERS as CONFIG_PROVIDERS, validateSettings } from '../../src/config.js';
import { createYandexEars, sessionOptions } from '../../src/audio/yandex_ears.js';
import { TTS_URL, createYandexMouth, toSpeechKitText } from '../../src/audio/yandex_mouth.js';
import { ElevenMouth } from '../../src/audio/eleven_mouth.js';
import { CAPTURE_WORKLET_SRC } from '../../src/browser/worklets.js';
import { resolveProvider } from '../../src/brain/client.js';
import { buildSystemPrompt, humanModelName, loadBrainAssets, playbookForMode } from '../../src/brain/prompt.js';
import { createAttribution } from '../../src/core/attribution.js';
import { createFloor } from '../../src/core/floor.js';
import { applySttFixes, interruptsHost, isOwnEcho, loadSttFixes } from '../../src/core/host.js';
import { isStartRequest } from '../../src/core/guards.js';

// ------------------------------------------------------------------------------------ mouth

/** fetch that answers utteranceSynthesis with NDJSON lines (split across reads on purpose). */
function ttsFetch(lines, { status = 200, calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (status !== 200) return new Response('{"error":{"message":"denied"}}', { status });
    const text = lines.map((l) => JSON.stringify(l)).join('\n');
    const cut = Math.floor(text.length / 2);
    const enc = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(text.slice(0, cut)));
        c.enqueue(enc.encode(text.slice(cut)));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  };
}
const chunk = (samples, v = 1000) => ({ result: { audioChunk: { data: Buffer.from(new Int16Array(samples).fill(v).buffer).toString('base64') } } });

describe('yandex mouth (SpeechKit TTS v3)', () => {
  test('say(): voice/role/speed hints, 24 kHz PCM, Api-Key + folder, audio as base64 then done', async () => {
    const calls = [];
    const mouth = createYandexMouth({ apiKey: 'test-api-key', folderId: 'b1f', tts: { voice: 'alena', role: 'good', speed: 1.1 }, fetch: ttsFetch([chunk(2400), chunk(1200)], { calls }) });
    const got = [];
    let start = null;
    let end = null;
    const r = await mouth.say('Всем привет!', { onAudio: (c) => got.push(c), onStart: (i) => (start = i), onEnd: (e) => (end = e) }).done;
    assert.equal(calls[0].url, TTS_URL);
    assert.equal(calls[0].init.headers.Authorization, 'Api-Key test-api-key');
    assert.equal(calls[0].init.headers['x-folder-id'], 'b1f');
    assert.deepEqual(calls[0].body.hints, [{ voice: 'alena' }, { role: 'good' }, { speed: 1.1 }]);
    assert.deepEqual(calls[0].body.outputAudioSpec, { rawAudio: { audioEncoding: 'LINEAR16_PCM', sampleRateHertz: 24000 } });
    assert.equal(calls[0].body.unsafeMode, undefined);
    assert.equal(got.length, 2);
    assert.equal(typeof got[0], 'string');
    assert.equal(r.status, 'completed');
    assert.equal(r.audio_ms, 150);
    assert.ok(Number.isFinite(start.ttfa_ms));
    assert.equal(end.status, 'completed');
    assert.equal(mouth.stats().completed, 1);
    assert.match(mouth.cacheKey, /^yandex_tts\|[0-9a-f]{12}$/);
  });

  test('format buffer, long text -> unsafeMode, renderClip concatenates, role null drops the hint', async () => {
    const calls = [];
    const mouth = createYandexMouth({ apiKey: 'k', tts: { role: null, speed: 1 }, fetch: ttsFetch([chunk(240), chunk(240)], { calls }) });
    const bufs = [];
    await mouth.say('а'.repeat(300), { format: 'buffer', onAudio: (b) => bufs.push(b) }).done;
    assert.ok(Buffer.isBuffer(bufs[0]));
    assert.equal(calls[0].body.unsafeMode, true);
    assert.deepEqual(calls[0].body.hints, [{ voice: 'alena' }]);
    assert.equal(calls[0].init.headers['x-folder-id'], undefined);
    const pcm = await mouth.renderClip('Итак.');
    assert.equal(pcm.length, 960);
    assert.notEqual(createYandexMouth({ apiKey: 'k', tts: { voice: 'marina' } }).cacheKey, mouth.cacheKey, 'another voice is another clip cache');
  });

  test('stress marks: U+0301 after a vowel becomes SpeechKit «+» before it', async () => {
    assert.equal(toSpeechKitText('Ти́ма, начнёшь?'), 'Т+има, начнёшь?');
    assert.equal(toSpeechKitText('Савва́ и Серёжа'), 'Савв+а и Серёжа');
    const calls = [];
    await createYandexMouth({ apiKey: 'k', fetch: ttsFetch([chunk(24)], { calls }) }).say('Ми́тя, привет').done;
    assert.equal(calls[0].body.text, 'М+итя, привет');
  });

  test('HTTP 403 -> failed with code auth; an error line fails the readout', async () => {
    const denied = createYandexMouth({ apiKey: 'k', fetch: ttsFetch([], { status: 403 }) });
    let end = null;
    await assert.rejects(denied.say('x', { onEnd: (e) => (end = e) }).done, (e) => e.code === 'auth');
    assert.equal(end.status, 'failed');
    const broken = createYandexMouth({ apiKey: 'k', fetch: ttsFetch([chunk(240), { error: { message: 'boom' } }]) });
    await assert.rejects(broken.say('x').done, /boom/);
    assert.equal(broken.stats().failed, 1);
  });

  test('cancel(): the request is aborted and the readout ends as cancelled', async () => {
    const fetch = (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    const mouth = createYandexMouth({ apiKey: 'k', fetch });
    let end = null;
    const h = mouth.say('Долгая фраза', { onEnd: (e) => (end = e) });
    await h.cancel();
    const r = await h.done;
    assert.equal(r.status, 'cancelled');
    assert.equal(end.status, 'cancelled');
    assert.equal(mouth.stats().cancelled, 1);
  });
});

// ------------------------------------------------------------------------------------- ears

class FakeCall extends EventEmitter {
  constructor(headers) {
    super();
    this.headers = headers;
    this.writes = [];
    this.ended = false;
  }
  write(req) {
    this.writes.push(req);
  }
  end() {
    this.ended = true;
  }
}

function fakeEars(opts = {}) {
  const calls = [];
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const ears = createYandexEars({
    apiKey: 'test-api-key',
    folderId: 'b1f',
    now: clock.now,
    tickMs: 5,
    clientFactory: async () => ({
      open: (headers) => {
        const c = new FakeCall(headers);
        calls.push(c);
        return c;
      },
      close: () => {},
    }),
    ...opts,
  });
  return { ears, calls, clock };
}
const pcm100 = (v = 3000) => new Int16Array(2400).fill(v); // 100 ms at 24 kHz

describe('yandex ears (SpeechKit STT v3, a session per track)', () => {
  test('session options: 16 kHz LINEAR16, ru-RU, EOU HIGH with the pause hint', () => {
    const o = sessionOptions({});
    assert.equal(o.recognition_model.audio_format.raw_audio.sample_rate_hertz, 16000);
    assert.deepEqual(o.recognition_model.language_restriction.language_code, ['ru-RU']);
    assert.deepEqual(o.eou_classifier.default_classifier, { type: 'HIGH', max_pause_between_words_hint_ms: 500 });
  });

  test('one session per track: options first, 24->16 kHz chunks, auth + folder metadata', async () => {
    const { ears, calls } = fakeEars();
    ears.pushAudio(pcm100(), 'trA');
    ears.pushAudio(pcm100(), 'trB');
    ears.pushAudio(pcm100(), 'trA');
    await sleep(5);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].headers, { authorization: 'Api-Key test-api-key', 'x-folder-id': 'b1f' });
    assert.ok(calls[0].writes[0].session_options, 'options first');
    const chunks = calls[0].writes.filter((w) => w.chunk);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].chunk.data.length, 3200, '100 ms at 16 kHz');
    assert.equal(ears.stats().sessions_opened, 2);
    ears.close();
    assert.ok(calls.every((c) => c.ended));
  });

  test('after a phrase: tailMs of zero PCM (not silence_chunk), then the session idles out', async () => {
    const { ears, calls, clock } = fakeEars({ gapMs: 150, tailMs: 600, idleCloseMs: 2000 });
    ears.pushAudio(pcm100(), 'trA');
    await sleep(5);
    clock.advance(400);
    await sleep(20);
    clock.advance(400);
    await sleep(20);
    const tail = calls[0].writes.filter((w) => w.chunk).slice(1);
    assert.ok(tail.length >= 1);
    assert.ok(tail.every((w) => w.chunk.data.every((b) => b === 0)), 'zeros');
    assert.equal(tail.reduce((s, w) => s + w.chunk.data.length, 0), 600 * 32, 'exactly tailMs of 16 kHz PCM');
    assert.ok(!calls[0].writes.some((w) => w.silence_chunk));
    clock.advance(2000);
    await sleep(20);
    assert.equal(calls[0].ended, true);
    assert.equal(ears.stats().open, 0);
    ears.close();
  });

  test('partial -> stt_delta, final -> stt_final with wall times from the audio timeline', async () => {
    const { ears, calls, clock } = fakeEars();
    const deltas = [];
    const finals = [];
    ears.on('stt_delta', (d) => deltas.push(d));
    ears.on('stt_final', (f) => finals.push(f));
    const t0 = clock.now();
    for (let i = 0; i < 5; i++) {
      ears.pushAudio(pcm100(), 'trA');
      clock.advance(100);
    }
    await sleep(5);
    const call = calls[0];
    call.emit('data', { partial: { alternatives: [{ text: 'кора при' }] } });
    call.emit('data', { final: { alternatives: [{ text: 'кора привет', end_time_ms: 400 }] } }); // start 0 omitted by proto3
    call.emit('data', { final: { alternatives: [{ text: '' }] } }); // empty finals after EOU are dropped
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0].track_id, 'trA');
    assert.equal(deltas[0].so_far, 'кора при');
    assert.equal(finals.length, 1);
    assert.equal(finals[0].text, 'кора привет');
    assert.equal(finals[0].track_id, 'trA');
    assert.equal(finals[0].t_speech_start, t0 - 100, 'first chunk arrived at its end');
    assert.equal(finals[0].t_speech_end, t0 + 300);
    assert.notEqual(finals[0].item_id, deltas[0].item_id.replace(/\.\d+$/, '.0'));
    ears.close();
  });

  test('a stream error is reported once and the next chunk opens a new session', async () => {
    const { ears, calls } = fakeEars();
    const errors = [];
    ears.on('stt_error', (e) => errors.push(e));
    ears.pushAudio(pcm100(), 'trA');
    await sleep(5);
    calls[0].emit('error', Object.assign(new Error('14 UNAVAILABLE'), { code: 14 }));
    calls[0].emit('end');
    assert.equal(errors.length, 1);
    ears.pushAudio(pcm100(), 'trA');
    await sleep(5);
    assert.equal(calls.length, 2);
    // our own end() surfaces as CANCELLED (code 1): not an error
    ears.close();
    calls[1].emit('error', Object.assign(new Error('1 CANCELLED'), { code: 1 }));
    assert.equal(errors.length, 1);
  });
});

// ------------------------------------------------------------------------------ attribution

function attr(opts = {}) {
  let t = 100_000;
  const events = [];
  const chorus = [];
  const a = createAttribution({ state: { idForName: (n) => n }, log: { event: (type, f) => events.push({ type, ...f }) }, now: () => t, onChorus: (c) => chorus.push(c), ...opts });
  const clock = { set: (x) => (t = x), advance: (ms) => (t += ms), now: () => t };
  /** One 100 ms chunk of levels: loud tracks at -30 dBFS, the others silent. */
  const levels = (loud, all = ['A', 'B']) => a.onLevels(all.map((id) => ({ track_id: id, frames: loud.includes(id) ? [-30, -30] : [-100, -100] })), [-30, -30], { t: clock.now() });
  return { a, clock, levels, events, chorus };
}

describe('attribution per SFU slot', () => {
  test('one DOM speaker names the slot (high) and becomes its owner; no DOM later -> owner (med)', () => {
    const { a, clock, levels } = attr();
    a.onDomSpeakers(['lesha'], { t: clock.now() });
    for (let i = 0; i < 10; i++) {
      clock.advance(100);
      levels(['A']);
    }
    a.onDomSpeakers([], { t: clock.now() });
    assert.deepEqual(a.speakerForTrack({ track_id: 'A', t_start: 100_100, t_end: clock.now() }), { id: 'lesha', conf: 'high', via: 'dom' });
    clock.advance(20_000);
    const later = a.speakerForTrack({ track_id: 'A', t_start: clock.now() - 1500, t_end: clock.now() });
    assert.equal(later.id, 'lesha');
    assert.equal(later.conf, 'med');
    assert.equal(later.via, 'owner');
    assert.equal(a.speakerForTrack({ track_id: 'B', t_start: clock.now() - 1500, t_end: clock.now() }).via, 'none');
  });

  test('two people over each other: the DOM marker that lines up with THIS slot wins', () => {
    const { a, clock, levels } = attr();
    // roma talks on B from the start; lesha joins on A a second later; roma stops first
    a.onDomSpeakers(['roma'], { t: clock.now() });
    for (let i = 0; i < 10; i++) {
      clock.advance(100);
      levels(['B']);
    }
    a.onDomSpeakers(['roma', 'lesha'], { t: clock.now() });
    for (let i = 0; i < 10; i++) {
      clock.advance(100);
      levels(['A', 'B']);
    }
    a.onDomSpeakers(['lesha'], { t: clock.now() });
    for (let i = 0; i < 15; i++) {
      clock.advance(100);
      levels(['A']);
    }
    a.onDomSpeakers([], { t: clock.now() });
    const onA = a.speakerForTrack({ track_id: 'A', t_start: 101_000, t_end: clock.now() });
    const onB = a.speakerForTrack({ track_id: 'B', t_start: 100_000, t_end: 102_000 });
    assert.equal(onA.id, 'lesha');
    assert.equal(onB.id, 'roma');
    assert.equal(onA.via, 'dom_levels');
    assert.deepEqual(onA.alt, ['roma']);
  });

  test('two slots loud for chorusMs -> one chorus note with the DOM names, rate-limited', () => {
    const { a, clock, levels, chorus, events } = attr();
    a.onDomSpeakers(['roma', 'lesha'], { t: clock.now() });
    for (let i = 0; i < 12; i++) {
      clock.advance(100);
      levels(['A', 'B']);
    }
    assert.equal(chorus.length, 1);
    assert.deepEqual(chorus[0].ids.sort(), ['lesha', 'roma']);
    assert.ok(events.some((e) => e.type === 'attr.chorus'));
    for (let i = 0; i < 20; i++) {
      clock.advance(100);
      levels(['A', 'B']);
    }
    assert.equal(chorus.length, 1, 'no second note within chorusGapMs');
  });
});

// --------------------------------------------------------------------------- capture worklet

function loadCapture(trackTaps) {
  const posts = [];
  class AudioWorkletProcessor {
    constructor() {
      this.port = { postMessage: (m) => posts.push(m), onmessage: null };
    }
  }
  let Cls = null;
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', 'currentTime', CAPTURE_WORKLET_SRC)(AudioWorkletProcessor, (n, c) => (Cls = c), 24000, 0);
  const proc = new Cls({ numberOfInputs: 2, processorOptions: { chunkFrames: 2400, levelFrames: 1200, trackTaps } });
  proc.port.onmessage({ data: { type: 'map', slot: 0, id: 'trA' } });
  proc.port.onmessage({ data: { type: 'map', slot: 1, id: 'trB' } });
  /** Render one 100 ms chunk with slot 0 at amplitude a0 and slot 1 at a1. */
  const chunkOf = (a0, a1) => {
    for (let q = 0; q < 2400 / 120; q++) {
      const inA = [new Float32Array(120).fill(a0)];
      const inB = [new Float32Array(120).fill(a1)];
      proc.process([inA, inB], [[new Float32Array(120)]]);
    }
  };
  const taps = () => posts.filter((p) => p.type === 'track_chunk');
  return { chunkOf, taps, posts };
}

describe('capture worklet: per-track taps', () => {
  test('off unless trackTaps: only the mix chunk is posted', () => {
    const w = loadCapture(false);
    w.chunkOf(0.2, 0.2);
    assert.equal(w.taps().length, 0);
    assert.equal(w.posts.filter((p) => p.type === 'chunk').length, 1);
  });

  test('a slot is sent only around its speech: pre-roll chunk, speech, 3-chunk tail', () => {
    const w = loadCapture(true);
    w.chunkOf(0.0005, 0); // quiet (kept as pre-roll)
    w.chunkOf(0.0005, 0);
    assert.equal(w.taps().length, 0);
    w.chunkOf(0.2, 0); // speech on A: pre-roll + this chunk
    w.chunkOf(0.2, 0);
    for (let i = 0; i < 5; i++) w.chunkOf(0, 0); // tail: 3 chunks, then nothing
    const a = w.taps().filter((p) => p.track_id === 'trA');
    assert.equal(a.length, 1 + 2 + 3);
    assert.equal(w.taps().filter((p) => p.track_id === 'trB').length, 0, 'the silent slot never goes out');
    assert.equal(new Int16Array(a[1].pcm)[0], Math.round(0.2 * 32767) | 0);
  });

  test('samples beyond full scale are clipped, not wrapped', () => {
    const w = loadCapture(true);
    w.chunkOf(1.5, 0);
    const pcm = new Int16Array(w.taps()[0].pcm);
    assert.equal(pcm[0], 32767);
  });
});

// ------------------------------------------------------------------------------ voice + brain

const CASCADE = {
  voice: { provider: 'yandex_cascade', eleven_voice_id: 'YjESejviApN7SHrbfnA2' },
  keys: { openai: 'OPENAI_API_KEY', openrouter: 'Cora_KEY', elevenlabs: 'Elevenlabs_Cora_API', yandex: 'key', yandex_folder: 'id', telegram: 'TELEGRAM_BOT_TOKEN' },
  yandex: { folder: 'b1folder', tts: { voice: 'alena', role: 'good', speed: 1.1 } },
  brain: { provider: 'yandex', yandex_model: 'aliceai-llm-flash/latest', openrouter_model: 'google/gemini-3.5-flash-lite' },
};

describe('voice factory + brain for yandex_cascade', () => {
  test('settings validation knows every voice provider (config.js keeps its own copy of the list)', () => {
    assert.deepEqual([...CONFIG_PROVIDERS], [...VOICE_PROVIDERS]);
    assert.deepEqual(validateSettings({ ...CASCADE, yandex: { ...CASCADE.yandex, cascade_mouth: 'nope' } }).errors.filter((e) => /yandex|provider/.test(e)), ['yandex.cascade_mouth must be speechkit|elevenlabs']);
    assert.ok(validateSettings({ ...CASCADE, yandex: {} }).errors.some((e) => /yandex\.folder/.test(e)));
  });

  test('selection: SpeechKit mouth by default, folder required, ElevenLabs on request', () => {
    const sel = selectVoiceProvider(CASCADE);
    assert.equal(sel.keyName, 'key');
    assert.equal(sel.folder, 'b1folder');
    assert.equal(sel.mouth, 'speechkit');
    assert.equal(sel.voice, 'alena/good x1.1');
    assert.throws(() => selectVoiceProvider({ ...CASCADE, yandex: {} }), /yandex\.folder/);
    assert.equal(selectVoiceProvider({ ...CASCADE, yandex: { ...CASCADE.yandex, cascade_mouth: 'elevenlabs' } }).mouth, 'elevenlabs');
  });

  test('createVoice: SpeechKit ears + mouth; connect() renders one short clip', async () => {
    const calls = [];
    const v = createVoice({ settings: CASCADE, keys: { yandex: 'test-api-key' }, fetch: ttsFetch([chunk(2400)], { calls }), people: [] });
    assert.equal(v.kind, 'yandex_cascade');
    assert.equal(typeof v.ears.pushAudio, 'function');
    assert.match(v.cacheKey, /^yandex_tts\|/);
    const info = await v.connect();
    assert.equal(info.tts_bytes, 4800);
    assert.equal(calls[0].body.text, 'Итак.');
    await v.close();
    const eleven = createVoice({ settings: { ...CASCADE, yandex: { ...CASCADE.yandex, cascade_mouth: 'elevenlabs' } }, keys: { yandex: 'test-api-key' }, env: { Elevenlabs_Cora_API: 'xi-test' }, people: [] });
    assert.ok(eleven.mouth instanceof ElevenMouth);
    await eleven.close();
  });

  test('brain: Yandex AI Studio endpoint, gpt://<folder>/<model>, Кора names her stack', () => {
    const p = resolveProvider(CASCADE, { env: { key: 'test-api-key' } });
    assert.equal(p.provider, 'yandex');
    assert.equal(p.url, 'https://ai.api.cloud.yandex.net/v1/chat/completions');
    assert.equal(p.model, 'gpt://b1folder/aliceai-llm-flash/latest');
    assert.equal(humanModelName(p.model), 'Alice AI Flash от Яндекса');
    const prompt = buildSystemPrompt({ personaBlock: 'Голос и слух от {voice_vendor}, решения принимает {brain_model}.', brainModelHuman: 'Alice AI Flash от Яндекса', voiceVendorHuman: 'Яндекс SpeechKit' });
    assert.match(prompt, /Голос и слух от Яндекс SpeechKit, решения принимает Alice AI Flash от Яндекса\./);
    assert.match(buildSystemPrompt({ personaBlock: 'от {voice_vendor}' }), /от OpenAI/, 'other providers keep OpenAI');
  });
});

// ------------------------------------------------------------------ turn-taking in the cascade

describe('cascade turn-taking: speech, not loudness', () => {
  test("floor activity 'speech': a loud room without recognized speech neither blocks nor interrupts her", () => {
    let t = 50_000;
    const bargeIns = [];
    const floor = createFloor({ settings: { floor: { activity: 'speech', barge_in_energy: false } }, now: () => t });
    floor.on('barge_in', (e) => bargeIns.push(e));
    for (let i = 0; i < 30; i++) {
      t += 100;
      floor.onLevels([-20, -20], { t });
    }
    assert.equal(floor.canSpeak(t), true, 'noise / a TV / an open mic at home');
    floor.setHostSpeaking(true, { t });
    for (let i = 0; i < 10; i++) {
      t += 100;
      floor.onLevels([-15, -15], { t });
    }
    assert.equal(bargeIns.length, 0);
    assert.equal(floor.bargeInFrom('stt', { t }), true, 'recognized speech does interrupt');
    assert.equal(bargeIns[0].source, 'stt');
    floor.setHostSpeaking(false, { t });
  });

  test("floor activity 'speech': busy from the first partial to the final, then silence_ms", () => {
    let t = 50_000;
    const floor = createFloor({ settings: { floor: { activity: 'speech', silence_ms: 700 } }, now: () => t });
    floor.onVad({ type: 'start', t });
    t += 2000;
    assert.equal(floor.canSpeak(t), false);
    floor.onVad({ type: 'stop', t });
    t += 500;
    assert.equal(floor.canSpeak(t), false, 'right after the phrase');
    t += 300;
    assert.equal(floor.canSpeak(t), true);
  });

  test('echo filter: her own words from someone’s speakers are not speech, questions and «подожди» are', () => {
    const said = ['Привет! Я тут, готова начать. Ждём Ярослава, начнём, как только он подключится.'];
    assert.equal(isOwnEcho('привет я тут готова начать', said), true);
    assert.equal(isOwnEcho('ждём ярослава', said), true);
    assert.equal(isOwnEcho('кора а сколько времени', said), false);
    assert.equal(interruptsHost('привет я тут готова', said), false);
    assert.equal(interruptsHost('угу', said), false, 'one word of noise');
    assert.equal(interruptsHost('подожди', said), true);
    assert.equal(interruptsHost('кора а сколько времени', said), true);
  });
});

describe('on-demand brain prompt and start phrases', () => {
  test('playbookForMode keeps one variant of the tagged sections and drops the tags', () => {
    const md = '# P\n\nintro\n\n(note about [по расписанию] and [по требованию])\n\n## Старт [по расписанию]\n\n- В 10:00 начинай\n\n## Старт [по требованию]\n\n- По просьбе\n\n## Финал\n\n- Прощайся';
    const on = playbookForMode(md, { scheduled: false });
    assert.match(on, /## Старт\n\n- По просьбе/);
    assert.doesNotMatch(on, /10:00|\[по /);
    assert.match(on, /## Финал/);
    const sc = playbookForMode(md, { scheduled: true });
    assert.match(sc, /## Старт\n\n- В 10:00 начинай/);
    assert.doesNotMatch(sc, /По просьбе|\[по /);
  });

  test('on-demand prompt from the real config: no clock, no «ждём Ярослава», start examples by request', () => {
    const assets = loadBrainAssets();
    const on = buildSystemPrompt({ ...assets, dayMode: 'daily_plans', scheduled: false });
    assert.deepEqual(on.match(/10:0[02]\b|10:2[8]\b|10:3[05]\b|[Жж]дём Ярослава|В 10:00|До 10:00/g), null);
    assert.match(on, /Кора, начинай/);
    assert.match(on, /^11\. Расписания нет/m);
    const sc = buildSystemPrompt({ ...assets, dayMode: 'daily_plans', scheduled: true });
    assert.match(sc, /В 10:00 Ярослав Орлов на связи/);
    assert.match(sc, /^11\. deadline\.soft/m);
  });

  test("DOM marker does not interrupt her in floor activity 'speech' (the host decides from the text)", () => {
    let t = 50_000;
    const floor = createFloor({ settings: { floor: { activity: 'speech' } }, now: () => t });
    const bargeIns = [];
    floor.on('barge_in', (e) => bargeIns.push(e));
    floor.setHostSpeaking(true, { t });
    floor.onDomSpeakers(['guest_1'], { t: (t += 300) });
    assert.equal(bargeIns.length, 0);
  });

  test('start requests in SpeechKit form: lower case, no punctuation, «начинать», «Корабль» fixed to «Кора»', () => {
    for (const t of ['кора начинай', 'кора поехали', 'кора давай начинать', 'кора запускай']) assert.equal(isStartRequest(t), true, t);
    assert.equal(isStartRequest('начинай'), false, 'no name — not to her');
    assert.equal(isStartRequest(applySttFixes('корабль начинай', loadSttFixes())), true);
  });
});
