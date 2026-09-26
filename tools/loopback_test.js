// Loopback acceptance test for the page audio adapter (WP2). No Telemost needed.
//
//   node tools/loopback_test.js            (from scripts/standup_host)
//
// Launches installed Chrome via playwright-core, serves a tiny page from 127.0.0.1, opens it twice
// (tab A = caller with our mic + avatar camera, tab B = callee) and connects them with a real
// RTCPeerConnection (signalling over a same-origin BroadcastChannel). Both tabs carry the init
// script from src/browser/page_inject.js, so:
//   A: __host_play() -> PlayerWorklet -> "microphone" -> WebRTC -> B: CaptureWorklet -> __host_audio
// Tests: (1) clip correlation + lag, (2) flush latency, (3) level cadence + echo isolation,
// (4) WAV fixture, (5) avatar video frames + speaking glow + camera toggle, (6) API sanity.
// Exit code 1 if any test FAILs.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { attachPageAudio, serveAssets } from '../src/browser/page_inject.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
const SR = 24000;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WITH_VIDEO = process.env.LOOPBACK_VIDEO !== '0';   // LOOPBACK_VIDEO=0 -> audio-only run (CPU baseline)
const AVATAR_MODE = process.env.LOOPBACK_AVATAR === 'still' ? 'still' : 'segments';   // LOOPBACK_AVATAR=still|segments
const LIVE_DIR = path.join(ROOT, 'assets', 'live');                 // Кора's continuous Sora take: kora_live.mp4 (20 s, 1280x720)
const LIVE_FILE = 'kora_live.mp4';
const LOOPS_GENERATED = path.join(FIXTURES, 'loops');               // generated stand-in take (MediaRecorder)
const STANDIN_FILE = 'kora_live_standin.mp4';
// placeholder listen/talk ranges (seconds in the file) until the real take is analysed
const SEGMENTS = { listen: [[0.3, 3.7], [10.3, 13.7], [18.2, 19.8]], talk: [[4.3, 9.7], [14.3, 17.7]] };
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------
// Synthetic signals (Int16Array, 24 kHz mono)
// ------------------------------------------------------------------------------------------------
function toPcm16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) { const v = Math.max(-1, Math.min(1, f32[i])); out[i] = v < 0 ? v * 32768 : v * 32767; }
  return out;
}
function chirp(sec, f0, f1, amp) {
  const n = Math.round(sec * SR); const out = new Float32Array(n);
  const fade = Math.round(0.01 * SR);
  for (let i = 0; i < n; i++) {
    const t = i / SR; const f = f0 + (f1 - f0) * (t / sec);
    let g = amp; if (i < fade) g *= i / fade; if (n - i < fade) g *= (n - i) / fade;
    out[i] = g * Math.sin(2 * Math.PI * (f0 * t + (f1 - f0) * t * t / (2 * sec)));
  }
  return out;
}
function speechLike(sec, amp) {
  // syllable bursts: harmonic tone (f0 160..220 Hz, 12 harmonics) with 4.5 syllables/s and word gaps
  const n = Math.round(sec * SR); const out = new Float32Array(n);
  const syl = 0.22, voiced = 0.14;
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const count = Math.floor(sec / syl);
  for (let s = 0; s < count; s++) {
    if (s % 5 === 4) continue;                       // word gap
    const f0 = 160 + 60 * rnd(); const start = Math.round(s * syl * SR); const len = Math.round(voiced * SR);
    const ph = rnd() * 6.28;
    for (let i = 0; i < len && start + i < n; i++) {
      const t = i / SR; const env = Math.sin(Math.PI * i / len);
      let v = 0;
      for (let h = 1; h <= 12; h++) v += Math.sin(2 * Math.PI * f0 * h * t + ph * h) / h * (h <= 3 ? 1 : 0.5);
      out[start + i] = amp * env * v / 2.2;
    }
  }
  return out;
}
function twoTone(sec, amp) {
  const n = Math.round(sec * SR); const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; out[i] = amp * (0.6 * Math.sin(2 * Math.PI * 523 * t) + 0.4 * Math.sin(2 * Math.PI * 659 * t)); }
  const fade = Math.round(0.005 * SR); for (let i = 0; i < fade; i++) out[i] *= i / fade;
  return out;
}
function concat(...arrs) { const n = arrs.reduce((a, b) => a + b.length, 0); const out = new Float32Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; }

// ------------------------------------------------------------------------------------------------
// Analysis helpers
// ------------------------------------------------------------------------------------------------
function envelope(pcm, winFrames) {
  const n = Math.floor(pcm.length / winFrames); const out = new Float64Array(n);
  for (let w = 0; w < n; w++) { let s = 0; for (let i = w * winFrames; i < (w + 1) * winFrames; i++) { const v = pcm[i] / 32768; s += v * v; } out[w] = Math.sqrt(s / winFrames); }
  return out;
}
function dbfs(rms) { return rms > 0 ? 20 * Math.log10(rms) : -100; }
function pearson(a, b) {
  const n = Math.min(a.length, b.length); if (n < 4) return 0;
  let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}
