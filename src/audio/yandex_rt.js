// Yandex AI Studio Realtime API transport — drop-in replacement for ElevenAgent in agent_host.
// Protocol: OpenAI Realtime-compatible events over WebSocket, new nested session format
// (endpoint wss://ai.api.cloud.yandex.net/v1/realtime, model URI gpt://<folder>/<model>).
// The same external contract: connect/pushAudio/sendUserMessage/sendContextualUpdate/
// sendToolResult/close/stats + the event set agent_host listens to.
//
// Audio rates: the page adapter runs at 24 kHz, Realtime at 16 kHz — resample.js bridges.
// Host notes (nudges) go in as text items; `sendUserMessage` triggers a response,
// `sendContextualUpdate` is context-only (system item, no response.create).

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { resample16to24, resample24to16 } from './resample.js';

export const DEFAULT_MODEL = 'speech-realtime-250923';
export const DEFAULT_WS_URL = 'wss://ai.api.cloud.yandex.net/v1/realtime';

// A tool call the model spoke aloud instead of invoking: name + optional args (JSON or
// spoken keys), e.g. «give_word {"person_id":"…"}», «set_phase(closing)»,
// «set_phase {"phase":"closing"}», «give word person name Глеб».
const SPOKEN_CALL = /(skip[_ ]?turn|leave[_ ]?meeting|give[_ ]?word|turn[_ ]?done|set[_ ]?phase(?:\s*\(\s*(\w+)\s*\)|\s*\{\s*"phase"\s*:\s*"(\w+)"\s*\}))(\s*\{[^}]*\}|\s+person[_ ]?(?:name|id)\s+«?[^»\n]{1,40}?(?:»|$)|\s+person[_ ]?(?:name|id)\s+"[^"\n]{1,40}")?/i;
const SPOKEN_CALL_GLOBAL = new RegExp(SPOKEN_CALL.source, 'gi');
const SPOKEN_TOOLS = new Set(['skip_turn', 'leave_meeting', 'give_word', 'turn_done', 'set_phase']);
// meta markers some models emit around narrated calls: «[TOOL_CALL_START]», «[/TOOL_CALL]»
const CALL_MARKER = /\[\/?(?:tool[_ -]?)?call[_ -]?(?:start|end)?\]/gi;

/** Map a spoken-call regex match to {name, params}; null when it is not a real tool. */
function concatPcm(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function parseSpokenCall(m) {
  let name;
  let params = {};
  const phase = m[2] ?? m[3];
  if (phase !== undefined) {
    name = 'set_phase';
    params = { phase };
  } else {
    name = m[1].toLowerCase().replace(/[_ ]/g, '_');
    const args = m[4]?.trim();
    if (args) {
      if (args.startsWith('{')) {
        try {
          params = JSON.parse(args);
        } catch {
          const pn = args.match(/"person_name"\s*:\s*"([^"]+)"/);
          const pi = args.match(/"person_id"\s*:\s*"([^"]+)"/);
          if (pn) params.person_name = pn[1];
          if (pi) params.person_id = pi[1];
        }
      } else {
        // spoken keys: «person name Глеб», «person_id nevsky_g»
        for (const kv of args.matchAll(/person[_ ]?(name|id)\s+«?"?([^"»\s]+)"?»?/gi)) {
          params[kv[1].toLowerCase() === 'name' ? 'person_name' : 'person_id'] = kv[2];
        }
      }
    }
  }
  return SPOKEN_TOOLS.has(name) ? { name, params } : null;
}

/** Text with the call spans blanked out — what would be left for human ears. */
function residualSpeech(clean, calls) {
  let out = clean;
  for (let i = calls.length - 1; i >= 0; i--) out = out.slice(0, calls[i].index) + ' ' + out.slice(calls[i].index + calls[i].len);
  return out;
}

// spoken Russian incl. pauses — for estimating how much audio a narrated call prefix takes
const NARRATION_CHARS_PER_SEC = 14;

