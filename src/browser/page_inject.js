// Page audio adapter for the standup host (WP2).
//
// ============================================================================
// CONTRACT (full version: docs/page_audio.md)
// ============================================================================
//
// Install (Node side, BEFORE page.goto):
//
//   import { attachPageAudio } from './browser/page_inject.js';
//   const audio = await attachPageAudio(page, {
//     onAudio: (pcm /* Int16Array 24 kHz mono, 2400 frames */, levels, meta) => {},
//     onEvent: (ev /* {type, t, ...} */) => {},
//     opts: { /* see DEFAULT_OPTS */ },
//   });
//   await page.goto(url);
//
//   attachPageAudio = page.exposeFunction('__host_audio', ...) + page.exposeFunction('__host_event', ...)
//                     + page.addInitScript({ content: buildInitScript(opts) }).
//   Both exposeFunction calls MUST precede navigation: the init script runs at document start of
//   every document (page + frames) and the bindings must already exist in that document.
//   The browser context should be created with { bypassCSP: true } so the worklet Blob URL is
//   not blocked by the site's Content-Security-Policy (script-src). Recommended Chrome flags:
//   --autoplay-policy=no-user-gesture-required --mute-audio --use-fake-ui-for-media-stream
//   --disable-background-timer-throttling --disable-renderer-backgrounding
//   --disable-backgrounding-occluded-windows
//
// Bindings (page -> Node, via exposeFunction; fire-and-forget, never awaited by the page):
//
//   window.__host_audio(b64pcm16, levelsJson, metaJson)
//     b64pcm16   base64 of PCM16 little-endian mono at 24 000 Hz, 2400 frames (100 ms), 4800 bytes;
//                the clipped sum of ALL remote audio tracks currently mapped (never our own mic).
//     levelsJson JSON array, one entry per mapped remote track:
//                [{"track_id":"<MediaStreamTrack.id>","slot":3,"frames":[-31.2,-33.8]}]
//                frames = RMS in dBFS for each 50 ms half of the chunk (2 per chunk); -100 = silence.
//     metaJson   {"seq":12,"ctx_time":1.2345,"t":12345.6,"sr":24000,"frames":2400,
//                 "mix":[-30.1,-32.0],"tracks":1}
//                seq        chunk counter (detect drops), ctx_time = AudioContext.currentTime (s)
//                at chunk end, t = performance.now() (ms) when forwarded, mix = dBFS of the mix.
//     Cadence: 10 calls/s while >= 1 remote audio track is mapped and capture is enabled.
//     No mapped tracks -> no calls (host relies on track.* events).
//
//   window.__host_event(jsonString)   ->  {type, t: performance.now(), ...}
//     host.installed {version, top, href}          audio.context {state, sample_rate, base_latency}
//     audio.state {state}                          audio.stalled {current_time} / audio.resumed
//     worklet.ready {}                             worklet.error {message}     <- fatal for audio
//     gum.request {audio, video, result, error?}   pc.created {pc}   pc.state {pc, state}
//     track.added {track_id, pc, slot, mid, stream_ids, muted, label}
//     track.muted / track.unmuted / track.ended {track_id, pc, slot, reason}
//     track.video {track_id, pc, mid, stream_ids}  (remote video tracks: information only)
//     player.started {utt, queued_ms}              player.underrun {utt, played_ms}
//     player.drained {utt, played_ms, reason: "eos"|"timeout", underruns}
//     player.aborted {utt, played_ms, dropped_ms}  capture.dropped {count}   error {where, message}
//     avatar.loaded {width, height}  avatar.start {fps, width, height}  avatar.stop {reason, frames}
//
// Page API (Node -> page via page.evaluate; also wrapped by the PageAudio helper below):
//
//   window.__host_play(b64pcm16)      enqueue PCM16 LE mono 24 kHz (any length); returns player state.
//   window.__host_playEnd()           end-of-stream marker: "drained" fires exactly when the last
//                                     queued sample has been rendered (otherwise after drainGraceMs
//                                     of starvation, reason "timeout").
//   window.__host_flush()             -> Promise<{played_ms, dropped_ms}>; output stops within one
//                                     render quantum + 4 ms fade (< 15 ms), queue is discarded.
//   window.__host_playerState()       -> {queued_ms, playing, played_ms, utt, underruns, ctx_state,
//                                         worklet}   (queued_ms is <= 50 ms stale)
//   window.__host_status()            -> diagnostic snapshot (context, worklet, tracks, mic, avatar, capture)
//   window.__host_setOpts(partial)    -> merge runtime options (capture on/off, fakeVideo, ...)
//   window.__host_setAvatar(src)      -> Promise<{width,height}>; enables/swaps the avatar image
//                                     (PNG data: or http(s): URL); null disables the camera again.
//   window.__hostOpts                 the live options object (avatar, fakeVideo, ...)
//
// Video: camera is OFF by default (video requests fail with NotFoundError). With opts.avatar =
// {src | path, fps: 12, width: 640, height: 480} video requests get a canvas.captureStream(fps)
// track: the portrait cover-fit on #050508, and a soft violet (#7532FF) edge glow that follows the
// player's output RMS while the host speaks. With opts.avatar = {mode:'segments', video, still|path,
// segments:{listen:[[a,b],...], talk:[[c,d],...]}, fps: 15, crossfadeMs: 250, loopFadeMs: 400} one
// continuous take is drawn from two muted <video> elements: the shown one loops inside the current
// kind's segments (round-robin, pre-seeked idle element, crossfade), 'talk' while the player outputs
// audio (hysteresis 120/400 ms, nearest segment of the new kind, crossfade); automatic fallback to
// the still on error/seek-stuck/stall. Serve the file same-origin with
// serveAssets(page, {prefix:'/__host_assets/', dir}) BEFORE page.goto(). The render timer stops when
// the page stops/disables every clone of the track and restarts on the next getUserMedia({video}).
//
// Everything on window is prefixed __host; nothing else is added to the global scope.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { WORKLET_MODULE_SRC } from './worklets.js';

export const VERSION = 'wp2-1';

export const DEFAULT_OPTS = Object.freeze({
  sampleRate: 24000,     // AudioContext rate; Chrome resamples remote tracks and our mic
  chunkMs: 100,          // capture chunk length -> __host_audio cadence
  levelMs: 50,           // per-track RMS frame length (chunkMs must be a multiple)
  slots: 16,             // max simultaneously mapped remote audio tracks (extra ones share the last slot)
  capture: true,         // emit __host_audio chunks
  trackTaps: false,      // also emit per-track pcm (__host_track_audio) while a track has sound (yandex_cascade STT)
  videoPolicy: 'notfound', // 'notfound' | 'deny' | 'strip' | 'fake' (see docs)
  fakeVideo: false,      // true = same as videoPolicy 'fake' (tiny black canvas track, 1 fps)
  micLabel: 'Ведущая',
  micDeviceId: 'standup-host-mic',
  micGroupId: 'standup-host',
  avatar: null,          // { src | path, fps: 12, width: 640, height: 480, fit: 'cover'|'contain', zoom, focusX, focusY,
                         //   shape: 'cover'|'circle', bg: '#050508', glow: '#7532FF', label } -> camera tile
  camLabel: 'Аватар',    // label of the fake videoinput device when an avatar is configured
  camDeviceId: 'standup-host-cam',
  muteMedia: true,       // force muted=true on every <audio>/<video> the page creates
  drainGraceMs: 250,     // starvation without playEnd() before "drained" (reason timeout)
  fadeMs: 4,             // flush fade-out
  progressMs: 50,        // player progress reports (feeds queued_ms / played_ms mirror)
  installInFrames: true, // also install in child frames (lazy: no AudioContext until needed)
  debug: false,          // console.debug chatter
});

