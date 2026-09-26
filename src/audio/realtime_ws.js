// OpenAI Realtime (GA) session shared by ears.js (VAD + STT) and mouth.js (verbatim readouts).
// See PLAN.md §2 (architecture), §4 (voice), §6 (session limits).
//
// Wire: wss://api.openai.com/v1/realtime?model=<model>, header "Authorization: Bearer <key>"
// (no OpenAI-Beta header), JSON events, audio = base64 PCM16 mono 24 kHz in both directions.
//
// Guarantees
// - connect() resolves only after the server echoed OUR session.update (session.updated) with
//   turn_detection.create_response=false and interrupt_response=false. Until then nothing but
//   session.update is written: the server default is server_vad + create_response=true, so audio
//   appended before our config lands could make the model answer on its own.
// - Handshake errors that name an optional field (OPTIONAL_SESSION_FIELDS: transcription.keywords,
//   transcription.prompt, noise_reduction, reasoning, ...) drop that field and re-send the update;
//   the drop sticks for later reconnects. Any other handshake error is fatal (no silent voice or
//   model change). Checked 18.09.2026: unknown fields -> error.code "unknown_parameter" with
//   error.param "session.<path>"; `transcription.keywords` is accepted but not echoed back.
// - Unexpected close or heartbeat timeout (WS ping/pong) -> reconnect with backoff 0.5/1/2/4/4 s
//   (5 tries), session.update re-sent, then 'reconnected' {gap_ms}. While (re)connecting send()
//   queues: audio older than maxAudioAgeMs (2 s) is dropped at flush, events bound to the old
//   session (response.cancel, conversation.item.*) are dropped at once, the rest is flushed in order.
// - Every client event gets an event_id; server "error" events echo it (error.event_id), so
//   callers correlate failures with their own requests.
//
// Events (EventEmitter; the server's "error" type is re-emitted as 'server_error', never 'error')
//   'open'          {epoch, session_id, connect_ms, attempts, dropped_fields}  first connect
//   'ready'         {epoch, session_id, reconnect}         after every successful handshake
//   'disconnected'  {epoch, code, reason, t}                socket lost, reconnect starts
//   'reconnected'   {epoch, gap_ms, attempts, dropped}      session usable again
//   'failed'        {error, attempts}                       gave up; state 'closed'
//   'closed'        {}                                      after close()
//   'event'         (serverEvent, ctx)                      every server event
//   '<type>'        (serverEvent, ctx)                      e.g. 'response.output_audio.delta'
//   'server_error'  (error, ctx)                            error = serverEvent.error
//   ctx = {t, epoch, req, response_id}; req = our response.metadata.req (null if unknown).
//
// Log records (injected logger: log.event(type, fields)): rt.connect, rt.reconnect, rt.disconnect,
// rt.error, rt.usage (one per response.done), rt.dropped, rt.close (with usage totals).

import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { CONFIG_DIR, contentPath, deepMerge } from '../config.js';

export const REALTIME_URL = 'wss://api.openai.com/v1/realtime';
export const SAMPLE_RATE = 24_000;
/** PCM16 mono 24 kHz: 48 bytes per millisecond. */
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000;
export const PEOPLE_PATH = contentPath('people.json');

/** Default persona line (override: settings.realtime.persona_line). */
export const DEFAULT_PERSONA_LINE = 'Ты Кора, ведущая стендапов команды. О себе только в женском роде.';
/** Contract with mouth.js: readouts arrive as {"response_text":…,"require_repeat_verbatim":true}. */
export const VERBATIM_RULE = 'Если require_repeat_verbatim равно true, произнеси ровно response_text и ничего больше.';
/** Default context line of the transcription prompt (override: settings.realtime.transcription_context). */
export const DEFAULT_TRANSCRIPTION_CONTEXT = 'Утренний стендап IT-команды: участники по очереди рассказывают фокусы на неделю и планы на день, ведущая Кора даёт слово.';

/** Session fields the handshake may drop when the server rejects them (paths inside `session`). */
export const OPTIONAL_SESSION_FIELDS = [
  'audio.input.transcription.keywords',
  'audio.input.transcription.prompt',
  'audio.input.transcription.languages',
  'audio.input.noise_reduction',
  'reasoning',
  'audio.output.speed',
];

/** Client events that reference objects of one server session (dropped instead of queued). */
const SESSION_BOUND = new Set(['response.cancel', 'conversation.item.delete', 'conversation.item.truncate', 'conversation.item.retrieve']);
/** Server error codes that are expected races, not faults. */
const BENIGN_ERROR_CODES = new Set(['response_cancel_not_active', 'item_delete_invalid_item_id']);
/** HTTP statuses at upgrade that retrying cannot fix. */
const FATAL_HTTP = new Set([400, 401, 403, 404]);
const MAX_KEYWORDS = 60;
const MAX_QUEUE = 2000;

