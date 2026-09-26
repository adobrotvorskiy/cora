#!/usr/bin/env node
// Renders Cora's lines with the Yandex Realtime voice(s) straight to WAV — raw server audio,
// no page player/resampler in the path. For picking the voice: play the files and choose.
//
//   node tools/audition_yandex_rt.js [--voices alena,marina] [--text "…"] [--out _internal]
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { APP_ROOT, loadEnv, requireKey } from '../src/env.js';
import { loadSettings } from '../src/config.js';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    voices: { type: 'string', default: 'alena,marina' },
    text: { type: 'string', default: 'Доброе утро! Планы на день, по очереди. Серёжа, начнёшь? Ага, принято. Кто следующий? Всё, ребята, хорошего дня, дальше дев-синк, пока!' },
    out: { type: 'string', default: join(APP_ROOT, '_internal') },
  },
  strict: true,
});

loadEnv();
const settings = loadSettings();
const key = requireKey(settings.keys.yandex);
const folder = settings.yandex?.folder ?? requireKey(settings.keys.yandex_folder);
const MODEL = settings.yandex?.model ?? 'speech-realtime-250923';

function toWav(pcmChunks, rate) {
  const pcm = Buffer.concat(pcmChunks);
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(rate, 24); hdr.writeUInt32LE(rate * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}

for (const voice of values.voices.split(',').map((v) => v.trim()).filter(Boolean)) {
  const t0 = Date.now();
  const chunks = [];
  let failed = null;
  const ws = new WebSocket(`wss://ai.api.cloud.yandex.net/v1/realtime?model=gpt://${folder}/${MODEL}`, { headers: { Authorization: `Api-Key ${key}` }, handshakeTimeout: 15_000 });
  try {
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', output_modalities: ['audio'], audio: { input: { format: { type: 'audio/pcm', rate: 16000 }, turn_detection: { type: 'server_vad', silence_duration_ms: 500 } }, output: { format: { type: 'audio/pcm', rate: 16000 }, voice } } } }));
    const done = new Promise((res) => {
      ws.on('message', (d) => {
        const ev = JSON.parse(d.toString());
        if (ev.type === 'error') failed = ev.error?.message ?? 'error';
        if (ev.type === 'response.output_audio.delta') chunks.push(Buffer.from(ev.delta ?? '', 'base64'));
        if (ev.type === 'response.done') res();
      });
      setTimeout(res, 40_000); // a rejected voice may never answer: do not hang the batch
    });
    await new Promise((r) => {
      ws.on('message', (d) => { if (JSON.parse(d.toString()).type === 'session.updated') r(); });
      setTimeout(r, 10_000);
    });
    ws.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Произнеси ровно этот текст бодро, с улыбкой, как живая ведущая утреннего стендапа, без своих слов: «${values.text}»` }] } }));
    ws.send(JSON.stringify({ type: 'response.create' }));
    await done;
    if (failed || chunks.length === 0) {
      console.log(`${voice}: FAILED${failed ? ` — ${String(failed).slice(0, 120)}` : ' (no audio)'}`);
      ws.close();
      continue;
    }
    const file = join(values.out, `voice_${voice}.wav`);
    writeFileSync(file, toWav(chunks, 16000));
    console.log(`${voice}: ${(Buffer.concat(chunks).length / 32000).toFixed(1)} s, ${Date.now() - t0} ms -> ${file}`);
  } catch (e) {
    console.log(`${voice}: FAILED — ${String(e?.message ?? e).slice(0, 120)}`);
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}
process.exit(0);
