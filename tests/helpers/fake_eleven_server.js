// Fakes for the ElevenLabs agent tests: an in-process WebSocket server that speaks the agent
// protocol (docs/eleven_agent.md §3), a REST stub, and a player that consumes audio streams.
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocketServer } from 'ws';

export class FakeElevenServer {
  constructor({ inFormat = 'pcm_24000', outFormat = 'pcm_24000', autoMetadata = true } = {}) {
    this.inFormat = inFormat;
    this.outFormat = outFormat;
    this.autoMetadata = autoMetadata;
    this.refuseInit = null; // {code, message} -> client_error instead of metadata
    this.conns = [];
    this.seq = 0;
    this.wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    this.listening = new Promise((resolve) => this.wss.once('listening', resolve));
  }

  get url() {
    return `ws://127.0.0.1:${this.wss.address().port}/v1/convai/conversation`;
  }

  get last() {
    return this.conns.at(-1);
  }

  send(conn, ev) {
    if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(ev));
  }

  metadata(conn) {
    this.send(conn, { type: 'conversation_initiation_metadata', conversation_initiation_metadata_event: { conversation_id: `conv_${conn.idx}`, agent_output_audio_format: this.outFormat, user_input_audio_format: this.inFormat } });
  }

  audio(conn, pcm, eventId = ++this.seq) {
    this.send(conn, { type: 'audio', audio_event: { audio_base_64: Buffer.from(pcm).toString('base64'), event_id: eventId } });
    return eventId;
  }

  response(conn, text, eventId = ++this.seq) {
    this.send(conn, { type: 'agent_response', agent_response_event: { agent_response: text, event_id: eventId } });
    return eventId;
  }

  correction(conn, original, corrected) {
    this.send(conn, { type: 'agent_response_correction', agent_response_correction_event: { original_agent_response: original, corrected_agent_response: corrected, event_id: ++this.seq } });
  }

  complete(conn, eventId = ++this.seq) {
    this.send(conn, { type: 'agent_response_complete', agent_response_complete_event: { event_id: eventId } });
  }

  transcript(conn, text, eventId = ++this.seq) {
    this.send(conn, { type: 'user_transcript', user_transcription_event: { user_transcript: text, event_id: eventId } });
  }

  tentative(conn, text) {
    this.send(conn, { type: 'tentative_user_transcript', tentative_user_transcription_event: { user_transcript: text } });
  }

  interrupt(conn, eventId = this.seq) {
    this.send(conn, { type: 'interruption', interruption_event: { event_id: eventId } });
  }

  ping(conn, eventId = ++this.seq, pingMs = 30) {
    this.send(conn, { type: 'ping', ping_event: { event_id: eventId, ping_ms: pingMs } });
    return eventId;
  }

  toolCall(conn, name, parameters = {}, id = `call_${++this.seq}`) {
    this.send(conn, { type: 'client_tool_call', client_tool_call: { tool_name: name, tool_call_id: id, parameters, expects_response: true, event_id: this.seq } });
    return id;
  }

  vad(conn, score) {
    this.send(conn, { type: 'vad_score', vad_score_event: { vad_score: score } });
  }

  clientError(conn, code, message) {
    this.send(conn, { type: 'client_error', error_event: { code, error_name: code, message } });
  }

  drop(conn) {
    conn.ws.terminate();
  }

  end(conn, code = 1000, reason = 'end_call') {
    conn.ws.close(code, reason);
  }

  /** Wait until `pred(conn)` is true (polling), else throw. */
  async waitFor(conn, pred, { ms = 3000, what = 'condition' } = {}) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (pred(conn)) return true;
      await sleep(10);
    }
    throw new Error(`timeout waiting for ${what}`);
  }

  /** Wait for the n-th connection to arrive and finish its init. */
  async connection(n = 0, ms = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const c = this.conns[n];
      if (c?.init) return c;
      await sleep(10);
    }
    throw new Error(`no connection #${n} with init within ${ms} ms`);
  }

  async close() {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise((resolve) => this.wss.close(resolve));
  }

  _onConnection(ws, req) {
    const conn = { ws, idx: this.conns.length, url: req.url, headers: req.headers, init: null, messages: [], audio: [], audioBytes: 0, pongs: [], toolResults: [], contextual: [], userMessages: [], closed: null };
    this.conns.push(conn);
    ws.on('close', (code, reason) => {
      conn.closed = { code, reason: reason?.toString() ?? '' };
    });
    ws.on('message', (data) => {
      let ev;
      try {
        ev = JSON.parse(data.toString());
      } catch {
        return;
      }
      conn.messages.push(ev);
      if (ev.user_audio_chunk) {
        const b = Buffer.from(ev.user_audio_chunk, 'base64');
        conn.audio.push(b);
        conn.audioBytes += b.length;
        return;
      }
      switch (ev.type) {
        case 'conversation_initiation_client_data':
          conn.init = ev;
          if (this.refuseInit) this.clientError(conn, this.refuseInit.code, this.refuseInit.message);
          else if (this.autoMetadata) this.metadata(conn);
          break;
        case 'pong':
          conn.pongs.push(ev);
          break;
        case 'client_tool_result':
          conn.toolResults.push(ev);
          break;
        case 'contextual_update':
          conn.contextual.push(ev.text);
          break;
        case 'user_message':
          conn.userMessages.push(ev.text);
          break;
        default:
      }
    });
  }
}

