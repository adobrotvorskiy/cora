#!/usr/bin/env node
// Live self-test of the Realtime client (WP3): talks to api.openai.com, costs a few cents.
//
//   node tools/realtime_selftest.js [--verbose] [--skip-reconnect]
//
// (a) mouth.say: 3 short Russian phrases -> TTFA and verbatim match (PLAN: TTFA <= 1.0 s)
// (b) renderClip a phrase, feed it (1.5 s silence + clip + 1.5 s silence, then silence until the
//     transcript is final) into ears of the same session in 100 ms chunks at real-time pace ->
//     VAD start/stop, STT deltas/final, latency end-of-speech -> final; then item hygiene
// (c) cancel: long phrase cancelled 300 ms after the request (before audio) and 300 ms after the
//     first audio (mid-stream) -> status cancelled, no audio forwarded after cancel()
// (d) forced socket drop -> reconnect gap (PLAN: <= 3 s) + a readout on the new session
// Audio goes to _internal/selftest_*.wav, results to _internal/selftest_result.json, events to
// logs/rt_selftest_YYYY-MM-DD.jsonl. The key is read inside this process only (env.requireKey).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createEars } from '../src/audio/ears.js';
import { compareVerbatim, createMouth } from '../src/audio/mouth.js';
import { BYTES_PER_MS, RealtimeSession, SAMPLE_RATE, loadPeople } from '../src/audio/realtime_ws.js';
import { loadSettings } from '../src/config.js';
import { APP_ROOT, redactSecrets, requireKey } from '../src/env.js';
import { openLog } from '../src/log.js';

const OUT_DIR = join(APP_ROOT, '_internal');
const CHUNK_MS = 100;
const CHUNK_BYTES = CHUNK_MS * BYTES_PER_MS;
const PAD_MS = 1500;
const SAY_PHRASES = [
  'Доброе утро! Начинаем стендап.',
  'Ярослав, тебе слово: какие планы на день?',
  'Спасибо всем, хорошего дня! Передаю слово на дев-синк.',
];
const STT_PHRASE = 'Всем привет. Вчера закончил интеграцию с трекером, сегодня делаю отчёт для Орлова. У меня всё.';
const LONG_PHRASE = 'Доброе утро, коллеги! Сегодня вторник, поэтому рассказываем планы на день. Начнём с Ярослава, потом пойдём по кругу, а в самом конце я передам слово на дев-синк.';
const TTFA_LIMIT_MS = 1000;
const STT_LATENCY_LIMIT_MS = 3000;
const RECONNECT_LIMIT_MS = 3000;

const { values: args } = parseArgs({
  options: { verbose: { type: 'boolean', short: 'v', default: false }, 'skip-reconnect': { type: 'boolean', default: false } },
});