const DEFAULTS = {
  connectTimeoutMs: 10_000,
  pingIntervalMs: 3_000,
  idleTimeoutMs: 10_000,
  reconnectDelaysMs: [500, 1000, 2000, 4000],
  maxAttempts: 5,
  maxAudioAgeMs: 2_000,
  maxBufferedBytes: 512 * 1024,
  responseHistory: 64,
};

// ---------------------------------------------------------------------------------------------
// Session config
// ---------------------------------------------------------------------------------------------

/** Session instructions: persona line, pace block, verbatim rule. Deterministic (clip cache key). */
export function buildInstructions(settings = {}) {
  const rt = settings.realtime ?? {};
  const persona = text(rt.persona_line) || DEFAULT_PERSONA_LINE;
  return [persona, text(rt.pace_instructions), VERBATIM_RULE].filter(Boolean).join('\n\n');
}

/**
 * People from config/people.json ({"people":[{display, aliases, spoken, vocative, ...}]}).
 * Missing or broken file -> [] (the prompt then goes without names).
 */
export function loadPeople(path = PEOPLE_PATH) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const data = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return Array.isArray(data?.people) ? data.people.filter((p) => p && typeof p === 'object') : [];
  } catch {
    return [];
  }
}

/**
 * Names for STT biasing: full display names of everyone not `exclude`d, plus the single-word
 * Cyrillic short forms found in spoken/vocative/aliases that are not already words of a display
 * name ("Слава Орлов" -> "Слава"). Stress marks stripped; ё/е variants count once (first wins).
 * @returns {{names: string[], extras: string[]}}
 */
export function peopleVocabulary(people = []) {
  const fold = (s) => s.toLowerCase().replace(/ё/g, 'е');
  const active = people.filter((p) => p && typeof p === 'object' && !p.exclude);
  const names = [];
  const nameKeys = new Set();
  const nameWords = new Set();
  for (const p of active) {
    const display = cleanName(p.display);
    if (!display || nameKeys.has(fold(display))) continue;
    nameKeys.add(fold(display));
    names.push(display);
    for (const w of display.split(' ')) nameWords.add(fold(w));
  }
  const extras = [];
  const extraKeys = new Set();
  for (const p of active) {
    for (const v of [p.spoken, p.vocative, ...(Array.isArray(p.aliases) ? p.aliases : [])]) {
      const c = cleanName(v);
      if (!c || !/[а-яё]/i.test(c) || /[a-z]/i.test(c)) continue;
      for (const w of c.split(' ')) {
        const key = fold(w);
        if (w.length < 2 || nameWords.has(key) || extraKeys.has(key)) continue;
        extraKeys.add(key);
        extras.push(w);
      }
    }
  }
  return { names, extras };
}

/** Transcription prompt: context line + participant names (when people.json has them). */
export function buildTranscriptionPrompt(settings = {}, people = []) {
  const rt = settings.realtime ?? {};
  const context = text(rt.transcription_context) || DEFAULT_TRANSCRIPTION_CONTEXT;
  const { names, extras } = peopleVocabulary(people);
  const parts = [context];
  if (names.length) parts.push(`Участники: ${names.join(', ')}.`);
  if (extras.length) parts.push(`Обращения: ${extras.join(', ')}.`);
  return parts.join(' ');
}

