# Page audio + avatar adapter (WP2) — contract

Files: `src/browser/page_inject.js` (page-side code + Node helpers), `src/browser/worklets.js`
(AudioWorklet processors as strings), `tools/loopback_test.js` (acceptance test, no Telemost needed),
`tests/fixtures/` (outputs of the last run: `loopback_capture.wav` = what tab B heard,
`loopback_avatar_idle.png` / `loopback_avatar_speaking.png` = frames tab B received,
`loops/kora_live_standin.mp4` = generated 20 s stand-in take used while `assets/live/kora_live.mp4` is absent).
`*.wav` is gitignored; the PNG/MP4 fixtures are generated artefacts too (WP0 may want to ignore `tests/fixtures/`).

The adapter is a self-contained script installed with `page.addInitScript`, so it runs **before** any
Telemost code in every document. It gives the Node host a microphone it can feed with PCM (the
"mouth"), a mixed capture of everything remote participants say (the "ears"), per-track levels, an
avatar camera (still image, or one continuous video take with listen/talk segments that follow the
voice), and keeps the machine's speakers silent.

```
Node host                                   Chrome page (Telemost)
---------                                   ----------------------
audio.play(pcm)  --page.evaluate-->  __host_play  -> PlayerWorklet -> MediaStreamAudioDestinationNode
                                                                      = getUserMedia({audio}) track(s)
                                        PlayerWorklet RMS ----------> avatar canvas (talk/listen, glow)
                                                                      = getUserMedia({video}) track(s)
onAudio(pcm, levels, meta) <--binding-- __host_audio <- CaptureWorklet <- MediaStreamAudioSourceNode
                                                                       <- RTCPeerConnection 'track' (remote audio)
onEvent(ev)               <--binding-- __host_event  (track/player/context/avatar lifecycle)
```

## 1. Installation (Node side)

```js
import { attachPageAudio, serveAssets } from './browser/page_inject.js';

const context = await browser.newContext({ bypassCSP: true, viewport: { width: 640, height: 480 } });
const page = await context.newPage();
await serveAssets(page, { prefix: '/__host_assets/', dir: 'assets/live' });   // only for the video avatar
const audio = await attachPageAudio(page, {
  onAudio: (pcm, levels, meta) => { /* Int16Array 2400 frames, [{track_id, slot, frames}], {seq,...} */ },
  onEvent: (ev) => { /* {type, t, ...} */ },
  opts: { avatar: { mode: 'segments', path: 'assets/avatar.png', video: '/__host_assets/kora_live.mp4',
                    segments: { listen: [[0.3, 3.7], [10.3, 13.7], [18.2, 19.8]], talk: [[4.3, 9.7], [14.3, 17.7]] },
                    fps: 15, width: 640, height: 480, crossfadeMs: 250, loopFadeMs: 400 } },
  baseDir: projectRoot,      // what avatar.path is relative to (default process.cwd())
});
await page.goto(telemostUrl);          // ONLY after serveAssets + attachPageAudio resolved
```

Rules:

* `attachPageAudio` = `page.exposeFunction('__host_audio')` + `page.exposeFunction('__host_event')` +
  `page.addInitScript({ content: buildInitScript(opts) })`. All of it must happen **before navigation**;
  a binding exposed after the document was created is not visible to that document. The page never
  awaits binding results.
* `bypassCSP: true` on the context: the worklet module is loaded from a `blob:` URL; a strict
  `script-src` on telemost.yandex.ru would otherwise reject it (`worklet.error` event, no audio).
* `serveAssets(page, {prefix, dir})` answers `<prefix><file>` requests from the page with local files
  through `page.route` (Range requests -> 206, so `<video>` can seek). Same-origin URLs keep the
  avatar canvas origin-clean, which `captureStream()` requires. Register it before `page.goto`.
* Chrome flags (also used by the loopback test): `--autoplay-policy=no-user-gesture-required
  --mute-audio --use-fake-ui-for-media-stream --disable-background-timer-throttling
  --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --window-position=-2400,0`.