// ---------------------------------------------------------------------------------------------
// Page-side code. Runs in the page as `(pageMain)(cfg)`. Must be self-contained: no references to
// module scope, no imports. `cfg` = { opts, workletSrc, version }.
// ---------------------------------------------------------------------------------------------
export function pageMain(cfg) {
  'use strict';
  const W = window;
  if (W.__host_installed) return;
  W.__host_installed = true;

  const DEFAULTS = {
    sampleRate: 24000, chunkMs: 100, levelMs: 50, slots: 16, capture: true, trackTaps: false,
    videoPolicy: 'notfound', fakeVideo: false, micLabel: 'Ведущая', micDeviceId: 'standup-host-mic',
    micGroupId: 'standup-host', avatar: null, camLabel: 'Аватар', camDeviceId: 'standup-host-cam',
    muteMedia: true, drainGraceMs: 250, fadeMs: 4, progressMs: 50, installInFrames: true, debug: false,
  };
  const opts = Object.assign({}, DEFAULTS, (cfg && cfg.opts) || {});
  W.__hostOpts = opts;
  let isTop = true;
  try { isTop = W.top === W; } catch (e) { isTop = false; }
  if (!isTop && !opts.installInFrames) return;

  const VERSION = (cfg && cfg.version) || 'wp2';
  const SR = opts.sampleRate;
  const CHUNK_FRAMES = Math.round(SR * opts.chunkMs / 1000);
  const LEVEL_FRAMES = Math.round(SR * opts.levelMs / 1000);
  const now = () => (W.performance && W.performance.now) ? W.performance.now() : Date.now();
  const nativeAddEventListener = W.EventTarget.prototype.addEventListener;

  function dbg() {
    if (!opts.debug) return;
    try { console.debug.apply(console, ['[host]'].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ }
  }
  function info() {
    try { console.debug.apply(console, ['[host]'].concat(Array.prototype.slice.call(arguments))); } catch (e) { /* ignore */ }
  }

  // ---- events up to Node ----------------------------------------------------------------------
  const droppedEvents = [];
  function emit(type, data) {
    const ev = Object.assign({ type: type, t: Math.round(now() * 10) / 10 }, data || {});
    if (!isTop) ev.frame = String(W.location && W.location.href).slice(0, 120);
    const fn = W.__host_event;
    if (typeof fn === 'function') {
      try { const r = fn(JSON.stringify(ev)); if (r && typeof r.catch === 'function') r.catch(function () {}); } catch (e) { dbg('event send failed', e); }
    } else {
      if (droppedEvents.length < 50) droppedEvents.push(ev);
      dbg('event (no binding)', ev);
    }
  }
  function fail(where, e) {
    const message = String((e && e.message) || e);
    info('error in', where, message);
    emit('error', { where: where, message: message });
  }

  // ---- base64 <-> PCM16 -----------------------------------------------------------------------
  function b64ToInt16(b64) {
    const bin = W.atob(b64);
    const n = bin.length & ~1;
    const buf = new ArrayBuffer(n);
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return new Int16Array(buf);
  }
  function bytesToB64(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return W.btoa(s);
  }
  function domErr(name, message) {
    try { return new DOMException(message, name); } catch (e) { const err = new Error(message); err.name = name; return err; }
  }

  // ---- AudioContext + worklets ----------------------------------------------------------------
  let ctx = null;
  let micDest = null;       // MediaStreamAudioDestinationNode -> bot microphone
  let silentGain = null;    // gain 0 -> destination, keeps the graph pulled
  let playerNode = null;
  let captureNode = null;
  let workletState = 'idle';    // idle | loading | ready | error
  let workletError = null;
  let workletPromise = null;
  let lastCtxTime = -1;
  let stalledSince = 0;
  let stalledReported = false;
  let resumeTimer = null;

  function ensureRunning() {
    if (!ctx) return;
    if (ctx.state === 'running') return;
    if (ctx.state === 'closed') return;
    if (resumeTimer) return;
    resumeTimer = setTimeout(function () { resumeTimer = null; }, 500);
    ctx.resume().then(function () { dbg('resumed'); }).catch(function (e) { dbg('resume failed', e); });
  }
  function onStateChange() {
    emit('audio.state', { state: ctx.state });
    if (ctx.state !== 'running') setTimeout(ensureRunning, 0);
  }
  function watchdog() {
    if (!ctx || ctx.state === 'closed') return;
    if (ctx.state !== 'running') { ensureRunning(); return; }
    const t = ctx.currentTime;
    if (t === lastCtxTime) {
      if (!stalledSince) stalledSince = now();
      else if (now() - stalledSince > 2000 && !stalledReported) {
        stalledReported = true;
        emit('audio.stalled', { current_time: t });
        ctx.suspend().then(function () { return ctx.resume(); }).catch(function () {});
      }
    } else {
      if (stalledReported) { stalledReported = false; emit('audio.resumed', { current_time: t }); }
      stalledSince = 0;
    }
    lastCtxTime = t;
  }
  function getCtx() {
    if (ctx) return ctx;
    const AC = W.AudioContext || W.webkitAudioContext;
    ctx = new AC({ sampleRate: SR, latencyHint: 'interactive' });
    micDest = new MediaStreamAudioDestinationNode(ctx, { channelCount: 1, channelCountMode: 'explicit' });
    silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    silentGain.connect(ctx.destination);
    nativeAddEventListener.call(ctx, 'statechange', onStateChange);
    emit('audio.context', { state: ctx.state, sample_rate: ctx.sampleRate, base_latency: ctx.baseLatency });
    info('AudioContext', ctx.state, ctx.sampleRate + ' Hz');
    ensureRunning();
    setInterval(watchdog, 1000);
    loadWorklets();
    return ctx;
  }
  function loadWorklets() {
    if (workletPromise) return workletPromise;
    getCtx();
    workletState = 'loading';
    let url = null;
    try {
      url = URL.createObjectURL(new Blob([cfg.workletSrc], { type: 'application/javascript' }));
    } catch (e) {
      workletState = 'error'; workletError = String(e);
      fail('worklet.blob', e);
      return (workletPromise = Promise.reject(e));
    }
    workletPromise = ctx.audioWorklet.addModule(url).then(function () {
      try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ }
      playerNode = new AudioWorkletNode(ctx, 'host-player', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { fadeMs: opts.fadeMs, drainGraceMs: opts.drainGraceMs, progressMs: opts.progressMs },
      });
      playerNode.port.onmessage = function (e) { onPlayerMessage(e.data); };
      playerNode.onprocessorerror = function (e) { fail('player.processor', e); };
      playerNode.connect(micDest);
      playerNode.connect(silentGain);   // belt and braces: guarantees the node is pulled
      captureNode = new AudioWorkletNode(ctx, 'host-capture', {
        numberOfInputs: opts.slots, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
        processorOptions: { chunkFrames: CHUNK_FRAMES, levelFrames: LEVEL_FRAMES, enabled: !!opts.capture, trackTaps: !!opts.trackTaps },
      });
      captureNode.port.onmessage = function (e) { onCaptureMessage(e.data); };
      captureNode.onprocessorerror = function (e) { fail('capture.processor', e); };
      captureNode.connect(silentGain);
      workletState = 'ready';
      info('worklets ready');
      emit('worklet.ready', {});
      flushPendingPlays();
      connectPendingTracks();
    }).catch(function (e) {
      workletState = 'error'; workletError = String((e && e.message) || e);
      info('worklet load FAILED (CSP? use bypassCSP:true):', workletError);
      emit('worklet.error', { message: workletError });
      throw e;
    });
    workletPromise.catch(function () {});
    return workletPromise;
  }

  // ---- player (mouth) -------------------------------------------------------------------------
  const player = {
    pushedTotal: 0, consumedTotal: 0, playing: false, playedMs: 0, utt: 0, underruns: 0,
    pending: [], pendingEos: false, flushSeq: 0, waiters: new Map(), rms: 0,
  };
  function playerState() {
    const queued = Math.max(0, player.pushedTotal - player.consumedTotal) + pendingFrames();
    return {
      queued_ms: Math.round(queued / SR * 1000), playing: player.playing, played_ms: player.playedMs,
      utt: player.utt, underruns: player.underruns, ctx_state: ctx ? ctx.state : 'none', worklet: workletState,
    };
  }
  function pendingFrames() { let n = 0; for (let i = 0; i < player.pending.length; i++) n += player.pending[i].length; return n; }
  function onPlayerMessage(m) {
    if (!m) return;
    switch (m.type) {
      case 'started':
        player.playing = true; player.utt = m.utt; player.playedMs = 0; player.rms = 0;
        emit('player.started', { utt: m.utt, queued_ms: m.queued_ms });
        break;
      case 'progress':
        player.consumedTotal = m.consumed; player.playedMs = m.played_ms; player.rms = m.rms || 0;
        break;
      case 'underrun':
        player.underruns++; player.rms = 0;
        emit('player.underrun', { utt: m.utt, played_ms: m.played_ms });
        break;
      case 'drained':
        player.playing = false; player.consumedTotal = m.consumed; player.playedMs = m.played_ms; player.rms = 0;
        emit('player.drained', { utt: m.utt, played_ms: m.played_ms, reason: m.reason, underruns: m.underruns });
        break;
      case 'flushed': {
        player.playing = false; player.consumedTotal = m.consumed; player.playedMs = m.played_ms; player.rms = 0;
        const w = player.waiters.get(m.id);
        if (w) { player.waiters.delete(m.id); clearTimeout(w.timer); w.resolve({ played_ms: m.played_ms, dropped_ms: m.dropped_ms }); }
        if (!m.idle) emit('player.aborted', { utt: m.utt, played_ms: m.played_ms, dropped_ms: m.dropped_ms });
        break;
      }
      default: break;
    }
  }
  function flushPendingPlays() {
    if (!playerNode) return;
    while (player.pending.length) {
      const pcm = player.pending.shift();
      playerNode.port.postMessage({ type: 'push', pcm: pcm.buffer }, [pcm.buffer]);
    }
    if (player.pendingEos) { player.pendingEos = false; playerNode.port.postMessage({ type: 'eos' }); }
  }
  function hostPlay(data) {
    try {
      let pcm;
      if (typeof data === 'string') pcm = b64ToInt16(data);
      else if (data instanceof Int16Array) pcm = new Int16Array(data);
      else if (data instanceof ArrayBuffer) pcm = new Int16Array(data.slice(0, data.byteLength & ~1));
      else throw new TypeError('__host_play: expected base64 string');
      if (pcm.length) {
        getCtx(); ensureRunning();
        player.pushedTotal += pcm.length;
        if (playerNode) playerNode.port.postMessage({ type: 'push', pcm: pcm.buffer }, [pcm.buffer]);
        else { player.pending.push(pcm); player.pendingEos = false; loadWorklets(); }
      }
    } catch (e) { fail('play', e); }
    return playerState();
  }
  function hostPlayEnd() {
    if (playerNode) playerNode.port.postMessage({ type: 'eos' });
    else if (player.pending.length) player.pendingEos = true;
    return playerState();
  }
  function hostFlush() {
    if (!playerNode) {
      const dropped = pendingFrames();
      player.pending = []; player.pendingEos = false;
      player.pushedTotal -= dropped;
      return Promise.resolve({ played_ms: 0, dropped_ms: Math.round(dropped / SR * 1000) });
    }
    const id = ++player.flushSeq;
    const st = playerState();
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        player.waiters.delete(id);
        resolve({ played_ms: player.playedMs, dropped_ms: st.queued_ms, timeout: true });
      }, 250);
      player.waiters.set(id, { resolve: resolve, timer: timer });
      playerNode.port.postMessage({ type: 'flush', id: id });
    });
  }

  // ---- avatar camera (canvas.captureStream) ---------------------------------------------------
  // Enabled when opts.avatar has a source (still: src/path; segments: video + segments) or via
  // __host_setAvatar(). Two modes share one canvas + captureStream track:
  //   still    : the portrait cover-fit (face anchored with focusX/focusY) on #050508; uncovered
  //              bars (fit 'contain' / zoom < 1) are feathered into the image edge.
  //   segments : ONE continuous take (video url) with listen/talk time ranges. Two muted <video>
  //              elements on the same URL: the shown one plays inside the current segment while the
  //              idle one is pre-seeked (paused, 'seeked' awaited) to the next segment of the same
  //              kind (round-robin) -> loopFadeMs before the segment end it starts and is crossfaded
  //              in. Player outputting audio -> 'talk' after 120 ms, back to 'listen' after 400 ms of
  //              silence: the idle element is seeked to the nearest segment of the new kind and
  //              crossfaded over crossfadeMs. A late seek never interrupts: the shown element keeps
  //              playing until the idle one reports 'seeked'. Video error / seek stuck / stall > 1 s
  //              -> automatic fallback to the still image.
  // A soft violet (#7532FF) edge glow follows the smoothed output RMS (attack 50 ms, release 250 ms;
  // subtler over video). The render timer runs only while a live+enabled track clone exists.
  const cam = {
    canvas: null, g: null, stream: null, timer: null, img: null, bg: '#050508', glow: '117,50,255',
    clones: new Set(), running: false, env: 0, lastTick: 0, frames: 0, loading: null,
    w: 640, h: 480, fps: 12, shape: 'cover', layout: null, strips: null, mode: 'still',
  };
  const seg = {
    active: false, ready: false, failed: null, url: null, els: null, cur: 0, idle: 1, duration: 0,
    kind: 'listen', state: 'listen', segs: null, idx: { listen: 0, talk: 0 }, curSeg: null,
    pre: null,            // pre-seek of the idle element: {kind, i, seg, target, ready, since, retries}
    fade: null,           // crossfade in progress: {start, ms, kind, i, seg}
    pendingSwitch: null,  // kind requested by the voice state machine, waiting for the idle seek
    talkingSince: 0, silentSince: 0, crossfadeMs: 250, loopFadeMs: 400,
    switches: 0, loopsDone: 0, lateSeeks: 0, seekMs: [], lateFlagged: false,
    lastVT: -1, stallSince: 0, crop: null, gen: 0,
  };
  const ALPHA = []; for (let i = 0; i <= 20; i++) ALPHA.push((i / 20).toFixed(2));   // no per-frame strings
  const GLOW = []; for (let i = 0; i <= 20; i++) GLOW.push('');                     // filled by applyAvatarOpts
  function avatarEnabled() {
    const a = opts.avatar;
    return !!(a && (a.src || (a.mode === 'segments' && a.video)));
  }
  function hexToRgb(hex, fallback) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return fallback;
    const v = parseInt(m[1], 16);
    return ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255);
  }
  function applyAvatarOpts() {
    const a = opts.avatar || {};
    cam.mode = a.mode === 'segments' ? 'segments' : 'still';
    cam.fps = a.fps > 0 ? a.fps : (cam.mode === 'segments' ? 15 : 12);
    cam.shape = a.shape === 'circle' ? 'circle' : 'cover';
    cam.bg = /^#[0-9a-f]{6}$/i.test(a.bg || '') ? a.bg : '#050508';
    cam.glow = hexToRgb(a.glow, '117,50,255');
    seg.crossfadeMs = a.crossfadeMs > 0 ? a.crossfadeMs : 250;
    seg.loopFadeMs = a.loopFadeMs > 0 ? a.loopFadeMs : 400;
    for (let i = 0; i <= 20; i++) GLOW[i] = 'rgba(' + cam.glow + ',' + ALPHA[i] + ')';
    cam.layout = null;
    seg.crop = null;
    cam.strips = null;
    if (cam.g) {
      // soft inner glow along the frame edges: four gradients built once, intensity via globalAlpha
      const w = cam.w, h = cam.h, G = Math.max(12, Math.round(Math.min(w, h) * 0.08));
      const c1 = 'rgba(' + cam.glow + ',1)', c0 = 'rgba(' + cam.glow + ',0)';
      const mk = function (x0, y0, x1, y1, rx, ry, rw, rh) {
        const gr = cam.g.createLinearGradient(x0, y0, x1, y1);
        gr.addColorStop(0, c1); gr.addColorStop(0.45, 'rgba(' + cam.glow + ',0.35)'); gr.addColorStop(1, c0);
        return { grad: gr, x: rx, y: ry, w: rw, h: rh };
      };
      cam.strips = [mk(0, 0, G, 0, 0, 0, G, h), mk(w, 0, w - G, 0, w - G, 0, G, h), mk(0, 0, 0, G, 0, 0, w, G), mk(0, h, 0, h - G, 0, h - G, w, G)];
    }
  }
  function loadAvatarImage(src) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous';
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('avatar image failed to load: ' + String(src).slice(0, 80))); };
      img.src = src;
    });
  }
  function ensureCam() {
    if (cam.canvas) return;
    const a = opts.avatar || {};
    cam.w = a.width || 640; cam.h = a.height || 480;
    cam.canvas = document.createElement('canvas');
    cam.canvas.width = cam.w; cam.canvas.height = cam.h;
    cam.g = cam.canvas.getContext('2d', { alpha: false });
    applyAvatarOpts();
    cam.stream = cam.canvas.captureStream(cam.fps);
    if (cam.mode === 'segments') initSegments();
    drawFrame(0);
  }
  // Where the still image goes inside the frame (recomputed on image swap / option change).
  function layoutImage() {
    const img = cam.img, w = cam.w, h = cam.h, a = opts.avatar || {};
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (!iw || !ih) return null;
    const fit = a.fit === 'contain' ? 'contain' : 'cover';
    const zoom = a.zoom > 0 ? a.zoom : 1;
    const s = (fit === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih)) * zoom;
    const dw = iw * s, dh = ih * s;
    const fx = a.focusX != null ? a.focusX : 0.5, fy = a.focusY != null ? a.focusY : 0.5;
    let x = w / 2 - fx * dw, y = h / 2 - fy * dh;              // focus point -> frame centre
    if (dw >= w) x = Math.min(0, Math.max(w - dw, x)); else x = (w - dw) / 2;   // no gaps if it covers
    if (dh >= h) y = Math.min(0, Math.max(h - dh, y)); else y = (h - dh) / 2;
    const g = cam.g, feathers = [], F = Math.max(8, Math.round(Math.min(w, h) * 0.06));
    const mk = function (x0, y0, x1, y1, rx, ry, rw, rh) {
      const gr = g.createLinearGradient(x0, y0, x1, y1);
      gr.addColorStop(0, cam.bg); gr.addColorStop(1, 'rgba(5,5,8,0)');
      feathers.push({ grad: gr, x: rx, y: ry, w: rw, h: rh });
    };
    if (x > 0.5) mk(x, 0, x + F, 0, x, y, F, dh);
    if (x + dw < w - 0.5) mk(x + dw, 0, x + dw - F, 0, x + dw - F, y, F, dh);
    if (y > 0.5) mk(0, y, 0, y + F, x, y, dw, F);
    if (y + dh < h - 0.5) mk(0, y + dh, 0, y + dh - F, x, y + dh - F, dw, F);
    return { x: x, y: y, dw: dw, dh: dh, feathers: feathers };
  }
  function setAvatar(src, extra) {
    if (!opts.avatar) opts.avatar = {};
    if (extra) Object.assign(opts.avatar, extra);
    opts.avatar.src = src;
    if (cam.canvas) applyAvatarOpts();
    const p = loadAvatarImage(src).then(function (img) {
      cam.img = img; cam.layout = null;
      if (cam.canvas) drawFrame(now());
      emit('avatar.loaded', { width: img.naturalWidth, height: img.naturalHeight });
      return { width: img.naturalWidth, height: img.naturalHeight };
    });
    p.catch(function (e) { fail('avatar.load', e); });
    cam.loading = p;
    return p;
  }

  // ---- segments mode --------------------------------------------------------------------------
  function makeVideo(url) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.loop = false;
    v.setAttribute('data-host', 'avatar');
    v.setAttribute('playsinline', '');
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1;';
    v.src = url;
    (document.body || document.documentElement).appendChild(v);
    return v;
  }
  function fixDuration(v) {   // MediaRecorder WebMs report Infinity until seeked past the end
    if (Number.isFinite(v.duration) && v.duration > 0) return Promise.resolve();
    return new Promise(function (resolve) {
      let done = false;
      const finish = function () { if (!done) { done = true; resolve(); } };
      nativeAddEventListener.call(v, 'seeked', function () {
        nativeAddEventListener.call(v, 'seeked', finish, { once: true });
        try { v.currentTime = 0; } catch (e) { finish(); }
      }, { once: true });
      try { v.currentTime = 1e101; } catch (e) { finish(); }
      setTimeout(finish, 3000);
    });
  }
  function whenLoaded(v, url) {
    return new Promise(function (resolve, reject) {
      const ok = function () { fixDuration(v).then(resolve); };
      nativeAddEventListener.call(v, 'error', function () { reject(new Error('video error: ' + url)); }, { once: true });
      if (v.readyState >= 2) ok(); else nativeAddEventListener.call(v, 'loadeddata', ok, { once: true });
      setTimeout(function () { reject(new Error('video load timeout: ' + url)); }, 20000);
    });
  }
  function parseSegments(s, duration) {
    const out = { listen: [], talk: [] };
    ['listen', 'talk'].forEach(function (k) {
      const arr = (s && s[k]) || [];
      for (let i = 0; i < arr.length; i++) {
        const a = Number(arr[i][0]), b = Number(arr[i][1]);
        if (Number.isFinite(a) && Number.isFinite(b) && b - a >= 0.5 && a >= 0 && (!duration || a < duration)) out[k].push([a, duration ? Math.min(b, duration) : b]);
      }
    });
    if (!out.listen.length) out.listen = [[0, duration || 1]];
    if (!out.talk.length) out.talk = out.listen;
    return out;
  }
  function seekIdle(kind, i, t) {
    const el = seg.els[seg.idle];
    const target = seg.segs[kind][i][0];
    seg.pre = { kind: kind, i: i, seg: seg.segs[kind][i], target: target, ready: false, since: t, retries: 0 };
    try { el.pause(); el.currentTime = target; } catch (e) { fail('avatar.seek', e); }
  }
  function onSeeked(el) {
    const p = seg.pre;
    if (!p || p.ready || !seg.els || seg.els[seg.idle] !== el) return;
    if (Math.abs(el.currentTime - p.target) < 0.3) { p.ready = true; seg.seekMs.push(Math.round(now() - p.since)); if (seg.seekMs.length > 50) seg.seekMs.shift(); }
  }
  function nearestSegment(kind, time) {
    const list = seg.segs[kind]; let best = 0, bd = Infinity;
    for (let i = 0; i < list.length; i++) {
      if (time >= list[i][0] && time < list[i][1] - seg.loopFadeMs / 1000) return i;   // already inside one
      const d = Math.abs(list[i][0] - time); if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function planNext(kind, t) { const n = seg.segs[kind].length; seekIdle(kind, (seg.idx[kind] + 1) % n, t); }
  function requestSwitch(kind, t) {
    seg.state = kind;
    if (seg.kind === kind && !seg.pendingSwitch) return;
    if (seg.kind === kind && seg.pendingSwitch) { seg.pendingSwitch = null; if (!seg.fade) planNext(kind, t); return; }   // changed mind before the seek landed
    seg.pendingSwitch = kind;
    if (!seg.fade) seekIdle(kind, nearestSegment(kind, seg.els[seg.cur].currentTime), t);
  }
  function startFade(ms, t) {
    const p = seg.pre;
    const el = seg.els[seg.idle];
    const pr = el.play(); if (pr && pr.catch) pr.catch(function () {});
    seg.fade = { start: t, ms: ms, kind: p.kind, i: p.i, seg: p.seg };
    seg.pre = null;
    if (p.kind === seg.kind && !seg.pendingSwitch) seg.loopsDone++;
    seg.lateFlagged = false;
  }
  function finishFade(t) {
    const f = seg.fade;
    try { seg.els[seg.cur].pause(); } catch (e) { /* ignore */ }
    const old = seg.cur; seg.cur = seg.idle; seg.idle = old;
    const switched = f.kind !== seg.kind;
    seg.kind = f.kind; seg.idx[f.kind] = f.i; seg.curSeg = f.seg; seg.fade = null;
    if (switched) { seg.switches++; emit('avatar.state', { state: f.kind, segment: f.i, at: Math.round(f.seg[0] * 100) / 100 }); }
    if (seg.pendingSwitch === seg.kind) seg.pendingSwitch = null;
    if (seg.pendingSwitch) seekIdle(seg.pendingSwitch, nearestSegment(seg.pendingSwitch, seg.els[seg.cur].currentTime), t);
    else planNext(seg.kind, t);
  }
  function initSegments() {
    const a = opts.avatar || {};
    const gen = ++seg.gen;
    seg.active = false; seg.ready = false; seg.failed = null; seg.fade = null; seg.pre = null; seg.pendingSwitch = null;
    seg.kind = 'listen'; seg.state = 'listen'; seg.talkingSince = 0; seg.silentSince = 0; seg.idx = { listen: 0, talk: 0 };
    if (seg.els) { seg.els.forEach(function (v) { try { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); } catch (e) { /* ignore */ } }); seg.els = null; }
    const still = a.still || a.src;
    if (still && !cam.img) setAvatar(still);          // drawn until the video is ready, and on fallback
    if (!a.video) { segmentsFallback('missing video url'); return; }
    seg.url = a.video;
    const els = [makeVideo(a.video), makeVideo(a.video)];
    seg.els = els;
    els.forEach(function (v) {
      nativeAddEventListener.call(v, 'seeked', function () { onSeeked(v); });
      nativeAddEventListener.call(v, 'error', function () { if (seg.gen === gen) segmentsFallback('video error'); });
    });
    Promise.all(els.map(function (v) { return whenLoaded(v, a.video); })).then(function () {
      if (seg.gen !== gen) return;
      seg.duration = els[0].duration;
      if (!(seg.duration > 0.5)) throw new Error('video duration unusable: ' + seg.duration);
      seg.segs = parseSegments(a.segments, seg.duration);
      seg.cur = 0; seg.idle = 1;
      seg.curSeg = seg.segs.listen[0];
      const t = now();
      // first frame: seek the shown element to the first listen segment, then play
      const v0 = els[0];
      const startPlay = function () {
        if (seg.gen !== gen) return;
        const pr = v0.play(); if (pr && pr.catch) pr.catch(function () {});
        seg.ready = true; seg.active = true; seg.lastVT = -1; seg.stallSince = 0;
        planNext('listen', now());
        emit('avatar.segments_ready', { duration_s: Math.round(seg.duration * 100) / 100, listen: seg.segs.listen.length, talk: seg.segs.talk.length,
          width: v0.videoWidth, height: v0.videoHeight });
        info('avatar segments ready', seg.duration.toFixed(2) + 's', JSON.stringify(seg.segs));
      };
      if (Math.abs(v0.currentTime - seg.curSeg[0]) < 0.05) startPlay();
      else { nativeAddEventListener.call(v0, 'seeked', startPlay, { once: true }); v0.currentTime = seg.curSeg[0]; setTimeout(function () { if (!seg.ready && seg.gen === gen) startPlay(); }, 3000); }
      void t;
    }).catch(function (e) { if (seg.gen === gen) segmentsFallback(String((e && e.message) || e)); });
  }
  function segmentsFallback(reason) {
    if (seg.failed) return;
    seg.failed = reason; seg.active = false; seg.fade = null; seg.pre = null; seg.pendingSwitch = null;
    if (seg.els) seg.els.forEach(function (v) { try { v.pause(); } catch (e) { /* ignore */ } });
    info('avatar segments fallback to still:', reason);
    emit('avatar.fallback', { reason: reason });
  }
  function updateSegments(t) {
    // voice state machine with hysteresis
    const outputting = player.playing && player.rms > 0.001;
    if (outputting) {
      seg.silentSince = 0;
      if (!seg.talkingSince) seg.talkingSince = t;
      if (seg.state === 'listen' && t - seg.talkingSince >= 120) requestSwitch('talk', t);
    } else {
      seg.talkingSince = 0;
      if (!seg.silentSince) seg.silentSince = t;
      if (seg.state === 'talk' && t - seg.silentSince >= 400) requestSwitch('listen', t);
    }
    const v = seg.els[seg.cur];
    if (seg.fade) {
      if (t - seg.fade.start >= seg.fade.ms) finishFade(t);
      return;
    }
    const p = seg.pre;
    if (p && !p.ready && t - p.since > 2500) {           // seek watchdog
      p.retries++;
      if (p.retries > 2) { segmentsFallback('seek stuck at ' + p.target.toFixed(2) + ' s'); return; }
      p.since = t; try { seg.els[seg.idle].currentTime = p.target + 0.001 * p.retries; } catch (e) { /* ignore */ }
    }
    if (seg.pendingSwitch) {
      if (p && p.ready && p.kind === seg.pendingSwitch) startFade(seg.crossfadeMs, t);
      return;                                            // else keep showing the current element
    }
    const end = seg.curSeg[1];
    if (v.currentTime >= end - (seg.loopFadeMs + 70) / 1000 || v.ended) {
      if (p && p.ready) startFade(seg.loopFadeMs, t);
      else if (!seg.lateFlagged) { seg.lateFlagged = true; seg.lateSeeks++; }
    }
  }
  function cropFor(v) {
    const vw = v.videoWidth, vh = v.videoHeight;
    const c = seg.crop;
    if (c && c.vw === vw && c.vh === vh) return c;
    const a = opts.avatar || {};
    const fx = a.focusX != null ? a.focusX : 0.5, fy = a.focusY != null ? a.focusY : 0.5;
    const zoom = a.zoom > 0 ? a.zoom : 1;               // > 1 crops tighter (e.g. 1.33 drops the side bars of a padded 16:9 portrait)
    const s = Math.min(vw / cam.w, vh / cam.h) / zoom;  // source pixels per output pixel (cover)
    const sw = cam.w * s, sh = cam.h * s;
    const sx = Math.max(0, Math.min(vw - sw, fx * vw - sw / 2)), sy = Math.max(0, Math.min(vh - sh, fy * vh - sh / 2));
    seg.crop = { vw: vw, vh: vh, sx: sx, sy: sy, sw: sw, sh: sh };
    return seg.crop;
  }
  function drawVideo(g, v, alpha) {
    if (!v || v.readyState < 2) return false;
    const c = cropFor(v);
    g.globalAlpha = alpha;
    g.drawImage(v, c.sx, c.sy, c.sw, c.sh, 0, 0, cam.w, cam.h);
    return true;
  }
  function drawSegments(g, t) {
    const v = seg.els[seg.cur];
    let drew = drawVideo(g, v, 1);
    if (seg.fade) {
      const a = Math.min(1, (t - seg.fade.start) / seg.fade.ms);
      drew = drawVideo(g, seg.els[seg.idle], a) || drew;
    }
    g.globalAlpha = 1;
    // stall watchdog on the shown element
    const vt = v.currentTime;
    if (vt === seg.lastVT && !v.paused && !v.ended) {
      if (!seg.stallSince) seg.stallSince = t;
      else if (t - seg.stallSince > 1000) segmentsFallback('video stalled > 1 s');
    } else seg.stallSince = 0;
    seg.lastVT = vt;
    return drew;
  }

  // ---- common lifecycle -----------------------------------------------------------------------
  function decorateCamTrack(t) {
    const settings = { deviceId: opts.camDeviceId, groupId: opts.micGroupId, width: cam.w, height: cam.h,
      frameRate: cam.fps, aspectRatio: cam.w / cam.h, facingMode: 'user', resizeMode: 'none' };
    try {
      Object.defineProperty(t, 'label', { value: (opts.avatar && opts.avatar.label) || opts.camLabel, configurable: true, enumerable: true });
      t.getSettings = function () { return Object.assign({}, settings); };
      t.getCapabilities = function () {
        return { deviceId: opts.camDeviceId, groupId: opts.micGroupId, width: { min: cam.w, max: cam.w },
          height: { min: cam.h, max: cam.h }, frameRate: { min: 1, max: cam.fps }, facingMode: ['user'] };
      };
      t.getConstraints = function () { return {}; };
      t.applyConstraints = function () { return Promise.resolve(); };
    } catch (e) { dbg('decorate cam failed', e); }
    return t;
  }
  function getCamClone() {
    ensureCam();
    if (cam.mode === 'still' && !cam.img && !cam.loading && opts.avatar && opts.avatar.src) setAvatar(opts.avatar.src);
    const t = decorateCamTrack(cam.stream.getVideoTracks()[0].clone());
    cam.clones.add(t);
    nativeAddEventListener.call(t, 'ended', function () { cam.clones.delete(t); });
    startCamLoop();
    return t;
  }
  function liveCamClones() {
    let n = 0;
    cam.clones.forEach(function (t) { if (t.readyState === 'ended') cam.clones.delete(t); else if (t.enabled) n++; });
    return n;
  }
  function startCamLoop() {
    if (cam.timer) return;
    cam.running = true; cam.lastTick = now();
    cam.timer = setInterval(camTick, Math.max(16, Math.round(1000 / cam.fps)));
    if (seg.active && seg.els) { const pr = seg.els[seg.cur].play(); if (pr && pr.catch) pr.catch(function () {}); }
    emit('avatar.start', { fps: cam.fps, width: cam.w, height: cam.h, mode: cam.mode });
  }
  function stopCamLoop(reason) {
    if (!cam.timer) return;
    clearInterval(cam.timer); cam.timer = null; cam.running = false; cam.env = 0;
    if (seg.els) { seg.els.forEach(function (v) { try { v.pause(); } catch (e) { /* ignore */ } }); if (seg.fade) { seg.fade = null; if (seg.active) planNext(seg.kind, now()); } }
    emit('avatar.stop', { reason: reason || 'no-live-track', frames: cam.frames });
  }
  function camTick() {
    if (liveCamClones() === 0) { stopCamLoop('no-live-track'); return; }
    const t = now();
    const dt = Math.min(500, t - cam.lastTick); cam.lastTick = t;
    const target = player.playing ? player.rms : 0;
    const tau = target > cam.env ? 50 : 250;
    cam.env += (target - cam.env) * (dt / (dt + tau));
    if (cam.env < 0.0005) cam.env = 0;
    if (seg.active) { try { updateSegments(t); } catch (e) { segmentsFallback('update error: ' + String((e && e.message) || e)); } }
    drawFrame(t);
  }
  function drawFrame(t) {
    const g = cam.g, w = cam.w, h = cam.h;
    if (!g) return;
    g.globalAlpha = 1;
    g.fillStyle = cam.bg; g.fillRect(0, 0, w, h);
    const k = cam.env >= 0.2 ? 1 : cam.env / 0.2;              // 0..1; RMS 0.2 (-14 dBFS) = full glow
    const ai = Math.round(k * 20);
    const breathe = 1 + 0.004 * Math.sin(t / 4000 * 6.2832);   // idle breathing, +-0.4 % (still mode)
    let video = false;
    if (seg.active) { try { video = drawSegments(g, t); } catch (e) { segmentsFallback('draw error: ' + String((e && e.message) || e)); } }
    if (!video) {
      if (cam.img && !cam.layout) cam.layout = layoutImage();
      const L = cam.layout;
      if (cam.shape === 'circle') {
        const cx = w * 0.5, cy = h * 0.5, r = Math.min(w, h) * 0.36 * breathe;
        if (ai > 0) {
          for (let i = 3; i >= 1; i--) {
            g.beginPath(); g.arc(cx, cy, r + (3 + 10 * k) * i, 0, 6.2832);
            g.strokeStyle = GLOW[Math.round(ai * 0.8 / (i * i))]; g.lineWidth = 5 + 6 * k; g.stroke();
          }
        }
        g.save(); g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.closePath(); g.clip();
        if (L) {
          const iw = cam.img.naturalWidth, ih = cam.img.naturalHeight, s = Math.max(2 * r / iw, 2 * r / ih);
          g.drawImage(cam.img, cx - iw * s / 2, cy - ih * s / 2, iw * s, ih * s);
        } else { g.fillStyle = '#15151c'; g.fillRect(cx - r, cy - r, 2 * r, 2 * r); }
        g.restore();
        cam.frames++;
        return;
      }
      if (L) {
        const dw = L.dw * breathe, dh = L.dh * breathe;
        g.drawImage(cam.img, L.x - (dw - L.dw) / 2, L.y - (dh - L.dh) / 2, dw, dh);
        for (let i = 0; i < L.feathers.length; i++) { const f = L.feathers[i]; g.fillStyle = f.grad; g.fillRect(f.x, f.y, f.w, f.h); }
      }
    }
    if (ai > 0 && cam.strips) {   // soft inner glow along the frame edges, intensity follows the voice
      g.globalAlpha = video ? 0.06 + 0.28 * k : 0.15 + 0.5 * k;
      for (let i = 0; i < 4; i++) { const s = cam.strips[i]; g.fillStyle = s.grad; g.fillRect(s.x, s.y, s.w, s.h); }
      g.globalAlpha = 1;
    }
    cam.frames++;
  }
  function installTrackHooks() {
    const MST = W.MediaStreamTrack && W.MediaStreamTrack.prototype;
    if (!MST) return;
    const origStop = MST.stop;
    MST.stop = function stop() {
      const r = origStop.apply(this, arguments);
      if (cam.clones.has(this)) { cam.clones.delete(this); if (liveCamClones() === 0) stopCamLoop('track-stopped'); }
      if (micClones.has(this)) micClones.delete(this);
      return r;
    };
    const en = Object.getOwnPropertyDescriptor(MST, 'enabled');
    if (en && en.set) {
      Object.defineProperty(MST, 'enabled', {
        configurable: true, enumerable: en.enumerable, get: en.get,
        set: function (v) { en.set.call(this, v); if (v && cam.clones.has(this)) startCamLoop(); },
      });
    }
  }
  // __host_setAvatar(src) -> still image (data:/http(s) URL); (object) -> reconfigure, e.g.
  // {mode:'segments', video, segments, still}; null -> camera off for future requests.
  function hostSetAvatar(srcOrCfg, extra) {
    if (!srcOrCfg) {
      if (opts.avatar) { opts.avatar.src = null; opts.avatar.video = null; }
      stopCamLoop('avatar-disabled');
      return Promise.resolve(null);
    }
    if (typeof srcOrCfg === 'object') {
      if (!opts.avatar) opts.avatar = {};
      Object.assign(opts.avatar, srcOrCfg);
      if (cam.canvas) {
        applyAvatarOpts();
        if (cam.mode === 'segments') initSegments();
        else { seg.active = false; seg.failed = null; if (opts.avatar.src) return setAvatar(opts.avatar.src); }
      }
      return Promise.resolve({ mode: cam.mode });
    }
    return setAvatar(srcOrCfg, extra);
  }

  // ---- microphone (getUserMedia / enumerateDevices / permissions) -----------------------------
  const micClones = new Set();
  let gumCount = 0;
  let fakeVideo = null;   // { canvas, stream, timer }

  function decorateMicTrack(t) {
    const settings = {
      deviceId: opts.micDeviceId, groupId: opts.micGroupId, sampleRate: SR, sampleSize: 16, channelCount: 1,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0.01,
    };
    try {
      Object.defineProperty(t, 'label', { value: opts.micLabel, configurable: true, enumerable: true });
      t.getSettings = function () { return Object.assign({}, settings); };
      t.getCapabilities = function () {
        return { deviceId: opts.micDeviceId, groupId: opts.micGroupId, sampleRate: { min: SR, max: SR },
          sampleSize: { min: 16, max: 16 }, channelCount: { min: 1, max: 1 },
          echoCancellation: [false], noiseSuppression: [false], autoGainControl: [false], latency: { min: 0.01, max: 0.01 } };
      };
      t.getConstraints = function () { return {}; };
      t.applyConstraints = function () { return Promise.resolve(); };
    } catch (e) { dbg('decorate failed', e); }
    return t;
  }
  function getMicClone() {
    getCtx(); ensureRunning(); loadWorklets();
    const src = micDest.stream.getAudioTracks()[0];
    const t = decorateMicTrack(src.clone());
    micClones.add(t);
    nativeAddEventListener.call(t, 'ended', function () { micClones.delete(t); });
    return t;
  }
  function makeFakeVideoTrack() {
    if (!fakeVideo) {
      const canvas = document.createElement('canvas');
      canvas.width = 160; canvas.height = 120;
      const g = canvas.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, canvas.width, canvas.height);
      const stream = canvas.captureStream(1);
      const track = stream.getVideoTracks()[0];
      const timer = setInterval(function () {
        g.fillRect(0, 0, canvas.width, canvas.height);
        if (track.requestFrame) track.requestFrame();
      }, 1000);
      fakeVideo = { canvas: canvas, stream: stream, timer: timer };
    }
    return fakeVideo.stream.getVideoTracks()[0].clone();
  }
  function summarizeConstraints(c) {
    const out = {};
    ['audio', 'video'].forEach(function (k) {
      const v = c && c[k];
      if (!v) return;
      if (v === true) { out[k] = true; return; }
      try { out[k] = JSON.stringify(v).slice(0, 200); } catch (e) { out[k] = 'object'; }
    });
    return out;
  }
  function hostGetUserMedia(constraints) {
    const c = constraints || {};
    const wantA = !!c.audio;
    const wantV = !!c.video;
    const n = ++gumCount;
    const ev = { n: n, audio: wantA, video: wantV, constraints: summarizeConstraints(c) };
    if (!wantA && !wantV) {
      ev.result = 'error'; ev.error = 'TypeError';
      emit('gum.request', ev);
      return Promise.reject(new TypeError("Failed to execute 'getUserMedia' on 'MediaDevices': At least one of audio and video must be requested"));
    }
    const policy = avatarEnabled() ? 'avatar' : (opts.fakeVideo ? 'fake' : opts.videoPolicy);
    const tracks = [];
    try {
      if (wantV) {
        if (policy === 'avatar') { tracks.push(getCamClone()); ev.video_source = 'avatar'; }
        else if (policy === 'fake') { tracks.push(makeFakeVideoTrack()); ev.video_source = 'black'; }
        else if (policy === 'strip' && wantA) { ev.video_stripped = true; }
        else {
          const err = policy === 'deny'
            ? domErr('NotAllowedError', 'Permission denied')
            : domErr('NotFoundError', 'Requested device not found');
          ev.result = 'error'; ev.error = err.name;
          emit('gum.request', ev);
          return Promise.reject(err);
        }
      }
      if (wantA) tracks.push(getMicClone());
    } catch (e) {
      ev.result = 'error'; ev.error = String(e);
      emit('gum.request', ev);
      return Promise.reject(domErr('AbortError', 'standup-host adapter failed: ' + String(e)));
    }
    ev.result = 'ok'; ev.mic_clones = micClones.size;
    emit('gum.request', ev);
    dbg('getUserMedia', ev);
    return Promise.resolve(new MediaStream(tracks));
  }
  function fakeDevices() {
    const mk = function (kind, deviceId, label) {
      const d = { deviceId: deviceId, kind: kind, label: label, groupId: opts.micGroupId };
      d.toJSON = function () { return { deviceId: deviceId, kind: kind, label: label, groupId: opts.micGroupId }; };
      return d;
    };
    const list = [mk('audioinput', opts.micDeviceId, opts.micLabel), mk('audiooutput', 'default', 'Default')];
    if (avatarEnabled() || opts.fakeVideo) list.push(mk('videoinput', opts.camDeviceId, (opts.avatar && opts.avatar.label) || opts.camLabel));
    return list;
  }
  function patchMediaDevices() {
    const MD = W.MediaDevices && W.MediaDevices.prototype;
    if (!MD) return;
    MD.getUserMedia = function getUserMedia(constraints) { return hostGetUserMedia(constraints); };
    MD.enumerateDevices = function enumerateDevices() { return Promise.resolve(fakeDevices()); };
    const legacy = function (constraints, ok, err) {
      hostGetUserMedia(constraints).then(ok, err || function () {});
    };
    try { if (W.navigator.getUserMedia) W.navigator.getUserMedia = legacy; } catch (e) { /* ignore */ }
    try { if (W.navigator.webkitGetUserMedia) W.navigator.webkitGetUserMedia = legacy; } catch (e) { /* ignore */ }
    const perms = W.navigator.permissions;
    if (perms && perms.query) {
      const origQuery = perms.query.bind(perms);
      const fakeStatus = function (name, state) {
        const s = new EventTarget();
        Object.defineProperty(s, 'state', { get: function () { return state; }, enumerable: true });
        Object.defineProperty(s, 'name', { get: function () { return name; }, enumerable: true });
        s.onchange = null;
        return s;
      };
      const Perm = W.Permissions && W.Permissions.prototype;
      const wrapped = function query(desc) {
        const name = desc && desc.name;
        if (name === 'microphone') return Promise.resolve(fakeStatus(name, 'granted'));
        if (name === 'camera') {
          const p = avatarEnabled() ? 'fake' : (opts.fakeVideo ? 'fake' : opts.videoPolicy);
          return Promise.resolve(fakeStatus(name, p === 'fake' ? 'granted' : (p === 'deny' ? 'denied' : 'prompt')));
        }
        return origQuery(desc);
      };
      if (Perm) Perm.query = wrapped; else perms.query = wrapped;
    }
  }

  // ---- remote audio capture (ears) ------------------------------------------------------------
  const tracks = new Map();        // track_id -> rec {track, pc, slot, src, el, mid, stream_ids}
  const slots = new Array(opts.slots).fill(null);
  const pendingTracks = [];        // recs waiting for the worklet
  let pcSeq = 0;
  const pcInfo = new WeakMap();
  const capture = { chunks: 0, dropped: 0, lastDropReport: 0, seq: -1 };

  function allocSlot() {
    for (let i = 0; i < slots.length - 1; i++) if (slots[i] === null) return i;
    return slots.length - 1;   // overflow slot: shared (mixed), reported as 'overflow'
  }
  function connectRec(rec) {
    if (!captureNode || rec.src || rec.dead) return;
    if (rec.track.readyState === 'ended') { releaseTrack(rec, 'ended-before-connect'); return; }
    try {
      rec.src = ctx.createMediaStreamSource(rec.stream);
      rec.src.connect(captureNode, 0, rec.slot);
      captureNode.port.postMessage({ type: 'map', slot: rec.slot, id: rec.shared ? 'overflow' : rec.id });
    } catch (e) { fail('track.connect', e); }
  }
  function connectPendingTracks() {
    while (pendingTracks.length) connectRec(pendingTracks.shift());
  }
  function attachSinkElement(rec) {
    // Chromium: remote WebRTC audio may not flow into WebAudio unless the stream is also consumed by
    // a media element. Hidden + muted element per track (page runs with --mute-audio as well).
    try {
      const el = document.createElement('audio');
      el.setAttribute('data-host', 'sink');
      el.muted = true; el.volume = 0; el.autoplay = true;
      el.style.display = 'none';
      el.srcObject = rec.stream;
      (document.body || document.documentElement).appendChild(el);
      const p = el.play(); if (p && p.catch) p.catch(function () {});
      rec.el = el;
    } catch (e) { fail('track.sink', e); }
  }
  function releaseTrack(rec, reason) {
    if (rec.dead) return;
    rec.dead = true;
    tracks.delete(rec.id);
    const idx = pendingTracks.indexOf(rec); if (idx >= 0) pendingTracks.splice(idx, 1);
    try { if (rec.src) rec.src.disconnect(); } catch (e) { /* ignore */ }
    if (rec.el) { try { rec.el.pause(); rec.el.srcObject = null; rec.el.remove(); } catch (e) { /* ignore */ } }
    if (!rec.shared) {
      slots[rec.slot] = null;
      if (captureNode) captureNode.port.postMessage({ type: 'unmap', slot: rec.slot });
    } else {
      let others = 0; tracks.forEach(function (r) { if (r.shared && !r.dead) others++; });
      if (!others) { slots[rec.slot] = null; if (captureNode) captureNode.port.postMessage({ type: 'unmap', slot: rec.slot }); }
    }
    const info_ = pcInfo.get(rec.pc); if (info_) info_.tracks.delete(rec.id);
    emit('track.ended', { track_id: rec.id, pc: rec.pcId, slot: rec.slot, reason: reason });
    info('track ended', rec.id.slice(0, 8), reason);
  }
  function onRemoteTrack(pc, pinfo, ev) {
    const track = ev.track;
    if (!track) return;
    const mid = (ev.transceiver && ev.transceiver.mid != null) ? ev.transceiver.mid : null;
    const streamIds = (ev.streams || []).map(function (s) { return s.id; });
    if (track.kind !== 'audio') {
      emit('track.video', { track_id: track.id, pc: pinfo.id, mid: mid, stream_ids: streamIds });
      return;
    }
    if (tracks.has(track.id)) return;
    getCtx(); ensureRunning();
    const slot = allocSlot();
    const shared = slots[slot] !== null;
    const rec = { id: track.id, track: track, pc: pc, pcId: pinfo.id, slot: slot, shared: shared,
      stream: new MediaStream([track]), src: null, el: null, mid: mid, streamIds: streamIds, dead: false };
    slots[slot] = shared ? 'overflow' : rec.id;
    tracks.set(track.id, rec);
    pinfo.tracks.add(track.id);
    attachSinkElement(rec);
    nativeAddEventListener.call(track, 'ended', function () { releaseTrack(rec, 'ended'); });
    nativeAddEventListener.call(track, 'mute', function () { emit('track.muted', { track_id: rec.id, pc: rec.pcId, slot: slot }); });
    nativeAddEventListener.call(track, 'unmute', function () { emit('track.unmuted', { track_id: rec.id, pc: rec.pcId, slot: slot }); });
    if (captureNode) connectRec(rec); else { pendingTracks.push(rec); loadWorklets(); }
    emit('track.added', { track_id: rec.id, pc: pinfo.id, slot: slot, shared: shared, mid: mid, stream_ids: streamIds,
      muted: track.muted, label: track.label });
    info('remote audio track', track.id.slice(0, 8), 'pc', pinfo.id, 'slot', slot, 'mid', mid);
  }
  function hookPc(pc) {
    if (!pc || pcInfo.has(pc)) return;
    const pinfo = { id: ++pcSeq, tracks: new Set() };
    pcInfo.set(pc, pinfo);
    nativeAddEventListener.call(pc, 'track', function (ev) { try { onRemoteTrack(pc, pinfo, ev); } catch (e) { fail('ontrack', e); } });
    nativeAddEventListener.call(pc, 'connectionstatechange', function () {
      emit('pc.state', { pc: pinfo.id, state: pc.connectionState });
      if (pc.connectionState === 'closed') releasePc(pc, pinfo, 'pc-closed');
    });
    emit('pc.created', { pc: pinfo.id });
    dbg('RTCPeerConnection #' + pinfo.id);
  }
  function releasePc(pc, pinfo, reason) {
    Array.from(pinfo.tracks).forEach(function (id) { const rec = tracks.get(id); if (rec) releaseTrack(rec, reason); });
  }
  function patchPeerConnection() {
    const Native = W.RTCPeerConnection;
    if (!Native) return;
    const Proxied = new Proxy(Native, {
      construct: function (target, args, newTarget) {
        const pc = Reflect.construct(target, args, newTarget);
        try { hookPc(pc); } catch (e) { fail('pc.hook', e); }
        return pc;
      },
    });
    W.RTCPeerConnection = Proxied;
    try { if ('webkitRTCPeerConnection' in W) W.webkitRTCPeerConnection = Proxied; } catch (e) { /* ignore */ }
    // Safety net for connections created through a captured native reference.
    const proto = Native.prototype;
    const origSRD = proto.setRemoteDescription;
    proto.setRemoteDescription = function setRemoteDescription() {
      try { hookPc(this); } catch (e) { /* ignore */ }
      return origSRD.apply(this, arguments);
    };
    const origClose = proto.close;
    proto.close = function close() {
      const r = origClose.apply(this, arguments);
      const pinfo = pcInfo.get(this);
      if (pinfo) releasePc(this, pinfo, 'pc-close');
      return r;
    };
  }
  function onCaptureMessage(m) {
    if (!m) return;
    if (m.type === 'track_chunk') {
      // per-track tap (диаризация): forwarded separately from the mix; no seq bookkeeping here
      const fnT = W.__host_track_audio;
      if (typeof fnT === 'function') {
        try {
          const r = fnT(bytesToB64(new Uint8Array(m.pcm)), String(m.track_id));
          if (r && typeof r.catch === 'function') r.catch(function () {});
        } catch (e) { dbg('track audio send failed', e); }
      }
      return;
    }
    if (m.type !== 'chunk') return;
    if (capture.seq >= 0 && m.seq !== capture.seq + 1) dbg('capture seq gap', capture.seq, '->', m.seq);
    capture.seq = m.seq;
    const fn = W.__host_audio;
    if (typeof fn !== 'function') {
      capture.dropped++;
      const t = now();
      if (t - capture.lastDropReport > 5000) { capture.lastDropReport = t; emit('capture.dropped', { count: capture.dropped }); }
      return;
    }
    try {
      const b64 = bytesToB64(new Uint8Array(m.pcm));
      const meta = { seq: m.seq, ctx_time: Math.round(m.ctx_time * 100000) / 100000, t: Math.round(now() * 10) / 10,
        sr: SR, frames: m.frames, mix: m.mix, tracks: m.levels.length };
      const r = fn(b64, JSON.stringify(m.levels), JSON.stringify(meta));
      if (r && typeof r.catch === 'function') r.catch(function () {});
      capture.chunks++;
    } catch (e) { capture.dropped++; dbg('audio send failed', e); }
  }
  function sweep() {
    tracks.forEach(function (rec) {
      if (rec.dead) return;
      if (rec.track.readyState === 'ended') releaseTrack(rec, 'ended-sweep');
      else if (rec.pc && (rec.pc.connectionState === 'closed' || rec.pc.signalingState === 'closed')) releaseTrack(rec, 'pc-closed-sweep');
    });
  }

  // ---- speakers safety: mute every media element the page creates -----------------------------
  const mutedSeen = new WeakSet();
  let mutedCount = 0;
  function muteEl(el) {
    if (!opts.muteMedia) return;
    try {
      if (!el.muted) el.muted = true;
      if (!mutedSeen.has(el)) { mutedSeen.add(el); mutedCount++; }
    } catch (e) { /* ignore */ }
  }
  function isMedia(n) { return n && (n.tagName === 'AUDIO' || n.tagName === 'VIDEO'); }
  function scan(root) {
    if (!root) return;
    if (isMedia(root)) muteEl(root);
    if (root.querySelectorAll) root.querySelectorAll('audio,video').forEach(muteEl);
  }
  function installMediaMuting() {
    if (!opts.muteMedia) return;
    const HME = W.HTMLMediaElement && W.HTMLMediaElement.prototype;
    if (HME) {
      const origPlay = HME.play;
      HME.play = function play() { muteEl(this); return origPlay.apply(this, arguments); };
      const so = Object.getOwnPropertyDescriptor(HME, 'srcObject');
      if (so && so.set) {
        Object.defineProperty(HME, 'srcObject', {
          configurable: true, enumerable: so.enumerable,
          get: so.get,
          set: function (v) { muteEl(this); return so.set.call(this, v); },
        });
      }
    }
    try {
      const mo = new MutationObserver(function (muts) {
        for (let i = 0; i < muts.length; i++) {
          const added = muts[i].addedNodes;
          for (let j = 0; j < added.length; j++) scan(added[j]);
        }
      });
      mo.observe(document, { childList: true, subtree: true });
    } catch (e) { fail('mutation-observer', e); }
    nativeAddEventListener.call(document, 'play', function (ev) { if (isMedia(ev.target)) muteEl(ev.target); }, true);
    setInterval(function () { scan(document); sweep(); }, 2000);
  }

  // ---- public page API ------------------------------------------------------------------------
  function hostStatus() {
    const list = [];
    tracks.forEach(function (rec) {
      list.push({ id: rec.id, pc: rec.pcId, slot: rec.slot, shared: rec.shared, mid: rec.mid, stream_ids: rec.streamIds,
        muted: rec.track.muted, readyState: rec.track.readyState, connected: !!rec.src });
    });
    return {
      version: VERSION, top: isTop, href: String(W.location && W.location.href).slice(0, 200),
      ctx: ctx ? { state: ctx.state, sample_rate: ctx.sampleRate, current_time: ctx.currentTime, base_latency: ctx.baseLatency } : null,
      worklet: workletState, worklet_error: workletError,
      player: playerState(),
      mic: { requests: gumCount, active_clones: micClones.size, label: opts.micLabel },
      avatar: { enabled: avatarEnabled(), mode: cam.mode, running: cam.running, frames: cam.frames, clones: liveCamClones(),
        image: !!cam.img, width: cam.w, height: cam.h, fps: cam.fps, shape: cam.shape, env: Math.round(cam.env * 1000) / 1000,
        state: seg.active ? seg.kind : null, target_state: seg.active ? seg.state : null,
        segments: { active: seg.active, ready: seg.ready, failed: seg.failed, duration_s: seg.duration, segs: seg.segs,
          kind: seg.kind, segment: seg.curSeg, position_s: seg.els && seg.active ? Math.round(seg.els[seg.cur].currentTime * 100) / 100 : null,
          switches: seg.switches, loops_done: seg.loopsDone, late_seeks: seg.lateSeeks, pending_switch: seg.pendingSwitch, fading: !!seg.fade,
          pre_ready: !!(seg.pre && seg.pre.ready), seek_ms: seg.seekMs.slice(-10) } },
      capture: { enabled: !!opts.capture, chunks: capture.chunks, dropped: capture.dropped, last_seq: capture.seq },
      tracks: list, pcs: pcSeq, muted_elements: mutedCount,
      bindings: { audio: typeof W.__host_audio === 'function', event: typeof W.__host_event === 'function' },
      dropped_events: droppedEvents.length,
    };
  }
  function hostSetOpts(partial) {
    const before = opts.capture;
    Object.assign(opts, partial || {});
    if (captureNode && before !== opts.capture) captureNode.port.postMessage({ type: 'enable', enabled: !!opts.capture });
    return Object.assign({}, opts);
  }

  W.__host_play = hostPlay;
  W.__host_playEnd = hostPlayEnd;
  W.__host_flush = hostFlush;
  W.__host_playerState = playerState;
  W.__host_status = hostStatus;
  W.__host_setOpts = hostSetOpts;
  W.__host_setAvatar = hostSetAvatar;
  W.__host_version = VERSION;

  try { patchMediaDevices(); } catch (e) { fail('patch.mediaDevices', e); }
  try { patchPeerConnection(); } catch (e) { fail('patch.rtc', e); }
  try { installMediaMuting(); } catch (e) { fail('patch.media', e); }
  try { installTrackHooks(); } catch (e) { fail('patch.tracks', e); }
  // WebRTC audio health probe: emitted every 20 s so the host log shows whether the call
  // actually carries sound (out bytes grow while she speaks, in bytes while others speak).
  setInterval(function () {
    try {
      let outBytes = 0, outPkts = 0, inBytes = 0, inPkts = 0;
      const jobs = [];
      pcInfo.forEach(function (pinfo, pc) {
        try {
          jobs.push(
            Promise.resolve(pc.getStats())
              .then(function (stats) {
                stats.forEach(function (s) {
                  const kind = s.mediaType || s.kind;
                  if (kind !== 'audio') return;
                  if (s.type === 'outbound-rtp') { outBytes += s.bytesSent || 0; outPkts += s.packetsSent || 0; }
                  else if (s.type === 'inbound-rtp') { inBytes += s.bytesReceived || 0; inPkts += s.packetsReceived || 0; }
                });
              })
              .catch(function () { /* pc closed */ }),
          );
        } catch (e) { /* getStats can throw on a closing pc */ }
      });
      Promise.all(jobs).then(function () {
        emit('rtc.stats', { out_bytes: outBytes, out_packets: outPkts, in_bytes: inBytes, in_packets: inPkts });
      });
    } catch (e) { /* never */ }
  }, 20000);
  setTimeout(function () {
    emit('host.installed', { version: VERSION, top: isTop, href: String(W.location && W.location.href).slice(0, 200) });
    if (isTop) info('installed', VERSION);
  }, 0);
}

