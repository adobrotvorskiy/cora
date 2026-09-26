// AudioWorkletProcessor sources for the page audio adapter (WP2).
//
// Both processors are shipped to the page as ONE module string (WORKLET_MODULE_SRC),
// loaded from a Blob URL by page_inject.js, and run on the AudioContext rendering
// thread at the context sample rate (24 000 Hz) in 128-frame render quanta (5.33 ms).
//
//   host-player  : PCM16 queue -> mono float output. Feeds MediaStreamAudioDestinationNode
//                  (= the bot's "microphone"). Messages in: push / eos / flush.
//                  Messages out: started / progress / underrun / drained / flushed.
//   host-capture : N inputs (one per remote audio track, "slots") -> per-slot RMS every
//                  levelFrames (50 ms) + clipped mix as PCM16 chunks of chunkFrames (100 ms).
//                  Messages in: map / unmap / enable. Messages out: chunk.
//
// The sources are plain strings: they must not reference anything from this module.
// Keep them free of backticks and `${` — they are embedded via String.raw and JSON.stringify.

export const PLAYER_PROCESSOR_NAME = 'host-player';
export const CAPTURE_PROCESSOR_NAME = 'host-capture';

export const PLAYER_WORKLET_SRC = String.raw`
class HostPlayerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const msToFrames = (ms) => Math.max(0, Math.round(ms * sampleRate / 1000));
    this.fadeFrames = Math.max(8, msToFrames(o.fadeMs != null ? o.fadeMs : 4));
    this.graceFrames = msToFrames(o.drainGraceMs != null ? o.drainGraceMs : 250);
    this.progressEvery = Math.max(1, Math.round(msToFrames(o.progressMs != null ? o.progressMs : 50) / 128));
    // Live queue: Int16Array chunks, FIFO; head = read offset inside chunks[0]. A flush moves the
    // live queue into fq (faded out, then dropped); pushes that arrive after the flush message
    // land in a fresh live queue and survive the flush (WP6 fix of the flush/push race).
    this.q = { chunks: [], head: 0, frames: 0 };
    this.fq = null;           // queue being faded out by a flush
    this.playing = false;     // an utterance is in progress (started, not drained/aborted)
    this.eos = false;         // host said "no more data for this utterance"
    this.utt = 0;             // utterance counter
    this.playedFrames = 0;    // rendered frames of the current utterance
    this.consumedTotal = 0;   // rendered + dropped frames since creation (for queued_ms mirror)
    this.underrunFrames = 0;  // consecutive starved frames while playing
    this.underruns = 0;
    this.fadeLeft = 0;        // > 0 while a flush fade-out is in progress
    this.fadeTotal = 0;
    this.flushId = null;
    this.quantum = 0;
    this.winSumsq = 0;        // output energy since the last progress report (drives the avatar glow)
    this.winFrames = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }
  get queuedFrames() { return this.q.frames; }
  ms(frames) { return Math.round(frames / sampleRate * 1000); }
  post(m) { this.port.postMessage(m); }
  winRms() {
    const r = this.winFrames > 0 ? Math.sqrt(this.winSumsq / this.winFrames) : 0;
    this.winSumsq = 0; this.winFrames = 0;
    return Math.round(r * 10000) / 10000;
  }
  onMessage(m) {
    if (!m) return;
    if (m.type === 'push') {
      const a = m.pcm instanceof Int16Array ? m.pcm : new Int16Array(m.pcm);
      if (a.length === 0) return;
      this.q.chunks.push(a);
      this.q.frames += a.length;
      this.eos = false;
    } else if (m.type === 'eos') {
      this.eos = true;
      if (this.playing && this.q.frames === 0 && this.fadeLeft === 0) this.finish('eos');
    } else if (m.type === 'flush') {
      if (this.fadeLeft > 0) {
        // a second flush during the fade: whatever was pushed since the first one goes too
        this.flushId = m.id;
        this.moveLiveToFade();
        return;
      }
      if (!this.playing && this.q.frames === 0) {
        this.post({ type: 'flushed', id: m.id, utt: this.utt, played_ms: 0, dropped_ms: 0,
          consumed: this.consumedTotal, idle: true });
        return;
      }
      this.flushId = m.id;
      this.moveLiveToFade();
      if (!this.playing || this.fq.frames === 0) { this.finishAbort(); return; }
      this.fadeTotal = Math.min(this.fadeFrames, this.fq.frames);
      this.fadeLeft = this.fadeTotal;
    }
  }
  // Everything queued so far goes to the fade-out queue; the live queue starts empty.
  moveLiveToFade() {
    if (!this.fq) this.fq = { chunks: [], head: 0, frames: 0 };
    const src = this.q;
    if (src.chunks.length && src.head > 0) { src.chunks[0] = src.chunks[0].subarray(src.head); src.head = 0; }
    if (this.fq.chunks.length && this.fq.head > 0) { this.fq.chunks[0] = this.fq.chunks[0].subarray(this.fq.head); this.fq.head = 0; }
    for (let i = 0; i < src.chunks.length; i++) this.fq.chunks.push(src.chunks[i]);
    this.fq.frames += src.frames;
    this.q = { chunks: [], head: 0, frames: 0 };
  }
  // Copy up to n frames from queue src into out[offset..], applying a linear gain ramp.
  pull(src, out, offset, n, gain, step) {
    let got = 0;
    while (n > 0 && src.chunks.length) {
      const c = src.chunks[0];
      const avail = c.length - src.head;
      const take = avail < n ? avail : n;
      const base = src.head;
      let sumsq = 0;
      for (let i = 0; i < take; i++) {
        const v = (c[base + i] / 32768) * gain;
        out[offset + i] = v;
        sumsq += v * v;
        gain -= step;
      }
      this.winSumsq += sumsq;
      src.head += take;
      if (src.head >= c.length) { src.chunks.shift(); src.head = 0; }
      src.frames -= take;
      n -= take; offset += take; got += take;
    }
    return got;
  }
  finish(reason) {
    this.post({ type: 'drained', utt: this.utt, played_ms: this.ms(this.playedFrames), reason: reason,
      consumed: this.consumedTotal, underruns: this.underruns });
    this.playing = false;
    this.eos = false;
    this.underrunFrames = 0;
  }
  finishAbort() {
    const dropped = this.fq ? this.fq.frames : 0;
    this.fq = null;
    this.consumedTotal += dropped;
    const wasPlaying = this.playing;
    this.post({ type: 'flushed', id: this.flushId, utt: this.utt, played_ms: this.ms(this.playedFrames),
      dropped_ms: this.ms(dropped), consumed: this.consumedTotal, idle: !wasPlaying && dropped === 0 });
    this.playing = false;
    if (this.q.frames === 0) this.eos = false;   // an eos that belongs to audio pushed after the flush stays
    this.fadeLeft = 0; this.fadeTotal = 0; this.flushId = null;
    this.underrunFrames = 0;
  }
  process(inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const N = out.length;
    this.quantum++;
    this.winFrames += N;
    if (this.fadeLeft > 0) {
      const n = Math.min(N, this.fadeLeft, this.fq.frames);
      const g0 = this.fadeLeft / this.fadeTotal;
      const got = this.pull(this.fq, out, 0, n, g0, 1 / this.fadeTotal);
      for (let i = got; i < N; i++) out[i] = 0;
      this.playedFrames += got; this.consumedTotal += got; this.fadeLeft -= got;
      if (this.fadeLeft <= 0 || this.fq.frames === 0 || got === 0) this.finishAbort();
      return true;
    }
    if (this.q.frames > 0) {
      if (!this.playing) {
        this.playing = true; this.utt++; this.playedFrames = 0; this.underrunFrames = 0;
        this.post({ type: 'started', utt: this.utt, queued_ms: this.ms(this.q.frames) });
      }
      const got = this.pull(this.q, out, 0, N, 1, 0);
      for (let i = got; i < N; i++) out[i] = 0;
      this.playedFrames += got; this.consumedTotal += got;
      this.underrunFrames = 0;
      if (this.q.frames === 0 && this.eos) this.finish('eos');
    } else {
      for (let i = 0; i < N; i++) out[i] = 0;
      if (this.playing) {
        if (this.underrunFrames === 0) {
          this.underruns++;
          this.post({ type: 'underrun', utt: this.utt, played_ms: this.ms(this.playedFrames) });
        }
        this.underrunFrames += N;
        if (this.underrunFrames >= this.graceFrames) this.finish('timeout');
      }
    }
    if (this.playing && (this.quantum % this.progressEvery) === 0) {
      this.post({ type: 'progress', utt: this.utt, played_ms: this.ms(this.playedFrames),
        consumed: this.consumedTotal, queued_ms: this.ms(this.q.frames), rms: this.winRms() });
    } else if (!this.playing && this.winFrames > sampleRate) {
      this.winSumsq = 0; this.winFrames = 0;   // keep the idle window bounded
    }
    return true;
  }
}
registerProcessor('host-player', HostPlayerProcessor);
`;

