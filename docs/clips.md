# Clips and player (WP4)

`src/audio/clips.js` renders the `config/phrases.json` × `config/people.json` phrases once and caches them.
`src/audio/player.js` feeds PCM (clips or a live stream) to the page adapter (WP2) and reports how each
utterance ended.

## Cache

```
cache/<provider>/<model>/<voice>/<sha1>.pcm    PCM16 LE mono 24 kHz, raw model output (get() trims edge silence)
cache/<provider>/<model>/<voice>/<sha1>.json   {text, created, duration_ms, key, person, variant, lead_ms, tail_ms, transcript, usage, ...}
sha1 = sha1(provider \n model \n voice \n instructions \n text)
```

The identity `{provider, model, voice, instructions}` comes from the mouth, else from settings (mirrors
`voice.js`: openrouter / `openai/gpt-audio-mini` / shimmer by default). The mouth is read in this order:
- `mouth.identity` (a property or a method);
- WP3's realtime mouth, recognised by `mouth.session`;
- `or_mouth.js` through its `model`, `voice` and `instructions`, with the provider taken from `cacheKey`.

The instructions are `buildInstructions(settings)`: the persona line, the pace block and the verbatim rule.
If any part changes, every key changes: old clips just miss (delete the old directory by hand when you like).
`model` in the path is made path-safe (`openai/gpt-audio-mini` → `openai_gpt-audio-mini`). Files are
written atomically.

Quality gates at render time:
- **Transcript.** A clip whose transcript still differs from its text after one retry is not cached (see
  `or.verbatim_mismatch` / `rt.verbatim_mismatch` / `clips.error`). On 18.09, 6 of 276 gpt-audio-mini
  renders came back garbled on the first try («фпокус», «тобе», «Aleксей»); all were fine on the retry.
- **Cut audio.** A clip still sounding in its last 10 ms window is retried once, then kept with
  `cut: true` in the sidecar and in `stats.warnings`. `render_clips --rerender-cut` renders cached cut
  clips again. Edge detection uses sustained 10 ms RMS windows above −45 dBFS, so an isolated click at an
  edge counts as silence.

## Texts

- `{name}` = `vocative` (with the U+0301 stress marks, which steer the voice).
- When two present people share a first name (ё = е, stress ignored), the name becomes `vocative surname_spoken`.
  `disambiguate_with_surname: false` turns this off. Presence comes from `opts.present` or `setPresent(ids)`.
  Without presence info there is no surname.
- `only_for: [ids]` means a per-person key applies to those ids only (other people get `null`).
- Variants rotate per phrase key: never the same variant twice in a row, chosen at random among the rest.
  `get()` rotates among cached variants only.
- `applyYo()` fixes е → ё conservatively (ещё, идёт, начнём, отчёт…, and «всё» only in unambiguous
  contexts: «у тебя всё?», «на этом всё», «Тима, всё?», «всё равно»). It runs on every clip text; use
  `finalizeText()` for live texts too.
- Plan size: general phrases once, per-person phrases × people, plus the «Имя Фамилия» forms for people who
  have a namesake in the roster. Identical texts are rendered once. The plain forms of the two Андреи,
  Сергеи, Саввы and Олеги coincide, so the full set is 377 unique clips, not the 437 counted in WP7.
  Core keys give 272.

## API

```js
import { ClipStore } from './audio/clips.js';
const clips = new ClipStore({ settings, mouth, log });           // cacheDir defaults to cache/
await clips.warmup({ present: ids, keys: 'core' });              // plan + ensure; never throws for render errors
clips.setPresent(ids);                                           // on every presence change
const c = clips.get('handoff', { person: 'tkach_t' });         // sync: {pcm, text, duration_ms, key, variant, hash, lead_ms, tail_ms, trimmed_ms} | null
const t = clips.text('check_done', { person: 'tkach_t' });     // text for a live readout (also rotates)
```

`get()` trims edge silence by default: below −45 dBFS, down to 20 ms of lead and 80 ms of tail.
gpt-audio-mini appends 0.3–0.5 s of silence. Untrimmed, the player would stay "speaking" through it, and
someone answering right after «тебе слово» would look like a barge-in. `{trim: false}` returns the file as
is.

`ensure(list, {concurrency: 2, signal, onProgress, keepMismatch})` returns stats
`{rendered, cached, failed, mismatched, skipped, audio_ms, cost_usd, cost_source, usage, fatal, errors}`.
Errors fall into three kinds (`classifyRenderError`):
- **fatal**: credits or quota (`credit_balance_exhausted`, `insufficient_quota`, HTTP 402, OrError `payment`,
  «no credits»), auth (401/403, `auth`), `model_unavailable`, or a closed mouth. The run stops scheduling at
  once and sets `stats.fatal`; `fatalMessage()` formats it.
- **retry**: rate limit, 429 without a quota text, 5xx, timeout, network. One more attempt after 1 s, but
  only when the mouth does not already retry (`or_mouth.js` has `clipRetries: 1`).
