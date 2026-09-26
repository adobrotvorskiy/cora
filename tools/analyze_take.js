// Analyze a Sora take of Кора: find talk/listen segments from the take's own audio track
// and render a contact sheet (thumbnails every --step seconds) for a visual check.
// Usage: node tools/analyze_take.js <take.mp4> [--step 0.5] [--cols 8]
// Output next to the take: <name>.segments.json and <name>.sheet.png
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { step: { type: 'string', default: '0.5' }, cols: { type: 'string', default: '8' } },
});
const take = positionals[0];
if (!take) {
  console.error('usage: node tools/analyze_take.js <take.mp4> [--step 0.5] [--cols 8]');
  process.exit(64);
}
const step = Number(values.step);
const cols = Number(values.cols);
const bytes = readFileSync(take);

const server = createServer((req, res) => {
  if (req.url.startsWith('/take.mp4')) {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length, 'Accept-Ranges': 'none' });
    res.end(bytes);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><body></body></html>');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.goto(base + '/');

const result = await page.evaluate(async ({ step, cols }) => {
  const buf = await (await fetch('/take.mp4')).arrayBuffer();

  // 1) Audio: RMS every 50 ms -> speech segments (hysteresis + hangover + min length).
  let speech = [];
  let audioInfo = null;
  try {
    const ctx = new OfflineAudioContext(1, 48000, 48000);
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const ch = audio.getChannelData(0);
    const sr = audio.sampleRate;
    const hop = Math.round(sr * 0.05);
    const rms = [];
    for (let i = 0; i + hop <= ch.length; i += hop) {
      let s = 0;
      for (let j = i; j < i + hop; j++) s += ch[j] * ch[j];
      rms.push(Math.sqrt(s / hop));
    }
    const db = rms.map((v) => 20 * Math.log10(v + 1e-9));
    const sorted = [...db].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.2)];
    const peak = sorted[Math.floor(sorted.length * 0.95)];
    const on = floor + (peak - floor) * 0.45;
    const off = floor + (peak - floor) * 0.3;
    let active = false, start = 0, lastOn = 0;
    db.forEach((v, k) => {
      const t = k * 0.05;
      if (!active && v > on) { active = true; start = t; }
      if (active && v > off) lastOn = t;
      if (active && v <= off && t - lastOn > 0.35) {
        active = false;
        if (lastOn - start >= 0.4) speech.push([+start.toFixed(2), +(lastOn + 0.05).toFixed(2)]);
      }
    });
    if (active && lastOn - start >= 0.4) speech.push([+start.toFixed(2), +(lastOn + 0.05).toFixed(2)]);
    audioInfo = { duration: audio.duration, floor_db: +floor.toFixed(1), peak_db: +peak.toFixed(1) };
  } catch (e) {
    audioInfo = { error: String(e) };
  }

  // 2) Frames: seek every `step` seconds, draw thumbnails with timestamps into a grid.
  const url = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = url;
  await new Promise((r, j) => { v.onloadeddata = r; v.onerror = () => j(new Error('video load failed')); });
  const dur = v.duration;
  const times = [];
  for (let t = 0; t < dur - 0.05; t += step) times.push(+t.toFixed(2));
  times.push(+(dur - 0.05).toFixed(2));
  const tw = 240, th = Math.round(tw * v.videoHeight / v.videoWidth);
  const rows = Math.ceil(times.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * tw; c.height = rows * (th + 18);
  const g = c.getContext('2d');
  g.fillStyle = '#050508'; g.fillRect(0, 0, c.width, c.height);
  g.font = '14px sans-serif';
  const inSpeech = (t) => speech.some(([a, b]) => t >= a && t <= b);
  for (let k = 0; k < times.length; k++) {
    v.currentTime = times[k];
    await new Promise((r) => { v.onseeked = r; });
    const x = (k % cols) * tw, y = Math.floor(k / cols) * (th + 18);
    g.drawImage(v, x, y, tw, th);
    g.fillStyle = inSpeech(times[k]) ? '#ff7a59' : '#9fb3ff';
    g.fillText(`${times[k].toFixed(1)}s ${inSpeech(times[k]) ? 'TALK' : 'listen'}`, x + 4, y + th + 14);
  }
  const png = c.toDataURL('image/png');

  // listen = complement of speech (with 0.25 s margins), talk = speech with 0.15 s inner margins
  const listen = [];
  let cur = 0;
  for (const [a, b] of speech) {
    if (a - 0.25 - cur > 0.8) listen.push([+cur.toFixed(2), +(a - 0.25).toFixed(2)]);
    cur = b + 0.25;
  }
  if (dur - cur > 0.8) listen.push([+cur.toFixed(2), +(dur - 0.05).toFixed(2)]);
  const talk = speech.filter(([a, b]) => b - a > 0.8).map(([a, b]) => [+(a + 0.15).toFixed(2), +(b - 0.15).toFixed(2)]);
  return { duration: dur, width: v.videoWidth, height: v.videoHeight, audio: audioInfo, speech, segments: { listen, talk }, png };
}, { step, cols });

await browser.close();
server.close();

const stem = join(dirname(take), basename(take).replace(/\.mp4$/i, ''));
writeFileSync(stem + '.sheet.png', Buffer.from(result.png.split(',')[1], 'base64'));
delete result.png;
writeFileSync(stem + '.segments.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ take: basename(take), size_kb: Math.round(statSync(take).size / 1024), ...result }, null, 2));
console.log('sheet:', stem + '.sheet.png');