export const CAPTURE_WORKLET_SRC = String.raw`
class HostCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    const slots = (options && options.numberOfInputs) || 16;
    this.slots = slots;
    this.chunkFrames = o.chunkFrames || Math.round(sampleRate * 0.1);
    this.levelFrames = o.levelFrames || Math.round(sampleRate * 0.05);
    this.enabled = o.enabled !== false;
    this.ids = new Array(slots).fill(null);   // slot -> track_id (null = unmapped)
    this.mapped = 0;
    this.sumsq = new Float64Array(slots);     // per-slot sum of squares for the current level frame
    this.levelAcc = new Array(slots);         // per-slot dBFS frames accumulated for the current chunk
    for (let s = 0; s < slots; s++) this.levelAcc[s] = [];
    this.mixSumsq = 0;
    this.mixAcc = [];
    this.buf = new Int16Array(this.chunkFrames);
    // per-track taps (yandex_cascade STT, one recognition session per SFU slot): a slot's chunks are
    // sent only while it has sound, plus one chunk of pre-roll and a short tail
    this.trackTaps = o.trackTaps === true;
    this.trackBuf = new Array(slots);
    this.trackPrev = new Array(slots).fill(null);  // last quiet chunk per slot (pre-roll)
    this.trackHang = new Array(slots).fill(0);     // tail chunks still to send per slot
    for (let s = 0; s < slots; s++) this.trackBuf[s] = new Int16Array(this.chunkFrames);
    this.pos = 0;
    this.seq = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }
  onMessage(m) {
    if (!m) return;
    if (m.type === 'map') {
      if (this.ids[m.slot] === null) this.mapped++;
      this.ids[m.slot] = m.id;
      this.sumsq[m.slot] = 0;
      this.levelAcc[m.slot] = [];
      this.trackPrev[m.slot] = null; this.trackHang[m.slot] = 0;
    } else if (m.type === 'unmap') {
      if (this.ids[m.slot] !== null) this.mapped--;
      this.ids[m.slot] = null;
      this.sumsq[m.slot] = 0;
      this.levelAcc[m.slot] = [];
      this.trackPrev[m.slot] = null; this.trackHang[m.slot] = 0;
    } else if (m.type === 'enable') {
      this.enabled = !!m.enabled;
      if (!this.enabled) this.reset();
    }
  }
  reset() {
    this.pos = 0; this.mixSumsq = 0; this.mixAcc = [];
    for (let s = 0; s < this.slots; s++) { this.sumsq[s] = 0; this.levelAcc[s] = []; this.trackPrev[s] = null; this.trackHang[s] = 0; }
  }
  dbfs(sumsq, n) {
    if (!(sumsq > 0)) return -100;
    const db = 10 * Math.log10(sumsq / n);
    return db < -100 ? -100 : Math.round(db * 10) / 10;
  }
  endLevelFrame() {
    for (let s = 0; s < this.slots; s++) {
      if (this.ids[s] !== null) this.levelAcc[s].push(this.dbfs(this.sumsq[s], this.levelFrames));
      this.sumsq[s] = 0;
    }
    this.mixAcc.push(this.dbfs(this.mixSumsq, this.levelFrames));
    this.mixSumsq = 0;
  }
  emitChunk() {
    const levels = [];
    for (let s = 0; s < this.slots; s++) {
      if (this.ids[s] === null) continue;
      levels.push({ track_id: this.ids[s], slot: s, frames: this.levelAcc[s] });
      this.levelAcc[s] = [];
    }
    const pcm = this.buf.buffer;
    this.port.postMessage({ type: 'chunk', seq: this.seq, pcm: pcm, levels: levels, mix: this.mixAcc,
      ctx_time: currentTime, frames: this.chunkFrames }, [pcm]);
    if (this.trackTaps) this.emitTrackChunks();
    this.seq++;
    this.buf = new Int16Array(this.chunkFrames);
    this.pos = 0;
    this.mixAcc = [];
  }
  emitTrackChunks() {
    for (let s = 0; s < this.slots; s++) {
      const b = this.trackBuf[s];
      this.trackBuf[s] = new Int16Array(this.chunkFrames);   // a posted buffer is transferred (neutered)
      if (this.ids[s] === null) continue;
      let energy = 0;
      for (let i = 0; i < this.chunkFrames; i += 8) energy += Math.abs(b[i]);
      const loud = energy / (this.chunkFrames / 8) > 80;     // mean |x| ~ -52 dBFS: someone is talking
      if (loud) {
        const pre = this.trackHang[s] === 0 ? this.trackPrev[s] : null;
        if (pre) this.port.postMessage({ type: 'track_chunk', seq: this.seq, track_id: this.ids[s], slot: s, pcm: pre.buffer }, [pre.buffer]);
        this.trackPrev[s] = null;
        this.trackHang[s] = 3;                                  // 300 ms tail keeps word endings
        this.port.postMessage({ type: 'track_chunk', seq: this.seq, track_id: this.ids[s], slot: s, pcm: b.buffer }, [b.buffer]);
      } else if (this.trackHang[s] > 0) {
        this.trackHang[s]--;
        this.port.postMessage({ type: 'track_chunk', seq: this.seq, track_id: this.ids[s], slot: s, pcm: b.buffer }, [b.buffer]);
      } else {
        this.trackPrev[s] = b;
      }
    }
  }
  process(inputs, outputs) {
    if (!this.enabled || this.mapped === 0) { if (this.pos) this.reset(); return true; }
    const out = outputs[0] && outputs[0][0];
    const N = out ? out.length : 128;
    const slots = inputs.length;
    const buf = this.buf; const sumsq = this.sumsq;
    for (let k = 0; k < N; k++) {
      const p = this.pos;
      let mix = 0;
      for (let s = 0; s < slots; s++) {
        const inp = inputs[s];
        if (inp.length === 0) continue;             // nothing connected to this slot
        let x = inp[0][k];
        if (inp.length > 1) x = (x + inp[1][k]) * 0.5;
        mix += x;
        sumsq[s] += x * x;
        if (this.trackTaps) this.trackBuf[s][p] = (x > 1 ? 32767 : x < -1 ? -32767 : (x * 32767) | 0);
      }
      if (mix > 1) mix = 1; else if (mix < -1) mix = -1;
      this.mixSumsq += mix * mix;
      buf[p] = (mix * 32767) | 0;
      this.pos = p + 1;
      if ((this.pos % this.levelFrames) === 0) this.endLevelFrame();
      if (this.pos >= this.chunkFrames) this.emitChunk();
    }
    if (out) for (let i = 0; i < N; i++) out[i] = 0;   // we never pass audio downstream
    return true;
  }
}
registerProcessor('host-capture', HostCaptureProcessor);
`;

export const WORKLET_MODULE_SRC = PLAYER_WORKLET_SRC + '\n' + CAPTURE_WORKLET_SRC;
