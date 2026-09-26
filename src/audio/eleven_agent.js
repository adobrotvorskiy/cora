// ElevenLabs Agents client (WP15, docs/eleven_agent.md §3): one WebSocket conversation with the
// hosted agent, a small REST helper (signed URL, conversation cost, balance), and the bridge that
// plays the agent's audio through the page player.
//
//   const rest = elevenRest({ apiKey });
//   const agent = new ElevenAgent({ apiKey, agentId, rest, log, init: () => ({ override, dynamicVariables, resume }) });
//   const playback = attachPlayer(agent, player, { log });
//   await agent.connect();                     // signed URL -> WS -> conversation_initiation_client_data -> metadata
//   agent.pushAudio(pcm24k);                    // page capture, 100 ms PCM16 mono 24 kHz -> {user_audio_chunk}
//   agent.sendContextualUpdate('[хост 10:03:10] Говорит: Тима.');   // background context, no reply
//   agent.sendUserMessage('[хост 10:00:00] Пора открывать стендап.'); // a user turn: the agent answers
//   agent.on('tool_call', ({tool_name, tool_call_id, parameters}) => agent.sendToolResult(tool_call_id, 'ok'));
//   await agent.close();
//
// Events: 'open' {conversation_id, reconnect}, 'audio' {pcm, event_id, t, alignment} (already 24 kHz;
// alignment = {chars, starts, durations} character timing of the chunk when the server sends it, else null), 'response' {text},
// 'correction' {original, corrected}, 'response_complete', 'transcript' {text}, 'tentative_transcript' {text},
// 'interruption' {event_id}, 'tool_call' {tool_name, tool_call_id, parameters, expects_response}, 'tool_response',
// 'vad' {score}, 'ping' {ping_ms}, 'client_error' {code, message}, 'server_event' (unhandled types),
// 'disconnected' {code, reason}, 'reconnected' {gap_ms, attempts, conversation_id}, 'failed' {error}, 'closed'.
// Never 'error' (an unhandled EventEmitter 'error' would throw).
//
// Interruption rule (as in the official SDKs): after `interruption` with event_id X every audio event with
// event_id <= X is dropped. A conversation cannot be resumed: an unexpected close starts a NEW conversation
// (fresh init from opts.init({reconnect: true}), then the `resume` text as a contextual update).
// Keys never reach logs or errors: only status codes and the API's own error messages are reported.

import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { ChunkStream } from './player.js';

export const ELEVEN_API = 'https://api.elevenlabs.io';
export const ELEVEN_WS = 'wss://api.elevenlabs.io/v1/convai/conversation';
export const SAMPLE_RATE = 24_000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;

const DEFAULTS = Object.freeze({
  connectTimeoutMs: 15_000,
  idleTimeoutMs: 60_000,
  reconnect: true,
  reconnectDelaysMs: [1000, 2000, 4000],
  maxReconnects: 3,
  maxBufferedBytes: 1024 * 1024,
  sampleRate: SAMPLE_RATE,
});

export class ElevenApiError extends Error {
  constructor(message, { status = null, body = null, path = null } = {}) {
    super(message);
    this.name = 'ElevenApiError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------------------------

/**
 * Minimal REST helper. `json()` throws ElevenApiError on non-2xx (message = the API's own detail).
 * @param {object} o  {apiKey, fetch?, baseUrl?, timeoutMs?}
 */
export function elevenRest({ apiKey, fetch = globalThis.fetch, baseUrl = ELEVEN_API, timeoutMs = 20_000 } = {}) {
  if (!apiKey) throw new Error('elevenRest: apiKey is required');
  async function call(method, path, { body, query, timeoutMs: t = timeoutMs } = {}) {
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), t);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: { 'xi-api-key': apiKey, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = text;
      }
      return { ok: res.ok, status: res.status, body: data };
    } finally {
      clearTimeout(timer);
    }
  }
  async function json(method, path, opts) {
    const r = await call(method, path, opts);
    if (!r.ok) throw new ElevenApiError(`${method} ${path} -> HTTP ${r.status}: ${describeError(r.body)}`, { status: r.status, body: r.body, path });
    return r.body;
  }
  return {
    call,
    json,
    get: (path, opts) => json('GET', path, opts),
    post: (path, body, opts) => json('POST', path, { ...opts, body }),
    patch: (path, body, opts) => json('PATCH', path, { ...opts, body }),
    del: (path, opts) => json('DELETE', path, opts),
    /** Signed WebSocket URL for a private agent. */
    signedUrl: async (agentId) => {
      const r = await json('GET', '/v1/convai/conversation/get-signed-url', { query: { agent_id: agentId } });
      if (!r?.signed_url) throw new ElevenApiError('get-signed-url: no signed_url in the response', { body: r });
      return r.signed_url;
    },
    subscription: () => json('GET', '/v1/user/subscription'),
    conversation: (id) => json('GET', `/v1/convai/conversations/${encodeURIComponent(id)}`),
  };
}