// ---------------------------------------------------------------------------------------------
// Node side
// ---------------------------------------------------------------------------------------------

const IMAGE_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

/** data: URL for an avatar file (PNG/JPEG/WebP). `baseDir` resolves relative paths (default: cwd). */
export function avatarSrcFromFile(file, baseDir = process.cwd()) {
  const abs = path.isAbsolute(file) ? file : path.resolve(baseDir, file);
  const mime = IMAGE_MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

/**
 * Options object handed to the page (what pageMain receives as `cfg`).
 * `avatar.path` (as in config/settings.json) is turned into `avatar.src` (data URL) here;
 * `baseDir` says what relative paths are relative to (default: process.cwd()).
 */
export function buildInitConfig(opts = {}, baseDir = process.cwd()) {
  const merged = { ...DEFAULT_OPTS, ...opts };
  if (merged.avatar && merged.avatar.path && !merged.avatar.src) {
    merged.avatar = { ...merged.avatar, src: avatarSrcFromFile(merged.avatar.path, baseDir) };
    delete merged.avatar.path;
  }
  return { opts: merged, workletSrc: WORKLET_MODULE_SRC, version: VERSION };
}

/** Self-contained script for page.addInitScript({ content }). */
export function buildInitScript(opts = {}, baseDir = process.cwd()) {
  return `(${pageMain.toString()})(${JSON.stringify(buildInitConfig(opts, baseDir))});`;
}

/** Decode a base64 PCM16 LE payload into an Int16Array (copy, aligned). */
export function b64ToPcm16(b64) {
  const buf = Buffer.from(b64, 'base64');
  const n = buf.length & ~1;
  const out = new Int16Array(n / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

/** Encode an Int16Array (PCM16 LE) as base64 for __host_play. */
export function pcm16ToB64(pcm) {
  const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  return buf.toString('base64');
}

const ASSET_MIME = { ...IMAGE_MIME, '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.json': 'application/json' };

/**
 * Serves local files same-origin to the page through page.route (Range requests supported, so
 * <video> can seek). Call BEFORE page.goto(). URLs inside the page: `${prefix}<file>`, e.g.
 * '/__host_assets/listen.mp4'. Same-origin keeps the avatar canvas origin-clean for captureStream.
 */
export async function serveAssets(page, { prefix = '/__host_assets/', dir } = {}) {
  const absDir = path.resolve(dir || '.');
  await page.route((url) => url.pathname.startsWith(prefix), async (route) => {
    const req = route.request();
    let file;
    try { file = path.normalize(path.join(absDir, decodeURIComponent(new URL(req.url()).pathname.slice(prefix.length)))); }
    catch { return route.fulfill({ status: 400, body: 'bad path' }); }
    if (!file.startsWith(absDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return route.fulfill({ status: 404, body: 'not found' });
    const size = fs.statSync(file).size;
    const type = ASSET_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const range = req.headers()['range'];
    const m = range && /bytes=(\d*)-(\d*)/.exec(range);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start > end || start >= size) return route.fulfill({ status: 416, headers: { 'content-range': `bytes */${size}` }, body: '' });
      const body = Buffer.alloc(end - start + 1);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, body, 0, body.length, start); } finally { fs.closeSync(fd); }
      return route.fulfill({ status: 206, headers: { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`,
        'accept-ranges': 'bytes', 'content-length': String(body.length), 'cache-control': 'no-store' }, body });
    }
    return route.fulfill({ status: 200, headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(size),
      'cache-control': 'no-store' }, body: fs.readFileSync(file) });
  });
  return { prefix, dir: absDir, url: (name) => prefix + name };
}

/**
 * Wires the bindings and the init script on a Playwright page. Must be awaited BEFORE page.goto().
 * Returns a PageAudio handle for the play/flush/state calls.
 */
export async function attachPageAudio(page, { onAudio, onEvent, onTrackAudio, opts = {}, baseDir = process.cwd() } = {}) {
  await page.exposeFunction('__host_audio', (b64, levelsJson, metaJson) => {
    if (!onAudio) return;
    let levels = [], meta = {};
    try { levels = JSON.parse(levelsJson); } catch { /* keep [] */ }
    try { meta = JSON.parse(metaJson); } catch { /* keep {} */ }
    onAudio(b64ToPcm16(b64), levels, meta);
  });
  if (onTrackAudio) {
    opts = { ...opts, trackTaps: true };
    await page.exposeFunction('__host_track_audio', (b64, trackId) => onTrackAudio(b64ToPcm16(b64), trackId));
  }
  await page.exposeFunction('__host_event', (json) => {
    if (!onEvent) return;
    let ev;
    try { ev = JSON.parse(json); } catch { ev = { type: 'unparsed', raw: json }; }
    onEvent(ev);
  });
  await page.addInitScript({ content: buildInitScript(opts, baseDir) });
  return new PageAudio(page);
}

/** Thin wrapper over the page API (all calls go through page.evaluate). */
export class PageAudio {
  constructor(page) { this.page = page; this._frameCache = null; }
  /**
   * The frame hosting the meeting app: since the 21.09 Telemost update the call runs inside a
   * /private-join/<id> iframe, and the adapter state (microphone clone, player, avatar) lives
   * per-frame — calls must go to the meeting frame, not the top document. Falls back to the
   * main frame (pre-21.09 layout and test stubs without frames).
   */
  async frame() {
    if (this._frameCache) return this._frameCache;
    const p = this.page;
    if (!p || typeof p.frames !== 'function') return p;
    for (const f of p.frames()) {
      const hit = await f
        .evaluate(
          () =>
            typeof window.__host_play === 'function' &&
            !!document.querySelector('[data-testid="enter-conference-button"], [data-testid="end-call-button"], [data-testid="end-call-alt-button"]'),
        )
        .catch(() => false);
      if (hit) {
        this._frameCache = f;
        return f;
      }
    }
    this._frameCache = typeof p.mainFrame === 'function' ? p.mainFrame() : p;
    return this._frameCache;
  }
  /** pcm: Int16Array | Buffer | base64 string. */
  async play(pcm) {
    const b64 = typeof pcm === 'string' ? pcm : pcm16ToB64(pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1));
    return (await this.frame()).evaluate((b) => window.__host_play(b), b64);
  }
  async playEnd() { return (await this.frame()).evaluate(() => window.__host_playEnd()); }
  async flush() { return (await this.frame()).evaluate(() => window.__host_flush()); }
  async state() { return (await this.frame()).evaluate(() => window.__host_playerState()); }
  async status() { return (await this.frame()).evaluate(() => window.__host_status()); }
  async setOpts(partial) { return (await this.frame()).evaluate((p) => window.__host_setOpts(p), partial); }
  /** src: PNG data URL or http(s) URL; null turns the camera back off. */
  async setAvatar(src) { return (await this.frame()).evaluate((s) => window.__host_setAvatar(s), src); }
}
