#!/usr/bin/env node
// Probe: does Telemost tell the client WHO is speaking (beyond the green tile outline)?
//
//   node tools/probe_speaker_meta.js --url <TEST room link> [--minutes 3] [--name "Кора (проба)"]
//
// Joins the room like the host (same Chrome profile, synthetic mic, no camera) and records, per
// frame (the call lives in the /private-join/ iframe):
//   ws.open / ws.in / ws.out / ws.close  every WebSocket message (text up to 4000 chars; binary:
//                                        length, first bytes, printable strings); captured on the
//                                        network (src net: frames, iframes, workers) and in the page
//                                        (src page, a fallback); the analysis prefers the network
//   dc.open / dc.in / dc.out             RTCDataChannel messages, same format
//   sdp                                  per m-line: mid, kind, a=ssrc / a=msid lines, a=extmap URIs
//                                        (csrc-audio-level / ssrc-audio-level = levels per source)
//   rtp.sources                          per audio receiver, on change: synchronization sources
//                                        (SSRC) and contributing sources (CSRC) with audioLevel
//   dom.speaker / dom.participants       the tile outline and the tiles (what the host uses today)
// Then correlates: which message kinds come right when someone starts speaking, which messages
// carry participant names (-> the id <-> name map), whether CSRCs exist and follow the speaker.
//
// Needs two people who take turns talking (≈10 s each, a few times) — a probe, not a conversation.
// Output: logs/probe_speaker_<date>.jsonl (gitignored: it holds names) + a summary in the console.

import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

// ---- page side ------------------------------------------------------------------------------------

