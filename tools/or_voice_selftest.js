#!/usr/bin/env node
// Live self-test of the OpenRouter voice provider (WP3b): talks to openrouter.ai on the key named by
// settings.keys.openrouter (Cora_KEY), costs a few cents.
//
//   node tools/or_voice_selftest.js [--verbose] [--skip-bench] [--skip-long] [--tts-model <id>] [--stt-model <id>]
//
// (0) connect: voice.connect() = GET /key (key valid, HTTPS connection warm) + STT language anchor render
// (a) mouth.say: 3 short Russian phrases -> TTFA and verbatim match (a mismatch in the model's own
//     transcript is re-checked with an independent STT of the audio)
// (b) renderClip a phrase, feed it (1.5 s silence + clip + 1.5 s silence, then silence until the
//     transcript is final) into the ears in 100 ms chunks at real-time pace -> VAD start/stop vs the
//     true speech edges (-45 dBFS oracle), stt_delta/stt_final text, latency end of speech -> final,
//     when the closer «у меня всё» first became visible
// (b2) long utterance (> 12 s): partial windows + stitched final
// (b3) short answer «Да.»: must not be dropped as too short, must come back in Cyrillic
// (b4) voice kill switch «Кора, стоп.»: exact transcript
// (c) cancel: 300 ms after the request (before audio) and 300 ms after the first audio
// (d) STT bench on the clip of (b): gpt-4o-transcribe, gpt-4o-mini-transcribe, whisper-large-v3
//     (default routing and provider order Groq) -> latency, similarity, cost, served-by
// (e) TTS bench: gpt-audio vs the configured model on one phrase -> TTFA, cost
// Audio goes to _internal/or_selftest_*.wav, results to _internal/or_selftest_result.json, events to
// logs/or_selftest_YYYY-MM-DD.jsonl. The key is read inside this process only (env.requireKey).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { compareVerbatim, normalizeSpoken } from '../src/audio/mouth.js';
import { OR_API_BASE, encodeWav, transcribeOnce } from '../src/audio/or_ears.js';
import { createOrMouth } from '../src/audio/or_mouth.js';
import { BYTES_PER_MS, buildTranscriptionPrompt, loadPeople } from '../src/audio/realtime_ws.js';
import { createVoice } from '../src/audio/voice.js';
import { deepMerge, loadSettings } from '../src/config.js';
import { APP_ROOT, redactSecrets, requireKey } from '../src/env.js';
import { openLog } from '../src/log.js';

const OUT_DIR = join(APP_ROOT, '_internal');
const CHUNK_MS = 100;
const CHUNK_BYTES = CHUNK_MS * BYTES_PER_MS;
const PAD_MS = 1500;
const SAY_PHRASES = ['Доброе утро! Начинаем стендап.', 'Ярослав, тебе слово: какие планы на день?', 'Спасибо всем, хорошего дня! Передаю слово на дев-синк.'];
const STT_PHRASE = 'Всем привет. Вчера закончил интеграцию с трекером, сегодня делаю отчёт для Орлова. У меня всё.';
const LONG_PHRASE =
  'Всем привет. Вчера я закончил интеграцию с трекером и поправил выгрузку отчётов, там была ошибка с часовыми поясами. ' +
  'Сегодня доделываю дашборд для клиента, потом созвон с Глебом по архитектуре, а после обеда пишу тесты на новый модуль. ' +
  'Если успею, начну миграцию базы. Блокеров нет. У меня всё.';
const SHORT_PHRASE = 'Да.';
const STOP_PHRASE = 'Кора, стоп.';
const CANCEL_PHRASE = 'Доброе утро, коллеги! Сегодня вторник, поэтому рассказываем планы на день. Начнём с Ярослава, потом пойдём по кругу, а в самом конце я передам слово на дев-синк.';
const CLOSER = 'у меня все';
const TTFA_LIMIT_MS = 2500;
const STT_LATENCY_LIMIT_MS = 2500;
const ORACLE_DB = -45;

const { values: args } = parseArgs({
  options: {
    verbose: { type: 'boolean', short: 'v', default: false },
    'skip-bench': { type: 'boolean', default: false },
    'skip-long': { type: 'boolean', default: false },
    'tts-model': { type: 'string' },
    'stt-model': { type: 'string' },
  },
});