function bestLag(src, cap) {
  // slide src over cap (cap delayed), lag >= 0
  let best = { lag: 0, corr: -2 };
  const maxLag = cap.length - src.length;
  for (let lag = 0; lag <= maxLag; lag++) {
    const c = pearson(src, cap.subarray(lag, lag + src.length));
    if (c > best.corr) best = { lag, corr: c };
  }
  return best;
}
function median(arr) { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; }
function fmt(x, d = 1) { return Number.isFinite(x) ? x.toFixed(d) : 'n/a'; }

// Timeline of captured chunks: map (chunk, sampleIndex) -> Node time (ms), using the audio clock
// of the capturing page (meta.ctx_time) aligned to Node arrival times via a median offset.
function makeTimeline(chunks) {
  const offs = chunks.map((c) => c.t - c.meta.ctx_time * 1000);
  const off = median(offs);
  return {
    off,
    sampleTime: (c, i) => c.meta.ctx_time * 1000 + off - (c.meta.frames - i) / SR * 1000,
  };
}
function joinChunks(chunks) {
  const n = chunks.reduce((a, c) => a + c.pcm.length, 0); const out = new Int16Array(n); let o = 0;
  for (const c of chunks) { out.set(c.pcm, o); o += c.pcm.length; }
  return out;
}
// first sample index (5 ms windows) where level crosses threshold, searching from `from`
function findOnset(pcm, thrDb, from = 0, win = 120) {
  for (let s = from; s + win <= pcm.length; s += win) {
    let e = 0; for (let i = s; i < s + win; i++) { const v = pcm[i] / 32768; e += v * v; }
    if (dbfs(Math.sqrt(e / win)) > thrDb) return s;
  }
  return -1;
}
function findOffset(pcm, thrDb, from, holdFrames, win = 120) {
  for (let s = from; s + win <= pcm.length; s += win) {
    let quiet = true;
    for (let q = s; q < Math.min(pcm.length - win, s + holdFrames); q += win) {
      let e = 0; for (let i = q; i < q + win; i++) { const v = pcm[i] / 32768; e += v * v; }
      if (dbfs(Math.sqrt(e / win)) > thrDb) { quiet = false; break; }
    }
    if (quiet) return s;
  }
  return -1;
}
function sampleToTime(chunks, tl, sampleIdx) {
  let acc = 0;
  for (const c of chunks) { if (sampleIdx < acc + c.pcm.length) return tl.sampleTime(c, sampleIdx - acc); acc += c.pcm.length; }
  return NaN;
}