/** Human-readable API error body (never the request). */
export function describeError(body) {
  if (body == null) return 'no body';
  if (typeof body === 'string') return body.slice(0, 300);
  const d = body.detail ?? body.error ?? body.message ?? body;
  if (typeof d === 'string') return d.slice(0, 300);
  if (d && typeof d === 'object') {
    if (typeof d.message === 'string') return `${d.status ? `${d.status}: ` : ''}${d.message}`.slice(0, 300);
    return JSON.stringify(d).slice(0, 300);
  }
  return String(d).slice(0, 300);
}

/** Credits and balance of the account from GET /v1/user/subscription (numbers only). */
export function balanceOf(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const used = Number(sub.character_count ?? 0);
  const limit = Number(sub.character_limit ?? 0);
  return { tier: sub.tier ?? null, used, limit, remaining: Math.max(0, limit - used), next_reset_unix: sub.next_character_count_reset_unix ?? null };
}

/**
 * Cost of a finished conversation: GET /v1/convai/conversations/{id}, retried while it is still processing.
 * @returns {Promise<{status, cost, call_duration_secs, llm_charge, call_charge, llm_price, tries}|null>}
 */
export async function fetchConversationCost(rest, conversationId, { tries = 3, delayMs = 3000 } = {}) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    try {
      const c = await rest.conversation(conversationId);
      const m = c?.metadata ?? {};
      last = {
        status: c?.status ?? null,
        cost: m.cost ?? null,
        call_duration_secs: m.call_duration_secs ?? null,
        llm_charge: m.charging?.llm_charge ?? null,
        call_charge: m.charging?.call_charge ?? null,
        llm_price: m.charging?.llm_price ?? null,
        free_minutes_consumed: m.charging?.free_minutes_consumed ?? null,
        transcript_lines: Array.isArray(c?.transcript) ? c.transcript.length : null,
        tries: i,
      };
      if (last.cost !== null || c?.status === 'done' || c?.status === 'failed') return last;
    } catch (e) {
      last = { status: 'error', error: e?.message ?? String(e), tries: i, cost: null };
      if (e?.status === 404 && i < tries) {
        // not indexed yet
      } else if (e?.status && e.status !== 404) return last;
    }
    if (i < tries) await sleep(delayMs);
  }
  return last;
}

// ---------------------------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------------------------

/** 'pcm_24000' -> 24000; throws for non-PCM formats. */
export function pcmRate(format) {
  const m = /^pcm_(\d+)$/.exec(String(format ?? ''));
  if (!m) throw new Error(`unsupported audio format "${format}" (expected pcm_<rate>)`);
  return Number(m[1]);
}

/** Linear-interpolation resampler for PCM16 LE mono (only used when the agent formats differ from 24 kHz). */
export function resamplePcm16(buf, from, to) {
  if (from === to) return buf;
  const inSamples = buf.length >> 1;
  const outSamples = Math.round((inSamples * to) / from);
  const out = Buffer.alloc(outSamples * 2);
  const ratio = from / to;
  for (let i = 0; i < outSamples; i++) {
    const pos = i * ratio;
    const i0 = Math.min(inSamples - 1, Math.floor(pos));
    const i1 = Math.min(inSamples - 1, i0 + 1);
    const frac = pos - i0;
    const s0 = buf.readInt16LE(i0 * 2);
    const s1 = buf.readInt16LE(i1 * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * frac))), i * 2);
  }
  return out;
}

function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (typeof chunk === 'string') return Buffer.from(chunk, 'base64');
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  throw new TypeError(`bad audio chunk: ${typeof chunk}`);
}

// ---------------------------------------------------------------------------------------------
// Agent session
// ---------------------------------------------------------------------------------------------