const rows = [];
const result = { started: new Date().toISOString(), rows, notes: [] };
const row = (name, pass, details, data = {}) => {
  rows.push({ name, pass, details, ...data });
  console.log(`${pass === null ? 'INFO' : pass ? 'PASS' : 'FAIL'}  ${name}: ${details}`);
};
const sec = (ms) => (ms == null ? '?' : `${(ms / 1000).toFixed(2)} s`);
const signed = (ms) => (ms == null ? '?' : `${ms >= 0 ? '+' : ''}${Math.round(ms)} ms`);

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  let settings = loadSettings();
  const voiceOverride = { provider: 'openrouter' };
  if (args['tts-model']) voiceOverride.tts_model = args['tts-model'];
  if (args['stt-model']) voiceOverride.stt_model = args['stt-model'];
  settings = deepMerge(settings, { voice: voiceOverride });
  const log = openLog({ name: 'or_selftest', verbose: args.verbose });
  const people = loadPeople();
  const voice = createVoice({ settings, log, people });
  result.voice = { ...voice.selection, cache_key: voice.cacheKey, people: people.length };
  try {
    const info = await voice.connect();
    row(
      'connect (GET /key + anchor)',
      info.ok === true && Boolean(info.anchor),
      `${info.ms} ms, key ${voice.selection.keyName}, tts ${voice.selection.tts_model} / ${voice.selection.voice}, stt ${voice.selection.stt_model}; STT anchor ${info.anchor ? `«${info.anchor.text}» ${info.anchor.ms} ms` : 'MISSING'}; spent today $${info.usage_daily_usd ?? '?'}`,
    );

    await testSay(voice.mouth, requireKey(settings.keys.openrouter));
    const clip = await testStt(voice, 'stt', STT_PHRASE, { closer: true });
    if (!args['skip-long']) await testStt(voice, 'long', LONG_PHRASE, { closer: true });
    await testStt(voice, 'short «Да.»', SHORT_PHRASE, {});
    await testStt(voice, 'kill switch «Кора, стоп.»', STOP_PHRASE, {});
    await testCancel(voice.mouth);
    if (!args['skip-bench']) {
      if (clip) await benchStt(settings, clip, people);
      await benchTts(settings, log);
    }
    result.ears = voice.ears.stats();
    result.mouth = voice.mouth.stats();
    result.cost_usd = voice.stats().cost_usd;
  } catch (err) {
    row('fatal', false, redactSecrets(err?.message ?? String(err)));
  } finally {
    await voice.close();
    log.close();
    result.log = log.path;
  }
}

// (a) three short readouts ------------------------------------------------------------------------
// Verbatim = the model's own transcript matches the text. The transcript can differ from the audio
// (18.09: transcript «стандап», audio «стендап» per two independent STTs), so a mismatch is checked
// against an independent transcription of the audio before it counts as a failure.
async function testSay(mouth, apiKey) {
  for (const [i, text] of SAY_PHRASES.entries()) {
    const chunks = [];
    const r = await mouth.say(text, { format: 'buffer', onAudio: (b) => chunks.push(b), meta: { test: `say${i + 1}` } }).done;
    const pcm = Buffer.concat(chunks);
    writeWav(`or_selftest_say_${i + 1}.wav`, pcm);
    let heard = null;
    if (r.status === 'completed' && r.verbatim === false) {
      try {
        const out = await transcribeOnce({ pcm, apiKey, language: 'ru', signal: AbortSignal.timeout(15_000) });
        heard = { text: out.text, similarity: compareVerbatim(text, out.text).similarity };
      } catch (err) {
        heard = { text: null, error: err.message };
      }
    }
    const spokenOk = r.verbatim === true || (heard?.similarity ?? 0) >= 0.9;
    const pass = r.status === 'completed' && r.ttfa_ms != null && r.ttfa_ms <= TTFA_LIMIT_MS && spokenOk;
    const verbatim = r.verbatim ? 'yes' : `NO in the model transcript «${r.transcript}»; audio heard as «${heard?.text ?? '?'}» (similarity ${heard?.similarity ?? '?'})`;
    row(
      `say #${i + 1}`,
      pass,
      `${r.status}${r.reason ? ` (${r.reason})` : ''}, TTFA ${r.ttfa_ms} ms (headers ${r.headers_ms} ms), audio ${sec(r.audio_ms)} in ${chunks.length} chunks, verbatim ${verbatim}, $${r.cost_usd ?? '?'}`,
      { ttfa_ms: r.ttfa_ms, headers_ms: r.headers_ms, audio_ms: r.audio_ms, verbatim: r.verbatim, heard, cost_usd: r.cost_usd, text, transcript: r.transcript },
    );
  }
}