/** Keyword list for gpt-live-transcribe: host name, product words, every name token. */
export function buildKeywords(settings = {}, people = []) {
  const { names, extras } = peopleVocabulary(people);
  const words = ['Кора', 'стендап', 'дев-синк', ...(Array.isArray(settings.keywords) ? settings.keywords : [])];
  for (const n of [...names, ...extras]) words.push(...n.split(/\s+/));
  const seen = new Set();
  const out = [];
  for (const w of words) {
    const key = w.toLowerCase().replace(/ё/g, 'е');
    if (w.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out.slice(0, MAX_KEYWORDS);
}

/**
 * The `session` object for session.update, from settings.realtime (+ names from people.json).
 * create_response/interrupt_response are always false: the host decides when to speak.
 */
export function buildSessionConfig(settings = {}, { people = [] } = {}) {
  const rt = settings.realtime ?? {};
  const languages = (Array.isArray(rt.language) ? rt.language : [rt.language || 'ru']).map(String);
  const transcription = {
    model: rt.transcribe_model || 'gpt-live-transcribe',
    languages,
    prompt: buildTranscriptionPrompt(settings, people),
  };
  const keywords = buildKeywords(settings, people);
  if (keywords.length) transcription.keywords = keywords;
  const input = { format: { type: 'audio/pcm', rate: SAMPLE_RATE } };
  if (rt.noise_reduction && rt.noise_reduction !== 'none') input.noise_reduction = { type: rt.noise_reduction };
  input.transcription = transcription;
  input.turn_detection = {
    type: 'semantic_vad',
    eagerness: rt.vad_eagerness || 'medium',
    create_response: false,
    interrupt_response: false,
  };
  const session = {
    type: 'realtime',
    model: rt.model || 'gpt-realtime-2.1',
    output_modalities: ['audio'],
    instructions: buildInstructions(settings),
  };
  if (rt.reasoning_effort) session.reasoning = { effort: rt.reasoning_effort };
  session.audio = {
    input,
    output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, voice: rt.voice || 'shimmer', speed: rt.speed ?? 1.0 },
  };
  return session;
}

/** Problems in a session.updated echo that make the session unsafe to use ([] = fine). */
export function verifySessionEcho(session) {
  const problems = [];
  const td = session?.audio?.input?.turn_detection;
  if (td?.create_response === true) problems.push('turn_detection.create_response is true (model would answer on its own)');
  if (td?.interrupt_response === true) problems.push('turn_detection.interrupt_response is true (VAD would cancel our readouts)');
  if (Array.isArray(session?.output_modalities) && !session.output_modalities.includes('audio')) problems.push('output_modalities lacks audio');
  return problems;
}

/** Which optional field an error names (path inside `session`), or null. */
export function findRejectedOptionalField(error, config, optional = OPTIONAL_SESSION_FIELDS) {
  const param = typeof error?.param === 'string' ? error.param.replace(/^session\./, '') : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  for (const path of optional) {
    if (!hasPath(config, path)) continue;
    if (param) {
      if (param === path || param.startsWith(`${path}.`) || param.startsWith(`${path}[`)) return path;
    } else if (message.includes(`session.${path}`)) {
      return path;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------------------------

export class RealtimeSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} [opts.settings]        merged settings (realtime section is used)
   * @param {string} opts.apiKey            OpenAI key (caller gets it via env.requireKey; never logged)
   * @param {object[]} [opts.people]        people.json entries for the transcription prompt
   * @param {object} [opts.session]         explicit session config (default buildSessionConfig)
   * @param {string} [opts.url]             base URL (default wss://api.openai.com/v1/realtime)
   * @param {{event: Function}} [opts.log]  logger from openLog()
   * @param {Function} [opts.WebSocket]     WebSocket class (tests)
   * @param {() => number} [opts.now]       clock (ms)
   * Timing knobs: connectTimeoutMs, pingIntervalMs, idleTimeoutMs, reconnectDelaysMs, maxAttempts,
   * maxAudioAgeMs, maxBufferedBytes (see DEFAULTS).
   */
  constructor({ settings = {}, apiKey, people, session, url, log, WebSocket: WS = WebSocket, now = Date.now, ...timing } = {}) {
    super();
    this.setMaxListeners(50); // ears + mouth + host subscribe to many event types
    if (!apiKey) throw new Error('RealtimeSession: apiKey is required');
    this.opts = { ...DEFAULTS, ...timing };
    this._apiKey = apiKey;
    this._WS = WS;
    this._now = now;
    this._logger = log;
    this._sessionConfig = structuredClone(session ?? buildSessionConfig(settings, { people: people ?? loadPeople() }));
    const model = this._sessionConfig.model;
    const base = url ?? settings.realtime?.url ?? REALTIME_URL;
    this.url = `${base}${base.includes('?') ? '&' : '?'}model=${encodeURIComponent(model)}`;

    this.state = 'idle'; // idle | connecting | open | reconnecting | closed
    this.epoch = 0; // successful handshakes so far; audio offsets and item ids are per epoch
    this.sessionId = null;
    this.expiresAt = null;
    this.echo = null; // last session.updated payload
    this._conn = null;
    this._closing = false;
    this._connecting = null;
    this._sleep = null;
    this._queue = [];
    this._eventSeq = 0;
    this._eventPrefix = `c${Math.random().toString(36).slice(2, 6)}_`;
    this._droppedFields = [];
    this._responses = new Map();
    this._outage = null;
    this._rateLimits = null;
    this._stats = {
      connects: 0,
      reconnects: 0,
      disconnects: 0,
      sent_events: 0,
      sent_audio_bytes: 0,
      dropped_events: 0,
      dropped_audio_bytes: 0,
      server_errors: 0,
      rtt_ms: null,
    };
    this._usage = {
      responses: 0,
      input_tokens: 0,
      output_tokens: 0,
      input_text_tokens: 0,
      input_audio_tokens: 0,
      cached_tokens: 0,
      output_text_tokens: 0,
      output_audio_tokens: 0,
      transcription: { items: 0, input_tokens: 0, output_tokens: 0, seconds: 0 },
    };
  }

  /** Session config as sent (after any dropped optional fields). */
  get config() {
    return structuredClone(this._sessionConfig);
  }

  /** Current session instructions (part of the clip cache key). */
  get instructions() {
    return this._sessionConfig.instructions ?? '';
  }

  /** Optional fields the server rejected and the handshake dropped. */
  get droppedFields() {
    return [...this._droppedFields];
  }

  /**
   * Open the socket and apply the session config. Retries transient failures (5 tries,
   * backoff 0.5/1/2/4 s); HTTP 400/401/403/404 and a rejected config fail at once.
   * @returns {Promise<{epoch: number, session_id: string, connect_ms: number, attempts: number, dropped_fields: string[]}>}
   */
  connect() {
    if (this.state === 'open') return Promise.resolve(this._info());
    if (this._connecting) return this._connecting;
    if (this.state === 'reconnecting') {
      return new Promise((resolve, reject) => {
        const onReady = () => {
          this.off('failed', onFailed);
          resolve(this._info());
        };
        const onFailed = ({ error }) => {
          this.off('ready', onReady);
          reject(error);
        };
        this.once('ready', onReady);
        this.once('failed', onFailed);
      });
    }
    this._closing = false;
    this.state = 'connecting';
    const t0 = this._now();
    this._connecting = this._establish(false)
      .then(({ conn, attempts }) => {
        this._activate(conn);
        this._stats.connects++;
        const info = { ...this._info(), connect_ms: this._now() - t0, attempts };
        this._log('rt.connect', {
          epoch: this.epoch,
          session_id: this.sessionId,
          model: this._sessionConfig.model,
          voice: this._sessionConfig.audio?.output?.voice,
          connect_ms: info.connect_ms,
          attempts,
          dropped_fields: this._droppedFields,
          expires_at: this.expiresAt,
        });
        this.emit('ready', { epoch: this.epoch, session_id: this.sessionId, reconnect: false });
        this._flushQueue();
        this.emit('open', info);
        return info;
      })
      .catch((err) => {
        if (!this._closing) {
          this.state = 'closed';
          this._dropQueue('failed');
          this._log('rt.error', { phase: 'connect', fatal: true, message: err.message, code: err.code, status: err.status });
        }
        throw err;
      })
      .finally(() => {
        this._connecting = null;
      });
    return this._connecting;
  }

  /**
   * Send a client event. Adds event_id when missing and returns it (null when dropped).
   * opts.onSent({epoch, t, event_id}) fires when the event is written to the socket,
   * opts.onDrop({reason, event_id, type}) when it never will be; opts.maxAgeMs bounds how long
   * it may wait in the reconnect queue; opts.bytes = audio payload size (computed if absent).
   * session.update payloads are merged into the stored config, so reconnects keep them.
   */
  send(event, opts = {}) {
    if (!event || typeof event.type !== 'string') throw new TypeError('send(): event.type is required');
    const ev = event.event_id ? event : { ...event, event_id: this._nextEventId() };
    if (ev.type === 'session.update' && ev.session) this._sessionConfig = deepMerge(this._sessionConfig, ev.session);
    const isAudio = ev.type === 'input_audio_buffer.append';
    const item = { ev, opts, isAudio, bytes: isAudio ? (opts.bytes ?? b64Bytes(ev.audio)) : 0, t: this._now() };
    if (this._writable()) {
      this._write(item);
      return ev.event_id;
    }
    if (this._closing || this.state === 'closed' || this.state === 'idle') {
      this._drop(item, 'not_connected');
      return null;
    }
    if (SESSION_BOUND.has(ev.type)) {
      this._drop(item, 'stale_session');
      return null;
    }
    if (ev.type === 'session.update') {
      this._drop(item, 'superseded'); // the handshake sends the merged config
      return null;
    }
    this._queue.push(item);
    this._pruneQueue();
    return ev.event_id;
  }

  /** Merge `partial` into the session config and send it (or apply it at the next handshake). */
  updateSession(partial) {
    return this.send({ type: 'session.update', session: { type: 'realtime', ...partial } });
  }

  /** Remove a queued (not yet written) event. True if it was still queued. */
  unqueue(eventId) {
    const i = this._queue.findIndex((item) => item.ev.event_id === eventId);
    if (i < 0) return false;
    this._queue.splice(i, 1);
    return true;
  }

  /** Bookkeeping for a response, by response_id or by our metadata.req. */
  responseInfo(idOrReq) {
    const byId = this._responses.get(idOrReq);
    if (byId) return { ...byId };
    for (const info of this._responses.values()) if (info.req === idOrReq) return { ...info };
    return null;
  }

  /** Test hook: drop the socket as if the network failed (triggers the reconnect path). */
  simulateDrop() {
    this._conn?.ws?.terminate();
  }

  /** Close for good (no reconnect). Queued events are dropped. */
  async close({ code = 1000, reason = 'client close' } = {}) {
    const prev = this.state;
    this._closing = true;
    this.state = 'closed';
    this._cancelSleep();
    const conn = this._conn;
    this._conn = null;
    if (conn) {
      this._stopHeartbeat(conn);
      conn.finish?.(closedError());
      await closeSocket(conn.ws, code, reason);
    }
    this._dropQueue('closed');
    if (prev !== 'closed' && prev !== 'idle') {
      this._log('rt.close', { epoch: this.epoch, ...this._statsForLog() });
      this.emit('closed', {});
    }
  }

  /** Counters for logs and cost.summary. */
  stats() {
    return {
      state: this.state,
      epoch: this.epoch,
      session_id: this.sessionId,
      ...this._statsForLog(),
      queue_len: this._queue.length,
      responses_active: [...this._responses.values()].filter((r) => r.status === 'in_progress').length,
      rate_limits: this._rateLimits,
      dropped_fields: [...this._droppedFields],
    };
  }

  // ---- connection lifecycle ------------------------------------------------------------------

  _info() {
    return { epoch: this.epoch, session_id: this.sessionId, dropped_fields: [...this._droppedFields] };
  }

  async _establish(reconnect) {
    const delays = this.opts.reconnectDelaysMs;
    let lastError = null;
    let attempt = 0;
    for (attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      const idx = reconnect ? attempt - 1 : attempt - 2;
      const delay = idx < 0 ? 0 : delays[Math.min(idx, delays.length - 1)];
      if (delay > 0) await this._sleepMs(delay);
      if (this._closing) throw closedError();
      try {
        const conn = await this._openOnce();
        return { conn, attempts: attempt };
      } catch (err) {
        lastError = err;
        if (this._closing) throw closedError();
        this._log('rt.error', {
          phase: reconnect ? 'reconnect' : 'connect',
          attempt,
          message: err.message,
          code: err.code,
          status: err.status,
          fatal: Boolean(err.fatal),
        });
        if (err.fatal) break;
      }
    }
    lastError.attempts = Math.min(attempt, this.opts.maxAttempts);
    throw lastError;
  }

  _openOnce() {
    return new Promise((resolve, reject) => {
      const conn = { ws: null, ready: false, lastRx: this._now(), pingAt: 0, hb: null, handshakeEventId: null, fallbacks: 0, sessionId: null, expiresAt: null, echo: null };
      let settled = false;
      const timer = setTimeout(() => {
        conn.finish(Object.assign(new Error(`handshake timeout after ${this.opts.connectTimeoutMs} ms`), { code: 'timeout' }));
      }, this.opts.connectTimeoutMs);
      conn.finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          if (this._conn === conn) this._conn = null;
          try {
            conn.ws?.terminate();
          } catch {
            // already gone
          }
          reject(err);
        } else {
          resolve(conn);
        }
      };
      let ws;
      try {
        ws = new this._WS(this.url, {
          headers: { Authorization: `Bearer ${this._apiKey}` },
          perMessageDeflate: false,
          handshakeTimeout: this.opts.connectTimeoutMs,
        });
      } catch (err) {
        conn.finish(err);
        return;
      }
      conn.ws = ws;
      this._conn = conn;
      ws.on('open', () => {
        conn.lastRx = this._now();
        this._sendSessionUpdate(conn);
      });
      ws.on('message', (data) => this._onMessage(conn, data));
      ws.on('pong', () => {
        conn.lastRx = this._now();
        if (conn.pingAt) this._stats.rtt_ms = conn.lastRx - conn.pingAt;
      });
      ws.on('error', (err) => {
        if (!conn.ready) {
          conn.finish(upgradeError(err));
          return;
        }
        this._log('rt.error', { phase: 'socket', message: err.message, code: err.code });
      });
      ws.on('close', (code, reason) => {
        if (!conn.ready) {
          conn.finish(Object.assign(new Error(`socket closed during handshake (${code})`), { code: 'closed', ws_code: code }));
          return;
        }
        this._onClose(conn, code, reason?.toString() ?? '');
      });
    });
  }

  _sendSessionUpdate(conn) {
    const ev = { type: 'session.update', event_id: this._nextEventId(), session: this._sessionConfig };
    conn.handshakeEventId = ev.event_id;
    try {
      conn.ws.send(JSON.stringify(ev));
    } catch (err) {
      conn.finish(err);
    }
  }

  _activate(conn) {
    this._conn = conn;
    this.epoch += 1;
    this.state = 'open';
    this.sessionId = conn.sessionId ?? conn.echo?.id ?? null;
    this.expiresAt = conn.expiresAt ?? conn.echo?.expires_at ?? null;
    this.echo = conn.echo;
    this._startHeartbeat(conn);
  }

  _onClose(conn, code, reason) {
    if (conn !== this._conn) return; // stale socket or close() already took over
    this._stopHeartbeat(conn);
    this._conn = null;
    if (this._closing) return;
    const t = this._now();
    this.state = 'reconnecting';
    this._stats.disconnects++;
    this._outage = { since: t, audio_chunks: 0, audio_ms: 0, events: {} };
    for (const info of this._responses.values()) if (info.status === 'in_progress') info.status = 'lost';
    this._log('rt.disconnect', { epoch: this.epoch, code, reason });
    this.emit('disconnected', { epoch: this.epoch, code, reason, t });
    this._establish(true).then(
      ({ conn: next, attempts }) => {
        this._activate(next);
        this._stats.reconnects++;
        const outage = this._outage;
        this.emit('ready', { epoch: this.epoch, session_id: this.sessionId, reconnect: true });
        this._flushQueue();
        this._outage = null;
        const gap = this._now() - outage.since;
        const dropped = { audio_chunks: outage.audio_chunks, audio_ms: Math.round(outage.audio_ms), events: outage.events };
        this._log('rt.reconnect', { epoch: this.epoch, session_id: this.sessionId, gap_ms: gap, attempts, dropped });
        if (outage.audio_chunks || Object.keys(outage.events).length) this._log('rt.dropped', { epoch: this.epoch, ...dropped });
        this.emit('reconnected', { epoch: this.epoch, gap_ms: gap, attempts, dropped });
      },
      (err) => {
        if (this._closing) return;
        this.state = 'closed';
        this._dropQueue('failed');
        this._log('rt.error', { phase: 'reconnect', fatal: true, gave_up: true, message: err.message, attempts: err.attempts });
        this.emit('failed', { error: err, attempts: err.attempts });
      },
    );
  }

  _startHeartbeat(conn) {
    conn.lastRx = this._now();
    conn.hb = setInterval(() => {
      if (conn !== this._conn) {
        clearInterval(conn.hb);
        return;
      }
      const idle = this._now() - conn.lastRx;
      if (idle > this.opts.idleTimeoutMs) {
        this._log('rt.error', { phase: 'heartbeat', message: `no data or pong for ${idle} ms`, idle_ms: idle });
        clearInterval(conn.hb);
        conn.ws.terminate(); // -> 'close' -> reconnect
        return;
      }
      try {
        conn.pingAt = this._now();
        conn.ws.ping();
      } catch {
        // socket closing; 'close' handles it
      }
    }, this.opts.pingIntervalMs);
    conn.hb.unref?.();
  }

  _stopHeartbeat(conn) {
    if (conn?.hb) clearInterval(conn.hb);
    if (conn) conn.hb = null;
  }

  _sleepMs(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._sleep = null;
        resolve();
      }, ms);
      this._sleep = { timer, resolve };
    });
  }

  _cancelSleep() {
    if (!this._sleep) return;
    clearTimeout(this._sleep.timer);
    const { resolve } = this._sleep;
    this._sleep = null;
    resolve();
  }

  // ---- incoming ------------------------------------------------------------------------------

  _onMessage(conn, data) {
    if (conn !== this._conn) return;
    conn.lastRx = this._now();
    let ev;
    try {
      ev = JSON.parse(data.toString());
    } catch {
      this._log('rt.error', { phase: 'parse', message: 'non-JSON message from server' });
      return;
    }
    if (!ev || typeof ev.type !== 'string') return;
    const t = this._now();

    if (!conn.ready) {
      this._onHandshakeEvent(conn, ev);
      return;
    }

    if (ev.type === 'error') {
      const err = ev.error ?? {};
      const benign = BENIGN_ERROR_CODES.has(err.code);
      this._stats.server_errors++;
      this._log('rt.error', {
        phase: 'server',
        type: err.type,
        code: err.code,
        message: err.message,
        param: err.param,
        event_id: err.event_id,
        ...(benign ? { benign: true } : {}),
      });
      const ctx = { t, epoch: this.epoch, req: null, response_id: null };
      this.emit('event', ev, ctx);
      this.emit('server_error', err, ctx);
      return;
    }

    if (ev.type === 'session.updated') {
      this.echo = ev.session;
      const problems = verifySessionEcho(ev.session);
      if (problems.length) this._log('rt.error', { phase: 'session.updated', problems });
    } else if (ev.type === 'rate_limits.updated') {
      this._rateLimits = ev.rate_limits;
    } else if (ev.type === 'conversation.item.input_audio_transcription.completed') {
      addTranscriptionUsage(this._usage.transcription, ev.usage);
    }

    const info = this._trackResponse(ev, t);
    const ctx = { t, epoch: this.epoch, req: info?.req ?? null, response_id: info?.id ?? ev.response_id ?? null };
    this.emit('event', ev, ctx);
    this.emit(ev.type, ev, ctx);
  }

  _onHandshakeEvent(conn, ev) {
    switch (ev.type) {
      case 'session.created':
        conn.sessionId = ev.session?.id ?? null;
        conn.expiresAt = ev.session?.expires_at ?? null;
        return;
      case 'session.updated': {
        const problems = verifySessionEcho(ev.session);
        if (problems.length) {
          conn.finish(Object.assign(new Error(`unsafe session config: ${problems.join('; ')}`), { fatal: true, code: 'unsafe_session' }));
          return;
        }
        conn.echo = ev.session;
        conn.sessionId = conn.sessionId ?? ev.session?.id ?? null;
        conn.expiresAt = conn.expiresAt ?? ev.session?.expires_at ?? null;
        conn.ready = true;
        conn.finish();
        return;
      }
      case 'error': {
        const err = ev.error ?? {};
        if (err.event_id && err.event_id !== conn.handshakeEventId) {
          this._log('rt.error', { phase: 'handshake', code: err.code, message: err.message, event_id: err.event_id });
          return;
        }
        const path = findRejectedOptionalField(err, this._sessionConfig, OPTIONAL_SESSION_FIELDS);
        if (path && conn.fallbacks < OPTIONAL_SESSION_FIELDS.length) {
          deletePath(this._sessionConfig, path);
          this._droppedFields.push(path);
          conn.fallbacks++;
          this._log('rt.error', { phase: 'handshake', recovered: true, dropped_field: path, code: err.code, message: err.message, param: err.param });
          this._sendSessionUpdate(conn);
          return;
        }
        conn.finish(
          Object.assign(new Error(`session.update rejected: ${err.code ?? err.type}: ${err.message}`), {
            fatal: true,
            code: 'config_rejected',
            server_error: err,
          }),
        );
        return;
      }
      default:
    }
  }

  _trackResponse(ev, t) {
    switch (ev.type) {
      case 'response.created': {
        const r = ev.response ?? {};
        if (!r.id) return null;
        const info = {
          id: r.id,
          req: r.metadata?.req ?? null,
          epoch: this.epoch,
          t_created: t,
          t_first_audio: null,
          audio_bytes: 0,
          status: 'in_progress',
          usage: null,
          t_done: null,
        };
        this._responses.set(r.id, info);
        while (this._responses.size > this.opts.responseHistory) this._responses.delete(this._responses.keys().next().value);
        return info;
      }
      case 'response.output_audio.delta': {
        const info = this._responses.get(ev.response_id);
        if (info) {
          if (!info.t_first_audio) info.t_first_audio = t;
          info.audio_bytes += b64Bytes(ev.delta);
        }
        return info ?? null;
      }
      case 'response.done': {
        const r = ev.response ?? {};
        let info = this._responses.get(r.id);
        if (!info && r.id) {
          info = { id: r.id, req: r.metadata?.req ?? null, epoch: this.epoch, t_created: null, t_first_audio: null, audio_bytes: 0 };
          this._responses.set(r.id, info);
        }
        if (!info) return null;
        info.status = r.status;
        info.usage = r.usage ?? null;
        info.t_done = t;
        addResponseUsage(this._usage, r.usage);
        const u = r.usage ?? {};
        this._log('rt.usage', {
          req: info.req,
          response_id: info.id,
          status: r.status,
          ...(r.status_details?.reason ? { reason: r.status_details.reason } : {}),
          input_tokens: u.input_tokens,
          output_tokens: u.output_tokens,
          in_text: u.input_token_details?.text_tokens,
          in_audio: u.input_token_details?.audio_tokens,
          in_cached: u.input_token_details?.cached_tokens,
          out_text: u.output_token_details?.text_tokens,
          out_audio: u.output_token_details?.audio_tokens,
          audio_ms: Math.round(info.audio_bytes / BYTES_PER_MS),
        });
        return info;
      }
      default:
        return ev.response_id ? (this._responses.get(ev.response_id) ?? null) : null;
    }
  }

  // ---- outgoing ------------------------------------------------------------------------------

  _writable() {
    return this.state === 'open' && this._conn?.ready === true && this._conn.ws.readyState === WebSocket.OPEN;
  }

  _write(item) {
    const ws = this._conn.ws;
    if (item.isAudio && ws.bufferedAmount > this.opts.maxBufferedBytes) {
      this._drop(item, 'backpressure');
      return;
    }
    try {
      ws.send(JSON.stringify(item.ev));
    } catch (err) {
      this._drop(item, 'send_error');
      return;
    }
    this._stats.sent_events++;
    if (item.isAudio) this._stats.sent_audio_bytes += item.bytes;
    if (item.opts.onSent) safeCall(() => item.opts.onSent({ epoch: this.epoch, t: this._now(), event_id: item.ev.event_id }), this, 'onSent');
  }

  _drop(item, reason) {
    this._stats.dropped_events++;
    if (item.isAudio) this._stats.dropped_audio_bytes += item.bytes;
    if (this._outage) {
      if (item.isAudio) {
        this._outage.audio_chunks++;
        this._outage.audio_ms += item.bytes / BYTES_PER_MS;
      } else {
        this._outage.events[item.ev.type] = (this._outage.events[item.ev.type] ?? 0) + 1;
      }
    }
    if (item.opts.onDrop) safeCall(() => item.opts.onDrop({ reason, event_id: item.ev.event_id, type: item.ev.type }), this, 'onDrop');
  }

  _isStale(item, now) {
    const age = now - item.t;
    if (item.isAudio && age > this.opts.maxAudioAgeMs) return true;
    return item.opts.maxAgeMs != null && age > item.opts.maxAgeMs;
  }

  _pruneQueue() {
    const now = this._now();
    if (this._queue.some((item) => this._isStale(item, now))) {
      const keep = [];
      for (const item of this._queue) {
        if (this._isStale(item, now)) this._drop(item, 'stale');
        else keep.push(item);
      }
      this._queue = keep;
    }
    while (this._queue.length > MAX_QUEUE) this._drop(this._queue.shift(), 'overflow');
  }

  _flushQueue() {
    const now = this._now();
    const queue = this._queue;
    this._queue = [];
    for (const item of queue) {
      if (this._isStale(item, now)) this._drop(item, 'stale');
      else if (this._writable()) this._write(item);
      else this._queue.push(item); // socket died again mid-flush; keep for the next handshake
    }
  }

  _dropQueue(reason) {
    const queue = this._queue;
    this._queue = [];
    for (const item of queue) this._drop(item, reason);
  }

  _nextEventId() {
    this._eventSeq += 1;
    return `${this._eventPrefix}${this._eventSeq}`;
  }

  _statsForLog() {
    const s = this._stats;
    return {
      connects: s.connects,
      reconnects: s.reconnects,
      disconnects: s.disconnects,
      sent_events: s.sent_events,
      sent_audio_ms: Math.round(s.sent_audio_bytes / BYTES_PER_MS),
      dropped_events: s.dropped_events,
      dropped_audio_ms: Math.round(s.dropped_audio_bytes / BYTES_PER_MS),
      server_errors: s.server_errors,
      rtt_ms: s.rtt_ms,
      usage: structuredClone(this._usage),
    };
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
// helpers
// ---------------------------------------------------------------------------------------------

/** Decoded size of a base64 string (no allocation). */
export function b64Bytes(b64) {
  return typeof b64 === 'string' ? Buffer.byteLength(b64, 'base64') : 0;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Strip stress marks (U+0301/U+0300) and extra spaces; '' for non-strings. */
function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').replace(/[̀́]/g, '').replace(/\s+/g, ' ').trim();
}

function hasPath(obj, path) {
  let o = obj;
  for (const key of path.split('.')) {
    if (o === null || typeof o !== 'object' || !(key in o)) return false;
    o = o[key];
  }
  return true;
}

function deletePath(obj, path) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = obj;
  for (const key of keys) {
    o = o?.[key];
    if (o === null || typeof o !== 'object') return false;
  }
  if (!(last in o)) return false;
  delete o[last];
  return true;
}

