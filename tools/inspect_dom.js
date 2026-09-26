// S0/S1 explorer: join the TEST room as a guest and dump the in-call DOM.
//
//   node tools/inspect_dom.js --url <telemost link> [--name "Кора (ИИ-ведущая)"]
//        [--viewport 640x480] [--stay 60] [--profile profile/inspect] [--no-leave] [--no-camera]
//
// Outputs (gitignored): _internal/inspect_<stamp>/{*.png, dom_*.txt, text_*.txt, buttons.json,
// mutations_*.json, console.log}. Findings are summarised by hand into docs/telemost_dom.md.
//
// Also exports page-side helpers used by tools/telemost_spike.js:
//   buildFakeMediaScript(opts)  – getUserMedia/enumerateDevices override: synthetic mic (WebAudio
//                                 destination) + synthetic camera (canvas avatar), window.__fakeMedia API
//   DOM_PROBE_SCRIPT            – window.__probe: dump(), outer(), media(), text(), mutation log

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, snap, ROOT } from '../src/browser/launch.js';
import { join, leave, classifyState, SEL, dismissPopups, getParticipants, openMore, closePopover, openParticipants, openChat, openSettings, closePanels, chatFrame } from '../src/browser/telemost.js';

// ---------------------------------------------------------------------------
// Page-side: synthetic microphone + camera (minimal stand-in for WP2's page_inject.js)
// ---------------------------------------------------------------------------
function fakeMediaMain(opts) {
  if (window.__fakeMedia) return;
  const md = navigator.mediaDevices;
  if (!md) return; // insecure context (about:blank, data:) – nothing to override
  const origGUM = md.getUserMedia.bind(md);
  const origEnum = md.enumerateDevices.bind(md);
  const state = { ctx: null, dest: null, gain: null, canvas: null, camTrack: null, gumCalls: [], playing: null, avatarFrames: 0 };

  function ensureAudio() {
    if (!state.ctx) {
      const ctx = new AudioContext({ sampleRate: opts.sampleRate || 48000 });
      const dest = ctx.createMediaStreamDestination();
      const gain = ctx.createGain();
      gain.gain.value = 1;
      gain.connect(dest);
      // silent keep-alive so the track is 'live' and never flagged muted
      const keep = ctx.createConstantSource();
      keep.offset.value = 0;
      keep.connect(dest);
      keep.start();
      Object.assign(state, { ctx, dest, gain });
    }
    if (state.ctx.state !== 'running') state.ctx.resume().catch(() => {});
    return state;
  }

  function drawAvatar(t) {
    const c = state.canvas; const g = c.getContext('2d');
    const w = c.width; const h = c.height;
    g.fillStyle = opts.bg || '#1f2430';
    g.fillRect(0, 0, w, h);
    const cx = w / 2;
    // breathing ring (keeps frames flowing without looking like a bug)
    const pulse = 0.5 + 0.5 * Math.sin(t / 900);
    if (state.avatarImg) {
      // real avatar image: circle-cropped, cover-fit, centred
      const cy = h / 2; const r = Math.min(w, h) * 0.42;
      g.beginPath(); g.arc(cx, cy, r + 8 + pulse * 5, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255,255,255,' + (0.15 + pulse * 0.25).toFixed(2) + ')'; g.lineWidth = 5; g.stroke();
      g.save(); g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.clip();
      const img = state.avatarImg; const s = Math.max((2 * r) / img.naturalWidth, (2 * r) / img.naturalHeight);
      g.drawImage(img, cx - img.naturalWidth * s / 2, cy - img.naturalHeight * s / 2, img.naturalWidth * s, img.naturalHeight * s);
      g.restore();
    } else {
      const cy = h / 2 - 20; const r = Math.min(w, h) * 0.27;
      g.beginPath(); g.arc(cx, cy, r + 10 + pulse * 6, 0, Math.PI * 2);
      g.strokeStyle = 'rgba(255,255,255,' + (0.15 + pulse * 0.25).toFixed(2) + ')'; g.lineWidth = 6; g.stroke();
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fillStyle = opts.color || '#7c5cff'; g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = 'bold ' + Math.round(r * 1.1) + 'px Arial, sans-serif';
      g.fillText(opts.avatarText || 'К', cx, cy + r * 0.05);
      g.font = Math.round(h * 0.07) + 'px Arial, sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.fillText(opts.avatarName || 'Кора', cx, cy + r + 44);
    }
    state.avatarFrames++;
  }

  /** Load an image (data: or http(s): URL) into the camera canvas; resolves when drawn. */
  function setAvatar(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { state.avatarImg = img; if (state.canvas) drawAvatar(performance.now()); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = () => reject(new Error('avatar image failed to load'));
      img.src = src;
    });
  }

  function ensureVideo() {
    if (!state.canvas) {
      const c = document.createElement('canvas');
      c.width = opts.width || 640; c.height = opts.height || 480;
      state.canvas = c;
      drawAvatar(performance.now());
      const stream = c.captureStream(opts.fps || 15);
      state.camTrack = stream.getVideoTracks()[0];
      setInterval(() => drawAvatar(performance.now()), opts.redrawMs || 500);
    }
    return state.camTrack;
  }

  function decorate(track, kind) {
    const dev = kind === 'audio' ? { deviceId: 'kora-mic', groupId: 'kora', label: opts.micLabel || 'Kora virtual microphone' }
      : { deviceId: 'kora-cam', groupId: 'kora', label: opts.camLabel || 'Kora virtual camera' };
    const origSettings = track.getSettings.bind(track);
    try {
      Object.defineProperty(track, 'label', { value: dev.label, configurable: true });
      track.getSettings = () => ({ ...origSettings(), deviceId: dev.deviceId, groupId: dev.groupId });
      track.getCapabilities = () => ({ deviceId: dev.deviceId, groupId: dev.groupId });
      track.applyConstraints = async () => {};
    } catch (e) { /* ignore */ }
    return track;
  }

  md.getUserMedia = async (constraints = {}) => {
    const wantAudio = !!constraints.audio; const wantVideo = !!constraints.video;
    state.gumCalls.push({ t: Date.now(), constraints: JSON.stringify(constraints).slice(0, 500) });
    const tracks = [];
    if (wantAudio) tracks.push(decorate(ensureAudio().dest.stream.getAudioTracks()[0].clone(), 'audio'));
    if (wantVideo) {
      if (opts.camera === false) throw new DOMException('Requested device not found', 'NotFoundError');
      tracks.push(decorate(ensureVideo().clone(), 'video'));
    }
    if (!tracks.length) return origGUM(constraints);
    return new MediaStream(tracks);
  };

  md.enumerateDevices = async () => {
    let real = [];
    try { real = await origEnum(); } catch (e) { /* ignore */ }
    const mk = (o) => ({ ...o, toJSON() { return { ...o }; } });
    const list = [mk({ deviceId: 'kora-mic', groupId: 'kora', kind: 'audioinput', label: opts.micLabel || 'Kora virtual microphone' })];
    if (opts.camera !== false) list.push(mk({ deviceId: 'kora-cam', groupId: 'kora', kind: 'videoinput', label: opts.camLabel || 'Kora virtual camera' }));
    for (const d of real) if (d.kind === 'audiooutput') list.push(d);
    return list;
  };

  async function playBuffer(ab, gainValue) {
    const s = ensureAudio();
    const src = s.ctx.createBufferSource();
    src.buffer = ab;
    const g = s.ctx.createGain(); g.gain.value = gainValue ?? 1;
    src.connect(g); g.connect(s.gain);
    const startedAt = Date.now();
    src.start();
    state.playing = { startedAt, durationMs: ab.duration * 1000 };
    await new Promise((r) => { src.onended = r; });
    state.playing = null;
    return { startedAt, endedAt: Date.now(), durationMs: Math.round(ab.duration * 1000) };
  }

  function synthVoice(ms) {
    const s = ensureAudio();
    const sr = s.ctx.sampleRate; const n = Math.round(sr * ms / 1000);
    const ab = s.ctx.createBuffer(1, n, sr); const d = ab.getChannelData(0);
    const f0 = 190; const formants = [700, 1220, 2600];
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const vib = 1 + 0.03 * Math.sin(2 * Math.PI * 5.5 * t);
      const contour = 1 + 0.12 * Math.sin(2 * Math.PI * 0.4 * t);
      phase += 2 * Math.PI * f0 * vib * contour / sr;
      let v = 0;
      for (let k = 1; k <= 14; k++) {
        const fk = f0 * k * vib * contour;
        let w = 0; for (const F of formants) w += Math.exp(-Math.pow((fk - F) / 250, 2));
        v += (w + 0.08) / k * Math.sin(phase * k);
      }
      const syl = Math.max(0, Math.sin(2 * Math.PI * 4 * t)); // ~4 syllables/s
      const env = Math.pow(syl, 0.6) * Math.min(1, t / 0.1) * Math.min(1, (ms / 1000 - t) / 0.1);
      d[i] = 0.35 * v * env;
    }
    return ab;
  }

  window.__fakeMedia = {
    state,
    setAvatar,
    info() {
      return {
        ctxState: state.ctx?.state, sampleRate: state.ctx?.sampleRate, gumCalls: state.gumCalls,
        micTrack: state.dest ? state.dest.stream.getAudioTracks()[0].readyState : null,
        camTrack: state.camTrack ? { readyState: state.camTrack.readyState, settings: state.camTrack.getSettings() } : null,
        avatarFrames: state.avatarFrames,
      };
    },
    async playWavBase64(b64, gain) {
      const s = ensureAudio();
      const bin = atob(b64); const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const ab = await s.ctx.decodeAudioData(u8.buffer);
      return playBuffer(ab, gain);
    },
    async playSynthVoice(ms = 3000, gain) { return playBuffer(synthVoice(ms), gain); },
  };
}

