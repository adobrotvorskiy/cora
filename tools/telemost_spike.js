// S2 + S5 spike: two guests in the TEST room.
//   host     «Кора (ИИ-ведущая)» – synthetic mic (plays a speech clip 3×) + synthetic camera (assets/avatar.png)
//   listener «Тест-слушатель»    – hooks remote audio tracks (AnalyserNode) and watches the DOM
//
//   node tools/telemost_spike.js --url <link> [--adapter fake|wp2] [--reps 3] [--phase-seconds 40]
//        [--chat] [--host-name ..] [--listener-name ..] [--avatar assets/avatar.png]
//
//   --adapter fake  (default) host uses tools/inspect_dom.js buildFakeMediaScript (proven in S0/S1)
//   --adapter wp2   host uses WP2's src/browser/page_inject.js (attachPageAudio, __host_play, avatar opts)
//
// Reports: per-repetition RX energy + onset latency on the listener, DOM active-speaker events,
// avatar visibility on the listener (pixel check + tile screenshot), upload kbps + CPU with camera
// on vs off. Outputs under _internal/spike_<stamp>/ (gitignored). Never use the real standup room.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, snap, ROOT, killStrayChrome } from '../src/browser/launch.js';
import { join, leave, SEL, getParticipants, getParticipantsFromPanel, watchActiveSpeaker, postChat, watchChat, setCamera, closePanels } from '../src/browser/telemost.js';
import { buildFakeMediaScript, DOM_PROBE_SCRIPT, parseArgs, mkOutDir, dumpStage, ensureProbe } from './inspect_dom.js';

// ---------------------------------------------------------------------------
// Page-side: RTCPeerConnection hook – remote audio levels (listener) + getStats (both)
// ---------------------------------------------------------------------------
function rtcProbeMain() {
  if (window.__rtc) return;
  const st = { pcs: [], tracks: [], levels: [], ctx: null };
  const Orig = window.RTCPeerConnection;
  if (!Orig) return;
  function attach(track, streams) {
    const rec = { kind: track.kind, id: track.id, streamIds: streams.map((s) => s.id), t: Date.now(), rms: 0 };
    if (track.kind === 'audio') {
      try {
        if (!st.ctx) st.ctx = new AudioContext();
        if (st.ctx.state !== 'running') st.ctx.resume().catch(() => {});
        const src = st.ctx.createMediaStreamSource(new MediaStream([track]));
        const an = st.ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0;
        src.connect(an);
        rec.an = an; rec.buf = new Float32Array(an.fftSize);
      } catch (e) { rec.error = String(e); }
    }
    st.tracks.push(rec);
  }
  class PC extends Orig {
    constructor(...args) {
      super(...args);
      st.pcs.push(this);
      this.addEventListener('track', (ev) => attach(ev.track, ev.streams || []));
    }
  }
  window.RTCPeerConnection = PC;
  setInterval(() => {
    const t = Date.now(); const row = [t];
    for (const tr of st.tracks) {
      if (tr.kind !== 'audio' || !tr.an) continue;
      tr.an.getFloatTimeDomainData(tr.buf);
      let s = 0; for (let i = 0; i < tr.buf.length; i++) s += tr.buf[i] * tr.buf[i];
      tr.rms = Math.sqrt(s / tr.buf.length);
      row.push(+tr.rms.toFixed(5));
    }
    st.levels.push(row);
    if (st.levels.length > 20000) st.levels.splice(0, 5000);
  }, 50);
  async function stats() {
    const out = { t: Date.now(), outbound: [], inbound: [], sources: [], pcs: st.pcs.map((p) => p.connectionState) };
    for (const pc of st.pcs) {
      if (pc.connectionState === 'closed') continue;
      let rep; try { rep = await pc.getStats(); } catch (e) { continue; }
      rep.forEach((r) => {
        if (r.type === 'outbound-rtp') out.outbound.push({ kind: r.kind, ssrc: r.ssrc, bytesSent: r.bytesSent, packetsSent: r.packetsSent, framesEncoded: r.framesEncoded, w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond, totalEncodeTime: r.totalEncodeTime, qual: r.qualityLimitationReason, active: r.active, rid: r.rid, scalabilityMode: r.scalabilityMode });
        else if (r.type === 'inbound-rtp') out.inbound.push({ kind: r.kind, ssrc: r.ssrc, bytesReceived: r.bytesReceived, packetsReceived: r.packetsReceived, w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond, audioLevel: r.audioLevel, totalAudioEnergy: r.totalAudioEnergy, framesDecoded: r.framesDecoded });
        else if (r.type === 'media-source') out.sources.push({ kind: r.kind, audioLevel: r.audioLevel, totalAudioEnergy: r.totalAudioEnergy, w: r.width, h: r.height, fps: r.framesPerSecond, frames: r.frames });
      });
    }
    return out;
  }
  window.__rtc = {
    tracks: () => st.tracks.map((t) => ({ kind: t.kind, id: t.id, streamIds: t.streamIds, t: t.t, rms: t.rms, error: t.error })),
    levels: (clear) => { const l = st.levels.slice(); if (clear) st.levels = []; return l; },
    pcs: () => st.pcs.map((p) => ({ conn: p.connectionState, ice: p.iceConnectionState, senders: p.getSenders().map((s) => s.track && s.track.kind + ':' + s.track.readyState + ':' + (s.track.enabled ? 'on' : 'off')), receivers: p.getReceivers().map((r) => r.track && r.track.kind + ':' + r.track.readyState) })),
    stats,
  };
}
export const RTC_PROBE_SCRIPT = `(${rtcProbeMain.toString()})();`;