function addResponseUsage(total, u) {
  if (!u) return;
  total.responses += 1;
  total.input_tokens += u.input_tokens ?? 0;
  total.output_tokens += u.output_tokens ?? 0;
  total.input_text_tokens += u.input_token_details?.text_tokens ?? 0;
  total.input_audio_tokens += u.input_token_details?.audio_tokens ?? 0;
  total.cached_tokens += u.input_token_details?.cached_tokens ?? 0;
  total.output_text_tokens += u.output_token_details?.text_tokens ?? 0;
  total.output_audio_tokens += u.output_token_details?.audio_tokens ?? 0;
}

function addTranscriptionUsage(total, u) {
  total.items += 1;
  if (!u) return;
  if (u.type === 'duration') total.seconds += u.seconds ?? 0;
  total.input_tokens += u.input_tokens ?? 0;
  total.output_tokens += u.output_tokens ?? 0;
}

function upgradeError(err) {
  const m = /Unexpected server response: (\d{3})/.exec(err?.message ?? '');
  if (!m) return err;
  const status = Number(m[1]);
  return Object.assign(new Error(`HTTP ${status} from realtime endpoint`), { status, code: `http_${status}`, fatal: FATAL_HTTP.has(status) });
}

function closedError() {
  return Object.assign(new Error('session closed'), { code: 'closed' });
}

function safeCall(fn, session, where) {
  try {
    fn();
  } catch (err) {
    session._log('rt.error', { phase: 'callback', where, message: err?.message });
  }
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
