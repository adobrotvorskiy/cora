// Find where Кора talks vs listens in a take by looking at her MOUTH, not the audio
// (Sora's audio track may contain off-screen voices). Samples frames at --fps, computes
// mouth-region motion (mean abs diff between consecutive frames, minus eye-region motion to
// cancel head nods), and renders a close-up sheet of the mouth every --step seconds.
// Usage: node tools/mouth_scan.js <take.mp4> --mouth x,y,w,h --eyes x,y,w,h [--fps 10] [--step 0.5]
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    mouth: { type: 'string' }, eyes: { type: 'string' },
    fps: { type: 'string', default: '10' }, step: { type: 'string', default: '0.5' },
  },
});
const take = positionals[0];
if (!take || !values.mouth || !values.eyes) {
  console.error('usage: node tools/mouth_scan.js <take.mp4> --mouth x,y,w,h --eyes x,y,w,h [--fps 10] [--step 0.5]');
  process.exit(64);
}
const roi = (s) => s.split(',').map(Number);
const bytes = readFileSync(take);
const server = createServer((req, res) => {
  if (req.url.startsWith('/take.mp4')) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
    res.end(bytes);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body></body></html>');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);

const out = await page.evaluate(async ({ mouth, eyes, fps, step }) => {
  const buf = await (await fetch('/take.mp4')).arrayBuffer();
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
  await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('load failed')); });
  const seek = (t) => new Promise((r) => { v.onseeked = r; v.currentTime = t; });
  const grab = (c, g, [x, y, w, h]) => { g.drawImage(v, x, y, w, h, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; };
  const mk = ([, , w, h]) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d', { willReadFrequently: true })]; };
  const [mc, mg] = mk(mouth), [ec, eg] = mk(eyes);
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return s / (a.length / 4) / 3; };

  const series = [];
  let pm = null, pe = null;
  for (let t = 0; t < v.duration - 0.02; t += 1 / fps) {
    await seek(t);
    const m = grab(mc, mg, mouth), e = grab(ec, eg, eyes);
    if (pm) series.push({ t: +t.toFixed(2), mouth: +diff(m, pm).toFixed(2), eyes: +diff(e, pe).toFixed(2) });
    pm = m.slice(); pe = e.slice();
  }
  // mouth activity = mouth motion minus head motion, smoothed over ~0.5 s
  const act = series.map((s) => Math.max(0, s.mouth - 0.8 * s.eyes));
  const k = Math.max(1, Math.round(fps * 0.5));
  const sm = act.map((_, i) => { const a = act.slice(Math.max(0, i - k), i + k + 1); return a.reduce((x, y) => x + y, 0) / a.length; });
  const sorted = [...sm].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.2)], hi = sorted[Math.floor(sorted.length * 0.9)];
  const thr = lo + (hi - lo) * 0.4;
  const talk = [];
  let on = false, st = 0;
  sm.forEach((x, i) => {
    const t = series[i].t;
    if (!on && x > thr) { on = true; st = t; }
    if (on && x <= thr) { on = false; if (t - st >= 0.6) talk.push([+st.toFixed(2), +t.toFixed(2)]); }
  });
  if (on && series.at(-1).t - st >= 0.6) talk.push([+st.toFixed(2), +series.at(-1).t.toFixed(2)]);

  // close-up sheet of the mouth every `step` seconds (2x zoom), labelled with activity
  const [x, y, w, h] = mouth, z = 2, cols = 10;
  const times = []; for (let t = 0; t < v.duration - 0.02; t += step) times.push(+t.toFixed(2));
  const c = document.createElement('canvas'); c.width = cols * w * z; c.height = Math.ceil(times.length / cols) * (h * z + 18);
  const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height); g.font = '14px sans-serif';
  const inTalk = (t) => talk.some(([a, b]) => t >= a && t <= b);
  for (let i = 0; i < times.length; i++) {
    await seek(times[i]);
    const cx = (i % cols) * w * z, cy = Math.floor(i / cols) * (h * z + 18);
    g.drawImage(v, x, y, w, h, cx, cy, w * z, h * z);
    g.fillStyle = inTalk(times[i]) ? '#ff7a59' : '#9fb3ff';
    g.fillText(`${times[i].toFixed(1)} ${inTalk(times[i]) ? 'T' : '-'}`, cx + 4, cy + h * z + 14);
  }
  return { duration: v.duration, threshold: +thr.toFixed(2), talk_by_mouth: talk, series: series.map((s, i) => ({ ...s, act: +sm[i].toFixed(2) })), png: c.toDataURL('image/png') };
}, { mouth: roi(values.mouth), eyes: roi(values.eyes), fps: Number(values.fps), step: Number(values.step) });

await browser.close();
server.close();
const stem = join(dirname(take), basename(take).replace(/\.mp4$/i, ''));
writeFileSync(stem + '.mouth.png', Buffer.from(out.png.split(',')[1], 'base64'));
delete out.png;
writeFileSync(stem + '.mouth.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ take: basename(take), duration: out.duration, threshold: out.threshold, talk_by_mouth: out.talk_by_mouth }));
console.log('sheet:', stem + '.mouth.png');