// ---------------------------------------------------------------------------
// Node side: CPU / memory sampling, WAV helpers
// ---------------------------------------------------------------------------
export async function cpuSampler(context) {
  const browser = context.browser();
  const s = await browser.newBrowserCDPSession();
  const cores = os.cpus().length;
  return {
    cores,
    async sample() { const { processInfo } = await s.send('SystemInfo.getProcessInfo'); return { t: Date.now(), procs: processInfo }; },
    diff(a, b) {
      const wall = (b.t - a.t) / 1000; const byType = {}; let total = 0;
      for (const p of b.procs) {
        const prev = a.procs.find((q) => q.id === p.id);
        const d = prev ? p.cpuTime - prev.cpuTime : 0;
        byType[p.type] = (byType[p.type] || 0) + d; total += d;
      }
      return { wallS: +wall.toFixed(1), pctOfOneCore: +(100 * total / wall).toFixed(1), pctOfMachine: +(100 * total / wall / cores).toFixed(1), byTypePctOfOneCore: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, +(100 * v / wall).toFixed(1)])), nProcs: b.procs.length, pids: b.procs.map((p) => p.id) };
    },
    detach: () => s.detach().catch(() => {}),
  };
}

export function memoryMB(pids) {
  if (!pids.length) return null;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue; [math]::Round(($p | Measure-Object WorkingSet64 -Sum).Sum / 1MB), [math]::Round(($p | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB)`], { encoding: 'utf8', timeout: 15000 });
    const [ws, priv] = out.trim().split(/\s+/).map(Number);
    return { workingSetMB: ws, privateMB: priv };
  } catch (e) { return { error: String(e).slice(0, 100) }; }
}

/** Parse a PCM WAV: returns {fmt:{channels,sampleRate,bits}, data:Buffer}. */
export function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12; let fmt = null; let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4); const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') { data = buf.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV without fmt/data');
  return { fmt, data };
}

/** Time-domain analysis helpers (levels rows = [t, rmsTrack0, rmsTrack1, ...]). */
export function windowStats(levels, from, to) {
  const rows = levels.filter((r) => r[0] >= from && r[0] <= to);
  if (!rows.length) return null;
  const n = rows[0].length - 1;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const v = rows.map((r) => r[i] ?? 0);
    out.push({ track: i - 1, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(5), max: +Math.max(...v).toFixed(5), samples: v.length });
  }
  return out;
}
export function onsetAfter(levels, t0, thr) {
  for (const r of levels) {
    if (r[0] < t0) continue;
    for (let i = 1; i < r.length; i++) if (r[i] > thr) return { t: r[0], track: i - 1, rms: r[i] };
  }
  return null;
}
export function offsetAfter(levels, t0, horizon, thr) {
  let last = null;
  for (const r of levels) {
    if (r[0] < t0 || r[0] > t0 + horizon) continue;
    for (let i = 1; i < r.length; i++) if (r[i] > thr) last = { t: r[0], track: i - 1, rms: r[i] };
  }
  return last;
}
function kbps(a, b, kind) {
  const sum = (s) => s.outbound.filter((o) => o.kind === kind).reduce((acc, o) => acc + (o.bytesSent || 0), 0);
  const dt = (b.t - a.t) / 1000;
  return +((sum(b) - sum(a)) * 8 / 1000 / dt).toFixed(1);
}

/** Downscale a PNG data URL inside the page (about:blank) to a small JPEG data URL for init-script use. */
async function downscaleInPage(page, dataUrl, size = 512) {
  return page.evaluate(async ([src, sz]) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('img load')); img.src = src; });
    const c = document.createElement('canvas'); c.width = sz; c.height = sz;
    c.getContext('2d').drawImage(img, 0, 0, sz, sz);
    return c.toDataURL('image/jpeg', 0.88);
  }, [dataUrl, size]);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || args._[0];
  if (!url) { console.error('usage: node tools/telemost_spike.js --url <link> [--adapter fake|wp2] [--reps 3] [--phase-seconds 40] [--chat]'); process.exit(2); }
  if (/11111111111111111111111111111111111111/.test(url)) { console.error('refusing to use the real standup room'); process.exit(2); }
  const adapter = args.adapter || 'fake';
  const hostName = args['host-name'] || 'Кора (ИИ-ведущая)';
  const listenerName = args['listener-name'] || 'Тест-слушатель';
  const reps = Number(args.reps ?? 3);
  const phaseS = Number(args['phase-seconds'] ?? 30);
  const maxS = Number(args['max-seconds'] ?? 240); // hard wall-clock limit for the whole run (leave + close included)
  const avatarPath = args.avatar ? path.resolve(args.avatar) : path.join(ROOT, 'assets', 'avatar.png');
  const avatarDataUrl = fs.existsSync(avatarPath) ? 'data:image/png;base64,' + fs.readFileSync(avatarPath).toString('base64') : null;
  const clip48 = path.join(ROOT, '_internal', 'test_clip.wav');
  const clip24 = path.join(ROOT, '_internal', 'test_clip_24k.wav');
  const clipB64Wav = fs.existsSync(clip48) ? fs.readFileSync(clip48).toString('base64') : null;
  let pcm24B64 = null;
  if (fs.existsSync(clip24)) { const { fmt, data } = parseWav(fs.readFileSync(clip24)); if (fmt.sampleRate === 24000 && fmt.channels === 1 && fmt.bits === 16) pcm24B64 = data.toString('base64'); }
  const dir = mkOutDir('spike');
  const logFile = fs.createWriteStream(path.join(dir, 'events.jsonl'));
  const log = (e) => { const rec = { ts: new Date().toISOString(), ...e }; logFile.write(JSON.stringify(rec) + '\n'); console.log(JSON.stringify(rec).slice(0, 1200)); };
  const report = { url, adapter, hostName, listenerName, avatar: avatarDataUrl ? avatarPath : null, clip: adapter === 'wp2' ? (pcm24B64 ? clip24 : 'synth (no 24k clip)') : (clipB64Wav ? clip48 : 'synthVoice'), reps, phaseS, cores: os.cpus().length, cpu: os.cpus()[0]?.model, chrome: null };
  console.log('output dir:', dir);

  // ---- launch -------------------------------------------------------------
  // Listener: camera-capable fake media (a failing video request pops «Включить видео не удалось» over the
  // pre-join form); the camera toggle is switched OFF at pre-join, so no video is ever sent.
  const lisInit = buildFakeMediaScript({ camera: true, fps: 2, width: 160, height: 120, redrawMs: 1000, avatarText: 'Т', avatarName: 'слушатель', micLabel: 'Listener virtual microphone' }) + '\n' + DOM_PROBE_SCRIPT + '\n' + RTC_PROBE_SCRIPT;
  const lis = await launchBrowser({ profileDir: 'profile/guest1', initScript: lisInit, log: (e) => log({ who: 'listener', ...e }) });

  let host; let hostAudio = null; const wp2Events = [];
  if (adapter === 'wp2') {
    const { attachPageAudio } = await import('../src/browser/page_inject.js');
    host = await launchBrowser({ profileDir: 'profile/host', initScript: DOM_PROBE_SCRIPT + '\n' + RTC_PROBE_SCRIPT, log: (e) => log({ who: 'host', ...e }) });
    const small = avatarDataUrl ? await downscaleInPage(host.page, avatarDataUrl, 512) : null;
    log({ who: 'host', type: 'avatar.downscaled', bytes: small ? small.length : 0 });
    hostAudio = await attachPageAudio(host.page, {
      onEvent: (ev) => { wp2Events.push({ tr: Date.now(), ...ev }); if (!/^audio\.state|player\.progress/.test(ev.type)) log({ who: 'host', type: 'wp2.' + ev.type, ...ev }); },
      opts: { avatar: small ? { src: small, fps: 12, width: 640, height: 480, shape: 'circle', label: 'Аватар' } : null, capture: false },
    });
  } else {
    const hostInit = buildFakeMediaScript({ camera: true, avatarText: 'К', avatarName: 'Кора' }) + '\n' + DOM_PROBE_SCRIPT + '\n' + RTC_PROBE_SCRIPT;
    host = await launchBrowser({ profileDir: 'profile/host', initScript: hostInit, log: (e) => log({ who: 'host', ...e }) });
  }
  for (const [who, g] of [['host', host], ['listener', lis]]) {
    const cl = fs.createWriteStream(path.join(dir, `console_${who}.log`));
    g.page.on('console', (m) => cl.write(`[${m.type()}] ${m.text().slice(0, 400)}\n`));
    g.page.on('pageerror', (e) => cl.write(`[pageerror] ${String(e).slice(0, 400)}\n`));
    g.page.on('dialog', async (d) => { log({ who, type: 'dialog', message: d.message() }); await d.dismiss().catch(() => {}); });
  }
  const hostCpu = await cpuSampler(host.context);
  const lisCpu = await cpuSampler(lis.context);
  report.chrome = (await host.context.browser().version());

  let finished = false;
  const bounded = (p, ms, label) => Promise.race([p, new Promise((r) => setTimeout(() => r({ timeout: label }), ms))]);
  const finish = async (code) => {
    if (finished) return; finished = true;
    for (const [who, g] of [['host', host], ['listener', lis]]) {
      try { const r = await bounded(leave(g.page, { log: (e) => log({ who, ...e }) }), 12_000, 'leave'); log({ who, type: 'leave.result', ...r }); } catch (e) { log({ who, type: 'leave.error', error: String(e).slice(0, 200) }); }
    }
    await bounded(Promise.all([hostCpu.detach(), lisCpu.detach()]), 3000, 'detach');
    await bounded(Promise.all([host.close(), lis.close()]), 15_000, 'close');
    if (wp2Events.length) fs.writeFileSync(path.join(dir, 'wp2_events.json'), JSON.stringify(wp2Events, null, 1));
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
    logFile.end();
    console.log('REPORT', JSON.stringify(report, null, 1));
    console.log('done; output in', dir);
    process.exit(code);
  };
  // Hard wall-clock stop: leaves + closes within the budget even if a step hangs.
  const hardStop = setTimeout(() => { log({ type: 'hard-stop', detail: `${maxS} s budget` }); finish(3); }, Math.max(60, maxS - 30) * 1000);
  setTimeout(() => { console.error('FORCE EXIT: budget exceeded'); killStrayChrome(host.userDataDir); killStrayChrome(lis.userDataDir); process.exit(4); }, maxS * 1000).unref();

  const setFakeAvatar = async () => {
    if (adapter !== 'fake' || !avatarDataUrl) return;
    const r = await host.page.evaluate((s) => window.__fakeMedia ? window.__fakeMedia.setAvatar(s) : null, avatarDataUrl).catch((e) => ({ error: String(e).slice(0, 120) }));
    log({ who: 'host', type: 'avatar.set', ...r });
  };

  /** Play the clip through the chosen adapter; returns {startedAt, endedAt, durationMs}. */
  const playClip = async () => {
    if (adapter === 'wp2') {
      const before = wp2Events.length;
      const startedAt = Date.now();
      if (pcm24B64) await hostAudio.play(pcm24B64); else throw new Error('no 24k clip for wp2 adapter');
      await hostAudio.playEnd();
      const deadline = Date.now() + 15000;
      let drained = null;
      while (Date.now() < deadline && !drained) {
        drained = wp2Events.slice(before).find((e) => e.type === 'player.drained');
        if (!drained) await host.page.waitForTimeout(50);
      }
      const endedAt = drained ? drained.tr : Date.now();
      return { startedAt, endedAt, durationMs: endedAt - startedAt, played_ms: drained?.played_ms, reason: drained?.reason, underruns: drained?.underruns };
    }
    return clipB64Wav
      ? host.page.evaluate((b) => window.__fakeMedia.playWavBase64(b), clipB64Wav)
      : host.page.evaluate(() => window.__fakeMedia.playSynthVoice(3000));
  };

  try {
    // ---- join both -------------------------------------------------------
    const jh = await join(host.page, url, hostName, {
      mic: true, camera: true, waitAdmissionMs: 120_000, log: (e) => log({ who: 'host', ...e }),
      onStage: async (s) => { if (s === 'landing' || s === 'prejoin') await setFakeAvatar(); if (s === 'prejoin-ready' || s === 'joined') await snap(host.page, `host_${s}`, dir); },
    });
    log({ who: 'host', type: 'join.result', ...jh });
    report.hostJoin = jh;
    if (jh.status !== 'joined') return finish(1);
    report.hostMedia = adapter === 'wp2' ? await hostAudio.status().catch((e) => ({ error: String(e).slice(0, 200) })) : await host.page.evaluate(() => window.__fakeMedia?.info()).catch(() => null);
    log({ who: 'host', type: 'media.status', status: report.hostMedia });

    const jl = await join(lis.page, url, listenerName, { mic: true, camera: false, waitAdmissionMs: 120_000, log: (e) => log({ who: 'listener', ...e }), onStage: async (s) => { if (s === 'joined' || s === 'waiting') await snap(lis.page, `listener_${s}`, dir); } });
    log({ who: 'listener', type: 'join.result', ...jl });
    report.listenerJoin = jl;
    if (jl.status !== 'joined') return finish(1);

    await host.page.waitForTimeout(4000);
    await Promise.all([ensureProbe(host.page), ensureProbe(lis.page)]);
    await dumpStage(lis.page, dir, 'listener_incall');
    await dumpStage(host.page, dir, 'host_incall');
    const tilesHtml = await lis.page.evaluate((s) => window.__probe.outer(s, 60000), SEL.incall.tilesRoot).catch(() => null);
    if (tilesHtml) fs.writeFileSync(path.join(dir, 'listener_tiles.html'), tilesHtml, 'utf8');

    report.participantsSeenByListener = await getParticipants(lis.page, { selfName: listenerName }).catch((e) => ({ error: String(e).slice(0, 200) }));
    report.participantsSeenByHost = await getParticipants(host.page, { selfName: hostName }).catch((e) => ({ error: String(e).slice(0, 200) }));
    log({ type: 'participants', listener: report.participantsSeenByListener, host: report.participantsSeenByHost });
    report.participantsPanel = await getParticipantsFromPanel(host.page, { close: true }).catch((e) => ({ error: String(e).slice(0, 200) }));
    log({ who: 'host', type: 'participants.panel', ...report.participantsPanel });
    await closePanels(host.page);
    report.listenerRxTracks = await lis.page.evaluate(() => window.__rtc.tracks());
    report.listenerPcs = await lis.page.evaluate(() => window.__rtc.pcs());
    report.hostPcs = await host.page.evaluate(() => window.__rtc.pcs());
    log({ who: 'listener', type: 'rx.tracks', tracks: report.listenerRxTracks, pcs: report.listenerPcs, hostPcs: report.hostPcs });

    // ---- avatar check on the listener --------------------------------------
    report.avatar = await lis.page.evaluate((blockSel) => [...document.querySelectorAll('video')].map((v) => {
      const r = v.getBoundingClientRect();
      let color = null;
      try {
        if (v.videoWidth) {
          const c = document.createElement('canvas'); c.width = 32; c.height = 24;
          const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(v, 0, 0, 32, 24);
          const d = g.getImageData(0, 0, 32, 24).data; let rr = 0, gg = 0, bb = 0;
          for (let i = 0; i < d.length; i += 4) { rr += d[i]; gg += d[i + 1]; bb += d[i + 2]; }
          const n = d.length / 4; const cd = g.getImageData(16, 12, 1, 1).data;
          color = { avg: [Math.round(rr / n), Math.round(gg / n), Math.round(bb / n)], center: [cd[0], cd[1], cd[2]] };
        }
      } catch (e) { color = 'err:' + String(e).slice(0, 60); }
      const block = v.parentElement ? v.parentElement.querySelector(blockSel) : null;
      return { w: v.videoWidth, h: v.videoHeight, paused: v.paused, visible: r.width > 0, box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], tracks: v.srcObject ? v.srcObject.getTracks().map((t) => t.kind + ':' + t.readyState + (t.muted ? ':muted' : '')) : null, gTrack: { id: v.getAttribute('data-g_track_id'), state: v.getAttribute('data-g_track_state'), enabled: v.getAttribute('data-g_track_enabled'), muted: v.getAttribute('data-g_track_muted') }, tileName: (block?.querySelector('[class*="TextName"]')?.getAttribute('title') || block?.innerText || '').slice(0, 60), color };
    }), SEL.incall.tileBlock).catch((e) => ({ error: String(e).slice(0, 200) }));
    log({ who: 'listener', type: 'avatar.videos', videos: report.avatar });
    await snap(lis.page, 'listener_view_avatar', dir);
    try {
      const tile = lis.page.locator(SEL.incall.tileBlock).filter({ hasText: hostName }).first().locator('xpath=..');
      await tile.screenshot({ path: path.join(dir, 'listener_kora_tile.png'), timeout: 5000 });
      log({ who: 'listener', type: 'avatar.tile.screenshot', file: 'listener_kora_tile.png' });
    } catch (e) { log({ who: 'listener', type: 'avatar.tile.screenshot.error', error: String(e).slice(0, 160) }); }

    // ---- S2: play the clip N× ----------------------------------------------
    await lis.page.evaluate(() => { window.__probe.startMutationLog(); window.__rtc.levels(true); });
    await host.page.evaluate(() => { window.__probe.startMutationLog(); });
    const speakerEvents = [];
    let stopSpeaker = () => {};
    try { stopSpeaker = watchActiveSpeaker(lis.page, (names) => { speakerEvents.push({ t: Date.now(), names }); log({ who: 'listener', type: 'activeSpeaker', names }); }); } catch (e) { log({ type: 'watchActiveSpeaker.unavailable', error: String(e).slice(0, 120) }); }

    const baselineFrom = Date.now();
    await host.page.waitForTimeout(3000);
    const baselineTo = Date.now();
    const statsBefore = await host.page.evaluate(() => window.__rtc.stats());
    const playWindows = [];
    for (let i = 0; i < reps; i++) {
      const w = await playClip();
      playWindows.push(w);
      log({ who: 'host', type: 'clip.played', rep: i + 1, ...w });
      await host.page.waitForTimeout(2500);
    }
    await host.page.waitForTimeout(1000);
    stopSpeaker();
    const levels = await lis.page.evaluate(() => window.__rtc.levels(false));
    const muts = await lis.page.evaluate(() => window.__probe.readMutationLog(true));
    const hostMuts = await host.page.evaluate(() => window.__probe.readMutationLog(true));
    fs.writeFileSync(path.join(dir, 'listener_levels.json'), JSON.stringify(levels));
    fs.writeFileSync(path.join(dir, 'listener_mutations_during_clips.json'), JSON.stringify(muts, null, 1));
    fs.writeFileSync(path.join(dir, 'host_mutations_during_clips.json'), JSON.stringify(hostMuts, null, 1));
    const statsAfter = await host.page.evaluate(() => window.__rtc.stats());
    const lisStats = await lis.page.evaluate(() => window.__rtc.stats());
    fs.writeFileSync(path.join(dir, 'stats_clips.json'), JSON.stringify({ statsBefore, statsAfter, lisStats }, null, 1));

    const base = windowStats(levels, baselineFrom, baselineTo);
    const baseMax = Math.max(0.0005, ...(base || []).map((b) => b.max));
    const thr = Math.max(baseMax * 3, 0.004);
    // mutation summary: which attributes/classes changed on tiles while the host was speaking
    const mutSummary = {};
    for (const m of muts) {
      const k = m.type === 'attr' ? `attr:${m.attr}@${m.path}` : `${m.type}@${m.path}`;
      mutSummary[k] = (mutSummary[k] || 0) + 1;
    }
    report.audio = {
      baseline: base, threshold: thr,
      reps: playWindows.map((w, i) => {
        const during = windowStats(levels, w.startedAt, w.endedAt + 800);
        const on = onsetAfter(levels, w.startedAt - 200, thr);
        const off = offsetAfter(levels, w.startedAt, w.durationMs + 2500, thr);
        const domOn = speakerEvents.find((e) => e.t >= w.startedAt - 500 && e.names.length && e.t <= w.endedAt + 2500);
        const domOff = speakerEvents.find((e) => domOn && e.t > domOn.t && !e.names.length);
        const mutsInWindow = muts.filter((m) => m.t >= w.startedAt - 300 && m.t <= w.endedAt + 2500).length;
        return { rep: i + 1, startedAt: w.startedAt, durationMs: w.durationMs, played_ms: w.played_ms, during, onsetLatencyMs: on ? on.t - w.startedAt : null, offsetAfterEndMs: off ? off.t - w.endedAt : null, domSpeakerOnMs: domOn ? domOn.t - w.startedAt : null, domSpeakerNames: domOn?.names, domSpeakerOffMs: domOff ? domOff.t - w.endedAt : null, mutationsInWindow: mutsInWindow };
      }),
      hostMediaSource: statsAfter.sources, listenerInbound: lisStats.inbound, listenerActiveSpeakerEvents: speakerEvents,
      mutationsDuringClips: muts.length, mutationSummary: Object.entries(mutSummary).sort((a, b) => b[1] - a[1]).slice(0, 40),
    };
    log({ type: 'audio.report', ...report.audio, listenerActiveSpeakerEvents: speakerEvents.length });

    // ---- chat (optional) ---------------------------------------------------
    if (args.chat) {
      const got = [];
      let stopChat = () => {};
      try { stopChat = watchChat(lis.page, (m) => { got.push({ t: Date.now(), ...m }); log({ who: 'listener', type: 'chat.seen', ...m }); }); } catch (e) { log({ type: 'watchChat.unavailable', error: String(e).slice(0, 120) }); }
      await lis.page.waitForTimeout(1500);
      const t0 = Date.now();
      const pr = await postChat(host.page, 'тест бота, не обращайте внимания', { log: (e) => log({ who: 'host', ...e }) }).catch((e) => ({ ok: false, error: String(e).slice(0, 200) }));
      await lis.page.waitForTimeout(5000);
      stopChat();
      report.chat = { post: pr, received: got, latencyMs: got[0] ? got[0].t - t0 : null };
      log({ type: 'chat.report', ...report.chat });
      await snap(lis.page, 'listener_chat', dir);
      await snap(host.page, 'host_chat', dir);
      await closePanels(host.page); await closePanels(lis.page);
    }

    // ---- S5: CPU + upload, camera on vs off ---------------------------------
    const phases = [];
    for (const cam of [true, false]) {
      if (!cam) {
        const r = await setCamera(host.page, false, (e) => log({ who: 'host', ...e })).catch((e) => ({ error: String(e).slice(0, 200) }));
        log({ who: 'host', type: 'camera.off', ...r });
        await host.page.waitForTimeout(3000);
      }
      const c0 = await hostCpu.sample(); const l0 = await lisCpu.sample(); const s0 = await host.page.evaluate(() => window.__rtc.stats());
      await host.page.waitForTimeout(phaseS * 1000);
      const c1 = await hostCpu.sample(); const l1 = await lisCpu.sample(); const s1 = await host.page.evaluate(() => window.__rtc.stats());
      const hc = hostCpu.diff(c0, c1); const lc = lisCpu.diff(l0, l1);
      const ph = { camera: cam, host: { cpu: hc, mem: memoryMB(hc.pids) }, listener: { cpu: lc, mem: memoryMB(lc.pids) }, uploadKbps: { video: kbps(s0, s1, 'video'), audio: kbps(s0, s1, 'audio') }, outboundVideo: s1.outbound.filter((o) => o.kind === 'video'), source: s1.sources };
      phases.push(ph);
      log({ type: 'phase', ...ph });
      await snap(lis.page, `listener_view_camera_${cam ? 'on' : 'off'}`, dir);
    }
    report.phases = phases;
    report.participantsEnd = await getParticipants(lis.page, { selfName: listenerName }).catch(() => null);
    clearTimeout(hardStop);
    await finish(0);
  } catch (e) {
    log({ type: 'error', error: String(e && e.stack || e) });
    await snap(host.page, 'host_error', dir); await snap(lis.page, 'listener_error', dir);
    clearTimeout(hardStop);
    await finish(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
