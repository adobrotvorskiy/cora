// Recording of the room per Telemost audio slot (docs/agent_plan.md step 2, docs/smart_turn_plan.md):
// the PCM each STT session hears, on the log's wall clock, for tuning SpeechKit and Smart Turn on
// real voices. Test rooms only, with the owner's consent (host.js refuses it in the real room).
//
//   const rec = new SlotRecorder({ dir: '_internal/rec_2026-09-27_18-00' });
//   rec.write(trackId, pcm16);      // PCM16 mono 24 kHz chunks as the page sends them
//   rec.close();                    // -> index.json {sample_rate, started_at, tracks: {id: {file, t0, samples}}}
//
// The page sends a slot's audio only while it has sound: the gaps are filled with zeros, so sample n
// of a file is at t0 + n / sample_rate on the wall clock (the time base of stt_final.t_speech_*).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PcmRecorder } from './pcm_recorder.js';

const MIN_GAP_MS = 60; // arrival jitter below this is not a gap: no zeros inside continuous speech
const MAX_GAP_S = 600; // a slot silent longer than this restarts its timeline (no 1 GB of zeros)

export class SlotRecorder {
  /** @param {{dir: string, sampleRate?: number, now?: () => number}} o */
  constructor({ dir, sampleRate = 24_000, now = Date.now }) {
    if (!dir) throw new Error('SlotRecorder: dir is required');
    this.dir = dir;
    this.sampleRate = sampleRate;
    this.now = now;
    this.startedAt = now();
    this.tracks = new Map(); // track id -> {rec, t0, samples, file}
    this.closed = false;
  }

  /** @param {string} trackId  @param {Int16Array|Buffer} pcm */
  write(trackId, pcm) {
    if (this.closed || !trackId || !pcm?.length) return;
    const t = this.now();
    const samples = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    let tr = this.tracks.get(trackId);
    if (!tr) {
      const file = `slot_${String(trackId).replace(/[^\w-]/g, '').slice(0, 12) || this.tracks.size}.wav`;
      // the chunk arrives when it has been captured: its first sample is `duration` earlier
      const t0 = t - (samples.length / this.sampleRate) * 1000;
      tr = { rec: new PcmRecorder({ path: join(this.dir, file), sampleRate: this.sampleRate }), t0, samples: 0, file, gaps_ms: 0 };
      this.tracks.set(trackId, tr);
    }
    const due = Math.round(((t - tr.t0) / 1000) * this.sampleRate) - samples.length;
    const gap = due - tr.samples;
    if (gap > (MIN_GAP_MS / 1000) * this.sampleRate && gap <= MAX_GAP_S * this.sampleRate) {
      tr.rec.write(Buffer.alloc(gap * 2));
      tr.samples += gap;
      tr.gaps_ms += Math.round((gap / this.sampleRate) * 1000);
    } else if (gap > MAX_GAP_S * this.sampleRate) {
      tr.t0 = t - (samples.length / this.sampleRate) * 1000 - (tr.samples / this.sampleRate) * 1000; // the file goes on without the hour of zeros
      tr.restarts = (tr.restarts ?? 0) + 1;
    }
    tr.rec.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
    tr.samples += samples.length;
  }

  /** @returns {{dir: string, tracks: object}} */
  close() {
    if (this.closed) return this.index();
    this.closed = true;
    for (const tr of this.tracks.values()) tr.rec.close();
    const index = this.index();
    writeFileSync(join(this.dir, 'index.json'), JSON.stringify(index, null, 2));
    return index;
  }

  index() {
    return {
      dir: this.dir,
      sample_rate: this.sampleRate,
      started_at: this.startedAt,
      tracks: Object.fromEntries([...this.tracks].map(([id, tr]) => [id, { file: tr.file, t0: Math.round(tr.t0), samples: tr.samples, seconds: Math.round(tr.samples / this.sampleRate), gaps_ms: tr.gaps_ms, ...(tr.restarts ? { restarts: tr.restarts } : {}) }])),
    };
  }
}