* Lower-level exports: `buildInitScript(opts, baseDir) -> string`, `buildInitConfig(opts, baseDir)`
  (turns `avatar.path` into a `data:` URL), `pageMain(cfg)` (the page function), `avatarSrcFromFile`,
  `b64ToPcm16`, `pcm16ToB64`, class `PageAudio` (`play`, `playEnd`, `flush`, `state`, `status`,
  `setOpts`, `setAvatar`).

Options (`DEFAULT_OPTS`): `sampleRate 24000`, `chunkMs 100`, `levelMs 50`, `slots 16`, `capture true`,
`videoPolicy 'notfound'` (`'deny'` | `'strip'` | `'fake'`), `fakeVideo false`, `micLabel 'Ведущая'`,
`micDeviceId 'standup-host-mic'`, `micGroupId 'standup-host'`, `avatar null` (see §7), `camLabel 'Аватар'`,
`camDeviceId 'standup-host-cam'`, `muteMedia true`, `drainGraceMs 250`, `fadeMs 4`, `progressMs 50`,
`installInFrames true`, `debug false`. The live copy is `window.__hostOpts`; `__host_setOpts(partial)`
merges at runtime.

## 2. Bindings (page -> Node)

### `__host_audio(b64pcm16, levelsJson, metaJson)`

| field | meaning |
|---|---|
| `b64pcm16` | base64 of **PCM16 little-endian, mono, 24 000 Hz, 2400 frames = 100 ms = 4800 bytes**. Content = hard-clipped sum of all mapped remote audio tracks. Our own microphone is never part of it (only `RTCPeerConnection` *remote* tracks are captured). |
| `levelsJson` | `[{"track_id":"<MediaStreamTrack.id>","slot":0,"frames":[-31.2,-33.8]}, ...]` — one entry per mapped track; `frames` = RMS in dBFS of each 50 ms half of the chunk, `-100` = digital silence, rounded to 0.1 dB. Tracks above `slots-1` share the last slot and appear as `track_id: "overflow"`. |
| `metaJson` | `{"seq":12,"ctx_time":1.2345,"t":12345.6,"sr":24000,"frames":2400,"mix":[-30.1,-32.0],"tracks":1}` — `seq` increments per chunk (gap = dropped chunk), `ctx_time` = `AudioContext.currentTime` (s) at chunk end (steady audio clock), `t` = `performance.now()` when forwarded, `mix` = dBFS of the mixed chunk per 50 ms. |

Cadence: exactly 10 calls/s while `capture` is enabled **and at least one remote audio track is
mapped**. With no remote tracks nothing is sent (the host sees `track.*` events instead). Measured in
the loopback: mean interval 97–100 ms, p95 101–123 ms, max 111–347 ms under load (bindings queue in
Node when its event loop is busy; `ctx_time` is the reliable timeline), 0 sequence gaps.

### `__host_event(jsonString)` — `{type, t, ...}` (`t` = page `performance.now()` ms)