export class ElevenAgent extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} [o.apiKey]        needed unless `rest` or `wsUrl` is given
   * @param {string} o.agentId
   * @param {object} [o.rest]          elevenRest() handle (tests pass a fake)
   * @param {{event: Function}} [o.log]
   * @param {Function} [o.WebSocket]   WebSocket class (tests)
   * @param {() => number} [o.now]
   * @param {(info: {reconnect: boolean}) => object|Promise<object>} [o.init]
   *        returns {override, dynamicVariables, resume, extra}: override -> conversation_config_override,
   *        dynamicVariables -> dynamic_variables, resume -> contextual update sent right after a reconnect
   * @param {string} [o.wsUrl]         direct WebSocket URL (tests / public agents); skips the signed URL
   * Timing: connectTimeoutMs, idleTimeoutMs, reconnect, reconnectDelaysMs, maxReconnects, maxBufferedBytes, sampleRate.
   */
  constructor({ apiKey, agentId, rest, log, WebSocket: WS = WebSocket, now = Date.now, init = null, wsUrl = null, ...timing } = {}) {
    super();
    this.setMaxListeners(40);
    if (!agentId && !wsUrl) throw new Error('ElevenAgent: agentId is required');
    this.opts = { ...DEFAULTS, ...timing };
    this.agentId = agentId ?? null;
    this.rest = rest ?? (apiKey ? elevenRest({ apiKey }) : null);
    if (!this.rest && !wsUrl) throw new Error('ElevenAgent: apiKey (or rest) is required for a signed URL');
    this._WS = WS;
    this._now = now;
    this._logger = log;
    this._init = init;
    this._wsUrl = wsUrl;
    this.state = 'idle'; // idle | connecting | open | reconnecting | closed
    this.conversationId = null;
    this.formats = { in: null, out: null };
    this._inRate = this.opts.sampleRate;
    this._outRate = this.opts.sampleRate;
    this._conn = null;
    this._closing = false;
    this._connecting = null;
    this._lastInterrupt = -1;
    this._sessions = []; // {conversation_id, t_open, t_close}
    this._stats = {
      connects: 0,
      reconnects: 0,
      disconnects: 0,
      audio_in_ms: 0,
      audio_out_ms: 0,
      dropped_chunks: 0,
      responses: 0,
      transcripts: 0,
      tool_calls: 0,
      interruptions: 0,
      pings: 0,
      context_updates: 0,
      user_messages: 0,
      server_errors: 0,
      last_ping_ms: null,
      context_tokens: null,
    };
  }

  get connected() {
    return this.state === 'open' && this._conn?.ready === true;
  }

  /** Open the conversation. Resolves after conversation_initiation_metadata. Rejects on a fatal failure. */
  connect() {
    if (this.state === 'open') return Promise.resolve(this._info());
    if (this._connecting) return this._connecting;
    this._closing = false;
    this.state = 'connecting';
    const t0 = this._now();
    this._connecting = this._openOnce({ reconnect: false })
      .then((conn) => {
        this._stats.connects++;
        this._log('eleven.connect', { conversation_id: this.conversationId, connect_ms: this._now() - t0, formats: this.formats, reconnect: false });
        this.emit('open', { conversation_id: this.conversationId, reconnect: false, formats: this.formats });
        return { ...this._info(), connect_ms: this._now() - t0 };
      })
      .catch((err) => {
        this.state = 'closed';
        this._log('eleven.error', { phase: 'connect', message: err?.message ?? String(err), status: err?.status ?? null });
        throw err;
      })
      .finally(() => {
        this._connecting = null;
      });
    return this._connecting;
  }

  /** Stream page audio (PCM16 mono 24 kHz: Buffer | Int16Array | ArrayBuffer | base64). False when not connected / dropped. */
  pushAudio(chunk) {
    if (!this.connected) {
      this._stats.dropped_chunks++;
      return false;
    }
    let buf = toBuffer(chunk);
    if (!buf.length) return false;
    if (this._inRate !== this.opts.sampleRate) buf = resamplePcm16(buf, this.opts.sampleRate, this._inRate);
    const ws = this._conn.ws;
    if (ws.bufferedAmount > this.opts.maxBufferedBytes) {
      this._stats.dropped_chunks++;
      return false;
    }
    if (!this._send({ user_audio_chunk: buf.toString('base64') })) return false;
    this._stats.audio_in_ms += toBuffer(chunk).length / BYTES_PER_MS;
    return true;
  }

  /** Background information for the agent (no reply is triggered). */
  sendContextualUpdate(text) {
    const ok = this._send({ type: 'contextual_update', text: String(text) });
    if (ok) this._stats.context_updates++;
    return ok;
  }

  /** A text turn from "the user": the agent answers (or skips the turn). */
  sendUserMessage(text) {
    const ok = this._send({ type: 'user_message', text: String(text) });
    if (ok) this._stats.user_messages++;
    return ok;
  }

  sendUserActivity() {
    return this._send({ type: 'user_activity' });
  }

  /** Answer a client_tool_call. `result` is sent as a string (objects are JSON-encoded). */
  sendToolResult(toolCallId, result, { isError = false } = {}) {
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? null);
    return this._send({ type: 'client_tool_result', tool_call_id: toolCallId, result: text, is_error: Boolean(isError) });
  }

  /** Close for good (no reconnect). */
  async close({ code = 1000, reason = 'client close' } = {}) {
    const prev = this.state;
    this._closing = true;
    this.state = 'closed';
    const conn = this._conn;
    this._conn = null;
    if (conn) {
      this._stopWatchdog(conn);
      this._endSession();
      await closeSocket(conn.ws, code, reason);
    }
    if (prev !== 'closed' && prev !== 'idle') {
      this._log('eleven.close', { reason, ...this.stats() });
      this.emit('closed', { reason });
    }
  }

  /** Total time connected (all conversations), including the current one. */
  connectedMs() {
    const now = this._now();
    return this._sessions.reduce((sum, s) => sum + ((s.t_close ?? now) - s.t_open), 0);
  }

  stats() {
    return {
      state: this.state,
      conversation_id: this.conversationId,
      conversation_ids: this._sessions.map((s) => s.conversation_id),
      sessions: this._sessions.length,
      connected_ms: Math.round(this.connectedMs()),
      formats: { ...this.formats },
      ...this._stats,
      audio_in_ms: Math.round(this._stats.audio_in_ms),
      audio_out_ms: Math.round(this._stats.audio_out_ms),
    };
  }

  /** Test hook: drop the socket as if the network failed. */
  simulateDrop() {
    this._conn?.ws?.terminate();
  }

  // ---- internals -----------------------------------------------------------------------------

  _info() {
    return { conversation_id: this.conversationId, formats: { ...this.formats }, state: this.state };
  }

  async _openOnce({ reconnect }) {
    const url = this._wsUrl ?? (await this.rest.signedUrl(this.agentId));
    const init = this._init ? await this._init({ reconnect }) : {};
    const payload = { type: 'conversation_initiation_client_data' };
    if (init?.override) payload.conversation_config_override = init.override;
    if (init?.dynamicVariables) payload.dynamic_variables = init.dynamicVariables;
    if (init?.extra && typeof init.extra === 'object') Object.assign(payload, init.extra);
    const conn = await new Promise((resolve, reject) => {
      const c = { ws: null, ready: false, lastRx: this._now(), watchdog: null, finish: null };
      let settled = false;
      const timer = setTimeout(() => c.finish(Object.assign(new Error(`ElevenLabs handshake timeout after ${this.opts.connectTimeoutMs} ms`), { code: 'timeout' })), this.opts.connectTimeoutMs);
      c.finish = (err, meta) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          try {
            c.ws?.terminate();
          } catch {
            // already gone
          }
          reject(err);
        } else resolve({ conn: c, meta });
      };
      let ws;
      try {
        ws = new this._WS(url, { perMessageDeflate: false, handshakeTimeout: this.opts.connectTimeoutMs });
      } catch (err) {
        c.finish(err);
        return;
      }
      c.ws = ws;
      ws.on('open', () => {
        c.lastRx = this._now();
        try {
          ws.send(JSON.stringify(payload));
        } catch (err) {
          c.finish(err);
        }
      });
      ws.on('message', (data) => this._onMessage(c, data));
      ws.on('error', (err) => {
        if (!c.ready) c.finish(upgradeError(err));
        else this._log('eleven.error', { phase: 'socket', message: err?.message });
      });
      ws.on('close', (code, reason) => {
        if (!c.ready) c.finish(Object.assign(new Error(`socket closed during handshake (${code}${reason ? `: ${reason}` : ''})`), { code: 'closed', ws_code: code }));
        else this._onClose(c, code, reason?.toString() ?? '');
      });
    }).then(({ conn: c, meta }) => {
      this._activate(c, meta);
      return c;
    });
    if (init?.resume && reconnect) this.sendContextualUpdate(init.resume);
    return conn;
  }

  _activate(conn, meta) {
    this._conn = conn;
    this.state = 'open';
    this._lastInterrupt = -1;
    this.conversationId = meta?.conversation_id ?? null;
    this.formats = { in: meta?.user_input_audio_format ?? null, out: meta?.agent_output_audio_format ?? null };
    this._inRate = safeRate(this.formats.in, this.opts.sampleRate);
    this._outRate = safeRate(this.formats.out, this.opts.sampleRate);
    this._sessions.push({ conversation_id: this.conversationId, t_open: this._now(), t_close: null });
    this._startWatchdog(conn);
  }

  _endSession() {
    const s = this._sessions.at(-1);
    if (s && s.t_close === null) s.t_close = this._now();
  }

  _onMessage(conn, data) {
    if (conn !== this._conn && conn.ready) return; // stale socket
    conn.lastRx = this._now();
    let ev;
    try {
      ev = JSON.parse(data.toString());
    } catch {
      this._log('eleven.error', { phase: 'parse', message: 'non-JSON message from server' });
      return;
    }
    if (!ev || typeof ev.type !== 'string') return;
    const t = this._now();
    if (!conn.ready) {
      if (ev.type === 'conversation_initiation_metadata') {
        conn.ready = true;
        conn.finish(null, ev.conversation_initiation_metadata_event ?? {});
        return;
      }
      if (ev.type === 'client_error' || ev.type === 'error') {
        const e = ev.error_event ?? ev.error ?? ev;
        conn.finish(Object.assign(new Error(`ElevenLabs refused the conversation: ${e.code ?? ''} ${e.message ?? JSON.stringify(e).slice(0, 200)}`.trim()), { code: 'refused', detail: e }));
        return;
      }
      if (ev.type === 'ping') this._pong(ev);
      return;
    }
    switch (ev.type) {
      case 'audio': {
        const a = ev.audio_event ?? {};
        const id = Number.isFinite(a.event_id) ? a.event_id : null;
        if (id !== null && id <= this._lastInterrupt) return;
        if (!a.audio_base_64) return;
        let pcm = Buffer.from(a.audio_base_64, 'base64');
        if (this._outRate !== this.opts.sampleRate) pcm = resamplePcm16(pcm, this._outRate, this.opts.sampleRate);
        this._stats.audio_out_ms += pcm.length / BYTES_PER_MS;
        const alignment = parseAlignment(a.alignment);
        if (alignment) this._stats.aligned_chunks = (this._stats.aligned_chunks ?? 0) + 1;
        this.emit('audio', { pcm, event_id: id, t, alignment });
        return;
      }
      case 'agent_response': {
        const r = ev.agent_response_event ?? {};
        this._stats.responses++;
        this.emit('response', { text: r.agent_response ?? '', event_id: r.event_id ?? null, response_id: r.response_id ?? null, t });
        return;
      }
      case 'agent_response_correction': {
        const r = ev.agent_response_correction_event ?? {};
        this.emit('correction', { original: r.original_agent_response ?? '', corrected: r.corrected_agent_response ?? '', event_id: r.event_id ?? null, t });
        return;
      }
      case 'agent_response_complete': {
        this.emit('response_complete', { event_id: ev.agent_response_complete_event?.event_id ?? null, t });
        return;
      }
      case 'user_transcript': {
        const u = ev.user_transcription_event ?? {};
        this._stats.transcripts++;
        this.emit('transcript', { text: u.user_transcript ?? '', event_id: u.event_id ?? null, t });
        return;
      }
      case 'tentative_user_transcript': {
        const u = ev.tentative_user_transcription_event ?? ev.user_transcription_event ?? {};
        this.emit('tentative_transcript', { text: u.user_transcript ?? u.tentative_user_transcript ?? '', t });
        return;
      }
      case 'interruption': {
        const id = ev.interruption_event?.event_id;
        if (Number.isFinite(id)) this._lastInterrupt = Math.max(this._lastInterrupt, id);
        this._stats.interruptions++;
        this.emit('interruption', { event_id: id ?? null, t });
        return;
      }
      case 'ping':
        this._pong(ev);
        return;
      case 'client_tool_call': {
        const c = ev.client_tool_call ?? {};
        this._stats.tool_calls++;
        this.emit('tool_call', { tool_name: c.tool_name, tool_call_id: c.tool_call_id, parameters: c.parameters ?? {}, expects_response: c.expects_response !== false, event_id: c.event_id ?? null, t });
        return;
      }
      case 'agent_tool_response':
        this.emit('tool_response', { ...(ev.agent_tool_response ?? {}), t });
        return;
      case 'vad_score':
        this.emit('vad', { score: ev.vad_score_event?.vad_score ?? null, t });
        return;
      case 'context_usage': {
        const c = ev.context_usage_event ?? {};
        this._stats.context_tokens = c.context_tokens ?? this._stats.context_tokens ?? null;
        this.emit('context_usage', { model: c.model ?? null, context_tokens: c.context_tokens ?? null, context_limit_tokens: c.context_limit_tokens ?? null, event_id: c.event_id ?? null, t });
        return;
      }
      case 'client_error': {
        const e = ev.error_event ?? {};
        this._stats.server_errors++;
        this._log('eleven.error', { phase: 'server', code: e.code ?? null, name: e.error_name ?? null, message: e.message ?? null });
        this.emit('client_error', { code: e.code ?? null, name: e.error_name ?? null, message: e.message ?? null, t });
        return;
      }
      case 'conversation_initiation_metadata':
        return;
      default:
        this.emit('server_event', ev);
    }
  }

  _pong(ev) {
    const p = ev.ping_event ?? {};
    this._stats.pings++;
    if (Number.isFinite(p.ping_ms)) this._stats.last_ping_ms = p.ping_ms;
    this._send({ type: 'pong', event_id: p.event_id });
    this.emit('ping', { event_id: p.event_id ?? null, ping_ms: p.ping_ms ?? null });
  }

  _onClose(conn, code, reason) {
    if (conn !== this._conn) return;
    this._stopWatchdog(conn);
    this._conn = null;
    this._endSession();
    if (this._closing) return;
    this._stats.disconnects++;
    const t = this._now();
    this._log('eleven.disconnect', { conversation_id: this.conversationId, code, reason });
    this.emit('disconnected', { code, reason, t, conversation_id: this.conversationId });
    if (!this.opts.reconnect || this._stats.reconnects >= this.opts.maxReconnects || code === 1000) {
      // 1000 = the server ended the conversation on purpose (end_call, max duration): not a failure
      this.state = 'closed';
      if (code === 1000) this.emit('closed', { reason: reason || 'server' });
      else this.emit('failed', { error: Object.assign(new Error(`socket closed (${code}${reason ? `: ${reason}` : ''})`), { code }), attempts: this._stats.reconnects });
      return;
    }
    this.state = 'reconnecting';
    void this._reconnect(t);
  }

  async _reconnect(since) {
    const delays = this.opts.reconnectDelaysMs;
    let attempt = 0;
    let lastError = null;
    while (!this._closing && this._stats.reconnects < this.opts.maxReconnects) {
      const delay = delays[Math.min(attempt, delays.length - 1)];
      await sleep(delay);
      if (this._closing) return;
      attempt++;
      this._stats.reconnects++;
      try {
        await this._openOnce({ reconnect: true });
        const gap = this._now() - since;
        this._log('eleven.reconnect', { conversation_id: this.conversationId, gap_ms: gap, attempts: attempt });
        this.emit('reconnected', { gap_ms: gap, attempts: attempt, conversation_id: this.conversationId });
        this.emit('open', { conversation_id: this.conversationId, reconnect: true, formats: this.formats });
        return;
      } catch (err) {
        lastError = err;
        this._log('eleven.error', { phase: 'reconnect', attempt, message: err?.message ?? String(err) });
      }
    }
    if (this._closing) return;
    this.state = 'closed';
    this.emit('failed', { error: lastError ?? new Error('reconnect failed'), attempts: attempt });
  }

  _startWatchdog(conn) {
    conn.watchdog = setInterval(() => {
      if (conn !== this._conn) {
        clearInterval(conn.watchdog);
        return;
      }
      const idle = this._now() - conn.lastRx;
      if (idle > this.opts.idleTimeoutMs) {
        this._log('eleven.error', { phase: 'watchdog', message: `no server message for ${Math.round(idle)} ms`, idle_ms: Math.round(idle) });
        clearInterval(conn.watchdog);
        try {
          conn.ws.terminate(); // -> 'close' -> reconnect
        } catch {
          // ignore
        }
      }
    }, 5000);
    conn.watchdog.unref?.();
  }

  _stopWatchdog(conn) {
    if (conn?.watchdog) clearInterval(conn.watchdog);
    if (conn) conn.watchdog = null;
  }

  _send(obj) {
    if (!this.connected) return false;
    try {
      this._conn.ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      this._log('eleven.error', { phase: 'send', message: err?.message, type: obj?.type ?? 'audio' });
      return false;
    }
  }

  _log(type, fields) {
    try {
      this._logger?.event?.(type, fields);
    } catch {
      // logging must never break the session
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Playback bridge
// ---------------------------------------------------------------------------------------------

/**
 * Route the agent's audio into the page player: one Player playback per response (a ChunkStream
 * that ends on agent_response_complete or after idleEndMs without audio), `interruption` -> abort +
 * page flush, consecutive responses queue. Returns {isSpeaking, waitIdle, stop, current, seal, unseal,
 * eventInfo, stats}.
 *
 * Seal (the farewell, live test 19.09: «…Передаю слово на дев-синк.» + leave_meeting + «нельзя передавать
 * слова после завершения стендапа» in the same response): seal({eventId, chars, maxMs}) lets only the
 * first `chars` characters of response `eventId` reach the room, cut by the server's character alignment;
 * without alignment only its first `maxMs` of audio when given. Audio of that response past the point is
 * dropped (audio already sent to the page is stopped when playback reaches it). Later responses are not
 * touched: when she answers someone after her goodbye, the room must hear it (live test #3: a sealed
 * later answer made her leave in silence).
 * @param {ElevenAgent} agent
 * @param {{play: Function, stop: Function, isSpeaking: Function}} player  src/audio/player.js Player
 * @param {object} [o]  {log, now, idleEndMs, onStart(u)}: onStart fires when the first chunk of an utterance arrives
 */
export function attachPlayer(agent, player, { log, now = Date.now, idleEndMs = 1500, onStart = null, gate = null } = {}) {
  let utt = null;
  let seq = 0;
  let seal = null; // {eventId, chars, maxMs, closed}
  let cutTimer = null;
  const events = new Map(); // event_id -> {chars, ms, aligned, starts: event-relative char start ms, u, offsetMs}
  const stats = { utterances: 0, completed: 0, aborted: 0, audio_ms: 0, aligned_chunks: 0, sealed_drop_ms: 0 };
  const emit = (type, fields) => {
    try {
      log?.event?.(type, fields);
    } catch {
      // never
    }
  };
  // the page started playing an utterance (real Player: state 'speaking' with the playback id)
  player.on?.('state', (e) => {
    if (e?.state !== 'speaking') return;
    for (const rec of events.values()) if (rec.u?.handle?.id === e.id && rec.u.tPlay == null) rec.u.tPlay = now();
  });
  function start(eventId) {
    if (gate?.()) {
      emit('agent.speech.suppressed', { event_id: eventId ?? null }); // «Кора, стоп»: she listens but the room must not hear her
      return null;
    }
    const stream = new ChunkStream();
    const u = { id: ++seq, stream, bytes: 0, t0: now(), tPlay: null, idleTimer: null, eventId };
    stats.utterances++;
    emit('agent.speech.start', { utt: u.id, event_id: eventId ?? null });
    let handle;
    try {
      handle = player.play(stream, { meta: { source: 'agent', kind: 'agent', utt: u.id }, source: 'agent', queue: true });
    } catch (e) {
      emit('agent.speech.error', { utt: u.id, message: e?.message ?? String(e) });
      return null;
    }
    u.handle = handle;
    Promise.resolve(handle.done)
      .then((r) => {
        const done = r?.status === 'completed';
        stats[done ? 'completed' : 'aborted']++;
        emit(done ? 'agent.speech.end' : 'agent.speech.abort', { utt: u.id, status: r?.status ?? null, played_ms: r?.played_ms ?? null, total_ms: r?.total_ms ?? Math.round(u.bytes / BYTES_PER_MS), played_ratio: r?.played_ratio ?? null, reason: r?.reason ?? null, duration_ms: now() - u.t0 });
      })
      .catch((e) => emit('agent.speech.error', { utt: u.id, message: e?.message ?? String(e) }));
    utt = u;
    if (onStart) {
      try {
        onStart({ id: u.id, t: u.t0, event_id: eventId ?? null });
      } catch (e) {
        emit('agent.speech.error', { where: 'onStart', message: e?.message ?? String(e) });
      }
    }
    return u;
  }
  function armIdle(u) {
    clearTimeout(u.idleTimer);
    u.idleTimer = setTimeout(() => {
      if (utt === u) end('idle');
    }, idleEndMs);
    u.idleTimer.unref?.();
  }
  function end(reason) {
    const u = utt;
    if (!u) return;
    utt = null;
    clearTimeout(u.idleTimer);
    u.stream.end();
    emit('agent.speech.eos', { utt: u.id, reason, ms: Math.round(u.bytes / BYTES_PER_MS) });
  }
  function abort(reason) {
    const u = utt;
    utt = null;
    if (u) {
      clearTimeout(u.idleTimer);
      u.stream.end();
    }
    let p = null;
    try {
      p = player.stop(reason);
    } catch (e) {
      emit('agent.speech.error', { where: 'stop', message: e?.message ?? String(e) });
    }
    if (p && typeof p.catch === 'function') p.catch(() => {});
    return p;
  }
  /** Per-response bookkeeping: characters (alignment) and audio ms before this chunk. */
  function account(eventId, pcm, alignment) {
    const key = eventId ?? 'none';
    let rec = events.get(key);
    if (!rec) {
      rec = { chars: 0, ms: 0, aligned: false, starts: [], u: null, offsetMs: 0 };
      events.set(key, rec);
      if (events.size > 64) events.delete(events.keys().next().value);
    }
    const before = { chars: rec.chars, ms: rec.ms };
    const chunkMs = pcm.length / BYTES_PER_MS;
    if (alignment) {
      stats.aligned_chunks++;
      rec.aligned = true;
      const cumulative = isCumulative(alignment, before.ms, chunkMs);
      if (stats.aligned_chunks <= 3) emit('agent.alignment_sample', { event_id: eventId, before_ms: Math.round(before.ms), chunk_ms: Math.round(chunkMs), cumulative, chars: alignment.chars.slice(0, 12).join(''), starts: alignment.starts?.slice(0, 12) ?? null });
      for (let i = 0; i < alignment.chars.length; i++) {
        const s = alignment.starts?.[i];
        if (rec.starts.length < 4000) rec.starts.push(Number.isFinite(s) ? (cumulative ? s : before.ms + s) : null);
      }
      rec.chars += alignment.chars.length;
    }
    rec.ms += chunkMs;
    return { rec, before, chunkMs };
  }

  /** The part of a chunk the room may hear under the seal: the chunk, a head of it, or null. */
  function sealed(pcm, eventId, before, chunkMs, rec) {
    const s = seal;
    if (!s || eventId !== s.eventId) return pcm; // only the farewell response itself is limited
    if (s.closed) return null;
    if (rec.aligned && Number.isFinite(s.chars)) {
      if (before.chars >= s.chars) return closeSeal(null);
      if (rec.chars <= s.chars) return pcm;
      const at = rec.starts[s.chars]; // event-relative start of the first character past the farewell
      if (!Number.isFinite(at)) return pcm;
      return closeSeal(pcm.subarray(0, evenBytes((Math.min(chunkMs, Math.max(0, at - before.ms))) * BYTES_PER_MS)));
    }
    if (Number.isFinite(s.maxMs)) {
      if (before.ms >= s.maxMs) return closeSeal(null);
      if (before.ms + chunkMs <= s.maxMs) return pcm;
      return closeSeal(pcm.subarray(0, evenBytes((s.maxMs - before.ms) * BYTES_PER_MS)));
    }
    return pcm;
  }
  function closeSeal(keep) {
    seal.closed = true;
    emit('agent.speech.sealed', { event_id: seal.eventId, chars: seal.chars, max_ms: seal.maxMs, kept_ms: keep ? Math.round(keep.length / BYTES_PER_MS) : 0 });
    return keep?.length ? keep : null;
  }

  /** Audio of the sealed response already sent to the page past `ms`: stop the page when playback gets there. */
  function cutSent(rec, ms, reason) {
    const u = rec.u;
    if (!u || !(rec.ms > ms)) return;
    const base = (u.tPlay ?? u.t0) + rec.offsetMs;
    const delay = Math.max(0, base + ms - now());
    clearTimeout(cutTimer);
    cutTimer = setTimeout(() => {
      cutTimer = null;
      emit('agent.speech.cut', { utt: u.id, event_id: seal?.eventId ?? null, at_ms: Math.round(ms), reason });
      abort(reason);
    }, delay);
    cutTimer.unref?.();
  }

  agent.on('audio', ({ pcm, event_id, alignment = null }) => {
    const { rec, before, chunkMs } = account(event_id, pcm, alignment);
    const out = sealed(pcm, event_id, before, chunkMs, rec);
    if (!out) {
      stats.sealed_drop_ms += chunkMs;
      return;
    }
    if (out.length < pcm.length) stats.sealed_drop_ms += (pcm.length - out.length) / BYTES_PER_MS;
    const u = utt ?? start(event_id);
    if (!u) return;
    if (!rec.u) {
      rec.u = u;
      rec.offsetMs = u.bytes / BYTES_PER_MS;
    }
    u.stream.push(out);
    u.bytes += out.length;
    stats.audio_ms += out.length / BYTES_PER_MS;
    armIdle(u);
  });
  agent.on('response_complete', () => end('complete'));
  agent.on('interruption', () => {
    clearTimeout(cutTimer);
    cutTimer = null;
    abort('interruption');
  });
  agent.on('disconnected', () => end('disconnected'));
  agent.on('closed', () => end('closed'));
  return {
    isSpeaking: () => Boolean(utt) || player.isSpeaking(),
    /** Wait until nothing is queued or playing (max ms). True when idle. */
    async waitIdle(maxMs = 8000) {
      const t0 = Date.now();
      while ((utt || player.isSpeaking()) && Date.now() - t0 < maxMs) await sleep(50);
      return !(utt || player.isSpeaking());
    },
    stop: (reason = 'stop') => abort(reason),
    current: () => (utt ? { id: utt.id, ms: Math.round(utt.bytes / BYTES_PER_MS), event_id: utt.eventId ?? null, t0: utt.t0 } : null),
    /**
     * Only the first `chars` characters (alignment) or `maxMs` of response `eventId` may be heard.
     * Calling it again for the same response tightens it (e.g. adds maxMs); other responses pass.
     */
    seal({ eventId = null, chars = null, maxMs = null } = {}) {
      seal = { eventId, chars: Number.isFinite(chars) ? chars : null, maxMs: Number.isFinite(maxMs) ? maxMs : null, closed: false };
      const rec = events.get(eventId ?? 'none');
      const info = { event_id: eventId, chars: seal.chars, max_ms: seal.maxMs, aligned: rec?.aligned ?? null, received_ms: rec ? Math.round(rec.ms) : 0, received_chars: rec?.chars ?? 0 };
      emit('agent.speech.seal', info);
      if (!rec) return info;
      if (rec.aligned && seal.chars !== null && rec.chars > seal.chars && Number.isFinite(rec.starts[seal.chars])) {
        seal.closed = true;
        cutSent(rec, rec.starts[seal.chars], 'farewell_tail');
      } else if (!rec.aligned && seal.maxMs !== null && rec.ms > seal.maxMs) {
        seal.closed = true;
        cutSent(rec, seal.maxMs, 'farewell_tail');
      }
      return info;
    },
    unseal() {
      clearTimeout(cutTimer);
      cutTimer = null;
      if (!seal) return;
      emit('agent.speech.unseal', { event_id: seal.eventId });
      seal = null;
    },
    /** {chars, ms, aligned} of one response (for the host's speech-rate estimate), or null. */
    eventInfo: (eventId) => {
      const rec = events.get(eventId ?? 'none');
      return rec ? { chars: rec.chars, ms: Math.round(rec.ms), aligned: rec.aligned } : null;
    },
    stats: () => ({ ...stats, audio_ms: Math.round(stats.audio_ms), sealed_drop_ms: Math.round(stats.sealed_drop_ms) }),
  };
}

/**
 * Are the alignment start times counted from the response start rather than from this chunk? Per-chunk
 * times all fall inside the chunk; cumulative ones start where the previous chunks ended.
 */
function isCumulative(alignment, beforeMs, chunkMs) {
  const s = alignment.starts;
  if (!s?.length || beforeMs <= 0) return false;
  return s[0] >= beforeMs - 30 && s[s.length - 1] >= chunkMs;
}

function evenBytes(n) {
  return Math.max(0, Math.floor(n)) & ~1;
}

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** audio_event.alignment -> {chars, starts, durations} (ms, relative to the chunk) or null. */
export function parseAlignment(al) {
  if (!al || !Array.isArray(al.chars) || !al.chars.length) return null;
  const nums = (a) => (Array.isArray(a) && a.length === al.chars.length && a.every((v) => Number.isFinite(v)) ? a : null);
  return { chars: al.chars.map((c) => String(c ?? '')), starts: nums(al.char_start_times_ms), durations: nums(al.char_durations_ms) };
}

function safeRate(format, fallback) {
  try {
    return format ? pcmRate(format) : fallback;
  } catch {
    return fallback;
  }
}

function upgradeError(err) {
  const m = /Unexpected server response: (\d{3})/.exec(err?.message ?? '');
  if (!m) return err;
  const status = Number(m[1]);
  return Object.assign(new Error(`HTTP ${status} from the ElevenLabs conversation endpoint`), { status, code: `http_${status}` });
}

function closeSocket(ws, code, reason) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      resolve();
    }, 1000);
    ws.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close(code, reason);
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}
