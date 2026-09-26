// Linear resampling between the page adapter rate (24 kHz) and the Yandex Realtime rate (16 kHz).
// Mono s16le Int16Array in, Int16Array out. Quality is fine for voice (bandwidth-limited anyway).

/** 24 kHz -> 16 kHz (factor 2/3). */
export function resample24to16(pcm) {
  const n = pcm.length;
  const out = new Int16Array(Math.floor((n * 2) / 3));
  for (let i = 0; i < out.length; i++) {
    const pos = (i * 3) / 2;
    const j = Math.floor(pos);
    const f = pos - j;
    const a = pcm[j] ?? 0;
    const b = pcm[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * f);
  }
  return out;
}

/** 16 kHz -> 24 kHz (factor 3/2). */
export function resample16to24(pcm) {
  const n = pcm.length;
  const out = new Int16Array(Math.floor((n * 3) / 2));
  for (let i = 0; i < out.length; i++) {
    const pos = (i * 2) / 3;
    const j = Math.floor(pos);
    const f = pos - j;
    const a = pcm[j] ?? 0;
    const b = pcm[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * f);
  }
  return out;
}
