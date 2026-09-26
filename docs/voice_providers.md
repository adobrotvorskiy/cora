# Voice providers (WP3b): OpenRouter cascade and OpenAI Realtime

Kora's ears (VAD + speech-to-text) and mouth (verbatim TTS) come in two interchangeable
implementations with **the same public interface and event names**. The host gets both
through one factory and never checks which one runs.

| provider | ears | mouth | key (`settings.keys.*`) | status |
|---|---|---|---|---|
| `openrouter` (default) | `src/audio/or_ears.js`: energy VAD (`vad.js`) + `POST /api/v1/audio/transcriptions` | `src/audio/or_mouth.js`: `POST /api/v1/chat/completions` with `openai/gpt-audio-mini`, streamed PCM | `openrouter` → `Cora_KEY` | production path since 18.09.2026 (the OpenAI account ran out of credits) |
| `openai_realtime` | `src/audio/ears.js`: semantic_vad + gpt-live-transcribe | `src/audio/mouth.js`: out-of-band verbatim readouts | `openai` → `OPENAI_API_KEY` | WP3, kept as an alternative (one WS session, `realtime_ws.js`) |

## 1. Use

```js
import { createVoice } from './audio/voice.js';

const voice = createVoice({ settings, log });   // key by NAME from settings.keys, value via env.requireKey
await voice.connect();       // openrouter: key check + warm HTTPS + STT anchor render (~1-2 s); realtime: WS handshake
page.onAudio = (pcm) => voice.ears.pushAudio(pcm);            // 100 ms PCM16 LE mono 24 kHz
voice.ears.on('vad', ...); voice.ears.on('stt_delta', ...); voice.ears.on('stt_final', ...);
const h = voice.mouth.say('Тима, тебе слово.', { onAudio: (b64) => player.play(b64) });
const pcm = await voice.mouth.renderClip('Доброе утро!');     // clips cache
await voice.close();
```

`createVoice({settings, log, keys?, env?, fetch?, people?, now?, ears?, mouth?})` returns
`{kind, selection, ears, mouth, instructions, cacheKey, connect(), close(), stats(), session?}`.
`selectVoiceProvider(settings)` returns `{provider, keyRole, keyName, tts_model, stt_model, voice}`
without touching key values (use it in `--check`). The shared `OPENROUTER_API_KEY` is refused, as in the brain.

**Clip cache key:** use `voice.cacheKey` (`openrouter|openai/gpt-audio-mini|shimmer|<sha1(instructions)[:12]>`).
It names provider, model, voice and instructions. Clips from one provider/model must not play next to live
speech from another.

## 2. Switching providers

`config/settings.json` → `voice.provider`. Machine-local override, no code change:

```json
// config/settings.local.json
{ "voice": { "provider": "openai_realtime" } }
```

`openai_realtime` takes its models from `settings.realtime` (model, voice, transcribe_model,
vad_eagerness, ...). `openrouter` takes them from `settings.voice`:

```json
"voice": {
  "provider": "openrouter",
  "tts_model": "openai/gpt-audio-mini",      // alternative: "openai/gpt-audio" (16x the price, same TTFA)
  "stt_model": "openai/gpt-4o-transcribe",   // alternative: "openai/gpt-4o-mini-transcribe" (half the price, see §6)
  "voice": "shimmer",
  "vad": { "start_db": 12, "start_ms": 150, "stop_db": 6, "stop_ms": 600, "preroll_ms": 300, "min_speech_ms": 200 },
  "stt": { "partial_interval_ms": 2500, "overlap_ms": 500, "full_max_ms": 12000, "early_final_ms": 250,
           "timeout_ms": 6000, "retries": 1, "concurrency": 2 }
}
```

