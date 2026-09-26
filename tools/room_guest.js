#!/usr/bin/env node
// Unattended smoke companion: joins a Telemost room as a guest and speaks phrases into the
// room "microphone" (the page player worklet, the same path the host's voice uses). Lets one
// person run a live end-to-end check of the host: hearing, answers, the on-demand start.
//
//   node tools/room_guest.js --url <room> [--name "Серёжа (тест)"] [--say "Кора, начинай!"]...
//                              [--gap-sec 25] [--delay-sec 5] [--leave-after-sec 20]
//
// --say phrases are synthesized with ElevenLabs (Nastya, pcm_24000) and cached under cache/.
// Requires the ElevenLabs key (settings.keys.elevenlabs). Exit 0 once the guest left the room.
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { APP_ROOT, loadEnv, requireKey } from '../src/env.js';
import { loadSettings } from '../src/config.js';
import { launchBrowser } from '../src/browser/launch.js';
import { attachPageAudio } from '../src/browser/page_inject.js';
import { join as roomJoin, leave as roomLeave, meetingFrame, readToggle } from '../src/browser/telemost.js';

const NASTYA_VOICE_ID = 'YjESejviApN7SHrbfnA2'; // the host's own voice: a familiar one is easiest to transcribe
const PCM_SR = 24000;
const PCM_BYTES_PER_S = PCM_SR * 2;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: 'string' },
    name: { type: 'string', default: 'Серёжа (тест)' },
    say: { type: 'string', multiple: true },
    'delay-sec': { type: 'string', default: '5' },
    'gap-sec': { type: 'string', default: '25' },
    'leave-after-sec': { type: 'string', default: '20' },
    profile: { type: 'string', default: 'profile/guest-smoke' },
    acoustic: { type: 'boolean', default: false }, // real mic + speakers instead of the page player
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});
if (values.help || !values.url || !(values.say ?? []).length) {
  console.log('node tools/room_guest.js --url <room> [--name "Серёжа (тест)"] [--say "Кора, начинай!"] [--gap-sec 25] [--delay-sec 5] [--leave-after-sec 20] [--profile guest] [--acoustic]');
  process.exit(values.help ? 0 : 64);
}