// (b) rendered clip -> ears at real-time pace --------------------------------------------------------
async function testStt(voice, name, phrase, { closer }) {
  const { ears, mouth } = voice;
  const clip = await mouth.renderClip(phrase, { withInfo: true, meta: { test: `${name}_clip` } });
  const slug = name.replace(/[^a-z]+/gi, '_').replace(/^_|_$/g, '').toLowerCase() || 'short';
  writeWav(`or_selftest_${slug}_clip.wav`, clip.pcm);
  const edges = speechEdges(clip.pcm);
  const stream = Buffer.concat([Buffer.alloc(PAD_MS * BYTES_PER_MS), clip.pcm, Buffer.alloc(PAD_MS * BYTES_PER_MS)]);
  writeWav(`or_selftest_${slug}_input.wav`, stream);

  const vad = [];
  const deltas = [];
  const finals = [];
  const failed = [];
  const on = { vad: (e) => vad.push(e), stt_delta: (e) => deltas.push(e), stt_final: (e) => finals.push(e), stt_failed: (e) => failed.push(e) };
  for (const [k, fn] of Object.entries(on)) ears.on(k, fn);

  const base = ears.audioMs;
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
    if (streamDone && !ears.speaking && finals.length + failed.length >= stops && stops > 0) break;
  }
  await sleep(300);
  for (const [k, fn] of Object.entries(on)) ears.off(k, fn);

  const trueStart = base + PAD_MS + edges.first;
  const trueEnd = base + PAD_MS + edges.last;
  const wallEnd = ears.audioMsToWall(trueEnd);
  const starts = vad.filter((v) => v.type === 'start');
  const stops = vad.filter((v) => v.type === 'stop');
  const text = finals.map((f) => f.text).filter(Boolean).join(' ').trim();
  const cmp = compareVerbatim(phrase, text);
  const lastFinal = finals.at(-1);
  const endToFinal = lastFinal && wallEnd != null ? lastFinal.t - wallEnd : null;
  const startErr = starts[0] ? starts[0].audio_ms - trueStart : null;
  const stopErr = stops.at(-1) ? stops.at(-1).audio_ms - trueEnd : null;
  let closerMs = null;
  if (closer && wallEnd != null) {
    const seen = [...deltas.map((d) => ({ t: d.t, text: d.so_far })), ...finals.map((f) => ({ t: f.t, text: f.text }))]
      .filter((x) => normalizeSpoken(x.text).includes(CLOSER))
      .sort((a, b) => a.t - b.t)[0];
    closerMs = seen ? seen.t - wallEnd : null;
  }
  const data = {
    clip_ms: Math.round(clip.pcm.length / BYTES_PER_MS),
    speech_edges_ms: edges,
    utterances: starts.length,
    vad_start_err_ms: startErr,
    vad_stop_err_ms: stopErr,
    stop_event_after_end_ms: stops.at(-1) && wallEnd != null ? stops.at(-1).t_rx - wallEnd : null,
    deltas: deltas.length,
    finals: finals.map((f) => ({ text: f.text, latency_ms: f.latency_ms, speculative: f.speculative ?? false, request_ms: f.request_ms, skipped: f.skipped })),
    failed: failed.map((f) => f.error),
    end_of_speech_to_final_ms: endToFinal,
    closer_visible_ms: closerMs,
    similarity: cmp.similarity,
    text,
  };
  result[`stt_${slug}`] = data;
  row(
    `${name}: vad`,
    starts.length >= 1 && stops.length === starts.length && startErr != null && Math.abs(startErr) <= 150 && stopErr != null && stopErr >= -150 && stopErr <= 600,
    `${starts.length} utterance(s); start ${signed(startErr)} vs true onset, end ${signed(stopErr)} vs true end, stop event ${signed(data.stop_event_after_end_ms)} after the end`,
    data,
  );
  const exact = phrase === SHORT_PHRASE || phrase === STOP_PHRASE; // one-word answers and the kill switch must be exact
  row(
    `${name}: transcript`,
    finals.length > 0 && failed.length === 0 && cmp.similarity >= (exact ? 1 : 0.8),
    `«${text}» similarity ${cmp.similarity}; ${deltas.length} delta(s); finals speculative: ${finals.map((f) => (f.skipped ? `skipped:${f.skipped}` : f.speculative ? 'yes' : 'no')).join(',')}`,
  );
  row(
    `${name}: latency end-of-speech -> final`,
    endToFinal != null && endToFinal <= STT_LATENCY_LIMIT_MS,
    `${endToFinal ?? '?'} ms after the true end (${lastFinal?.latency_ms ?? '?'} ms after the VAD end, STT request ${lastFinal?.request_ms ?? '?'} ms)${closer ? `; «у меня всё» visible ${signed(closerMs)} after the end` : ''}`,
  );
  return { pcm: clip.pcm, phrase };
}