| type | payload | when |
|---|---|---|
| `host.installed` | `version, top, href` | adapter ran in a document |
| `audio.context` | `state, sample_rate, base_latency` | AudioContext created (lazily: first getUserMedia / remote track / play) |
| `audio.state` | `state` | context state change (`suspended` -> auto-resume) |
| `audio.stalled` / `audio.resumed` | `current_time` | watchdog: `currentTime` frozen > 2 s while "running" (suspend/resume kick is attempted) |
| `worklet.ready` / `worklet.error` | `message` | worklet module loaded / **failed (fatal for audio, check CSP)** |
| `gum.request` | `n, audio, video, constraints, result, error?, video_source?` | every `getUserMedia` call made by the page |
| `pc.created` / `pc.state` | `pc`, `state` | RTCPeerConnection created / connectionState changed |
| `track.added` | `track_id, pc, slot, shared, mid, stream_ids, muted, label` | remote **audio** track mapped |
| `track.muted` / `track.unmuted` | `track_id, pc, slot` | RTP stopped / started for the track (SFUs mute idle senders; `unmuted` = audio really flowing) |
| `track.ended` | `track_id, pc, slot, reason` | track ended, PC closed, or sweep found it dead |
| `track.video` | `track_id, pc, mid, stream_ids` | remote video track (information only) |
| `player.started` | `utt, queued_ms` | first sample of an utterance rendered |
| `player.underrun` | `utt, played_ms` | queue starved mid-utterance (streaming TTS too slow) |
| `player.drained` | `utt, played_ms, reason: 'eos' \| 'timeout', underruns` | last queued sample rendered after `__host_playEnd()`, or `drainGraceMs` of starvation without EOS |
| `player.aborted` | `utt, played_ms, dropped_ms` | `__host_flush()` cut an utterance |
| `avatar.loaded` | `width, height` | still image decoded |
| `avatar.segments_ready` | `duration_s, listen, talk, width, height` | the take is playable in both `<video>` elements, first listen segment playing |
| `avatar.state` | `state: 'talk' \| 'listen', segment, at` | segments mode finished a crossfade into the other kind |
| `avatar.fallback` | `reason` | segments mode gave up (load error/timeout, unusable duration, seek stuck, stall > 1 s, draw error) -> still image |
| `avatar.start` / `avatar.stop` | `fps, width, height, mode` / `reason, frames` | render loop started / stopped |
| `capture.dropped` | `count` | chunks lost because `__host_audio` is missing (rate-limited) |
| `error` | `where, message` | any caught adapter error |

## 3. Page API (Node -> page via `page.evaluate`)

| call | returns | notes |
|---|---|---|
| `__host_play(b64pcm16)` | player state | enqueue PCM16 LE mono 24 kHz, any length (100–500 ms chunks recommended). Also accepts `Int16Array`/`ArrayBuffer`. Starts the context / worklet lazily; chunks pushed before the worklet is ready are queued. |
| `__host_playEnd()` | player state | end-of-stream marker for the current utterance -> exact `player.drained`. Without it, `drained` comes `drainGraceMs` (250 ms) after the queue starves (reason `timeout`). A push after EOS starts/continues normally. |
| `__host_flush()` | `Promise<{played_ms, dropped_ms}>` | discards the queue; output stops within one render quantum (5.3 ms) + 4 ms fade-out. Measured: evaluate round trip 5–14 ms; audio at the far end stops 5–33 ms later than the steady-state path latency; captured length = `played_ms` (±3 ms). |
| `__host_playerState()` | `{queued_ms, playing, played_ms, utt, underruns, ctx_state, worklet}` | `queued_ms`/`played_ms` mirror the worklet's 50 ms progress reports (<= 50 ms stale). |
| `__host_status()` | diagnostic snapshot | context, worklet state/error, player, mic clones, avatar (`mode, running, state, target_state, segments{active, ready, failed, duration_s, segs, kind, segment, position_s, switches, loops_done, late_seeks, pending_switch, fading, pre_ready, seek_ms}`), capture counters, mapped tracks, muted element count, binding presence. |
| `__host_setOpts(partial)` | merged opts | e.g. `{capture:false}` pauses chunk emission (P1 cost gating), `{fakeVideo:true}`. |
| `__host_setAvatar(x)` | `Promise` | string -> still image (PNG `data:`/`http(s):` URL); object -> reconfigure, e.g. `{mode:'segments', video, segments, still}` (re-initialises the take); `null` -> camera off for future requests, render loop stopped. |

Utterance semantics: `started` -> (`underrun`*) -> `drained` | `aborted`. `played_ms` counts rendered
audio frames (silence during underruns is not counted). `utt` increments per `started`. Barge-in
ratio for the floor controller = `played_ms / total_ms_pushed`.

## 4. Microphone (mouth)

* One `AudioContext({sampleRate: 24000, latencyHint: 'interactive'})`, created lazily, auto-resumed on
  `statechange`, watchdog every 1 s. Chrome resamples for the WebRTC encoder (48 kHz Opus) itself.
* `PlayerWorklet` (128-frame quanta) -> `MediaStreamAudioDestinationNode` (mono). Every
  `getUserMedia({audio})` call gets a **clone** of that track (so Telemost calling `track.stop()` on
  mute cannot kill the source), decorated with `label = micLabel`, `getSettings()` -> `deviceId
  'standup-host-mic'`, `channelCount 1`, `sampleRate 24000`, `echoCancellation false`.