async function ttsPcm24k(text, keyName) {
  const dir = join(APP_ROOT, 'cache', 'guest_phrases');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${createHash('md5').update(text).digest('hex')}.pcm`);
  if (existsSync(file)) return readFileSync(file);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${NASTYA_VOICE_ID}?output_format=pcm_${PCM_SR}`, {
    method: 'POST',
    headers: { 'xi-api-key': requireKey(keyName), 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, pcm);
  return pcm;
}

/** Push PCM in ~100 ms chunks slightly ahead of real time, then the end-of-stream marker. */
async function streamPcm(audio, pcm) {
  const chunk = Math.floor(PCM_BYTES_PER_S / 10);
  for (let off = 0; off < pcm.length; off += chunk) {
    await audio.play(pcm.subarray(off, off + chunk));
    await sleep(70); // build a small buffer ahead of the worklet so it never underruns
  }
  await audio.playEnd();
  await sleep(600);
}

/** Wrap raw pcm_24000 s16le in a WAV header (for the acoustic mode: playback via the OS speakers). */
function writeWav(pcm, file) {
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(PCM_SR, 24); hdr.writeUInt32LE(PCM_BYTES_PER_S, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(pcm.length, 40);
  writeFileSync(file, Buffer.concat([hdr, pcm]));
  return file;
}

const execFileP = promisify(execFile);
/** Play a WAV through the machine's real speakers; the room hears it via the real microphone. */
async function playWav(file) {
  const ps = file.replace(/'/g, "''");
  await execFileP('powershell.exe', ['-NoProfile', '-Command', `(New-Object System.Media.SoundPlayer '${ps}').PlaySync()`], { timeout: 120_000 });
}

loadEnv();
const settings = loadSettings();
const log = (line) => console.log(`[guest ${new Date().toISOString().slice(11, 19)}] ${line}`);
const { context, page, close } = await launchBrowser({ profileDir: values.profile, offscreen: true, muteAudio: !values.acoustic, log: (e) => log(`browser.${e.type}`) });
let exitCode = 0;
try {
  // The init script must be in place BEFORE the meeting app loads (as the host does): it
  // installs window.__host_play, the page player that becomes the guest's "microphone".
  // Acoustic mode skips it: Telemost gets the machine's real microphone and the phrases are
  // played through the real speakers (a human impression, immune to page-audio quirks).
  let maxRms = 0;
  const audio = values.acoustic
    ? null
    : await attachPageAudio(page, {
        onAudio: (pcm) => {
          let s = 0;
          const n = Math.min(pcm.length, 2400);
          for (let i = 0; i < n; i++) s += pcm[i] * pcm[i];
          const rms = Math.sqrt(s / n) / 32768;
          if (rms > maxRms) maxRms = rms;
        },
        onEvent: (e) => {
          if (/^(gum\.|audio\.context|worklet\.|capture\.|player\.)/.test(e.type ?? '')) log(`page.${e.type} ${JSON.stringify({ ...e, type: undefined }).slice(0, 420)}`);
        },
      });
  // probe: keep every RTCPeerConnection reachable to inspect audio senders (does our voice leave the page?)
  if (!values.acoustic) {
    await page.addInitScript(() => {
      if (window.__pcs) return;
      window.__pcs = [];
      const Native = window.RTCPeerConnection;
      const Wrapped = function (...args) {
        const pc = new Native(...args);
        window.__pcs.push(pc);
        return pc;
      };
      Wrapped.prototype = Native.prototype;
      window.RTCPeerConnection = Wrapped;
      window.__sender_stats = async () => {
        const out = [];
        for (const pc of window.__pcs) {
          try {
            const stats = await pc.getStats();
            for (const s of stats.values()) {
              if (s.type === 'outbound-rtp' && s.mediaType === 'audio') {
                out.push({ mid: s.mid ?? null, trackId: s.trackIdentifier ?? null, bytesSent: s.bytesSent ?? null, packetsSent: s.packetsSent ?? null });
              }
            }
          } catch { /* pc closed */ }
        }
        return out;
      };
    });
  }
  const joinRes = await roomJoin(page, values.url, values.name, { mic: true, camera: false, log: (e) => log(`join.${e.stage ?? e.type} ${e.micState ? `mic=${e.micState.on}` : ''}${e.camState ? ` cam=${e.camState.on}` : ''}`) });
  log(`join: ${joinRes.status} in ${joinRes.tookMs} ms${joinRes.detail ? ` (${joinRes.detail})` : ''}`);
  if (joinRes.status !== 'joined') {
    exitCode = 1;
  } else {
    const callScope = await meetingFrame(page);
    const mic = await readToggle(callScope, '[data-testid="turn-on-mic-button"], [data-testid="turn-off-mic-button"]');
    log(`in-call mic toggle: on=${mic.on} testid=${mic.testid}`);
    if (!values.acoustic) {
      const status = await callScope.evaluate(() => window.__host_status?.()).catch(() => null);
      log(`host_status: ${JSON.stringify(status)}`);
    }
    await sleep(Number(values['delay-sec']) * 1000);
    for (const phrase of values.say) {
      const pcm = await ttsPcm24k(phrase, settings.keys.elevenlabs);
      log(`say: «${phrase}» (${(pcm.length / PCM_BYTES_PER_S).toFixed(1)} s of pcm)`);
      if (values.acoustic) {
        const wav = writeWav(pcm, join(APP_ROOT, 'cache', 'guest_phrases', `${createHash('md5').update(phrase).digest('hex')}.wav`));
        await playWav(wav);
        log('played through the speakers');
      } else {
        await streamPcm(audio, pcm);
        log(`player: ${JSON.stringify(await audio.state().catch(() => null))}`);
        const st2 = await callScope.evaluate(() => window.__host_status?.()).catch(() => null);
        log(`host_status mic=${JSON.stringify(st2?.mic)} tracks=${JSON.stringify(st2?.tracks?.map((t) => ({ mid: t.mid, muted: t.muted })))}`);
        const senders = await callScope.evaluate(() => window.__sender_stats?.()).catch(() => null);
        log(`senders: ${JSON.stringify(senders)} heardMaxRms=${maxRms.toFixed(4)}`);
      }
      await sleep(Number(values['gap-sec']) * 1000);
    }
    await sleep(Number(values['leave-after-sec']) * 1000);
  }
} catch (e) {
  log(`ERROR: ${e?.message ?? e}`);
  exitCode = 1;
} finally {
  await roomLeave(page).catch(() => {});
  log('left the room');
  await close().catch(() => {});
}
await context.close?.().catch(() => {});
process.exit(exitCode);