/** Length (chars) of the leading call block («turn_done{…} Все…» -> the turn_done{…} part), 0 when none. */
function leadingNarrationChars(clean, calls) {
  if (!calls.length) return 0;
  const sorted = [...calls].sort((a, b) => a.index - b.index);
  let end = 0;
  for (const c of sorted) {
    const between = clean.slice(end, c.index);
    if (!/^[\s\p{P}]*$/u.test(between)) break; // human text before this call: the block is over
    end = c.index + c.len;
  }
  if (end === 0) return 0;
  return /^[\s\p{P}]*$/u.test(clean.slice(end)) ? 0 : end; // pure narration is suppressed elsewhere
}

/** Client tools in the OpenAI function format — the same contract the ElevenLabs agent had. */
export function buildYandexTools() {
  const person = {
    person_id: { type: 'string', description: 'id участника из ростера' },
    person_name: { type: 'string', description: 'имя участника (короткое)' },
  };
  const personReq = { type: 'object', properties: person };
  return [
    { type: 'function', name: 'skip_turn', description: 'Промолчать на этом ходу (не на прямое обращение по имени).', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'give_word', description: 'Передать слово участнику (вызывай вместе с произнесением его имени).', parameters: personReq },
    { type: 'function', name: 'turn_done', description: 'Участник закончил выступление (вместе с give_word следующему).', parameters: personReq },
    {
      type: 'function', name: 'set_phase', description: 'Фаза встречи.',
      parameters: { type: 'object', properties: { phase: { type: 'string', enum: ['waiting', 'round', 'open_floor', 'closing'] } }, required: ['phase'] } },
    { type: 'function', name: 'leave_meeting', description: 'Завершить: в том же ходе, что и прощание, последним действием.', parameters: { type: 'object', properties: {} } },
  ];
}