function speakerProbeMain(cfg) {
  const W = window;
  if (W.__speakerProbe) return;
  W.__speakerProbe = true;
  let isTop = true;
  try {
    isTop = W.top === W;
  } catch (e) {
    isTop = false;
  }
  const frame = isTop ? 'top' : String(W.location && W.location.pathname).slice(0, 60);
  const MAX = cfg.maxText || 4000;
  const nowMs = () => Math.round(W.performance.timeOrigin + W.performance.now());
  const pending = [];
  function emit(type, data) {
    const ev = Object.assign({ type: type, t: nowMs(), frame: frame }, data || {});
    const fn = W[cfg.binding];
    if (typeof fn === 'function') {
      try {
        const r = fn(JSON.stringify(ev));
        if (r && r.catch) r.catch(function () {});
      } catch (e) { /* ignore */ }
    } else if (pending.length < 1000) pending.push(ev);
  }
  setInterval(function () {
    const fn = W[cfg.binding];
    if (typeof fn !== 'function' || !pending.length) return;
    pending.splice(0).forEach(function (ev) {
      try { fn(JSON.stringify(ev)); } catch (e) { /* ignore */ }
    });
  }, 500);

  function hex(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    return s;
  }
  function printable(u8) {
    let text = '';
    try { text = new TextDecoder('utf-8', { fatal: false }).decode(u8); } catch (e) { return []; }
    const m = text.match(/[\p{L}\p{N}_@.:\-]{4,}/gu) || [];
    return m.slice(0, 30).map(function (x) { return x.slice(0, 80); });
  }
  function describe(data, cb) {
    if (typeof data === 'string') return cb({ text: data.slice(0, MAX), len: data.length });
    let u8 = null;
    if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (u8) return cb({ bin: true, len: u8.length, head: hex(u8.subarray(0, 48)), strings: printable(u8) });
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      data.arrayBuffer().then(function (buf) { describe(buf, cb); }, function () { cb({ blob: true, len: data.size }); });
      return undefined;
    }
    return cb({ other: typeof data });
  }

  // WebSocket (signaling)
  const NativeWS = W.WebSocket;
  if (NativeWS && !NativeWS.__probeWrapped) {
    let wsSeq = 0;
    const Wrapped = function WebSocket(url, protocols) {
      const ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
      const id = frame + '#' + (++wsSeq);
      emit('ws.open', { src: 'page', ws: id, url: String(url).slice(0, 300) });
      ws.addEventListener('message', function (e) { describe(e.data, function (d) { emit('ws.in', Object.assign({ src: 'page', ws: id }, d)); }); });
      ws.addEventListener('close', function (e) { emit('ws.close', { src: 'page', ws: id, code: e.code }); });
      const send = ws.send;
      ws.send = function (d) {
        try { describe(d, function (x) { emit('ws.out', Object.assign({ src: 'page', ws: id }, x)); }); } catch (e) { /* ignore */ }
        return send.call(ws, d);
      };
      return ws;
    };
    Wrapped.prototype = NativeWS.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { Wrapped[k] = NativeWS[k]; });
    Wrapped.__probeWrapped = true;
    W.WebSocket = Wrapped;
  }

  // RTCPeerConnection: data channels, SDP, RTP sources
  const PC = W.RTCPeerConnection;
  if (!PC) return;
  const pcs = new Set();
  let dcSeq = 0;
  function wrapChannel(ch) {
    if (!ch || ch.__probe) return;
    ch.__probe = true;
    const id = frame + '#dc' + (++dcSeq) + ':' + ch.label;
    emit('dc.open', { dc: id, label: ch.label, protocol: ch.protocol });
    ch.addEventListener('message', function (e) { describe(e.data, function (d) { emit('dc.in', Object.assign({ dc: id }, d)); }); });
    const send = ch.send;
    ch.send = function (d) {
      try { describe(d, function (x) { emit('dc.out', Object.assign({ dc: id }, x)); }); } catch (e) { /* ignore */ }
      return send.apply(ch, arguments);
    };
  }
  function track(pc) {
    if (pcs.has(pc)) return;
    pcs.add(pc);
    try { pc.addEventListener('datachannel', function (e) { wrapChannel(e.channel); }); } catch (e) { /* ignore */ }
  }
  function sdpSummary(sdp) {
    const out = [];
    let cur = null;
    String(sdp || '').split(/\r?\n/).forEach(function (l) {
      if (l.indexOf('m=') === 0) {
        cur = { m: l.slice(2, 40), mid: null, ssrc: [], msid: [], extmap: [] };
        out.push(cur);
      } else if (!cur) {
        if (l.indexOf('a=extmap:') === 0) out.push({ session_extmap: l.slice(9, 160) });
      } else if (l.indexOf('a=mid:') === 0) cur.mid = l.slice(6);
      else if (l.indexOf('a=ssrc:') === 0 && cur.ssrc.length < 12) cur.ssrc.push(l.slice(7, 200));
      else if (l.indexOf('a=msid:') === 0) cur.msid.push(l.slice(7, 200));
      else if (l.indexOf('a=extmap:') === 0) cur.extmap.push(l.slice(9, 160));
    });
    return out.slice(0, 40);
  }
  const P = PC.prototype;
  const origCDC = P.createDataChannel;
  P.createDataChannel = function () {
    track(this);
    const ch = origCDC.apply(this, arguments);
    try { wrapChannel(ch); } catch (e) { /* ignore */ }
    return ch;
  };
  ['setRemoteDescription', 'setLocalDescription'].forEach(function (name) {
    const orig = P[name];
    P[name] = function (desc) {
      track(this);
      try {
        if (desc && desc.sdp) emit('sdp', { side: name === 'setRemoteDescription' ? 'remote' : 'local', sdpType: desc.type, lines: sdpSummary(desc.sdp) });
      } catch (e) { /* ignore */ }
      return orig.apply(this, arguments);
    };
  });

  const last = new Map();
  setInterval(function () {
    pcs.forEach(function (pc) {
      let transceivers = [];
      try { transceivers = pc.getTransceivers(); } catch (e) { return; }
      transceivers.forEach(function (tr) {
        const r = tr.receiver;
        if (!r || !r.track || r.track.kind !== 'audio') return;
        let ss = [];
        let cs = [];
        try { ss = r.getSynchronizationSources ? r.getSynchronizationSources() : []; } catch (e) { /* ignore */ }
        try { cs = r.getContributingSources ? r.getContributingSources() : []; } catch (e) { /* ignore */ }
        const act = function (s) { return (s.audioLevel || 0) > cfg.activeLevel; };
        const key = ss.map(function (s) { return s.source + (act(s) ? '*' : ''); }).join(',') + '|' + cs.map(function (s) { return s.source + (act(s) ? '*' : ''); }).join(',');
        const k = r.track.id;
        if (last.get(k) === key) return;
        last.set(k, key);
        const lv = function (s) { return { s: s.source, lvl: Math.round((s.audioLevel || 0) * 1000) / 1000 }; };
        emit('rtp.sources', { mid: tr.mid, track: k.slice(0, 12), ssrc: ss.map(lv), csrc: cs.map(lv) });
      });
    });
  }, cfg.pollMs);
}

/** Self-contained init script for page.addInitScript({ content }). */
export function buildSpeakerProbeScript({ binding = '__probe_event', pollMs = 200, activeLevel = 0.02, maxText = 4000 } = {}) {
  return `(${speakerProbeMain.toString()})(${JSON.stringify({ binding, pollMs, activeLevel, maxText })});`;
}