* `MediaDevices.prototype.getUserMedia` / `enumerateDevices` and `Permissions.prototype.query` are
  replaced on the **prototype** (works for `.call` / captured references); everything not ours goes to
  the originals. Constraints are honoured loosely: any `audio` request -> our mic, whatever
  `deviceId` it asks for. `enumerateDevices()` -> `audioinput 'Ведущая' (standup-host-mic)`,
  `audiooutput 'Default'`, plus `videoinput 'Аватар' (standup-host-cam)` only when an avatar is set.
  `permissions.query({name:'microphone'})` -> `granted`; `camera` -> `granted` with avatar, else `prompt`
  (`denied` with `videoPolicy 'deny'`).
* No real device is ever opened. `--use-fake-ui-for-media-stream` is only a safety net.

## 5. Remote capture (ears)

* `RTCPeerConnection` is wrapped with a `Proxy` on the constructor (`instanceof`, `name`, statics,
  `toString` all native) plus prototype hooks on `setRemoteDescription` (catches PCs built from a
  captured native reference) and `close` (releases tracks). Any number of PCs, renegotiations and
  track add/remove cycles are handled; tracks are keyed by `MediaStreamTrack.id` and de-duplicated.
* Every remote **audio** track: `new MediaStream([track])` -> `MediaStreamAudioSourceNode` -> input
  `slot` of the `CaptureWorklet` (`numberOfInputs = slots`, mono explicit). The same stream is also
  attached to a hidden muted `<audio data-host="sink">` (Chromium needs a media-element sink for
  remote audio to reach WebAudio; verified in the loopback that muted elements do not stop capture).
* `CaptureWorklet`: per slot sum-of-squares -> dBFS every 1200 frames (50 ms), clipped mix ->
  Int16 every 2400 frames (100 ms), posted with a transferable buffer. Levels are labelled with the
  track ids mapped to the slots. Cost: 16 slots × 128 frames per quantum — negligible.
* Lifecycle: `ended` event, `pc.close()`, `connectionstatechange = closed` and a 2 s sweep
  (`readyState === 'ended'`) all release the slot and emit `track.ended`. `mute`/`unmute` are
  forwarded as events (with an SFU, `unmuted` is the real "this participant's audio is live" signal).
* Echo: our microphone is a local track; it never arrives as a remote `track` event, so it cannot
  enter the mix. Loopback: A's capture stays at -100 dBFS while A plays a -6 dBFS clip.

## 6. Speakers safety

`--mute-audio` is the primary guard. Belt and braces in the page: `HTMLMediaElement.prototype.play`
and the `srcObject` setter mute the element first (covers detached `new Audio()`), a
`MutationObserver` mutes every `<audio>/<video>` added to the DOM, a capture-phase `play` listener
re-mutes, and a 2 s sweep re-mutes everything. `muted = true` on elements does **not** stop WebRTC
audio from reaching our WebAudio graph (verified). Our own `AudioContext.destination` receives only
a gain-0 node. The avatar's own `<video>` elements are muted too (the take carries no audio we need).

## 7. Video / avatar camera

