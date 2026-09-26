// Streaming WAV writer for PCM16 mono (WP15): the agent's voice (and optionally the room mix) is
// appended chunk by chunk to a file under _internal/, the RIFF header is patched on close().
// Nothing is buffered in memory, so a 30-minute standup (~86 MB) is fine.

import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const HEADER_BYTES = 44;

export class PcmRecorder {
  /** @param {{path: string, sampleRate?: number, channels?: number}} o */
  constructor({ path, sampleRate = 24_000, channels = 1 }) {
    if (!path) throw new Error('PcmRecorder: path is required');
    this.path = path;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bytes = 0;
    this.closed = false;
    mkdirSync(dirname(path), { recursive: true });
    this._fd = openSync(path, 'w');
    writeSync(this._fd, Buffer.alloc(HEADER_BYTES));
  }

  /** Append PCM16 LE samples (Buffer | typed array | base64 string). */
  write(chunk) {
    if (this.closed) return false;
    const buf = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk, 'base64') : ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : Buffer.from(chunk);
    if (!buf.length) return true;
    writeSync(this._fd, buf);
    this.bytes += buf.length;
    return true;
  }

  get ms() {
    return Math.round(this.bytes / ((this.sampleRate * 2 * this.channels) / 1000));
  }

  /** Patch the header and close the file. Returns {path, bytes, ms}. */
  close() {
    if (this.closed) return { path: this.path, bytes: this.bytes, ms: this.ms };
    this.closed = true;
    try {
      writeSync(this._fd, wavHeader(this.bytes, this.sampleRate, this.channels), 0, HEADER_BYTES, 0);
    } finally {
      closeSync(this._fd);
    }
    return { path: this.path, bytes: this.bytes, ms: this.ms };
  }
}

/** 44-byte RIFF/WAVE header for PCM16. */
export function wavHeader(dataBytes, sampleRate = 24_000, channels = 1) {
  const h = Buffer.alloc(HEADER_BYTES);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * 2, 28);
  h.writeUInt16LE(channels * 2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