Other knobs have code defaults and can be added to `voice.vad`/`voice.stt` in `settings.local.json`:
`vad.js` `VAD_DEFAULTS` (`break_ms`, `floor_*`) and `or_ears.js` `EARS_DEFAULTS` (`tail_pad_ms`,
`min_context_ms`, `max_window_ms`, `anchor_gap_ms`, `lang_retries`, `buffer_ms`, `stall_ms`, `log_deltas`).
Also: `voice.language` (default `realtime.language`, `ru`) and `voice.stt_anchor` (anchor text, or `false`).
Both providers read the pace block from `realtime.pace_instructions` and the persona line from `realtime.persona_line`.

## 3. Contract (both providers)

Ears: `pushAudio(b64|Buffer|Int16Array|ArrayBuffer, {t})` → boolean. `t` is the wall time of the chunk's last
sample. `pushAudio` never blocks. Also `speaking`, `audioMs`, `audioMsToWall(ms)`, `sweepItems()`, `stats()`, `close()`.

| event | payload | notes for OpenRouter |
|---|---|---|
| `vad` | `{type:'start'\|'stop', audio_ms, t, t_rx, item_id, speech_ms?}` | `t` is the capture time of the onset/end (energy edges, ±1 frame), `t_rx` is when the event fired. A stop may carry `reason: 'stall'\|'flush'` |
| `stt_delta` | `{item_id, text, so_far, t}` | running text of a long utterance, or the speculative text if speech resumed. `revised: true` means `so_far` was replaced, not extended. Match closers on `so_far` |
| `stt_final` | `{item_id, text, t, t_speech_start, t_speech_end, latency_ms}` | exactly one per VAD stop (or `stt_failed`). `text: ''` + `skipped: 'too_short'` for utterances < `min_speech_ms`. Extras: `speculative`, `request_ms`, `window_ms`, `stitched` |
| `stt_failed` | `{item_id, error: {code, message, status?}, t}` | after `timeout_ms` × (1 + `retries`) or a non-retryable HTTP error |
| `reset` | `{reason, item_id, t}` | only `close()` mid-utterance (Realtime: socket loss) |

Mouth: `say(text, {meta, onAudio, format: 'b64'|'buffer', onStart, onEnd, queue, maxAgeMs, maxOutputTokens})`
→ `{id, done, cancel}`. `done` resolves `{status: 'completed'|'cancelled'|'failed', reason?, ttfa_ms,
audio_ms, wait_ms, usage, transcript, verbatim, similarity, ...}`. A second `say()` rejects `busy` unless
`queue: true`. After `close()` it rejects `closed`, and empty text rejects `bad_text`. No `onAudio` call happens
after `cancel()` returns. `renderClip(text, {withInfo})` → PCM Buffer, rejecting with `err.code` on failure.
Also `cancelAll()`, `busy`, `stats()`, `close()`. OpenRouter extras: `headers_ms`, `cost_usd`, `upstream`,
`attempts`, `warmup()`, `instructions`, `cacheKey`.

## 4. How the OpenRouter provider works

**VAD (`vad.js`, pure state machine over 20 ms frames of the mixed 24 kHz PCM).** The noise floor is a
slow-rising minimum tracker (1 dB/s) over dB-smoothed (60 ms) frame levels. It never lags the minimum of
the last 5 s, and it is clamped to [-70, -30] dBFS: digital silence from muted SFU tracks cannot drag it
down. Start = 150 ms of frames ≥ floor+12 dB (frames between the thresholds keep the count), dated at the
first loud frame. Stop = 600 ms below floor+6 dB, dated at the first quiet frame; blips < 40 ms do not
break the quiet run. `pause` at 250 ms of quiet triggers the speculative final. Per-track VADs (P1
attribution) can feed the page's 50 ms levels through `EnergyVad.pushLevel`.

**STT scheduling (`or_ears.js`).**
- Each utterance gets 300 ms of pre-roll and 150 ms of tail pad.
- During speech, every 2.5 s a tail window is transcribed and stitched onto the running text. Windows are
  ≥ 4 s long and overlap ≥ 0.5 s. `stitchText` does an overlap alignment that tolerates a misheard word and
  cut-word fragments.