// (c) cancel ---------------------------------------------------------------------------------------
async function testCancel(mouth) {
  {
    let cancelled = false;
    let before = 0;
    let after = 0;
    const h = mouth.say(CANCEL_PHRASE, {
      format: 'buffer',
      meta: { test: 'cancel_300ms' },
      onAudio: () => {
        if (cancelled) after++;
        else before++;
      },
    });
    await sleep(300);
    cancelled = true;
    const r = await h.cancel();
    await sleep(1000);
    row(
      'cancel 300 ms after request',
      r.status === 'cancelled' && after === 0,
      `${r.status}${r.reason ? ` (${r.reason})` : ''}, done ${r.cancel_ms} ms after cancel(), chunks before/after cancel ${before}/${after}`,
      { cancel_ms: r.cancel_ms, before, after },
    );
  }
  {
    let cancelled = false;
    const kept = [];
    let after = 0;
    let h = null;
    let cancelAt = null;
    h = mouth.say(CANCEL_PHRASE, {
      format: 'buffer',
      meta: { test: 'cancel_midstream' },
      onStart: () =>
        setTimeout(() => {
          cancelled = true;
          cancelAt = performance.now();
          h.cancel();
        }, 300),
      onAudio: (b) => {
        if (cancelled) after++;
        else kept.push(b);
      },
    });
    const r = await h.done;
    const doneAt = performance.now();
    await sleep(1000);
    writeWav('or_selftest_cancel_midstream.wav', Buffer.concat(kept));
    row(
      'cancel mid-stream (+300 ms)',
      r.status === 'cancelled' && after === 0,
      `${r.status}, done ${Math.round(doneAt - (cancelAt ?? doneAt))} ms after cancel(), audio forwarded ${sec(r.audio_ms)} then ${after} chunks, deltas dropped after cancel ${r.dropped_after_cancel ?? 0}`,
      { cancel_ms: r.cancel_ms, after, audio_ms: r.audio_ms },
    );
  }
}

// (d) STT model bench ------------------------------------------------------------------------------
async function benchStt(settings, clip, people) {
  const apiKey = requireKey(settings.keys.openrouter);
  const pcm = Buffer.concat([Buffer.alloc(300 * BYTES_PER_MS), clip.pcm]);
  const prompt = buildTranscriptionPrompt(settings, people);
  const variants = [
    { label: 'openai/gpt-4o-transcribe', model: 'openai/gpt-4o-transcribe' },
    { label: 'openai/gpt-4o-mini-transcribe', model: 'openai/gpt-4o-mini-transcribe' },
    { label: 'openai/whisper-large-v3', model: 'openai/whisper-large-v3' },
    { label: 'openai/whisper-large-v3 + provider order Groq', model: 'openai/whisper-large-v3', provider: { order: ['Groq'], allow_fallbacks: false } },
  ];
  const bench = [];
  for (const v of variants) {
    const runs = [];
    let servedBy = null;
    for (let i = 0; i < 2; i++) {
      const t0 = performance.now();
      try {
        const out = await transcribeOnce({ pcm, apiKey, model: v.model, language: 'ru', prompt: v.model.includes('gpt-4o') ? prompt : undefined, provider: v.provider, signal: AbortSignal.timeout(20_000) });
        runs.push({ ms: Math.round(performance.now() - t0), similarity: compareVerbatim(clip.phrase, out.text).similarity, cost_usd: out.usage?.cost ?? null, text: out.text });
        if (v.provider && i === 0 && out.generation_id) servedBy = await generationProvider(apiKey, out.generation_id);
      } catch (err) {
        runs.push({ ms: Math.round(performance.now() - t0), error: `${err.kind ?? 'error'}: ${err.message}` });
      }
    }
    const ok = runs.filter((r) => !r.error);
    const entry = {
      model: v.label,
      ms: runs.map((r) => r.ms),
      similarity: ok.length ? Math.min(...ok.map((r) => r.similarity)) : null,
      cost_usd: ok[0]?.cost_usd ?? null,
      served_by: servedBy,
      errors: runs.filter((r) => r.error).map((r) => r.error),
      text: ok[0]?.text ?? null,
    };
    bench.push(entry);
    row(
      `stt bench: ${v.label}`,
      null,
      `${entry.ms.join(' / ')} ms, similarity ${entry.similarity ?? '?'}, $${entry.cost_usd ?? '?'} per ${sec(pcm.length / BYTES_PER_MS)}${servedBy ? `, served by ${servedBy}` : ''}${entry.errors.length ? `, errors: ${entry.errors.join('; ')}` : ''}`,
    );
  }
  result.stt_bench = bench;
}