const rows = [];
const result = { started: new Date().toISOString(), rows, notes: [] };
const row = (name, pass, details, data = {}) => {
  rows.push({ name, pass, details, ...data });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: ${details}`);
};
const sec = (ms) => (ms == null ? '?' : `${(ms / 1000).toFixed(2)} s`);

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const settings = loadSettings();
  const log = openLog({ name: 'rt_selftest', verbose: args.verbose });
  const people = loadPeople();
  const session = new RealtimeSession({ settings, apiKey: requireKey(settings.keys.openai), people, log });
  const mouth = createMouth(session, { log });
  const ears = makeEars(session, log);
  try {
    // ---- connect ------------------------------------------------------------------------------
    const info = await session.connect();
    const echo = session.echo ?? {};
    const tr = echo.audio?.input?.transcription ?? {};
    const td = echo.audio?.input?.turn_detection ?? {};
    result.session = {
      model: echo.model,
      voice: echo.audio?.output?.voice,
      speed: echo.audio?.output?.speed,
      reasoning: echo.reasoning,
      transcription: { model: tr.model, languages: tr.languages, prompt_chars: tr.prompt?.length ?? 0, keywords_echoed: 'keywords' in tr },
      turn_detection: td,
      noise_reduction: echo.audio?.input?.noise_reduction,
      people: people.length,
      dropped_fields: info.dropped_fields,
    };
    row(
      'connect + session.update',
      true,
      `${info.connect_ms} ms, ${echo.model}/${echo.audio?.output?.voice}, stt ${tr.model} ${JSON.stringify(tr.languages)}, vad ${td.type}/${td.eagerness}, create_response=${td.create_response}; dropped fields: ${info.dropped_fields.length ? info.dropped_fields.join(', ') : 'none'}; keywords echoed: ${'keywords' in tr}`,
    );

    await testSay(mouth);
    await testStt(mouth, ears);
    await testCancel(mouth);
    if (!args['skip-reconnect']) await testReconnect(session, mouth);

    result.usage = session.stats().usage;
    result.ears = ears.stats();
    result.mouth = mouth.stats();
  } catch (err) {
    row('fatal', false, redactSecrets(err?.message ?? String(err)));
  } finally {
    ears.close();
    mouth.close();
    await session.close();
    log.close();
    result.log = log.path;
  }
}

function makeEars(session, log) {
  // manual hygiene in (b): items younger than 1 s are kept, the timer never fires on its own
  return createEars(session, { log, itemMaxAgeMs: 1000, hygieneIntervalMs: 3_600_000 });
}

// (a) three short readouts -----------------------------------------------------------------------
async function testSay(mouth) {
  for (const [i, text] of SAY_PHRASES.entries()) {
    const chunks = [];
    const r = await mouth.say(text, { format: 'buffer', onAudio: (b) => chunks.push(b), meta: { test: `say${i + 1}` } }).done;
    writeWav(join(OUT_DIR, `selftest_say_${i + 1}.wav`), Buffer.concat(chunks));
    const pass = r.status === 'completed' && r.ttfa_ms != null && r.ttfa_ms <= TTFA_LIMIT_MS && r.verbatim === true;
    row(
      `say #${i + 1}`,
      pass,
      `${r.status}, TTFA ${r.ttfa_ms} ms, audio ${sec(r.audio_ms)} in ${chunks.length} deltas (first ${chunks[0]?.length ?? 0} B), verbatim ${r.verbatim ? 'yes' : `NO: «${r.transcript}»`}`,
      { ttfa_ms: r.ttfa_ms, audio_ms: r.audio_ms, verbatim: r.verbatim, text, transcript: r.transcript, usage: r.usage },
    );
  }
}