- At 250 ms of quiet the final is requested *speculatively*: the whole utterance if ≤ 12 s, else the tail
  stitched onto the running text. If the VAD then stops at the same point, that request is the final.
  The 600 ms hangover and the STT call overlap, so the final lands ≈ 0.4 s after the stop event.
- Limits: at most 2 requests in flight (finals first), 6 s timeout, 1 retry for finals, none for partials.

**Language (measured 18.09.2026).** OpenRouter does **not** forward `language` or `prompt` to
`gpt-4o-transcribe`: `language=en` on Russian speech still returns Russian, and a spelling prompt has no effect.
Whisper on DeepInfra does get `language`. Without a hint the model guesses per request: «Да.» → `Da.`,
«Кора, стоп.» → `Cora, stop.`, «Угу» → `Uhu.`/`오호.`, «Секунду» → `Segundo.`, and a 2.7 s mid-phrase window
came back in Serbian. Countermeasures:
1. **Language anchor.** `voice.connect()` renders «Итак.» with Kora's own voice (~0.6–1 s) and hands it to
   the ears. It is prepended, with 200 ms of silence, to every request whose window starts at the utterance
   onset, and stripped from the text. With it: `Да.`, `Кора, стоп.`, `нет`, `всё`, `секунду`. It is not used
   on mid-phrase windows, where it glued onto cut words («Итак, Виктория…»).
2. `fixLatinShort`: a short all-Latin answer is mapped to Cyrillic through a dictionary and transliteration.
   This is the safety net if the anchor is missing.
3. `isForeignScript`: letters outside Russian/plain Latin, or ≥ 3 mostly-Latin words. A final is requested
   again once; a partial is dropped.
4. Echoes of the prompt and known silence hallucinations («Продолжение следует…», subtitle credits) → `''`.

**TTS (`or_mouth.js`).**
- Request: `modalities: ['text','audio']`, `audio: {voice, format: 'pcm16'}`, `stream: true`,
  `usage: {include: true}`. The system message is the Realtime session's instructions
  (`buildInstructions`: persona + pace block + verbatim rule). The user message is
  `{"response_text": …, "require_repeat_verbatim": true}`.
- The SSE stream is decoded as **UTF-8 explicitly**. Audio deltas are re-aligned to whole samples.
- The model's own transcript is compared with the text. On 18.09 the transcript once read «стандап» while the
  audio said «стендап» (two independent STTs agree): a mismatch in `or.verbatim_mismatch` is a hint, not proof.
- `cancel()` aborts the HTTP stream at once. Clips are retried once on transient errors before any audio;
  live readouts are not.

**Logs** (`log.event`): `vad.start`, `vad.stop`, `stt.final`, `stt.failed`, `vad.reset` (same types as WP3),
`stt.delta` (only with `log_deltas`), `or.stt` (one per STT request: kind, window, ms, cost_usd,
anchored/translit/foreign/filtered), `or.stt_error`, `or.readout` (one per readout: ttfa_ms, headers_ms,
audio_ms, cost_usd, verbatim), `or.verbatim_mismatch`, `or.warmup`, `or.anchor`, `voice.init`,
`voice.connect_error`, `voice.anchor_error`. Keys never reach the log; the key label from `GET /key` is not logged.

## 5. Latency expectations (live, 18.09.2026, `tools/or_voice_selftest.js`)

| what | OpenRouter (this provider) | OpenAI Realtime (WP3, for reference) |
|---|---|---|
| TTS time to first audio, gpt-audio-mini | 0.95–1.9 s (avg 1.3 s; headers alone 0.7–1.2 s) | 0.84 s (effort minimal) |
| TTS TTFA, gpt-audio | 0.94–2.2 s | — |
| VAD start vs true onset | −10 ms, event ~150–250 ms later | −450 ms (prefix padding), event ~0.3 s later |
| VAD end vs true end of speech | +10…+80 ms (+390 ms after «стоп»), stop event +0.6…0.75 s | event ~0.85 s after the end |
| end of speech → `stt_final` | **1.08–1.37 s** (7 s phrase, 18 s monologue, «Да.», «Кора, стоп.») | ~1.45 s |
| closer «у меня всё» visible | with the final, +1.1 s | deltas live |
| `cancel()` → done | 1–3 ms, no audio after | ~0.1 s |