/** REST stub: the signed URL points at the fake server; balance and conversation cost are canned. */
export function fakeRest(server, { balance = { tier: 'free', character_count: 100, character_limit: 10_000 }, cost = 42 } = {}) {
  const calls = [];
  return {
    calls,
    signedUrl: async (agentId) => {
      calls.push(['signedUrl', agentId]);
      return `${server.url}?agent_id=${encodeURIComponent(agentId)}&token=t`;
    },
    subscription: async () => {
      calls.push(['subscription']);
      return { ...balance };
    },
    conversation: async (id) => {
      calls.push(['conversation', id]);
      return { status: 'done', conversation_id: id, metadata: { cost, call_duration_secs: 61, charging: { llm_charge: 2, call_charge: cost - 2 } }, transcript: [] };
    },
  };
}

/** Player double: consumes the async iterable, records chunks per playback, honours stop()/abort(). */
export function fakePlayer({ now = Date.now } = {}) {
  const em = new EventEmitter();
  const plays = [];
  const stops = [];
  let active = null;
  const player = {
    plays,
    stops,
    play(src, { meta = {}, source } = {}) {
      const u = { meta, source, chunks: [], bytes: 0, aborted: false, status: null, t: now() };
      u.done = (async () => {
        try {
          for await (const c of src) {
            if (u.aborted) break;
            const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
            u.chunks.push(b);
            u.bytes += b.length;
          }
          u.status = u.aborted ? 'aborted' : 'completed';
        } catch {
          u.status = 'failed';
        }
        if (active === u) active = null;
        em.emit('state', { speaking: false });
        return { status: u.status, played_ms: Math.round(u.bytes / 48), total_ms: Math.round(u.bytes / 48), played_ratio: u.status === 'completed' ? 1 : 0.5, reason: u.reason ?? null };
      })();
      u.abort = async (reason = 'abort') => {
        u.aborted = true;
        u.reason = reason;
        return u.done;
      };
      active = u;
      plays.push(u);
      em.emit('state', { speaking: true });
      return { id: `p${plays.length}`, done: u.done, abort: u.abort, meta };
    },
    async stop(reason = 'stop') {
      stops.push(reason);
      const u = active;
      if (u) await u.abort(reason);
      return u ? u.done : null;
    },
    isSpeaking: () => active !== null,
    on: (t, fn) => em.on(t, fn),
    onPageEvent() {},
    stats: () => ({ plays: plays.length, stops: stops.length }),
    close() {},
  };
  return player;
}