export class YandexAgent extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.apiKey       Yandex Cloud API key (no scope restriction)
   * @param {string} o.folderId     cloud folder id (b1…)
   * @param {string} [o.instructions]
   * @param {string} [o.voice]      e.g. 'alena'
   * @param {Array} [o.tools]       OpenAI-format tools (buildYandexTools())
   * @param {string} [o.model]
   * @param {string} [o.wsUrl]
   * @param {Function} [o.WebSocket] injectable ws constructor (tests)
   * @param {{event?: Function}} [o.log]
   * @param {() => number} [o.now]
   */
  constructor({ apiKey, folderId, instructions = '', voice = 'alena', tools = [], model = DEFAULT_MODEL, wsUrl = DEFAULT_WS_URL, WebSocket: WS = WebSocket, log = null, now = Date.now, maxReconnects = 3 } = {}) {
    super();
    if (!apiKey || !folderId) throw new Error('YandexAgent: apiKey and folderId are required');
    this.apiKey = apiKey;
    this.folderId = folderId;
    this.instructions = instructions;
    this.voice = voice;
    this.tools = tools;
    this.model = model;
    this.wsUrl = wsUrl;
    this.WS = WS;
    this._log = log;
    this._now = now;
    this.maxReconnects = maxReconnects;

    this.connected = false;
    this.state = 'idle'; // idle | connecting | open | closing | closed
    this.conversationId = null; // Realtime has none; kept for interface parity
    this._ws = null;
    this._sessionSent = false;
    this._outbox = []; // queued events until the session is up
    this._audioQueueCap = 200;
    this._droppedAudio = 0;
    this._responding = false;
    this._responseId = null;
    this._responseText = '';
    this._reconnects = 0;
    this._openedAt = 0;
    this._toolNamesByCallId = new Map();
    this._textByResponse = new Map();
    this._audioBuffer = new Map();
    this._skipUtterance = new Set();
    this._spokenSeen = new Map();
    this._utt = 0;
  }

  _ev(type, fields) {
    try {
      this._log?.event?.(type, fields);
    } catch { /* logging must never break the agent */ }
  }

  _send(obj) {
    const line = JSON.stringify(obj);
    if (this._ws && this._ws.readyState === 1 && this._sessionSent) this._ws.send(line);
    else this._outbox.push(line);
  }

  _sendSession() {
    this._sessionSent = true;
    this._send({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        instructions: this.instructions,
        tools: this.tools,
        // room speech transcripts: without this the host is blind (kill switch, addressed
        // lines, the on-demand start request all key off final transcripts)
        input_audio_transcription: { model: 'whisper-1' },
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 16_000 },
            turn_detection: { type: 'server_vad', silence_duration_ms: 500 },
          },
          output: { format: { type: 'audio/pcm', rate: 16_000 }, voice: this.voice },
        },
      },
    });
  }

  /** Connect (or reconnect) the socket; resolves once the session is up. */
  connect() {
    if (this.state === 'open' || this.state === 'connecting') return Promise.resolve({ conversation_id: null, state: this.state });
    this.state = 'connecting';
    const url = `${this.wsUrl}?model=gpt://${this.folderId}/${this.model}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new this.WS(url, { headers: { Authorization: `Api-Key ${this.apiKey}` }, handshakeTimeout: 15_000 });
      this._ws = ws;
      const onError = (e) => {
        if (!settled) { settled = true; this.state = 'idle'; reject(e instanceof Error ? e : new Error(String(e?.message ?? e))); }
      };
      ws.on('error', onError);
      ws.on('open', () => {
        this._ev('rt.socket_open', { reconnect: this._reconnects > 0 });
      });
      ws.on('message', (data) => {
        let ev;
        try { ev = JSON.parse(data.toString()); } catch { return; }
        if (!settled && (ev.type === 'session.created' || ev.type === 'session.updated')) {
          const wasReconnect = this._reconnects > 0;
          const gap = wasReconnect ? this._now() - this._openedAt : 0;
          this.connected = true;
          this.state = 'open';
          if (!this._openedAt) this._openedAt = this._now();
          this._flushOutbox();
        if (!settled) {
          settled = true;
          resolve({ conversation_id: null, state: 'open', formats: { in: 'pcm_16000', out: 'pcm_16000' } });
        }
        if (wasReconnect) this.emit('reconnected', { gap_ms: gap, attempts: this._reconnects, conversation_id: null });
        this.emit('open', { conversation_id: null, reconnect: wasReconnect, formats: { in: 'pcm_16000', out: 'pcm_16000' } });
        return;
        }
        this._onEvent(ev);
      });
      ws.on('close', (code, reason) => {
        const was = this.connected;
        this.connected = false;
        this._sessionSent = false;
        if (this.state === 'closing' || code === 1000) {
          this.state = 'closed';
          this.emit('closed', { reason: reason?.toString() || 'closed' });
          return;
        }
        this.state = 'idle';
        this.emit('disconnected', { code, reason: reason?.toString() ?? '', t: this._now(), conversation_id: null });
        if (!was) return;
        this._reconnects += 1;
        if (this._reconnects > this.maxReconnects) {
          this.emit('failed', { error: new Error(`socket closed (${code})`), attempts: this._reconnects });
          return;
        }
        const wait = 1000 * 2 ** (this._reconnects - 1);
        setTimeout(() => this.connect().catch(() => {}), wait).unref?.();
      });
      this._sendSession();
    });
  }

  _flushOutbox() {
    if (!this._ws || this._ws.readyState !== 1) return;
    for (const line of this._outbox.splice(0)) this._ws.send(line);
  }

  _onEvent(ev) {
    const t = ev.type;
    if (t === 'input_audio_buffer.speech_started') {
      if (this._responding) {
        this.emit('interruption', { event_id: this._responseId ?? null, t: this._now() });
        this._send({ type: 'response.cancel' });
      }
      return;
    }
    if (t === 'response.created') {
      this._responding = true;
      this._responseId = ev.response?.id ?? `rt_${++this._utt}`;
      this._responseText = '';
      this._textByResponse.set(this._responseId, '');
      this._audioBuffer.set(this._responseId, []); // held until we know the utterance is not a spoken tool name
      return;
    }
    if (t === 'response.output_audio.delta' || t === 'response.audio.delta') {
      const rid = ev.response_id ?? this._responseId;
      if (this._skipUtterance.has(rid)) return; // the model «said» a tool name: keep it out of the room
      const b64 = ev.delta ?? ev.audio ?? '';
      if (!b64) return;
      const pcm16 = Buffer.from(b64, 'base64');
      const pcm = resample16to24(new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength >> 1));
      const buf = this._audioBuffer.get(rid);
      if (buf) buf.push(pcm); // released by the first confident text delta (see below)
      else this.emit('audio', { pcm, event_id: rid, t: this._now() });
      return;
    }
    if (t === 'response.output_text.delta' || t === 'response.audio_transcript.delta' || t === 'response.output_audio_transcript.delta') {
      const text = ev.delta ?? '';
      if (!text) return;
      const rid = ev.response_id ?? this._responseId;
      this._emitTextDelta(rid, text);
      return;
    }
    if (t === 'response.output_item.done') {
      const item = ev.item ?? {};
      if (item.type === 'function_call') {
        let parameters = {};
        try { parameters = JSON.parse(item.arguments || '{}'); } catch { parameters = {}; }
        if (item.call_id) this._toolNamesByCallId.set(item.call_id, item.name);
        this.emit('tool_call', { tool_name: item.name, tool_call_id: item.call_id, parameters, expects_response: true, event_id: this._responseId ?? null, t: this._now() });
      }
      return;
    }
    if (t === 'response.completed' || t === 'response.done') {
      const rid = ev.response?.id ?? this._responseId;
      if (rid === this._responseId) this._responding = false;
      // no text arrived at all (audio-only): release whatever was held
      const buf = this._audioBuffer.get(rid);
      if (buf && !this._skipUtterance.has(rid)) {
        for (const pcm of buf) this.emit('audio', { pcm, event_id: rid, t: this._now() });
      }
      this._audioBuffer.delete(rid);
      this._textByResponse.delete(rid);
      this._skipUtterance.delete(rid);
      this._spokenSeen.delete(rid);
      this.emit('response_complete', { event_id: rid, t: this._now() });
      return;
    }
    if (t === 'conversation.item.input_audio_transcription.completed') {
      const text = ev.transcript ?? ev.item?.content?.[0]?.transcript ?? '';
      if (text) this.emit('transcript', { text, event_id: ev.item_id ?? null, t: this._now() });
      return;
    }
    if (t === 'conversation.item.input_audio_transcription.partial') {
      const text = ev.transcript ?? '';
      if (text) this.emit('tentative_transcript', { text, t: this._now() });
      return;
    }
    if (t === 'error') {
      const err = ev.error ?? {};
      this.emit('client_error', { code: err.code ?? null, name: err.type ?? null, message: err.message ?? 'realtime error', t: this._now() });
      return;
    }
    if (t === 'response.cancelled' || t === 'response.canceled') {
      this._responding = false;
      return;
    }
    this.emit('server_event', ev);
  }

  /** One output-text delta: spoken-tool-call detection + audio gating, attributed to its own response. */
  _emitTextDelta(rid, text) {
    this._responseText += text;
    // realtime models sometimes verbalize tool calls instead of making them — «give_word
    // {"person_id":…}», «[TOOL_CALL_START]give_word …», chains. Execute every call found in
    // the text; keep the audio out of the room when nothing human-facing would remain.
    const raw = (this._textByResponse.get(rid) ?? '') + text;
    this._textByResponse.set(rid, raw);
    const clean = raw.replace(CALL_MARKER, ' ');
    const calls = [];
    for (const m of clean.matchAll(SPOKEN_CALL_GLOBAL)) {
      const parsed = parseSpokenCall(m);
      if (parsed) calls.push({ parsed, index: m.index, len: m[0].length });
    }
    if (!this._skipUtterance.has(rid)) {
      // execute each call once (text grows delta by delta; indices are stable)
      const seen = this._spokenSeen.get(rid) ?? new Set();
      this._spokenSeen.set(rid, seen);
      for (const { parsed, index } of calls) {
        const key = `${index}:${parsed.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const callId = `spoken_${parsed.name}_${rid}_${index}`;
        this._toolNamesByCallId.set(callId, parsed.name);
        this.emit('tool_call', { tool_name: parsed.name, tool_call_id: callId, parameters: parsed.params, expects_response: false, event_id: rid, t: this._now() });
        this.emit('tool_response', { tool_name: parsed.name, status: 'success', is_error: false, t: this._now() });
      }
      const residual = residualSpeech(clean, calls).replace(/[\s\p{P}«»"']/gu, '');
      if (calls.length && residual === '') {
        // pure narration (maybe decorated with markers): nothing for human ears
        this._skipUtterance.add(rid);
        this._audioBuffer.delete(rid);
      } else if (!/^\s*(skip|set|leave|give|turn)\b/i.test(raw)) {
        // confident this is speech, not a tool name: release the held audio, cutting the
        // estimated duration of a narrated call prefix («turn_done{…} Все высказались…»)
        const buf = this._audioBuffer.get(rid);
        if (buf && buf.length) {
          this._audioBuffer.delete(rid);
          let pcm = buf.length === 1 ? buf[0] : concatPcm(buf);
          const leadChars = leadingNarrationChars(clean, calls);
          if (leadChars > 0) {
            const trim = Math.min(Math.floor((leadChars / NARRATION_CHARS_PER_SEC) * 24_000), Math.floor(pcm.length * 0.9));
            if (trim > 2400) pcm = pcm.slice(trim);
          }
          this.emit('audio', { pcm, event_id: rid, t: this._now() });
        } else if (buf) {
          this._audioBuffer.delete(rid);
        }
      }
    }
    this.emit('response', { text, event_id: rid, t: this._now() });
  }

  /** Push one room-audio chunk (24 kHz mono s16le) to the model input. */
  pushAudio(pcm) {
    if (!this.connected || this.state !== 'open') {
      this._droppedAudio += 1;
      return false;
    }
    const pcm16 = resample24to16(pcm);
    const b64 = Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).toString('base64');
    this._send({ type: 'input_audio_buffer.append', audio: b64 });
    return true;
  }

  /** A host note that must trigger a turn (nudges, addressed lines). */
  sendUserMessage(text) {
    this._send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    this._send({ type: 'response.create' });
    return this.connected;
  }

  /** Context-only line (presence, speaker notes): no response triggered. */
  sendContextualUpdate(text) {
    this._send({ type: 'conversation.item.create', item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] } });
    return this.connected;
  }

  /** Answer a client tool call; a synthetic tool_response is emitted so agent_host's
      skip-turn bookkeeping (addressed lines always get an answer) keeps working.
      continueTurn=false acknowledges the call without asking the model to speak on
      (leave_meeting: the leave flow is running; skip_turn: silence was the point). */
  sendToolResult(id, result, { isError, continueTurn = false } = {}) {
    const output = isError ? JSON.stringify({ error: typeof result === 'string' ? result : JSON.stringify(result) }) : JSON.stringify(result ?? {});
    this._send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: id, output } });
    if (continueTurn) this._send({ type: 'response.create' });
    this.emit('tool_response', { tool_name: this._toolNamesByCallId.get(id) ?? null, status: isError ? 'error' : 'success', is_error: Boolean(isError), t: this._now() });
    return true;
  }

  async close({ reason = 'closed' } = {}) {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.state = 'closing';
    this._responding = false;
    try {
      this._ws?.close(1000, reason);
    } catch { /* already closed */ }
    if (!this.connected && this._ws?.readyState !== 1) this.emit('closed', { reason });
  }

  stats() {
    return {
      connected_ms: this._openedAt ? this._now() - this._openedAt : 0,
      sessions: this._reconnects + (this._openedAt ? 1 : 0),
      conversation_ids: [],
      dropped_audio: this._droppedAudio,
    };
  }
}