/**
 * Build the init script for a synthetic mic + camera.
 * @param {{camera?: boolean, avatarText?: string, avatarName?: string, color?: string, width?: number, height?: number, fps?: number, sampleRate?: number}} [opts]
 */
export function buildFakeMediaScript(opts = {}) {
  return `(${fakeMediaMain.toString()})(${JSON.stringify(opts)});`;
}

// ---------------------------------------------------------------------------
// Page-side: DOM probe (dump / mutation log)
// ---------------------------------------------------------------------------
function probeMain() {
  if (window.__probe) return;
  const INTERESTING_TAGS = new Set(['button', 'input', 'textarea', 'select', 'a', 'video', 'audio', 'img', 'dialog', 'form', 'ul', 'li', 'canvas']);
  const CLS_RE = /speak|active|mute|participant|member|tile|chat|message|leave|hangup|exit|video|audio|indicator|voice|avatar|list|panel|settings|toolbar|popup|modal|badge|status/i;
  const clsOf = (el) => (typeof el.className === 'string' ? el.className : (el.getAttribute && el.getAttribute('class')) || '');
  function desc(el) {
    const a = {};
    for (const at of el.attributes) {
      if (at.name === 'class' || at.name === 'd' || at.name.startsWith('xlink') || at.name === 'viewBox' || at.name === 'fill' || at.name === 'stroke') continue;
      if (at.name === 'style' && at.value.length > 80) { a.style = at.value.slice(0, 77) + '...'; continue; }
      a[at.name] = at.value.length > 120 ? at.value.slice(0, 117) + '...' : at.value;
    }
    const own = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' ');
    const text = (el.childElementCount === 0 ? (el.textContent || '') : own).trim().replace(/\s+/g, ' ').slice(0, 80);
    return { tag: el.tagName.toLowerCase(), cls: clsOf(el).slice(0, 200), attrs: a, text };
  }
  function* walk(root, depth = 0) {
    const kids = root.shadowRoot ? [...root.shadowRoot.children, ...root.children] : root.children;
    for (const el of kids) { yield [el, depth]; yield* walk(el, depth + 1); }
  }
  function isInteresting(el) {
    for (const n of ['data-testid', 'aria-label', 'role', 'data-test', 'title', 'aria-pressed', 'contenteditable', 'aria-live']) if (el.hasAttribute(n)) return true;
    if (INTERESTING_TAGS.has(el.tagName.toLowerCase())) return true;
    return CLS_RE.test(clsOf(el));
  }
  function line(el, depth) {
    const d = desc(el);
    const parts = [d.tag];
    if (d.attrs['data-testid']) parts.push('[testid=' + d.attrs['data-testid'] + ']');
    if (d.attrs.role) parts.push('[role=' + d.attrs.role + ']');
    for (const [k, v] of Object.entries(d.attrs)) { if (k === 'data-testid' || k === 'role') continue; parts.push('[' + k + '=' + v + ']'); }
    if (d.cls) parts.push('.' + d.cls.trim().split(/\s+/).join('.'));
    if (d.text) parts.push('"' + d.text + '"');
    const r = el.getBoundingClientRect();
    const vis = r.width > 0 && r.height > 0 ? ' @' + Math.round(r.x) + ',' + Math.round(r.y) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) : ' (hidden)';
    return ' '.repeat(depth) + parts.join(' ') + vis;
  }
  function dump(rootSel, o = {}) {
    const root = rootSel ? document.querySelector(rootSel) : document.body;
    if (!root) return 'root not found: ' + rootSel;
    const lines = [];
    for (const [el, depth] of walk(root)) {
      if (!o.all && !isInteresting(el)) continue;
      lines.push(line(el, depth));
      if (lines.length >= (o.max || 5000)) { lines.push('...truncated'); break; }
    }
    return lines.join('\n');
  }
  function buttons() {
    return [...document.querySelectorAll('button, [role="button"], a[href], input, textarea, [contenteditable="true"]')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(), testid: el.getAttribute('data-testid'), aria: el.getAttribute('aria-label'), title: el.getAttribute('title'),
        role: el.getAttribute('role'), pressed: el.getAttribute('aria-pressed'), expanded: el.getAttribute('aria-expanded'), disabled: el.disabled || el.getAttribute('aria-disabled'),
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60), cls: clsOf(el).slice(0, 120),
        visible: r.width > 0 && r.height > 0, box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        parentTestid: el.parentElement?.closest('[data-testid]')?.getAttribute('data-testid'),
      };
    });
  }
  function outer(sel, limit = 20000) { const el = document.querySelector(sel); return el ? el.outerHTML.slice(0, limit) : null; }
  function media() {
    return [...document.querySelectorAll('video,audio')].map((m) => ({
      tag: m.tagName.toLowerCase(), id: m.id, cls: clsOf(m).slice(0, 80), muted: m.muted, volume: m.volume, paused: m.paused, autoplay: m.autoplay,
      srcObject: m.srcObject ? m.srcObject.getTracks().map((t) => t.kind + ':' + t.id.slice(0, 8) + ':' + t.readyState + (t.muted ? ':muted' : '') + (t.enabled ? '' : ':disabled')) : null,
      src: (m.currentSrc || '').slice(0, 60), w: m.videoWidth, h: m.videoHeight, testid: m.closest('[data-testid]')?.getAttribute('data-testid'),
      visible: m.getBoundingClientRect().width > 0,
    }));
  }
  function text(limit = 4000) { return (document.body?.innerText || '').replace(/\n{2,}/g, '\n').slice(0, limit); }
  function pathOf(el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur.nodeType === 1 && parts.length < 7) {
      let p = cur.tagName.toLowerCase();
      const tid = cur.getAttribute('data-testid');
      if (tid) p += '[' + tid + ']';
      else { const c = clsOf(cur).trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.'); if (c) p += '.' + c; }
      parts.unshift(p); cur = cur.parentElement;
    }
    return parts.join('>');
  }
  let mo = null; let mlog = [];
  function startMutationLog() {
    mlog = [];
    if (mo) mo.disconnect();
    mo = new MutationObserver((muts) => {
      const t = Date.now();
      for (const m of muts) {
        if (m.type === 'attributes') {
          const nv = m.target.getAttribute(m.attributeName) || '';
          if (m.attributeName === 'style' && nv.length > 160) continue;
          mlog.push({ t, type: 'attr', attr: m.attributeName, old: (m.oldValue || '').slice(0, 200), new: nv.slice(0, 200), path: pathOf(m.target) });
        } else if (m.type === 'childList') {
          for (const n of m.addedNodes) if (n.nodeType === 1) mlog.push({ t, type: 'add', path: pathOf(n), html: n.outerHTML.slice(0, 400) });
          for (const n of m.removedNodes) if (n.nodeType === 1) mlog.push({ t, type: 'rm', path: pathOf(m.target) + '>' + n.tagName.toLowerCase(), cls: clsOf(n).slice(0, 120), tid: n.getAttribute && n.getAttribute('data-testid'), text: (n.textContent || '').slice(0, 60) });
        } else if (m.type === 'characterData') {
          mlog.push({ t, type: 'text', path: pathOf(m.target.parentElement), old: (m.oldValue || '').slice(0, 80), new: (m.target.data || '').slice(0, 80) });
        }
      }
      if (mlog.length > 30000) mlog.splice(0, 10000);
    });
    mo.observe(document.body, { attributes: true, attributeOldValue: true, childList: true, subtree: true, characterData: true, characterDataOldValue: true });
    return true;
  }
  function readMutationLog(clear = false) { const out = mlog.slice(); if (clear) mlog = []; return out; }
  function stopMutationLog() { if (mo) mo.disconnect(); mo = null; const out = mlog; mlog = []; return out; }
  window.__probe = { dump, buttons, outer, media, text, pathOf, startMutationLog, readMutationLog, stopMutationLog };
}
export const DOM_PROBE_SCRIPT = `(${probeMain.toString()})();`;