// (b) rendered clip -> ears at real-time pace ------------------------------------------------------
async function testStt(mouth, ears) {
  const clip = await mouth.renderClip(STT_PHRASE, { withInfo: true, meta: { test: 'stt_clip' } });
  writeWav(join(OUT_DIR, 'selftest_clip.wav'), clip.pcm);
  const clipMs = clip.pcm.length / BYTES_PER_MS;
  const stream = Buffer.concat([Buffer.alloc(PAD_MS * BYTES_PER_MS), clip.pcm, Buffer.alloc(PAD_MS * BYTES_PER_MS)]);
  writeWav(join(OUT_DIR, 'selftest_stt_input.wav'), stream);

  const vad = [];
  const deltas = [];
  const finals = [];
  const onVad = (e) => vad.push(e);
  const onDelta = (e) => deltas.push(e);
  const onFinal = (e) => finals.push(e);
  ears.on('vad', onVad);
  ears.on('stt_delta', onDelta);
  ears.on('stt_final', onFinal);

  const base = ears.audioMs; // audio already written to this server session (0 here)
  const t0 = performance.now();
  const maxChunks = Math.ceil(stream.length / CHUNK_BYTES) + 100; // + 10 s of silence at most
  let i = 0;
  for (; i < maxChunks; i++) {
    const wait = t0 + (i + 1) * CHUNK_MS - performance.now(); // chunk i is "captured" at its end
    if (wait > 0) await sleep(wait);
    const off = i * CHUNK_BYTES;
    let chunk = off < stream.length ? stream.subarray(off, off + CHUNK_BYTES) : Buffer.alloc(CHUNK_BYTES);
    if (chunk.length < CHUNK_BYTES) chunk = Buffer.concat([chunk, Buffer.alloc(CHUNK_BYTES - chunk.length)]);
    ears.pushAudio(chunk);
    const streamDone = off + CHUNK_BYTES >= stream.length;
    const stops = vad.filter((v) => v.type === 'stop').length;
    if (streamDone && finals.length > 0 && !ears.speaking && finals.length >= stops) break;
  }
  await sleep(300); // late deltas/finals
  ears.off('vad', onVad);
  ears.off('stt_delta', onDelta);
  ears.off('stt_final', onFinal);

  const wallClipStart = ears.audioMsToWall(base + PAD_MS);
  const wallClipEnd = ears.audioMsToWall(base + PAD_MS + clipMs);
  const start = vad.find((v) => v.type === 'start');
  const stops = vad.filter((v) => v.type === 'stop');
  const lastStop = stops.at(-1);
  const lastFinal = finals.at(-1);
  const text = finals.map((f) => f.text).join(' ').trim();
  const cmp = compareVerbatim(STT_PHRASE, text);
  const endToFinal = lastFinal && wallClipEnd != null ? lastFinal.t - wallClipEnd : null;
  const deltasBeforeStop = lastStop ? deltas.filter((d) => d.t < lastStop.t_rx).length : 0;
  const firstDeltaAfterStart = deltas.length && wallClipStart != null ? deltas[0].t - wallClipStart : null;
  const data = {
    clip_ms: Math.round(clipMs),
    fed_ms: i * CHUNK_MS,
    vad: vad.map((v) => ({ type: v.type, audio_ms: v.audio_ms - base, lag_ms: v.t_rx - v.t, item_id: v.item_id })),
    vad_start_vs_clip_ms: start ? Math.round(start.audio_ms - base - PAD_MS) : null,
    vad_stop_vs_clip_end_ms: lastStop ? Math.round(lastStop.audio_ms - base - PAD_MS - clipMs) : null,
    vad_stop_event_lag_ms: lastStop ? lastStop.t_rx - lastStop.t : null,
    deltas: deltas.length,
    deltas_before_vad_stop: deltasBeforeStop,
    first_delta_after_speech_start_ms: firstDeltaAfterStart,
    finals: finals.map((f) => ({ text: f.text, latency_from_vad_stop_ms: f.latency_ms })),
    end_of_speech_to_final_ms: endToFinal,
    similarity: cmp.similarity,
    text,
  };
  result.stt = data;
  row(
    'stt: vad',
    Boolean(start && lastStop),
    start && lastStop
      ? `start ${sec(start.audio_ms - base)} (clip starts ${sec(PAD_MS)}, ${data.vad_start_vs_clip_ms >= 0 ? '+' : ''}${data.vad_start_vs_clip_ms} ms), stop ${sec(lastStop.audio_ms - base)} (clip ends ${sec(PAD_MS + clipMs)}, +${data.vad_stop_vs_clip_end_ms} ms), ${stops.length} turn(s), stop event ${data.vad_stop_event_lag_ms} ms after the fact`
      : `vad events: ${JSON.stringify(data.vad)}`,
    data,
  );
  row(
    'stt: transcript',
    finals.length > 0 && cmp.similarity >= 0.75,
    `«${text}» similarity ${cmp.similarity}; ${deltas.length} deltas (${deltasBeforeStop} before VAD stop, first ${firstDeltaAfterStart ?? '?'} ms after speech start)`,
  );
  row(
    'stt: latency end-of-speech -> final',
    endToFinal != null && endToFinal <= STT_LATENCY_LIMIT_MS,
    `${endToFinal ?? '?'} ms after the clip ended (${lastFinal?.latency_ms ?? '?'} ms after VAD stop)`,
  );

  // hygiene: every committed user item of this test is deleted (items are now > 1 s old)
  await sleep(1100);
  const before = ears.stats().items_deleted;
  const tracked = ears.stats().items_tracked;
  const sent = ears.sweepItems();
  const deadline = Date.now() + 3000;
  while (ears.stats().items_deleted - before < sent && Date.now() < deadline) await sleep(50);
  const deleted = ears.stats().items_deleted - before;
  row('stt: item hygiene', tracked > 0 && deleted === sent && ears.stats().delete_errors === 0, `${tracked} committed item(s), ${sent} delete(s) sent, ${deleted} confirmed, ${ears.stats().delete_errors} error(s)`);
}