Camera is **off by default**: `getUserMedia({video})` rejects with `NotFoundError` ("Requested device
not found", consistent with the empty `videoinput` list); `{audio, video}` rejects too, like a real
machine without a camera — Telemost then has to ask for audio only (`videoPolicy: 'strip'` makes such
combined requests succeed with audio only; `'deny'` gives `NotAllowedError`; `'fake'` /
`fakeVideo: true` returns a 160×120 black canvas track at 1 fps).

With `opts.avatar` set, video requests return a **clone of a `canvas.captureStream(fps)` track**
(`label 'Аватар'`, `deviceId 'standup-host-cam'`, `getSettings()` with width/height/frameRate); a
`videoinput` device is listed and the camera permission reports `granted`. Common options:
`width 640`, `height 480`, `fps` (12 still / 15 segments), `bg '#050508'`, `glow '#7532FF'`, `label`,
`focusX/focusY` (0..1, where the face is; default centre), `zoom`.

### Still mode (`avatar = {src | path, ...}`)

* The portrait is drawn cover-fit (`fit: 'cover'`, default) with the focus point at the frame centre;
  `fit: 'contain'` or `zoom < 1` leave bars, which are filled with `bg` and feathered into the image
  edge (linear gradient over 6 % of the short side). `shape: 'circle'` gives a round crop instead.
* `path` (as in `config/settings.json`) is read by `buildInitConfig` and embedded as a `data:` URL
  (1024×1024 PNG ≈ 1.5 MB -> 2 MB init script; fine, but keep the file ≤ ~2 MB).
* Idle: static image with a ±0.4 % breathing scale on a 4 s period. Speaking: violet edge glow.

### Segments mode (`avatar = {mode:'segments', video, still|src|path, segments:{listen:[[a,b],…], talk:[[c,d],…]}, fps:15, crossfadeMs:250, loopFadeMs:400, ...}`)

One continuous take (`assets/live/kora_live.mp4`, 20 s, 1280×720) served same-origin; `segments`
are seconds inside the file. Placeholders until the take is analysed:
`listen [[0.3,3.7],[10.3,13.7],[18.2,19.8]]`, `talk [[4.3,9.7],[14.3,17.7]]`.

* **Two hidden muted `<video>` elements on the same URL** (`preload auto`, 2 px, opacity 0.01, in
  the DOM so Chrome keeps decoding). Ready when both report `loadeddata` (a MediaRecorder file
  with `duration = Infinity` is fixed by a seek past the end). The shown element is seeked to the
  first listen segment and played; `avatar.segments_ready` follows.
* **Pre-seek:** whenever an element becomes the shown one, the idle element is paused and seeked to
  the start of the *next* segment of the same kind (round-robin across that kind's segments for
  variety); its `seeked` event marks it ready (H.264 seeks measured at 24–78 ms median while paused).
  A seek that has not landed after 2.5 s is retried (twice), then the mode falls back to the still.
* **In-segment loop:** `loopFadeMs + 70 ms` before the current segment's end, if the idle element is
  ready it starts playing and is crossfaded in over `loopFadeMs`; then the roles swap, the old element
  is paused and the next pre-seek is issued. If the seek is late the shown element simply keeps
  playing past the segment end (counted in `late_seeks`) until the idle one is ready.
* **State switch:** `outputting = player.playing && rms > 0.001` (PlayerWorklet 50 ms reports);
  listen -> talk after 120 ms of output, talk -> listen after 400 ms of silence. The idle element is
  re-seeked to the **nearest** segment of the new kind (the one containing the current position, else
  the closest start) and crossfaded over `crossfadeMs`; a switch requested during a fade waits for the
  fade to finish; a request cancelled before the seek landed (voice resumed) just re-plans the loop.
  `avatar.state` fires when the crossfade into the other kind completes. `video.loop` (visible jump)
  and ping-pong (Chrome's reverse playback is unreliable) were rejected; the separate-files "loops"
  mode was dropped in favour of this engine (one file, same code path).
* **Framing:** the 16:9 source is cropped to the output aspect (4:3 by default) around
  `focusX/focusY`; `zoom` > 1 crops tighter. A portrait padded to 1280×720 on `#050508` keeps
  120 px dark bars on each side at 4:3 with `zoom 1` (`zoom 1.33` fills the frame with the portrait,
  losing top/bottom).
* **Glow:** same violet edge glow, subtler (`alpha 0.06 + 0.28·k` vs `0.15 + 0.5·k` in still mode).
* **Fallback:** `<video>` error, load timeout (20 s), unusable duration, seek stuck, the shown
  element's `currentTime` not advancing for > 1 s, or a draw/update exception -> `avatar.fallback
  {reason}` and the still image is drawn (loaded at init from `still`/`src`/`path`, also shown until
  the take is ready).
* Render loop: `setInterval(1000/fps)`, runs only while a live+enabled clone of the track exists
  (`track.stop()` is hooked on `MediaStreamTrack.prototype.stop`; `enabled = true` and a new
  `getUserMedia({video})` restart it; the shown element is paused/resumed with it). No per-frame
  allocations beyond canvas calls (alpha strings, gradients and layer scratch arrays are prebuilt).

### Measurements (loopback, 2026-09-18)

Tab B received 640×480 frames in both modes. Still: mean luma 63, 72 % non-black, frame diff
idle→speaking 4.6 gray levels (idle jitter 0.4). Segments (generated 20 s 1280×720 H.264 stand-in with
the placeholder ranges): `talk` 500 ms after the first sample, `listen` 1.2 s after the end,
2 switches, 3 in-segment loops, 0 late seeks, pre-seek median 24–28 ms, no fallback, talk-vs-listen
frame diff 4.4–4.8 (listen-listen 1.0, the stand-in "listen" animation moves).

CPU (Chrome tree via `SystemInfo.getProcessInfo`; machine shared with other agents, so ±30 %):
audio-only loopback ≈28 % of one core; still avatar ≈99–109 %; segments avatar ≈126–138 %
(renderer 87–95 %, GPU 21–25 %, network 7–8 %, audio service 5 %). The renderer share is dominated
by the software VP8 encode + decode of the 640×480 WebRTC stream in **two** tabs; the 720p H.264
take decodes in the GPU process (+10 % over still). In production only the encode side (A) runs in
our browser; WP1 should measure on the real call (plus 12–15 incoming tiles, S5). If it is tight:
`fps 12`, or a 960×540 take.

## 8. Failure modes

| symptom | event | what happens / what to do |
|---|---|---|
| CSP blocks the blob worklet | `worklet.error {message}` | no mouth, no ears. Create the context with `bypassCSP: true`; the host should abort the run on this event. |
| context suspended / interrupted | `audio.state {state}` | auto `resume()` with 500 ms backoff; if `currentTime` freezes > 2 s: `audio.stalled` + suspend/resume kick, `audio.resumed` when it moves again. |
| TTS chunks arrive slower than real time | `player.underrun` | silence is rendered, `played_ms` pauses; after `drainGraceMs` without EOS -> `drained {reason:'timeout'}`. Push ahead ≥ 200 ms or call `__host_playEnd()` deterministically. |
| host forgets `__host_playEnd()` | `player.drained {reason:'timeout'}` 250 ms late | acceptable for clips; use `playEnd()` for exact timing. |
| binding missing (page opened without `attachPageAudio`) | `capture.dropped`, console `[host]` lines | chunks are dropped, nothing buffers. |
| > 15 remote audio tracks | `track.added {shared:true}` + levels `track_id:'overflow'` | audio still in the mix, per-track levels only for the first 15. |
| track never unmutes | `track.added {muted:true}` without `track.unmuted` | SFU sends nothing for that participant yet (or ever); levels stay -100. |
| take missing / broken / seek stuck / stalled | `avatar.fallback {reason}` | still image is shown; fix the file, the ranges or the `serveAssets` prefix/dir. |
| `serveAssets` not registered before `goto` | `avatar.fallback 'video error'` (404) | register the route before navigation. |
| page navigates / reloads | new `host.installed` | everything is per-document; the host must re-issue `play` state; bindings and routes survive navigation. |
| `__host_flush` gets no worklet reply within 250 ms | promise resolves with `timeout:true` | should not happen; treat as audio thread stalled (`audio.stalled` follows). |

## 9. Loopback test

```
cd scripts/standup_host
node tools/loopback_test.js                          # audio + segments avatar (assets/live/kora_live.mp4 if present, else a generated stand-in)
LOOPBACK_AVATAR=still node tools/loopback_test.js    # audio + still avatar
LOOPBACK_VIDEO=0 node tools/loopback_test.js         # audio only (CPU baseline)
```

Chrome (channel `chrome`, headful, window at -2400,0, flags from §1) serves `http://127.0.0.1:<port>`
from `node:http`; tab B (callee) and tab A (caller, mic + avatar) connect one RTCPeerConnection via a
`BroadcastChannel` (offer/answer/ICE, host candidates only). Without `assets/live/kora_live.mp4` the
test records a 20 s 1280×720 H.264 stand-in take once (MediaRecorder from a canvas, talk/listen
animation switched by the placeholder ranges) into `tests/fixtures/loops/`; with the real take it
reads `avatar.segments` from `config/settings.json` when present. Results of the runs on 2026-09-18
(Windows 11, Node 24.13.1, Chrome stable, playwright-core 1.63):

| # | check | result | numbers |
|---|---|---|---|
| 1 | 1 s chirp + 2 s speech-like clip A→B, envelope correlation | PASS | corr 0.97–0.997, push→capture 77–122 ms, started→capture 64–111 ms, peak −5.8 dBFS (source −6.0), gain −0.1 dB |
| 1b | player events | PASS | `started` 8–28 ms after first push, `drained` played_ms 3000 (reason eos), 0 underruns |
| 2 | flush after 500 ms | PASS | evaluate RTT 5–14 ms; played 553–612 / dropped ≈4440 ms; far-end energy drop 5–33 ms later than the path latency; captured length = played_ms ±3 ms |
| 3a | per-track levels cadence | PASS | chunk interval mean 97–100 ms, p95 101–123, max 111–347 (loaded machine); 20.3–20.9 level frames/s; 0 seq gaps |
| 3b | echo isolation | PASS | A captured 63–65 chunks while speaking, max −100 dBFS |
| 3c | capture with muted media elements | PASS | all B media elements muted, audio flows |
| 4 | WAV fixture | PASS | `tests/fixtures/loopback_capture.wav`, 10–14 s |
| 5a | avatar frames reach B | PASS | 640×480, mean luma 45 (segments) / 63 (still), 50–72 % non-black |
| 5b | still: glow reacts to speech | PASS | frame diff vs idle 4.6 gray levels (idle jitter 0.4) |
| 5d | segments: talk on speech / listen after silence / in-segment loop / visible switch | PASS | talk at +500 ms, listen at +1.2 s, 2 switches, 3 loops, 0 late seeks, seek median 24–28 ms, no fallback, diff 4.4–4.8 |
| 5c | camera toggle | PASS | stop() halts loop, new getUserMedia restarts |
| 6 | devices / permissions / PC proxy / detached `<audio>` muted | PASS | see console output |
| — | CPU | info | Node 8–14 %, Chrome tree 99–138 % of one core with video (renderer 80–95 %, GPU 12–25 %); 28 % audio-only |

## 10. What to verify first in the real Telemost spike (WP1)

1. `worklet.ready` arrives on telemost.yandex.ru (CSP) — if `worklet.error`, confirm `bypassCSP`.
2. Pre-join: does clicking `turn-on-mic-button` produce `gum.request {audio:true, result:'ok'}` and does
   the level meter move when `__host_play` runs? Does Telemost request `{audio, video}` together
   (then decide `videoPolicy 'strip'` vs avatar)?
3. After join: `pc.created`, `track.added`, and crucially `track.unmuted` per participant; `mix`
   levels above −60 dBFS when someone talks. Check whether Telemost uses one audio track per
   participant or SFU "slots" (track ids stay, content switches) — decides P1 attribution.
4. Participants hear the clip (S2). If not: `RTCRtpSender.replaceTrack` fallback with the mic clone.
5. Camera ON with the avatar: tile shows the take, `avatar.segments_ready` then `avatar.state` events
   while she speaks, no `avatar.fallback`; the `/__host_assets/*` route works on the Telemost origin
   (Range requests -> 206). Camera OFF/ON emits `avatar.stop`/`avatar.start`. Check Telemost does not
   re-request video with exact width/height constraints it then rejects, and whether its encoder
   bitrate keeps the portrait readable at 640×480.
6. Nobody in the room hears the bot's machine speakers (`--mute-audio` + muted elements).
7. CPU with 12–15 incoming video tiles (S5) — if high, disable incoming video in Telemost settings;
   the adapter itself is ≈ a few % (worklets) + the camera encode (+ GPU decode of the take).
8. `navigator.webdriver` / automation detection is WP1's launch concern (`--disable-blink-features=AutomationControlled`).