// ------------------------------------------------------------------------------------------------
// PNG avatar (RGBA, filter 0, one IDAT)
// ------------------------------------------------------------------------------------------------
function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { let c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makeAvatarPng(size = 256) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4; const d = Math.hypot(x - cx, y - cy);
    let r = 40 + Math.round(60 * y / size), g = 70, b = 130;                 // background
    if (d < size * 0.36) { r = 236; g = 196; b = 168; }                       // face
    if (Math.hypot(x - cx + size * 0.12, y - cy + size * 0.08) < size * 0.035) { r = 40; g = 30; b = 30; }  // eyes
    if (Math.hypot(x - cx - size * 0.12, y - cy + size * 0.08) < size * 0.035) { r = 40; g = 30; b = 30; }
    const dm = Math.hypot(x - cx, y - (cy + size * 0.02));
    if (y > cy + size * 0.1 && dm > size * 0.2 && dm < size * 0.23) { r = 150; g = 50; b = 60; }           // smile
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------------------------------------
// WAV
// ------------------------------------------------------------------------------------------------
function writeWav(file, pcm, sr) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

// ------------------------------------------------------------------------------------------------
// CPU of the whole Chrome process tree via CDP SystemInfo.getProcessInfo (cpuTime in seconds)
// ------------------------------------------------------------------------------------------------
async function chromeCpuSeconds(browser) {
  try {
    const cdp = await browser.newBrowserCDPSession();
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    await cdp.detach().catch(() => {});
    const byType = {};
    for (const p of processInfo) byType[p.type] = (byType[p.type] || 0) + (p.cpuTime || 0);
    return { total: processInfo.reduce((a, p) => a + (p.cpuTime || 0), 0), byType };
  } catch (e) { return { total: NaN, byType: {} }; }
}

// ------------------------------------------------------------------------------------------------
// Test page
// ------------------------------------------------------------------------------------------------
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>host loopback</title></head><body>
<script>
// Clip generator (used when assets/loops/*.mp4 are absent): the portrait padded to 1280x720 on
// #050508 with a small animation, recorded from canvas.captureStream via MediaRecorder.
window.__lb_makeClip = async ({ avatarUrl, segments, seconds, fps }) => {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('avatar load')); i.src = avatarUrl; });
  const W = 1280, H = 720; const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(c.captureStream(fps), { mimeType: mime, videoBitsPerSecond: 2500000 });
  const parts = []; rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });
  const s = Math.min(W / img.naturalWidth, H / img.naturalHeight); const dw = img.naturalWidth * s, dh = img.naturalHeight * s; const x0 = (W - dw) / 2, y0 = (H - dh) / 2;
  const t0 = performance.now();
  const kindAt = (t) => (segments.talk.some(([a, b]) => t >= a && t < b) ? 'talk' : 'listen');
  const draw = () => {
    const t = (performance.now() - t0) / 1000;
    const kind = kindAt(t);
    g.fillStyle = '#050508'; g.fillRect(0, 0, W, H);
    if (kind === 'talk') {
      g.drawImage(img, x0, y0 + Math.sin(t * 6.5) * 6, dw, dh);
      const m = 0.5 + 0.5 * Math.sin(t * 12);
      g.globalAlpha = 0.35 * m; g.fillStyle = '#1a0a10'; g.beginPath(); g.ellipse(W / 2, y0 + dh * 0.56, 40, 10 + 14 * m, 0, 0, 6.2832); g.fill(); g.globalAlpha = 1;
    } else {
      const z = 1 + 0.01 * Math.sin(t * 1.2); const zw = dw * z, zh = dh * z;
      g.drawImage(img, x0 - (zw - dw) / 2, y0 - (zh - dh) / 2, zw, zh);
      g.globalAlpha = 0.25 + 0.15 * Math.sin(t * 0.9); g.fillStyle = '#7532FF'; g.fillRect(x0 - 30, 0, 20, H); g.fillRect(x0 + dw + 10, 0, 20, H); g.globalAlpha = 1;
    }
  };
  rec.start(); const iv = setInterval(draw, 1000 / fps); draw();
  await new Promise((r) => setTimeout(r, seconds * 1000)); clearInterval(iv); rec.stop(); await done;
  const u8 = new Uint8Array(await new Blob(parts, { type: mime }).arrayBuffer());
  let b = ''; for (let i = 0; i < u8.length; i += 0x8000) b += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { b64: btoa(b), mime, size: u8.length };
};
(async () => {
  const q = new URLSearchParams(location.search);
  if (q.get('gen') === '1') { window.__lb = { ready: true, gen: true }; return; }
  const role = q.get('role'); const other = role === 'A' ? 'B' : 'A';
  const wantVideo = q.get('video') === '1';
  const S = window.__lb = { role, ready: false, conn: 'new', ice: 'new', remote: [], errors: [], localTracks: [], videoEl: null, localVideoTrack: null, videoTrack2: null };
  const bc = new BroadcastChannel('host-loopback');
  const pc = new RTCPeerConnection({ iceServers: [] });
  S.pc = pc;
  const pendingIce = []; let remoteSet = false;
  pc.addEventListener('track', (ev) => {
    S.remote.push({ id: ev.track.id, kind: ev.track.kind, mid: ev.transceiver && ev.transceiver.mid });
    if (ev.track.kind === 'video') {
      const v = document.createElement('video'); v.autoplay = true; v.muted = true; v.playsInline = true;
      v.srcObject = new MediaStream([ev.track]); v.style.width = '320px'; document.body.appendChild(v); v.play().catch(() => {});
      S.videoEl = v;
    }
  });
  pc.addEventListener('connectionstatechange', () => { S.conn = pc.connectionState; });
  pc.addEventListener('iceconnectionstatechange', () => { S.ice = pc.iceConnectionState; });
  pc.addEventListener('icecandidate', (e) => { if (e.candidate) bc.postMessage({ from: role, type: 'ice', cand: e.candidate.toJSON() }); });
  try {
    const ms = await navigator.mediaDevices.getUserMedia(wantVideo ? { audio: true, video: true } : { audio: true });
    for (const t of ms.getTracks()) {
      pc.addTrack(t, ms);
      S.localTracks.push({ id: t.id, kind: t.kind, label: t.label, settings: t.getSettings() });
      if (t.kind === 'video') S.localVideoTrack = t;
    }
  } catch (e) { S.errors.push('gum: ' + e); }
  async function drainIce() { remoteSet = true; while (pendingIce.length) { try { await pc.addIceCandidate(pendingIce.shift()); } catch (e) { S.errors.push('ice: ' + e); } } }
  bc.onmessage = async ({ data }) => {
    if (!data || data.from !== other) return;
    try {
      if (data.type === 'hello' && role === 'B') bc.postMessage({ from: role, type: 'ready' });
      else if (data.type === 'ready' && role === 'A') { await pc.setLocalDescription(await pc.createOffer()); bc.postMessage({ from: role, type: 'offer', sdp: pc.localDescription.toJSON() }); }
      else if (data.type === 'offer' && role === 'B') { await pc.setRemoteDescription(data.sdp); await drainIce(); await pc.setLocalDescription(await pc.createAnswer()); bc.postMessage({ from: role, type: 'answer', sdp: pc.localDescription.toJSON() }); }
      else if (data.type === 'answer' && role === 'A') { await pc.setRemoteDescription(data.sdp); await drainIce(); }
      else if (data.type === 'ice') { if (remoteSet) await pc.addIceCandidate(data.cand); else pendingIce.push(data.cand); }
    } catch (e) { S.errors.push(data.type + ': ' + e); }
  };
  S.ready = true;
  bc.postMessage({ from: role, type: role === 'A' ? 'hello' : 'ready' });
  window.__lb_sampleVideo = (w = 64, h = 48) => {
    const v = S.videoEl; if (!v || v.readyState < 2) return null;
    const c = window.__lb_canvas || (window.__lb_canvas = document.createElement('canvas')); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(v, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data; const gray = new Array(w * h); let sum = 0, nonBlack = 0;
    for (let i = 0; i < w * h; i++) { const y = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114; gray[i] = Math.round(y); sum += y; if (y > 24) nonBlack++; }
    return { w, h, mean: sum / (w * h), nonBlackRatio: nonBlack / (w * h), gray, videoWidth: v.videoWidth, videoHeight: v.videoHeight };
  };
  window.__lb_grabFrame = () => {   // full-resolution PNG of the current remote video frame
    const v = S.videoEl; if (!v || v.readyState < 2) return null;
    const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0); return c.toDataURL('image/png');
  };
})();
</script></body></html>`;

function startServer(avatarPng) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/avatar.png') {   // Кора's portrait when present, else the synthetic face
        const real = path.join(ROOT, 'assets', 'avatar.png');
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); res.end(fs.existsSync(real) ? fs.readFileSync(real) : avatarPng); return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(PAGE_HTML);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ------------------------------------------------------------------------------------------------
// Main
// ------------------------------------------------------------------------------------------------
async function main() {
  const { chromium } = await import('playwright-core');
  const avatarPng = makeAvatarPng(256);
  const { server, base } = await startServer(avatarPng);
  // Кора's real avatar (config/settings.json -> avatar.path) when present, else the synthetic PNG over http.
  const ASSET = path.join(ROOT, 'assets', 'avatar.png');
  const stillOpts = fs.existsSync(ASSET) ? { path: 'assets/avatar.png' } : { src: `${base}/avatar.png` };
  let avatarOpts = { ...stillOpts, fps: 12, width: 640, height: 480 };
  let loopsDir = null, loopNames = null;
  const results = [];
  const add = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
  const rec = { A: { chunks: [], events: [] }, B: { chunks: [], events: [] } };
  const hook = (role) => ({
    onAudio: (pcm, levels, meta) => rec[role].chunks.push({ t: now(), pcm, levels, meta }),
    onEvent: (ev) => rec[role].events.push({ ...ev, tn: now() }),
  });
  const waitEvent = (role, pred, timeoutMs, since = 0) => new Promise((res, rej) => {
    const t0 = now();
    const iv = setInterval(() => {
      const e = rec[role].events.find((x) => x.tn >= since && pred(x));
      if (e) { clearInterval(iv); res(e); } else if (now() - t0 > timeoutMs) { clearInterval(iv); rej(new Error(`timeout waiting for event (${role})`)); }
    }, 10);
  });

  console.log('[loopback] launching Chrome ...');
  const args = ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--use-fake-ui-for-media-stream',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--window-position=-2400,0', '--window-size=640,480'];
  let browser;
  try { browser = await chromium.launch({ channel: 'chrome', headless: false, args }); }
  catch (e) { console.log('  channel chrome failed (' + e.message.split('\n')[0] + '), trying executablePath'); browser = await chromium.launch({ executablePath: CHROME_PATH, headless: false, args }); }
  const t0 = now();
  const cpu0 = process.cpuUsage();
  try {
    const context = await browser.newContext({ bypassCSP: true, viewport: { width: 640, height: 480 } });

    // ---------- avatar source: Sora loops if present, else generate stand-in clips once ----------
    if (WITH_VIDEO && AVATAR_MODE === 'segments') {
      let segments = SEGMENTS;
      if (fs.existsSync(path.join(LIVE_DIR, LIVE_FILE))) {
        loopsDir = LIVE_DIR; loopNames = { video: LIVE_FILE };
        try {   // real ranges from config/settings.json when present
          const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'settings.json'), 'utf8'));
          if (st.avatar && st.avatar.segments) segments = st.avatar.segments;
        } catch { /* keep placeholders */ }
      } else {
        fs.mkdirSync(LOOPS_GENERATED, { recursive: true });
        const existing = fs.readdirSync(LOOPS_GENERATED).find((f) => /^kora_live_standin\.(mp4|webm)$/.test(f));
        if (existing) loopNames = { video: existing };
        else {
          console.log('[loopback] generating a 20 s stand-in take (MediaRecorder, 1280x720, talk/listen by segment times) ...');
          const gen = await context.newPage();
          await gen.goto(`${base}/?gen=1`);
          const r = await gen.evaluate((a) => window.__lb_makeClip(a), { avatarUrl: `${base}/avatar.png`, segments: SEGMENTS, seconds: 20, fps: 15 });
          const name = /mp4/.test(r.mime) ? STANDIN_FILE : STANDIN_FILE.replace('.mp4', '.webm');
          fs.writeFileSync(path.join(LOOPS_GENERATED, name), Buffer.from(r.b64, 'base64'));
          console.log(`  ${name}: ${r.mime}, ${(r.size / 1024).toFixed(0)} KB`);
          loopNames = { video: name };
          await gen.close();
        }
        loopsDir = LOOPS_GENERATED;
      }
      avatarOpts = { mode: 'segments', ...stillOpts, video: '/__host_assets/' + loopNames.video, segments,
        fps: 15, width: 640, height: 480, crossfadeMs: 250, loopFadeMs: 400 };
    }
    console.log(`[loopback] avatar: mode=${avatarOpts.mode || 'still'} ${avatarOpts.path || avatarOpts.src}${loopsDir ? ' video=' + path.join(loopsDir, loopNames.video) : ''}`);
    const wire = (page, role) => {
      page.on('console', (m) => { const txt = m.text(); if (m.type() === 'error' || /^\[host\]/.test(txt)) console.log(`  [${role} console] ${txt}`); });
      page.on('pageerror', (e) => console.log(`  [${role} pageerror] ${e.message}`));
    };
    const pageB = await context.newPage(); wire(pageB, 'B');
    const B = await attachPageAudio(pageB, { ...hook('B') });
    await pageB.goto(`${base}/?role=B`);
    await pageB.waitForFunction(() => window.__lb && window.__lb.ready, null, { timeout: 15000 });

    const pageA = await context.newPage(); wire(pageA, 'A');
    if (loopsDir) await serveAssets(pageA, { prefix: '/__host_assets/', dir: loopsDir });
    const A = await attachPageAudio(pageA, { ...hook('A'), opts: WITH_VIDEO ? { avatar: avatarOpts } : {}, baseDir: ROOT });
    await pageA.goto(`${base}/?role=A${WITH_VIDEO ? '&video=1' : ''}`);
    await Promise.all([
      pageA.waitForFunction(() => window.__lb && window.__lb.conn === 'connected', null, { timeout: 20000 }),
      pageB.waitForFunction(() => window.__lb && window.__lb.conn === 'connected', null, { timeout: 20000 }),
    ]);
    console.log(`[loopback] connected in ${fmt(now() - t0, 0)} ms`);
    let loopRestart = null;
    if (loopsDir) {
      const ev = await waitEvent('A', (e) => e.type === 'avatar.segments_ready' || e.type === 'avatar.fallback', 25000).catch(() => null);
      console.log(`  A: ${ev ? ev.type + ' ' + JSON.stringify({ ...ev, t: undefined, tn: undefined, type: undefined }) : 'no segments_ready/fallback event within 25 s'}`);
      // let the first listen segment reach its end at least once -> exercises the pre-seek + loop crossfade
      const tw = now();
      while (now() - tw < 9000) { const st = (await A.status()).avatar; if (st.segments && (st.segments.loops_done >= 1 || st.segments.failed)) { loopRestart = st.segments; break; } await sleep(200); }
      console.log(`  A: after ${fmt((now() - tw) / 1000, 1)} s: segment loops ${loopRestart ? loopRestart.loops_done : 0}, late seeks ${loopRestart ? loopRestart.late_seeks : '?'}, seek ms ${loopRestart ? JSON.stringify(loopRestart.seek_ms) : '?'}, failed ${loopRestart && loopRestart.failed || 'no'}`);
    }
    await sleep(1500);   // let remote tracks map + audio start flowing
    const stA0 = await A.status(); const stB0 = await B.status();
    console.log(`  A: worklet=${stA0.worklet} ctx=${stA0.ctx && stA0.ctx.state} tracks=${stA0.tracks.length} avatar.running=${stA0.avatar.running}`);
    console.log(`  B: worklet=${stB0.worklet} ctx=${stB0.ctx && stB0.ctx.state} tracks=${stB0.tracks.length} chunks=${stB0.capture.chunks}`);
    const lbErrors = await pageA.evaluate(() => window.__lb.errors.concat()); const lbErrorsB = await pageB.evaluate(() => window.__lb.errors.concat());
    if (lbErrors.length || lbErrorsB.length) console.log('  page errors:', lbErrors, lbErrorsB);
    const cpuChrome0 = (await chromeCpuSeconds(browser)).total;
    const cpuBy0 = (await chromeCpuSeconds(browser)).byType;
    const tCpu0 = now();

    // ---------- Test 5a: avatar visible on B (idle frames) ----------
    const idleFrames = [];
    for (let i = 0; i < 4; i++) { const f = await pageB.evaluate(() => window.__lb_sampleVideo()); if (f) idleFrames.push(f); await sleep(250); }
    const frameDiff = (a, b) => { let s = 0; for (let i = 0; i < a.gray.length; i++) s += Math.abs(a.gray[i] - b.gray[i]); return s / a.gray.length; };
    let idleDiff = NaN;
    if (idleFrames.length >= 2) { let s = 0; for (let i = 1; i < idleFrames.length; i++) s += frameDiff(idleFrames[i - 1], idleFrames[i]); idleDiff = s / (idleFrames.length - 1); }
    const f0 = idleFrames[idleFrames.length - 1];
    const savePng = async (name) => { const d = await pageB.evaluate(() => window.__lb_grabFrame()); if (d) { fs.mkdirSync(FIXTURES, { recursive: true }); fs.writeFileSync(path.join(FIXTURES, name), Buffer.from(d.split(',')[1], 'base64')); } return !!d; };
    if (WITH_VIDEO) await savePng('loopback_avatar_idle.png');
    if (WITH_VIDEO) add('5a avatar video frames reach B (non-black)', !!f0 && f0.nonBlackRatio >= 0.2 && f0.mean > 15,
      f0 ? `video ${f0.videoWidth}x${f0.videoHeight}, mean luma ${fmt(f0.mean)}, non-black ${fmt(f0.nonBlackRatio * 100, 0)}%, idle frame diff ${fmt(idleDiff, 2)}` : 'no video frame');

    // ---------- Test 1: clip through the chain ----------
    console.log('[loopback] test 1: chirp + speech-like clip');
    const clip1 = toPcm16(concat(chirp(1.0, 200, 3000, 0.5), speechLike(2.0, 0.55)));
    const tPush0 = now();
    const CH = Math.round(0.2 * SR);
    for (let o = 0; o < clip1.length; o += CH) await A.play(clip1.subarray(o, Math.min(clip1.length, o + CH)));
    await A.playEnd();
    const started1 = await waitEvent('A', (e) => e.type === 'player.started', 3000, tPush0);
    // speaking frames for test 5b while the clip plays
    const speakFrames = [];
    let stateTalk = null, stateListen = null;
    for (let i = 0; i < 5; i++) {
      await sleep(250);
      const f = await pageB.evaluate(() => window.__lb_sampleVideo()); if (f) speakFrames.push(f);
      if (WITH_VIDEO && i === 1) { await savePng('loopback_avatar_speaking.png'); stateTalk = (await A.status()).avatar; }
    }
    const drained1 = await waitEvent('A', (e) => e.type === 'player.drained', 6000, tPush0);
    await sleep(1200);
    if (WITH_VIDEO) stateListen = (await A.status()).avatar;
    const tEnd1 = now();
    {
      const chunks = rec.B.chunks.filter((c) => c.t >= tPush0 - 300 && c.t <= tEnd1);
      const cap = joinChunks(chunks);
      const tl = makeTimeline(chunks);
      const envS = envelope(clip1, 240), envC = envelope(cap, 240);
      const { lag, corr } = bestLag(envS, envC);
      let peak = 0; for (let i = 0; i < cap.length; i++) peak = Math.max(peak, Math.abs(cap[i]) / 32768);
      const onset = findOnset(cap, -40);
      const tOnset = onset >= 0 ? sampleToTime(chunks, tl, onset) : NaN;
      const rmsS = Math.sqrt(envS.reduce((a, v) => a + v * v, 0) / envS.length);
      const seg = cap.subarray(lag * 240, lag * 240 + clip1.length);
      const rmsC = Math.sqrt(envelope(seg, 240).reduce((a, v) => a + v * v, 0) / Math.max(1, Math.floor(seg.length / 240)));
      const gainDb = 20 * Math.log10(rmsC / rmsS);
      const played = drained1.played_ms;
      add('1  clip A->B: envelope correlation', corr >= 0.8 && dbfs(peak) > -30 && chunks.length > 20,
        `corr ${fmt(corr, 3)}, push->capture ${fmt(tOnset - tPush0, 0)} ms, started->capture ${fmt(tOnset - started1.tn, 0)} ms, peak ${fmt(dbfs(peak))} dBFS, gain ${fmt(gainDb)} dB, ${chunks.length} chunks`);
      add('1b player events: started/drained, played_ms ~ 3000', Math.abs(played - 3000) <= 40 && drained1.reason === 'eos',
        `played_ms ${played}, reason ${drained1.reason}, underruns ${drained1.underruns}, started after push ${fmt(started1.tn - tPush0, 0)} ms`);
    }

    // ---------- Test 5b: speaking glow changes the frame ----------
    {
      let speakVsIdle = NaN;
      if (f0 && speakFrames.length) { let s = 0; for (const f of speakFrames) s += frameDiff(f, f0); speakVsIdle = s / speakFrames.length; }
      const stA = await A.status();
      if (WITH_VIDEO && !loopsDir) add('5b avatar glow reacts to speech (frame diff vs idle)', Number.isFinite(speakVsIdle) && speakVsIdle >= 1.0 && speakVsIdle > 3 * (idleDiff || 0),
        `speaking-vs-idle diff ${fmt(speakVsIdle, 2)} gray levels (idle-idle ${fmt(idleDiff, 2)}), ${speakFrames.length} frames, avatar frames drawn ${stA.avatar.frames}`);
      if (WITH_VIDEO && loopsDir) {
        const sg = stA.avatar.segments || {};
        const seekMed = sg.seek_ms && sg.seek_ms.length ? median(sg.seek_ms) : NaN;
        const ok = !!stateTalk && stateTalk.state === 'talk' && !!stateListen && stateListen.state === 'listen' && sg.active && !sg.failed
          && Number.isFinite(speakVsIdle) && speakVsIdle >= 1.0 && sg.loops_done >= 1;
        add('5d segments: listen->talk on speech, back to listen after silence, in-segment loop, switch visible', ok,
          `state ~500 ms after start: ${stateTalk && stateTalk.state}, 1.2 s after end: ${stateListen && stateListen.state}; switches ${sg.switches}, segment loops ${sg.loops_done}, ` +
          `late seeks ${sg.late_seeks}, seek median ${fmt(seekMed, 0)} ms, take ${fmt(sg.duration_s, 2)} s, failed ${sg.failed || 'no'}; talk-vs-listen frame diff ${fmt(speakVsIdle, 2)} (listen-listen ${fmt(idleDiff, 2)}), frames drawn ${stA.avatar.frames}`);
      }
    }

    // ---------- Test 2: flush latency ----------
    console.log('[loopback] test 2: flush after 500 ms');
    const clip2 = toPcm16(twoTone(5.0, 0.45));
    const tPush2 = now();
    const CH2 = Math.round(0.5 * SR);
    for (let o = 0; o < clip2.length; o += CH2) await A.play(clip2.subarray(o, o + CH2));
    await A.playEnd();
    const started2 = await waitEvent('A', (e) => e.type === 'player.started', 3000, tPush2);
    await sleep(500);
    const tFlush0 = now();
    const fl = await A.flush();
    const tFlush1 = now();
    await sleep(1500);
    const tEnd2 = now();
    {
      const chunks = rec.B.chunks.filter((c) => c.t >= tPush2 - 200 && c.t <= tEnd2);
      const cap = joinChunks(chunks);
      const tl = makeTimeline(chunks);
      const onset = findOnset(cap, -40);
      const offset = onset >= 0 ? findOffset(cap, -50, onset, Math.round(0.2 * SR)) : -1;
      const tOnset = sampleToTime(chunks, tl, onset), tOffset = sampleToTime(chunks, tl, offset);
      const onsetLag = tOnset - started2.tn;
      const stopLag = tOffset - tFlush0;
      const extra = stopLag - onsetLag;
      const capturedMs = (offset - onset) / SR * 1000;
      const aborted = rec.A.events.find((e) => e.type === 'player.aborted' && e.tn >= tPush2);
      const pass = Number.isFinite(extra) && extra <= 100 && (tFlush1 - tFlush0) <= 50 && Math.abs(capturedMs - fl.played_ms) <= 60;
      add('2  flush: B energy drops within <= 100 ms (net of path latency)', pass,
        `flush rtt ${fmt(tFlush1 - tFlush0)} ms, played ${fl.played_ms} ms, dropped ${fl.dropped_ms} ms, onset lag ${fmt(onsetLag, 0)} ms, stop lag ${fmt(stopLag, 0)} ms, extra ${fmt(extra, 0)} ms, captured ${fmt(capturedMs, 0)} ms (vs played ${fl.played_ms}), aborted event ${aborted ? 'yes' : 'no'}`);
    }

    // ---------- Test 3: level cadence + echo isolation ----------
    {
      const chunks = rec.B.chunks.filter((c) => c.t >= tPush0 && c.t <= tEnd2);
      const ivs = []; for (let i = 1; i < chunks.length; i++) ivs.push(chunks[i].t - chunks[i - 1].t);
      const mean = ivs.reduce((a, b) => a + b, 0) / Math.max(1, ivs.length);
      const p95 = [...ivs].sort((a, b) => a - b)[Math.floor(ivs.length * 0.95)] || NaN;
      const maxIv = Math.max(...ivs);
      let seqGaps = 0; for (let i = 1; i < chunks.length; i++) if (chunks[i].meta.seq !== chunks[i - 1].meta.seq + 1) seqGaps++;
      let badFrames = 0; for (const c of chunks) { if (!c.levels.length) badFrames++; for (const l of c.levels) if (!Array.isArray(l.frames) || l.frames.length !== 2) badFrames++; }
      const trackIds = new Set(); for (const c of chunks) for (const l of c.levels) trackIds.add(l.track_id);
      const framesPerSec = (chunks.length * 2) / ((chunks[chunks.length - 1].t - chunks[0].t) / 1000);
      add('3a per-track levels every ~50 ms (2 per 100 ms chunk)', Math.abs(mean - 100) <= 5 && seqGaps === 0 && badFrames === 0 && ivs.length >= 50,
        `chunk interval mean ${fmt(mean)} ms, p95 ${fmt(p95)} ms, max ${fmt(maxIv)} ms, ${fmt(framesPerSec)} level frames/s, seq gaps ${seqGaps}, malformed ${badFrames}, tracks ${trackIds.size}`);
      // echo isolation: A captures B's (silent) mic while A itself is talking
      const aChunks = rec.A.chunks.filter((c) => c.t >= tPush0 && c.t <= tEnd2);
      let aMax = -100; for (const c of aChunks) { for (const l of c.levels) for (const v of l.frames) aMax = Math.max(aMax, v); for (const v of (c.meta.mix || [])) aMax = Math.max(aMax, v); }
      add('3b echo isolation: A never captures its own mic', aChunks.length >= 20 && aMax <= -55,
        `A received ${aChunks.length} chunks while speaking, max level ${fmt(aMax)} dBFS (B mic idle)`);
      const sinks = await pageB.evaluate(() => Array.from(document.querySelectorAll('audio,video')).map((e) => ({ tag: e.tagName, host: e.dataset.host || null, muted: e.muted })));
      const allMuted = sinks.every((s) => s.muted);
      add('3c capture works with muted media elements', allMuted && chunks.length > 20, `B media elements: ${JSON.stringify(sinks)}`);
    }

    // ---------- Test 4: WAV fixture ----------
    {
      const all = joinChunks(rec.B.chunks);
      const file = path.join(FIXTURES, 'loopback_capture.wav');
      writeWav(file, all, SR);
      const size = fs.statSync(file).size;
      add('4  WAV fixture written', size > 100000, `${file} (${(size / 1024).toFixed(0)} KB, ${fmt(all.length / SR)} s)`);
    }

    // ---------- Test 5c: camera toggle stops / restarts the render loop ----------
    if (WITH_VIDEO) {
      const before = (await A.status()).avatar;
      await pageA.evaluate(() => { window.__lb.localVideoTrack.stop(); });
      await sleep(400);
      const stopped = (await A.status()).avatar;
      await pageA.evaluate(async () => { const s = await navigator.mediaDevices.getUserMedia({ video: true }); window.__lb.videoTrack2 = s.getVideoTracks()[0]; });
      await sleep(400);
      const restarted = (await A.status()).avatar;
      add('5c camera toggle: stop() halts the render loop, new getUserMedia restarts it',
        before.running && !stopped.running && restarted.running,
        `running before ${before.running}, after stop ${stopped.running} (frames ${stopped.frames}), after re-request ${restarted.running} (frames ${restarted.frames})`);
    }

    // ---------- Test 6: API sanity ----------
    {
      const api = await pageA.evaluate(async () => {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const mic = await navigator.permissions.query({ name: 'microphone' });
        const cam = await navigator.permissions.query({ name: 'camera' });
        const a = new Audio(); a.play().catch(() => {});
        return {
          devices: devs.map((d) => d.kind + ':' + d.label),
          micPerm: mic.state, camPerm: cam.state,
          pcInstance: window.__lb.pc instanceof RTCPeerConnection,
          pcName: RTCPeerConnection.name, pcStatic: typeof RTCPeerConnection.generateCertificate,
          pcToString: String(RTCPeerConnection).slice(0, 40),
          detachedAudioMuted: a.muted,
          localTracks: window.__lb.localTracks.map((t) => t.kind + ':' + t.label + ':' + (t.settings.deviceId || '')),
          version: window.__host_version,
        };
      });
      const ok = api.devices.some((d) => d.startsWith('audioinput:')) && (!WITH_VIDEO || api.devices.some((d) => d.startsWith('videoinput:'))) && api.micPerm === 'granted' && api.camPerm === (WITH_VIDEO ? 'granted' : 'prompt') && api.pcInstance && api.pcName === 'RTCPeerConnection' && api.pcStatic === 'function' && api.detachedAudioMuted;
      add('6  devices / permissions / RTCPeerConnection proxy / detached <audio> muted', ok, JSON.stringify(api));
    }

    // ---------- CPU ----------
    const cpu1 = process.cpuUsage(cpu0);
    const wall = (now() - tCpu0) / 1000;
    const cpuEnd = await chromeCpuSeconds(browser);
    const cpuChrome1 = cpuEnd.total;
    const nodePct = (cpu1.user + cpu1.system) / 1e6 / ((now() - t0) / 1000) * 100;
    const chromePct = Number.isFinite(cpuChrome0) && Number.isFinite(cpuChrome1) ? (cpuChrome1 - cpuChrome0) / wall * 100 : NaN;
    const byType = Object.keys(cpuEnd.byType).map((k) => `${k} ${fmt((cpuEnd.byType[k] - (cpuBy0[k] || 0)) / wall * 100, 0)}%`).join(', ');
    const vidDesc = !WITH_VIDEO ? 'audio only' : loopsDir ? 'avatar SEGMENTS 640x480@15fps (720p H.264 take, 2 <video>) + WebRTC video encode/decode' : 'avatar STILL 640x480@12fps + WebRTC video encode/decode';
    console.log(`[loopback] CPU: node ~${fmt(nodePct)}% of one core; Chrome tree ~${fmt(chromePct, 0)}% of one core over ${fmt(wall, 0)} s (2 tabs, ${vidDesc}, 2 capture worklets)`);
    console.log(`[loopback] CPU by Chrome process type: ${byType}`);
    const evTypes = {}; for (const r of ['A', 'B']) for (const e of rec[r].events) evTypes[r + ':' + e.type] = (evTypes[r + ':' + e.type] || 0) + 1;
    console.log('[loopback] events:', JSON.stringify(evTypes));
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }

  console.log('\n RESULT  TEST');
  console.log(' ------  ' + '-'.repeat(70));
  for (const r of results) console.log(` ${r.pass ? 'PASS  ' : 'FAIL  '}  ${r.name}`);
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('[loopback] ERROR', e); process.exit(1); });