// ---- analysis -------------------------------------------------------------------------------------

/** Kind of a signaling message: JSON type/method/event…, socket.io event name, or a binary size class. */
export function messageKind(ev) {
  if (ev.bin || ev.blob) return `bin:${ev.len < 64 ? 'small' : ev.len < 1024 ? 'medium' : 'large'}`;
  if (typeof ev.text !== 'string') return 'other';
  let s = ev.text.trim();
  const sio = /^\d+(?=[[{])/.exec(s); // socket.io: 42["event", {...}]
  if (sio) s = s.slice(sio[0].length);
  let v;
  try {
    v = JSON.parse(s);
  } catch {
    return `text:${s.slice(0, 24)}`;
  }
  if (Array.isArray(v)) return typeof v[0] === 'string' ? `arr:${v[0]}` : 'arr';
  if (!v || typeof v !== 'object') return 'json:scalar';
  for (const k of ['type', 'method', 'event', 'action', 'op', 'name', 'cmd', 'kind']) {
    if (typeof v[k] === 'string') return `${k}:${v[k]}`;
  }
  const keys = Object.keys(v);
  if (keys.length === 1 && v[keys[0]] && typeof v[keys[0]] === 'object') {
    const inner = v[keys[0]];
    for (const k of ['type', 'method', 'event']) if (typeof inner[k] === 'string') return `${keys[0]}.${k}:${inner[k]}`;
    return `${keys[0]}{${Object.keys(inner).slice(0, 3).join(',')}}`;
  }
  return `{${keys.slice(0, 4).join(',')}}`;
}

/**
 * @param {object[]} events  the recorded events (page side + dom.*)
 * @param {{windowMs?: number}} [opts]
 * @returns {object} summary: connections, kinds, speaking-correlated kinds, messages with names, RTP facts
 */
export function analyze(events, { windowMs = 700 } = {}) {
  const fromNet = events.some((e) => e.type === 'ws.in' && e.src === 'net');
  const msgs = events.filter((e) => (e.type === 'ws.in' && (!fromNet || e.src === 'net')) || e.type === 'dc.in');
  const t0 = Math.min(...events.map((e) => e.t).filter(Number.isFinite));
  const t1 = Math.max(...events.map((e) => e.t).filter(Number.isFinite));
  const duration = Math.max(1, t1 - t0);

  // speaking starts from the tile outline
  const starts = [];
  let prev = new Set();
  for (const e of events.filter((x) => x.type === 'dom.speaker').sort((a, b) => a.t - b.t)) {
    const cur = new Set(e.names ?? []);
    for (const n of cur) if (!prev.has(n)) starts.push({ name: n, t: e.t });
    prev = cur;
  }

  const kinds = new Map();
  for (const m of msgs) {
    const k = `${m.type === 'dc.in' ? 'dc' : 'ws'} ${messageKind(m)}`;
    const rec = kinds.get(k) ?? { kind: k, count: 0, hits: 0, example: null, times: [] };
    rec.count++;
    rec.times.push(m.t);
    rec.example ??= m.text ? m.text.slice(0, 300) : (m.strings ?? []).join(' ').slice(0, 300);
    kinds.set(k, rec);
  }
  const windows = starts.length;
  for (const rec of kinds.values()) {
    rec.hits = starts.filter((s) => rec.times.some((t) => Math.abs(t - s.t) <= windowMs)).length;
    const expected = windows * Math.min(1, (rec.count * 2 * windowMs) / duration);
    rec.lift = expected > 0 ? Math.round((rec.hits / expected) * 10) / 10 : 0;
  }
  const correlated = [...kinds.values()]
    .filter((r) => windows >= 2 && r.hits >= Math.max(2, Math.ceil(windows * 0.6)) && r.lift >= 2)
    .sort((a, b) => b.lift - a.lift)
    .map(({ times, ...r }) => r);

  // messages that mention participant names (-> they carry the participant id <-> name map)
  const names = new Set();
  for (const e of events.filter((x) => x.type === 'dom.participants')) for (const n of e.names ?? []) if (n) names.add(n);
  for (const s of starts) names.add(s.name);
  const words = [...names].flatMap((n) => String(n).split(/\s+/)).filter((w) => w.length >= 3);
  const withNames = new Map();
  for (const m of msgs) {
    const hay = `${m.text ?? ''} ${(m.strings ?? []).join(' ')}`;
    const hit = words.find((w) => hay.includes(w));
    if (!hit) continue;
    const k = `${m.type === 'dc.in' ? 'dc' : 'ws'} ${messageKind(m)}`;
    if (!withNames.has(k)) withNames.set(k, { kind: k, count: 0, example: hay.slice(0, 400) });
    withNames.get(k).count++;
  }

  // RTP: SSRC per mid, CSRC presence, which CSRC is active when someone starts talking
  const rtp = events.filter((e) => e.type === 'rtp.sources');
  const ssrcByMid = new Map();
  const csrcs = new Set();
  for (const e of rtp) {
    const set = ssrcByMid.get(e.mid) ?? new Set();
    for (const s of e.ssrc ?? []) set.add(s.s);
    ssrcByMid.set(e.mid, set);
    for (const c of e.csrc ?? []) csrcs.add(c.s);
  }
  const csrcVotes = {};
  for (const s of starts) {
    const near = rtp.filter((e) => Math.abs(e.t - s.t) <= windowMs);
    for (const e of near) for (const c of e.csrc ?? []) if (c.lvl > 0.02) (csrcVotes[s.name] ??= {})[c.s] = ((csrcVotes[s.name] ?? {})[c.s] ?? 0) + 1;
  }
  const extmap = new Set();
  for (const e of events.filter((x) => x.type === 'sdp' && x.side === 'remote')) {
    for (const l of e.lines ?? []) for (const x of [...(l.extmap ?? []), ...(l.session_extmap ? [l.session_extmap] : [])]) extmap.add(x.replace(/^\d+(\/\w+)?\s+/, ''));
  }

  return {
    duration_s: Math.round(duration / 1000),
    connections: events.filter((e) => (e.type === 'ws.open' && (!fromNet || e.src === 'net')) || e.type === 'dc.open').map((e) => e.url ?? e.label),
    messages_in: msgs.length,
    speaking_starts: starts.length,
    kinds: [...kinds.values()].sort((a, b) => b.count - a.count).slice(0, 25).map(({ times, ...r }) => r),
    correlated,
    with_names: [...withNames.values()].sort((a, b) => b.count - a.count),
    rtp: {
      changes: rtp.length,
      ssrc_per_mid: Object.fromEntries([...ssrcByMid].map(([mid, set]) => [mid, set.size])),
      csrc_distinct: csrcs.size,
      csrc_votes: csrcVotes,
      extmap: [...extmap],
    },
  };
}

/** A WebSocket frame payload (string or Buffer) in the same shape as the page-side events. */
export function describePayload(payload, maxText = 4000) {
  if (typeof payload === 'string') return { text: payload.slice(0, maxText), len: payload.length };
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? []);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  return { bin: true, len: buf.length, head: buf.subarray(0, 48).toString('hex'), strings: (text.match(/[\p{L}\p{N}_@.:\-]{4,}/gu) ?? []).slice(0, 30).map((x) => x.slice(0, 80)) };
}

// ---- run ------------------------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      minutes: { type: 'string', default: '3' },
      name: { type: 'string', default: 'Кора (проба)' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || !values.url) {
    console.log('node tools/probe_speaker_meta.js --url <TEST room link> [--minutes 3] [--name "Кора (проба)"]');
    return values.help ? 0 : 64;
  }
  const [{ launchBrowser }, telemost, { attachPageAudio }, { APP_ROOT }, { LOGS_DIR, PROFILE_DIR, loadSettings }, { realRoomAllowed }, clock] = await Promise.all([
    import('../src/browser/launch.js'),
    import('../src/browser/telemost.js'),
    import('../src/browser/page_inject.js'),
    import('../src/env.js'),
    import('../src/config.js'),
    import('../src/core/guards.js'),
    import('../src/clock.js'),
  ]);
  const settings = loadSettings();
  const gate = realRoomAllowed({ url: values.url, flags: {}, realUrl: settings.real_room_url ?? null });
  if (!gate.allowed) {
    console.error(`refused: ${gate.reason} (a probe never joins the real standup room)`);
    return 64;
  }
  mkdirSync(LOGS_DIR, { recursive: true });
  const path = join(LOGS_DIR, `probe_speaker_${clock.formatMsk(new Date(), 'YYYY-MM-DD_HH-mm')}.jsonl`);
  const out = createWriteStream(path, { flags: 'a' });
  const events = [];
  const record = (e) => {
    events.push(e);
    out.write(`${JSON.stringify(e)}\n`);
  };

  const browser = await launchBrowser({ profileDir: `${PROFILE_DIR}/host`, offscreen: true, viewport: [640, 480], log: () => {} });
  const page = browser.page;
  await page.exposeFunction('__probe_event', (json) => {
    try {
      record(JSON.parse(json));
    } catch {
      // ignore a broken event
    }
  });
  await page.addInitScript({ content: buildSpeakerProbeScript() });
  // the network view of every WebSocket (frames, iframes, workers): the in-page hook cannot see a worker
  let wsSeq = 0;
  page.on('websocket', (ws) => {
    const id = `net#${++wsSeq}`;
    record({ type: 'ws.open', src: 'net', t: Date.now(), ws: id, url: ws.url().slice(0, 300) });
    ws.on('framereceived', (f) => record({ type: 'ws.in', src: 'net', t: Date.now(), ws: id, ...describePayload(f.payload) }));
    ws.on('framesent', (f) => record({ type: 'ws.out', src: 'net', t: Date.now(), ws: id, ...describePayload(f.payload) }));
    ws.on('close', () => record({ type: 'ws.close', src: 'net', t: Date.now(), ws: id }));
  });
  await attachPageAudio(page, { onAudio: () => {}, onEvent: () => {}, opts: { avatar: null }, baseDir: APP_ROOT });
  console.log(`joining ${values.url} as «${values.name}»; log ${path}`);
  const res = await telemost.join(page, values.url, values.name, { mic: true, camera: false, waitAdmissionMs: 180_000, log: () => {} });
  if (res.status !== 'joined') {
    console.error(`join failed: ${res.status} ${res.detail ?? ''}`);
    await browser.close().catch(() => {});
    return 1;
  }
  const stopObservers = await telemost.installObservers(
    page,
    (e) => {
      if (e.type === 'speaker') record({ type: 'dom.speaker', t: Date.now(), names: e.names });
      else if (e.type === 'participants') record({ type: 'dom.participants', t: Date.now(), names: (e.list ?? []).map((p) => p.name) });
    },
    { selfName: values.name },
  );
  console.log(`joined. Take turns talking (~10 s each, a few times) for ${values.minutes} min…`);
  const end = Date.now() + Number(values.minutes) * 60_000;
  while (Date.now() < end) {
    await sleep(30_000);
    const c = (t) => events.filter((e) => e.type === t).length;
    console.log(`  ws in ${c('ws.in')}, dc in ${c('dc.in')}, rtp changes ${c('rtp.sources')}, speaker changes ${c('dom.speaker')}`);
  }
  await stopObservers?.().catch(() => {});
  await telemost.leave(page, { log: () => {} }).catch(() => {});
  await browser.close().catch(() => {});
  out.end();

  const a = analyze(events);
  console.log(`\n== ${a.duration_s} s, ${a.messages_in} signaling messages in, ${a.speaking_starts} speaking starts (tile outline)`);
  console.log(`connections: ${a.connections.map((u) => String(u).replace(/\?.*$/, '')).join(' | ') || 'none seen (signaling may run in a worker)'}`);
  console.log('\nmessage kinds (top):');
  for (const k of a.kinds) console.log(`  ${String(k.count).padStart(5)}  ${k.kind}`);
  console.log('\nkinds that come right when someone starts speaking (lift = vs chance):');
  if (!a.correlated.length) console.log('  none');
  for (const k of a.correlated) console.log(`  ${k.kind}: ${k.hits}/${a.speaking_starts} starts, lift ${k.lift}\n    e.g. ${k.example}`);
  console.log('\nmessages that mention participant names (id <-> name map):');
  if (!a.with_names.length) console.log('  none');
  for (const k of a.with_names) console.log(`  ${k.kind} x${k.count}\n    e.g. ${k.example}`);
  console.log(`\nRTP: ${a.rtp.changes} source changes; SSRC per mid ${JSON.stringify(a.rtp.ssrc_per_mid)}; distinct CSRC ${a.rtp.csrc_distinct}`);
  if (Object.keys(a.rtp.csrc_votes).length) console.log(`  CSRC active at speaking starts: ${JSON.stringify(a.rtp.csrc_votes)}`);
  console.log(`  RTP header extensions offered: ${a.rtp.extmap.join(', ') || 'none'}`);
  console.log(`\nfull log: ${path} (names inside: keep it local)`);
  return 0;
}

if (process.argv[1]?.endsWith('probe_speaker_meta.js')) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${e?.stack ?? e}`);
      process.exit(1);
    },
  );
}