// ---------------------------------------------------------------------------
// Node side helpers
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k.startsWith('no-')) out[k.slice(3)] = false;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
      else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

export function mkOutDir(prefix) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(ROOT, '_internal', `${prefix}_${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function ensureProbe(page) {
  await page.evaluate(DOM_PROBE_SCRIPT).catch(() => {});
}

export async function dumpStage(page, dir, name, { rootSel = null } = {}) {
  await ensureProbe(page);
  const [tree, text, media, buttons] = await Promise.all([
    page.evaluate(([s]) => window.__probe.dump(s), [rootSel]).catch((e) => 'dump error: ' + e),
    page.evaluate(() => window.__probe.text()).catch(() => ''),
    page.evaluate(() => window.__probe.media()).catch(() => []),
    page.evaluate(() => window.__probe.buttons()).catch(() => []),
  ]);
  fs.writeFileSync(path.join(dir, `dom_${name}.txt`), tree, 'utf8');
  fs.writeFileSync(path.join(dir, `text_${name}.txt`), text, 'utf8');
  fs.writeFileSync(path.join(dir, `media_${name}.json`), JSON.stringify(media, null, 1), 'utf8');
  fs.writeFileSync(path.join(dir, `buttons_${name}.json`), JSON.stringify(buttons, null, 1), 'utf8');
  await snap(page, name, dir);
  return { tree, text, media, buttons };
}

/** Find a visible control by regexes over testid / aria-label / title / text. */
export async function findControl(page, res) {
  const src = res.map((r) => [r.source, r.flags]);
  return page.evaluate((patterns) => {
    const regs = patterns.map(([s, f]) => new RegExp(s, f));
    const els = [...document.querySelectorAll('button, [role="button"], a[href]')];
    const hits = [];
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      const hay = [el.getAttribute('data-testid'), el.getAttribute('aria-label'), el.getAttribute('title'), (el.textContent || '').trim().slice(0, 80)].filter(Boolean);
      if (hay.some((h) => regs.some((re) => re.test(h)))) {
        hits.push({ testid: el.getAttribute('data-testid'), aria: el.getAttribute('aria-label'), text: (el.textContent || '').trim().slice(0, 60), box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] });
      }
    }
    return hits;
  }, src);
}

export function selectorFor(hit) {
  if (hit.testid) return `[data-testid="${hit.testid}"]`;
  if (hit.aria) return `[aria-label="${hit.aria.replace(/"/g, '\\"')}"]`;
  return null;
}


// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url || args._[0];
  if (!url) { console.error('usage: node tools/inspect_dom.js --url <link> [--name ..] [--viewport WxH] [--stay 20] [--no-leave] [--no-camera] [--skip-panels]'); process.exit(2); }
  if (/11111111111111111111111111111111111111/.test(url)) { console.error('refusing to use the real standup room'); process.exit(2); }
  const name = args.name || 'Кора (ИИ-ведущая)';
  const [vw, vh] = String(args.viewport || '640x480').split('x').map(Number);
  const stay = Number(args.stay ?? 20);
  const camera = args.camera !== false;
  const dir = mkOutDir('inspect');
  const logFile = fs.createWriteStream(path.join(dir, 'events.jsonl'));
  const log = (e) => { const rec = { ts: new Date().toISOString(), ...e }; logFile.write(JSON.stringify(rec) + '\n'); console.log(JSON.stringify(rec).slice(0, 1500)); };
  console.log('output dir:', dir);

  const initScript = buildFakeMediaScript({ camera, avatarText: 'К', avatarName: 'Кора' }) + '\n' + DOM_PROBE_SCRIPT;
  const { page, close } = await launchBrowser({ profileDir: args.profile || 'profile/inspect', viewport: [vw, vh], initScript, log, offscreen: args.offscreen !== false });
  const consoleLog = fs.createWriteStream(path.join(dir, 'console.log'));
  page.on('console', (m) => consoleLog.write(`[${m.type()}] ${m.text().slice(0, 500)}\n`));
  page.on('pageerror', (e) => consoleLog.write(`[pageerror] ${String(e).slice(0, 500)}\n`));
  page.on('dialog', async (d) => { log({ type: 'dialog', message: d.message() }); await d.dismiss().catch(() => {}); });

  const hardStop = setTimeout(async () => { log({ type: 'hard-stop', detail: '5 min budget' }); try { await leave(page, { log }); } catch {} await close(); process.exit(3); }, 290_000);
  const saveOuter = async (sel, fname) => { const html = await page.evaluate((s) => window.__probe.outer(s, 60000), sel).catch(() => null); if (html) fs.writeFileSync(path.join(dir, fname), html, 'utf8'); return !!html; };
  const dumpDiff = async (before, stageName) => {
    const after = await dumpStage(page, dir, stageName);
    const b = new Set(before.tree.split('\n').map((l) => l.trim()));
    const added = after.tree.split('\n').filter((l) => !b.has(l.trim()));
    fs.writeFileSync(path.join(dir, `diff_${stageName}.txt`), added.join('\n'), 'utf8');
    log({ type: 'diff', stage: stageName, addedLines: added.length, sample: added.slice(0, 12).map((l) => l.trim().slice(0, 160)) });
    return after;
  };

  const avatarPath = args.avatar ? path.resolve(args.avatar) : path.join(ROOT, 'assets', 'avatar.png');
  const avatarDataUrl = camera && fs.existsSync(avatarPath) ? 'data:image/png;base64,' + fs.readFileSync(avatarPath).toString('base64') : null;
  const setAvatar = async () => {
    if (!avatarDataUrl) return;
    const r = await page.evaluate((s) => window.__fakeMedia ? window.__fakeMedia.setAvatar(s) : null, avatarDataUrl).catch((e) => ({ error: String(e).slice(0, 120) }));
    log({ type: 'avatar.set', ...r });
  };

  try {
    const res = await join(page, url, name, {
      mic: true, camera, log,
      onStage: async (stage) => { if (stage === 'landing' || stage === 'prejoin') await setAvatar(); await dumpStage(page, dir, `stage_${stage}`); },
    });
    log({ type: 'join.result', ...res });
    fs.writeFileSync(path.join(dir, 'join_result.json'), JSON.stringify(res, null, 1));
    if (res.status !== 'joined') { log({ type: 'stop', reason: res.status }); await close(); clearTimeout(hardStop); return; }

    await page.waitForTimeout(2500);
    await dismissPopups(page, log);
    const incall = await dumpStage(page, dir, 'incall');
    log({ type: 'incall.buttons', buttons: incall.buttons.filter((b) => b.visible).map((b) => ({ testid: b.testid, aria: b.aria, title: b.title, text: b.text })) });
    log({ type: 'fakeMedia', ...(await page.evaluate(() => window.__fakeMedia?.info()).catch(() => ({}))) });
    await saveOuter(SEL.incall.tilesRoot, 'outer_tiles.html');
    log({ type: 'participants.tiles', list: await getParticipants(page, { selfName: name }).catch((e) => String(e)) });

    if (!args['skip-panels']) {
      // «Ещё» popover
      await openMore(page).catch((e) => log({ type: 'more.error', error: String(e).slice(0, 200) }));
      await dumpStage(page, dir, 'popover_more');
      await saveOuter(SEL.incall.morePopover, 'outer_popover_more.html');
      await closePopover(page);

      // Participants panel
      await page.evaluate(() => window.__probe.startMutationLog());
      await openParticipants(page).catch((e) => log({ type: 'participants.open.error', error: String(e).slice(0, 200) }));
      await page.waitForTimeout(1500);
      const pm = await page.evaluate(() => window.__probe.readMutationLog(true));
      fs.writeFileSync(path.join(dir, 'mutations_open_participants.json'), JSON.stringify(pm.filter((m) => m.type === 'add').slice(0, 200), null, 1));
      await dumpDiff(incall, 'panel_participants');
      for (const s of ['[class*="participantsPanel"]', '[class*="ParticipantsPanel"]', '[class*="participantsList"]', '[class*="sidePanel"]', '[role="dialog"]']) if (await saveOuter(s, 'outer_panel_participants.html')) { log({ type: 'participants.panel.root', selector: s }); break; }
      await closePanels(page);
      await page.waitForTimeout(500);

      // Chat
      await openChat(page).catch((e) => log({ type: 'chat.open.error', error: String(e).slice(0, 200) }));
      await page.waitForTimeout(4000);
      await dumpDiff(incall, 'panel_chat');
      const frame = chatFrame(page);
      log({ type: 'chat.frame', url: frame ? frame.url().slice(0, 200) : null, frames: page.frames().map((f) => f.url().slice(0, 100)) });
      if (frame) {
        await frame.evaluate(DOM_PROBE_SCRIPT).catch((e) => log({ type: 'chat.frame.probe.error', error: String(e).slice(0, 200) }));
        const ftree = await frame.evaluate(() => window.__probe.dump()).catch((e) => 'err ' + e);
        const fbtn = await frame.evaluate(() => window.__probe.buttons()).catch(() => []);
        const ftext = await frame.evaluate(() => window.__probe.text()).catch(() => '');
        fs.writeFileSync(path.join(dir, 'dom_chat_iframe.txt'), ftree, 'utf8');
        fs.writeFileSync(path.join(dir, 'buttons_chat_iframe.json'), JSON.stringify(fbtn, null, 1), 'utf8');
        fs.writeFileSync(path.join(dir, 'text_chat_iframe.txt'), ftext, 'utf8');
        log({ type: 'chat.iframe', text: ftext.slice(0, 300), buttons: fbtn.filter((b) => b.visible).map((b) => ({ tag: b.tag, testid: b.testid, aria: b.aria, text: b.text.slice(0, 30), cls: b.cls.slice(0, 60) })) });
      }
      await closePanels(page);
      await page.waitForTimeout(500);

      // Settings
      await openSettings(page).catch((e) => log({ type: 'settings.open.error', error: String(e).slice(0, 200) }));
      await page.waitForTimeout(1500);
      const st = await dumpDiff(incall, 'panel_settings');
      for (const s of ['[data-testid="orb-modal2"]', '[role="dialog"]', '[class*="settings"]']) if (await saveOuter(s, 'outer_panel_settings.html')) { log({ type: 'settings.root', selector: s }); break; }
      const tabs = st.buttons.filter((b) => b.visible && (b.role === 'tab' || /tab/i.test(b.cls)));
      log({ type: 'settings.tabs', tabs: tabs.map((t) => t.text) });
      for (const t of tabs.slice(0, 6)) {
        await page.locator('[role="tab"]').filter({ hasText: t.text }).first().click({ timeout: 2000 }).catch(() => {});
        await page.waitForTimeout(600);
        await dumpStage(page, dir, `settings_tab_${t.text.replace(/\W+/g, '_').slice(0, 20)}`);
      }
      await closePanels(page);
      await page.waitForTimeout(500);
    }

    log({ type: 'stay', seconds: stay });
    await page.evaluate(() => window.__probe.startMutationLog());
    const stayEnd = Date.now() + stay * 1000;
    let chunk = 0;
    while (Date.now() < stayEnd) {
      await page.waitForTimeout(Math.min(10_000, stayEnd - Date.now()));
      const muts = await page.evaluate(() => window.__probe.readMutationLog(true)).catch(() => []);
      if (muts.length) fs.writeFileSync(path.join(dir, `mutations_stay_${chunk++}.json`), JSON.stringify(muts, null, 1));
      const s = await classifyState(page);
      const plist = await getParticipants(page, { selfName: name }).catch(() => []);
      log({ type: 'stay.tick', muts: muts.length, status: s.status, participants: plist.map((p) => p.name + (p.muted ? ' (muted)' : '') + (p.cameraOn ? ' (cam)' : '')) });
      if (s.status !== 'joined') break;
    }
    await dumpStage(page, dir, 'incall_end');

    if (args.leave !== false) {
      const r = await leave(page, { log });
      log({ type: 'leave.result', ...r });
      await dumpStage(page, dir, 'after_leave');
    }
  } catch (e) {
    log({ type: 'error', error: String(e && e.stack || e) });
    await snap(page, 'error', dir);
  } finally {
    clearTimeout(hardStop);
    await close();
    logFile.end(); consoleLog.end();
    console.log('done; output in', dir);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
