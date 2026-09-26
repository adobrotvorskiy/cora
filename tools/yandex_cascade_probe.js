#!/usr/bin/env node
// Live probe of the yandex_cascade pipeline without a room (network; costs kopecks):
//   1. mouth: SpeechKit TTS renders two phrases (time to first audio);
//   2. ears: the two renders are streamed in real time on two "tracks" at once, like two Telemost
//      SFU slots with people talking over each other; each must come back as its own final;
//   3. brain: one Yandex AI Studio decision on a synthetic standup context.
//
//   node tools/yandex_cascade_probe.js [--no-brain] [--verbose]
//
// Key values are never printed. Uses settings (+ settings.local.json) exactly like the host.

import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createYandexEars } from '../src/audio/yandex_ears.js';
import { createYandexMouth } from '../src/audio/yandex_mouth.js';
import { createBrain } from '../src/brain/client.js';
import { buildContext } from '../src/brain/context.js';
import { loadBrainAssets } from '../src/brain/prompt.js';
import { loadSettings } from '../src/config.js';
import { loadEnv, requireKey } from '../src/env.js';

const PHRASES = {
  A: 'Кора, привет! Сегодня доделываю интеграцию с Телемостом, у меня всё.',
  B: 'А я вчера закрыл два бага и сегодня на ревью.',
};

async function main() {
  const { values } = parseArgs({ options: { 'no-brain': { type: 'boolean', default: false }, verbose: { type: 'boolean', short: 'v', default: false } } });
  loadEnv();
  const settings = loadSettings();
  const y = settings.yandex ?? {};
  if (!y.folder) throw new Error('settings.yandex.folder is not set (settings.local.json)');
  const apiKey = requireKey(settings.keys.yandex);
  const log = values.verbose ? { event: (type, f) => console.log(`   · ${type} ${JSON.stringify(f)}`) } : null;
  let failed = false;

  // 1. mouth
  const mouth = createYandexMouth({ apiKey, folderId: y.folder, tts: y.tts, log });
  const pcm = {};
  for (const [track, text] of Object.entries(PHRASES)) {
    const t0 = Date.now();
    let ttfa = null;
    const parts = [];
    const r = await mouth.say(text, { format: 'buffer', onStart: (i) => (ttfa = i.ttfa_ms), onAudio: (b) => parts.push(b) }).done;
    pcm[track] = Buffer.concat(parts);
    console.log(`mouth  ${track}: ${r.status}, first audio ${ttfa} ms, total ${Date.now() - t0} ms, ${r.audio_ms} ms of speech (${mouth.instructions})`);
  }

  // 2. ears: both tracks at once, in real time (100 ms chunks, then silence like the page does)
  const ears = createYandexEars({ apiKey, folderId: y.folder, model: y.stt_model ?? 'general', ...(y.eou ? { eou: y.eou } : {}), ...(Number.isFinite(y.pause_hint_ms) ? { pauseHintMs: y.pause_hint_ms } : {}), log });
  const finals = [];
  const t0 = Date.now();
  let firstPartial = null;
  ears.on('stt_delta', (d) => {
    firstPartial ??= { track: d.track_id, ms: Date.now() - t0 };
    if (values.verbose) console.log(`   delta ${d.track_id}: ${d.so_far}`);
  });
  ears.on('stt_final', (f) => finals.push({ ...f, at: Date.now() - t0 }));
  ears.on('stt_error', (e) => {
    failed = true;
    console.log(`ears   ERROR ${e.track_id}: ${e.message}`);
  });
  const chunk = 2400 * 2; // 100 ms of 24 kHz PCM16
  const n = Math.max(pcm.A.length, pcm.B.length);
  const ends = {};
  for (let off = 0; off < n; off += chunk) {
    for (const track of ['A', 'B']) {
      const buf = pcm[track];
      if (off < buf.length) {
        const piece = buf.subarray(off, Math.min(off + chunk, buf.length));
        ears.pushAudio(new Int16Array(piece.buffer.slice(piece.byteOffset, piece.byteOffset + piece.byteLength)), track);
        if (off + chunk >= buf.length) ends[track] = Date.now() - t0;
      }
    }
    await sleep(100);
  }
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && new Set(finals.map((f) => f.track_id)).size < 2) await sleep(50);
  await sleep(700); // late extra finals
  ears.close();
  console.log(`ears   first partial ${firstPartial ? `${firstPartial.ms} ms (${firstPartial.track})` : 'none'}; stats ${JSON.stringify(ears.stats())}`);
  for (const f of finals) {
    console.log(`ears   final ${f.track_id} +${f.at - (ends[f.track_id] ?? 0)} ms after its audio ended: «${f.text}»`);
  }
  for (const track of ['A', 'B']) {
    if (!finals.some((f) => f.track_id === track)) {
      failed = true;
      console.log(`ears   MISSING a final for track ${track}`);
    }
  }

  // 3. brain
  if (!values['no-brain']) {
    const brainSettings = { ...settings, voice: { ...settings.voice, provider: 'yandex_cascade' }, brain: { ...settings.brain, provider: 'yandex', min_interval_ms: 0 } };
    const brain = createBrain({ settings: brainSettings, log, dayMode: 'daily_plans' });
    const context = buildContext({
      now: '10:00:05',
      day_mode: 'daily_plans',
      phase: 'waiting',
      // the whole roster, like the host's snapshot: only Сергей is on the call
      participants: loadBrainAssets().people.map((p) => ({ id: p.id, name: p.display ?? p.id, present: p.id === 'belozersky_s', ...(p.id === 'belozersky_s' ? { joined: '09:59:40', status: 'pending' } : { status: 'absent' }) })),
      speaker: null,
      host: { speaking: false, silent_mode: false, last_utterance: null, last_interrupted: false },
      plan: { next: null, then: [] },
      transcript_window: [{ t: '10:00:01', who: 'belozersky_s', text: 'Кора, привет! Ты меня слышишь?' }],
      recent_events: [{ t: '10:00:01', type: 'question_to_host', who: 'belozersky_s', how: 'name' }],
      trigger: 'question_to_host',
    });
    // the host prefetches the line once `text` is out of the stream (text_ms), before `plan` ends (latency_ms)
    const r = await brain.decide(context, { trigger: 'question_to_host', onText: (e) => mouth.prefetch?.(e.text) });
    console.log(`brain  ${brain.model}: ${r.status} ${r.latency_ms} ms (ttft ${r.ttft_ms ?? '-'}, text ${r.text_ms ?? '-'}) -> ${r.action?.action ?? '-'} «${r.action?.text ?? ''}»`);
    if (r.status !== 'ok') {
      failed = true;
      console.log(`brain  errors: ${JSON.stringify(r.errors ?? r.error ?? null)}`);
    } else if (r.action?.text) {
      let ttfa = null;
      await mouth.say(r.action.text, { format: 'buffer', onStart: (i) => (ttfa = i.ttfa_ms) }).done;
      console.log(`mouth  reply: first audio ${ttfa} ms after the decision (prefetch ${JSON.stringify(mouth.stats().prefetch)})`);
    }
    brain.close();
  }
  await mouth.close();
  console.log(failed ? 'RESULT FAIL' : 'RESULT OK');
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${e?.message ?? e}`);
    process.exit(1);
  },
);