// (c) cancel ---------------------------------------------------------------------------------------
async function testCancel(mouth) {
  // c1: 300 ms after the request (TTFA ~0.85 s, so usually before any audio)
  {
    let cancelled = false;
    let before = 0;
    let after = 0;
    const h = mouth.say(LONG_PHRASE, {
      format: 'buffer',
      meta: { test: 'cancel_300ms' },
      onAudio: () => {
        if (cancelled) after++;
        else before++;
      },
    });
    await sleep(300);
    cancelled = true;
    h.cancel();
    const r = await h.done;
    await sleep(1000);
    row(
      'cancel 300 ms after request',
      r.status === 'cancelled' && after === 0,
      `${r.status}${r.reason ? ` (${r.reason})` : ''}, done ${r.cancel_ms} ms after cancel(), chunks forwarded before/after cancel ${before}/${after}, server deltas dropped ${r.dropped_after_cancel}`,
      { cancel_ms: r.cancel_ms, before, after, dropped: r.dropped_after_cancel },
    );
  }
  // c2: 300 ms after the first audio (mid-stream: deltas are in flight)
  {
    let cancelled = false;
    const kept = [];
    let after = 0;
    let h = null;
    h = mouth.say(LONG_PHRASE, {
      format: 'buffer',
      meta: { test: 'cancel_midstream' },
      onStart: () =>
        setTimeout(() => {
          cancelled = true;
          h.cancel();
        }, 300),
      onAudio: (b) => {
        if (cancelled) after++;
        else kept.push(b);
      },
    });
    const r = await h.done;
    await sleep(1000);
    writeWav(join(OUT_DIR, 'selftest_cancel_midstream.wav'), Buffer.concat(kept));
    row(
      'cancel mid-stream (+300 ms)',
      r.status === 'cancelled' && after === 0,
      `${r.status}, done ${r.cancel_ms} ms after cancel(), audio forwarded ${sec(r.audio_ms)} then 0 chunks, server deltas dropped after cancel ${r.dropped_after_cancel}`,
      { cancel_ms: r.cancel_ms, after, dropped: r.dropped_after_cancel, audio_ms: r.audio_ms },
    );
  }
}

// (d) reconnect ------------------------------------------------------------------------------------
async function testReconnect(session, mouth) {
  const reconnected = new Promise((resolve) => session.once('reconnected', resolve));
  const failed = new Promise((resolve) => session.once('failed', resolve));
  session.simulateDrop();
  const ev = await Promise.race([reconnected, failed, sleep(15_000).then(() => null)]);
  if (!ev || ev.error) {
    row('reconnect after socket drop', false, ev?.error ? `failed: ${ev.error.message}` : 'no reconnect within 15 s');
    return;
  }
  const r = await mouth.say('Связь восстановлена.', { meta: { test: 'after_reconnect' } }).done;
  row(
    'reconnect after socket drop',
    ev.gap_ms <= RECONNECT_LIMIT_MS && r.status === 'completed',
    `gap ${ev.gap_ms} ms (${ev.attempts} attempt), epoch ${ev.epoch}; readout after: ${r.status}, TTFA ${r.ttfa_ms} ms, verbatim ${r.verbatim}`,
    { gap_ms: ev.gap_ms, ttfa_ms: r.ttfa_ms },
  );
}

function writeWav(path, pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([header, pcm]));
}

function printTable() {
  const width = Math.max(...rows.map((r) => r.name.length), 4);
  console.log(`\n${'TEST'.padEnd(width)}  RESULT  DETAILS`);
  for (const r of rows) console.log(`${r.name.padEnd(width)}  ${r.pass ? 'PASS  ' : 'FAIL  '}  ${r.details}`);
  const u = result.usage;
  if (u) {
    console.log(
      `\nusage: ${u.responses} responses, in ${u.input_tokens} tok (text ${u.input_text_tokens}, audio ${u.input_audio_tokens}, cached ${u.cached_tokens}), out ${u.output_tokens} tok (text ${u.output_text_tokens}, audio ${u.output_audio_tokens}); transcription ${u.transcription.items} item(s), ${u.transcription.seconds} s, ${u.transcription.input_tokens}/${u.transcription.output_tokens} tok`,
    );
  }
  const failed = rows.filter((r) => !r.pass).length;
  console.log(`\n${failed ? `RESULT FAIL (${failed} of ${rows.length})` : `RESULT PASS (${rows.length} checks)`}`);
  console.log(`audio: ${join(OUT_DIR, 'selftest_*.wav')}   log: ${result.log ?? '-'}`);
  return failed;
}

main()
  .catch((err) => row('fatal', false, redactSecrets(err?.message ?? String(err))))
  .finally(() => {
    result.finished = new Date().toISOString();
    const failed = printTable();
    try {
      writeFileSync(join(OUT_DIR, 'selftest_result.json'), JSON.stringify(result, null, 2));
    } catch {
      // not fatal
    }
    process.exitCode = failed ? 1 : 0;
  });