**Handoffs do not depend on TTS TTFA.** Standard phrases (handoff, check_done, greetings, closing) are
pre-rendered with `renderClip` into the clip cache (keyed by `voice.cacheKey`) and start playing at once.
Only brain-authored live phrases (Q&A, unusual situations) pay the ~1.3 s TTFA, on top of the brain's ~1.3 s.
For turn-taking, the stop event arrives ~0.6–0.75 s after the end of speech, and the final text ~0.4 s later.

## 6. Cost and model choice

| model | price (OpenRouter, 18.09) | measured |
|---|---|---|
| `openai/gpt-audio-mini` (TTS, default) | ≈ $0.0003 per 3 s phrase | verbatim on all phrases |
| `openai/gpt-audio` | ≈ $0.0047 per 3 s phrase (16x) | same TTFA, verbatim |
| `openai/gpt-4o-transcribe` (STT, default) | ≈ $0.0042 per minute of audio | 0.8–1.4 s per 6.75 s clip, best on short answers with the anchor |
| `openai/gpt-4o-mini-transcribe` | ≈ $0.0022 per minute | 0.7–0.8 s, but with the anchor «Кора, стоп» → «скоро стоп», «Угу» → «ухо» |
| `openai/whisper-large-v3` | ≈ $0.00045 per minute | 1.3–6.7 s (DeepInfra, highly variable). `provider: {order/only: ['groq']}` is **ignored** by this endpoint: every call was served by DeepInfra |

Coverage: short utterances are sent once (plus the ~1 s anchor). Long monologues are sent ≈ 1.6x
(4 s windows every 2.5 s, plus the tail). A standup with ~20–25 min of speech ≈ 30–40 min of STT audio
≈ $0.15–0.2 ≈ 15–20 ₽, plus TTS ≈ 1 ₽. The live self-test costs ≈ $0.01.

## 7. Self-test

```
node tools/or_voice_selftest.js [--verbose] [--skip-bench] [--skip-long] [--tts-model <id>] [--stt-model <id>]
```

The run covers: connect (key + anchor); 3 readouts (TTFA, verbatim, with an independent STT check on a
mismatch); rendered clips fed through the ears at real-time pace (7 s phrase, 18 s monologue, «Да.»,
«Кора, стоп.») checking VAD edges vs a −45 dBFS oracle, transcript, and end-of-speech → final latency;
cancel before and during audio; STT and TTS model benches. Outputs: `_internal/or_selftest_*.wav`,
`_internal/or_selftest_result.json`, `logs/or_selftest_YYYY-MM-DD.jsonl`. Offline tests:
`tests/unit/or_voice.test.js`.

## 8. Notes for the host (WP6)

- Call `voice.connect()` at startup. Without the anchor, one-word answers depend on the Latin fallback.
- `--check` in `src/main.js` still requires `OPENAI_API_KEY` ("realtime voice needs it") and prints realtime
  voice info. With `voice.provider = openrouter` it should require `selectVoiceProvider(settings).keyName`
  (`Cora_KEY`) instead.
- The energy VAD fires on any sound ≥ 12 dB above the floor for 150 ms (coughs, laughter), so treat `vad`
  as a signal, not as a turn decision (PLAN §3). Sentence pauses ≥ 600 ms end an utterance. A monologue
  arrives as several `stt_final`s; that is normal.
- Every `vad` stop gets exactly one `stt_final` or `stt_failed` (`''` + `skipped` for < 200 ms). Compare
  closers and answers with `normalizeSpoken` (ё=е, no punctuation).
- When the page reports that all remote tracks ended, call `ears.flush()`. Otherwise an open utterance is
  closed by the 1.5 s stall watchdog.
- `min_speech_ms` is 200 ms, not 300: a clipped «да» is ~200–250 ms and must reach the host (check_done).
  Shorter blips still get a VAD start/stop pair.