async function generationProvider(apiKey, id) {
  for (let i = 0; i < 5; i++) {
    await sleep(1500);
    try {
      const res = await fetch(`${OR_API_BASE}/generation?id=${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (res.ok) return (await res.json())?.data?.provider_name ?? null;
    } catch {
      // informational only
    }
  }
  return null;
}

// (e) TTS model bench ------------------------------------------------------------------------------
async function benchTts(settings, log) {
  const apiKey = requireKey(settings.keys.openrouter);
  const models = [...new Set([settings.voice.tts_model, 'openai/gpt-audio', 'openai/gpt-audio-mini'])];
  const bench = [];
  for (const model of models) {
    const mouth = createOrMouth({ settings, apiKey, log, model });
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const r = await mouth.say(SAY_PHRASES[1], { meta: { test: `tts_bench_${i + 1}` } }).done;
      runs.push(r);
    }
    mouth.close();
    const entry = {
      model,
      ttfa_ms: runs.map((r) => r.ttfa_ms),
      verbatim: runs.every((r) => r.verbatim === true),
      cost_usd: runs[0]?.cost_usd ?? null,
      audio_ms: runs[0]?.audio_ms ?? null,
      status: runs.map((r) => r.status),
    };
    bench.push(entry);
    row(`tts bench: ${model}`, null, `TTFA ${entry.ttfa_ms.join(' / ')} ms, verbatim ${entry.verbatim}, audio ${sec(entry.audio_ms)}, $${entry.cost_usd ?? '?'} per readout`);
  }
  result.tts_bench = bench;
}

// ---- helpers ---------------------------------------------------------------------------------------

/** First/last 10 ms frame above ORACLE_DB in a PCM16 clip, ms. */
function speechEdges(pcm) {
  const n = 240;
  let first = null;
  let last = null;
  for (let off = 0; off + n * 2 <= pcm.length; off += n * 2) {
    let acc = 0;
    for (let j = 0; j < n; j++) {
      const s = pcm.readInt16LE(off + j * 2);
      acc += s * s;
    }
    const db = acc > 0 ? 10 * Math.log10(acc / n / 1073741824) : -100;
    if (db > ORACLE_DB) {
      if (first === null) first = off / BYTES_PER_MS;
      last = (off + n * 2) / BYTES_PER_MS;
    }
  }
  return { first: first ?? 0, last: last ?? pcm.length / BYTES_PER_MS };
}

function writeWav(name, pcm) {
  try {
    writeFileSync(join(OUT_DIR, name), encodeWav(pcm));
  } catch {
    // not fatal
  }
}

function printTable() {
  const width = Math.max(...rows.map((r) => r.name.length), 4);
  console.log(`\n${'TEST'.padEnd(width)}  RESULT  DETAILS`);
  for (const r of rows) console.log(`${r.name.padEnd(width)}  ${r.pass === null ? 'INFO  ' : r.pass ? 'PASS  ' : 'FAIL  '}  ${r.details}`);
  const say = rows.filter((r) => r.name.startsWith('say #') && r.ttfa_ms != null).map((r) => r.ttfa_ms);
  const summary = {
    ttfa_ms: say.length ? { avg: Math.round(say.reduce((a, b) => a + b, 0) / say.length), max: Math.max(...say) } : null,
    stt_latency_ms: result.stt_stt?.end_of_speech_to_final_ms ?? null,
    long_latency_ms: result.stt_long?.end_of_speech_to_final_ms ?? null,
    vad_start_err_ms: result.stt_stt?.vad_start_err_ms ?? null,
    vad_stop_err_ms: result.stt_stt?.vad_stop_err_ms ?? null,
    closer_visible_ms: result.stt_stt?.closer_visible_ms ?? null,
    cost_usd: result.cost_usd ?? null,
  };
  result.summary = summary;
  console.log(`\nsummary: ${JSON.stringify(summary)}`);
  const failed = rows.filter((r) => r.pass === false).length;
  const checks = rows.filter((r) => r.pass !== null).length;
  console.log(`\n${failed ? `RESULT FAIL (${failed} of ${checks})` : `RESULT PASS (${checks} checks)`}`);
  console.log(`audio: ${join(OUT_DIR, 'or_selftest_*.wav')}   log: ${result.log ?? '-'}`);
  return failed;
}

main()
  .catch((err) => row('fatal', false, redactSecrets(err?.message ?? String(err))))
  .finally(() => {
    result.finished = new Date().toISOString();
    const failed = printTable();
    try {
      writeFileSync(join(OUT_DIR, 'or_selftest_result.json'), JSON.stringify(result, null, 2));
    } catch {
      // not fatal
    }
    process.exitCode = failed ? 1 : 0;
  });