- Anything else fails only that clip.

Four failures in a row also stop the run (`too_many_failures`). Log records: `clips.render`, `clips.miss`,
`clips.error`, `clips.fatal`, `clips.ensure`.

## Player

```js
import { Player } from './audio/player.js';
const player = new Player({ page, log });                  // or { audio: pageAudio } (WP2 handle), as WP6's deps.js does
await attachPageAudio(page, { onEvent: (ev) => player.onPageEvent(ev), ... });  // before page.goto; forward ALL events
const h = player.play(c.pcm, { meta: { text: c.text, key: c.key }, source: 'clip' });
const h2 = player.playLive(mouth, text, { meta: { trigger } });                // mouth.say -> stream -> page
h.abort('barge_in');  const r = await h.done;
// r = {status: 'completed'|'aborted'|'failed', played_ms, pushed_ms, total_ms, played_ratio, ttfa_ms, reason?, dropped_ms?, partial?}
player.on('state', ({ state, speaking }) => {});   // idle -> starting -> speaking -> idle;  player.isSpeaking()
player.stop('kill_switch');                    // abort + drop the queue
```

`aborted` means the caller stopped it (`abort`, `stop`, `interrupt`). `failed` means one of `FAIL_REASONS`:
the page is gone, a navigation, a stall, or a source error before any audio. A source that fails after audio
went out ends `completed` with `partial: true` once the audio already sent has played.

- Audio goes to the page in slices of at most 200 ms. The page queue is kept no more than 2 s ahead,
  because a live stream arrives about 5× faster than real time.
- Completion is exact: `__host_playEnd()`, then the page's `player.drained {reason: 'eos'}`. Without
  forwarded events, `__host_playerState()` is polled every 100 ms.
- A playback that has not drained by the expected end + 3 s is aborted as `stall`.
- `abort()` does three things:
  - stops reading the source (`iterator.return()`) and calls `onAbort` (`playLive` cancels the readout);
  - sends `__host_flush()` before anything else can reach the page;
  - releases the floor at once (state `idle`).

  `done` resolves when the flush reports back, with `played_ms = pushed − dropped`.
- One playback at a time. A second `play()` rejects `done` with `code: 'busy'`; `{queue: true}` waits in a FIFO,
  and `{interrupt: true}` aborts the current one as `interrupted`.
- A playback that starts right after an abort waits for that flush to finish. The page worklet drops
  everything queued when its flush fade ends, including a push that arrives in the same render quantum.
- Page failures end the playback with `status: 'failed'` and a reason:
  - `page_closed` / `page_crashed`: page events (no flush);
  - `navigated`: `host.installed` for the top frame, or a destroyed context;
  - `no_adapter`, `worklet_error`, `page_timeout`, `page_error`.

  The next `play()` works again once the adapter is back.
- Logs: `speech.start {source, text, ttfa_ms?, wait_ms, ...meta}`, `speech.end {played_ms, completion}`,
  `speech.abort {status, reason, played_ms, dropped_ms, played_ratio}`. Only primitive `meta` fields are logged,
  and `meta` is read when the first chunk goes out, so a live caller can still fill `meta.ttfa_ms` in `onStart`.
  `logSpeech: false` turns these records off when the host writes its own `speech.*` records.

## Tools

```
node tools/render_clips.js --dry-run [--core]             # texts, counts, estimate; no network
node tools/render_clips.js --core                         # render missing core clips for the whole roster
node tools/render_clips.js --present "orlov_y,tkach_t" --keys "handoff,check_done"
node tools/render_clips.js --core --rerender-cut          # also render again cached clips that stop mid-sound
node tools/render_clips.js --core --mock --mock-fail-after 5   # offline check of the flow (scratch cache)
node tools/audition_names.js [--all] [--people ids] [--dry-run]  # -> _internal/audition/{NN_<id>.wav, all.wav, index.txt}
```

The voice for rendering comes from `src/audio/voice.js` `createVoice()`. Without it, WP3's realtime mouth is
used, but only when `settings.voice.provider` is `openai_realtime`.

`render_clips` refuses estimates above `--max-usd` (default 3; the estimate uses $64 per 1M audio tokens and
20 tokens/s). It prints the actual cost from `usage.cost`, which OpenRouter returns. Exit codes: 0 ok,
1 some clips failed, 2 over budget, 3 fatal (credits or auth).

The $64/1M figure is realtime pricing. The core set on OpenRouter gpt-audio-mini/shimmer (18.09) came out at:
- 272 clips, 944.8 s of audio;
- $0.09 (≈ $0.0003 per clip), 20 audio tokens/s;
- 3.6 min of wall time at concurrency 2;
- lead silence ≈ 12 ms, tail ≈ 0.35 s (trimmed by `get()`).

`audition_names` uses the normal transcript policy: its «Имя Фамилия, всё?» texts are the same cache keys
as the `check_done` surname clips.
