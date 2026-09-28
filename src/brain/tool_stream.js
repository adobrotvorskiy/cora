// Streaming chat.completions with tool calls (OpenAI-compatible SSE: OpenAI, OpenRouter, Yandex AI Studio).
//
//   const r = await readToolStream(res, { clock, onToolName, onToolArgs });
//   r = {content, toolCalls: [{index, id, name, arguments, args, error}], finish_reason, usage, timings}
//
// Tool-call deltas arrive per index: the first delta carries id + function.name, the following ones
// append to function.arguments. onToolName(call, ms) fires the moment a call's name is known — the
// agent host starts a filler («Так…») or a synthesis prefetch there, before the arguments are done.
// onToolArgs(call, ms) fires once a call's arguments are complete (the next index started, or the
// stream ended), with `args` parsed (null + `error` when the JSON is broken). A provider that sends a
// whole tool call in one chunk goes through the same path. `timings`: ttft (first content or tool
// delta), first_tool_name, done — ms since `started`.

/**
 * Split an SSE body into `data:` payloads (comments, event:, id: and blank lines skipped).
 * @param {ReadableStream<Uint8Array>} body
 * @param {(data: string) => void} onData
 * @param {Promise<never>} [aborted]  rejects to stop reading (timeouts, caller abort)
 */
export async function readSse(body, onData, aborted = null) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let ended = false;
  const line = (raw) => {
    const l = raw.replace(/\r$/, '');
    if (!l.startsWith('data:')) return;
    const data = l.slice(5).trim();
    if (data && data !== '[DONE]') onData(data);
  };
  try {
    for (;;) {
      const { value, done } = await (aborted ? Promise.race([reader.read(), aborted]) : reader.read());
      if (done) {
        ended = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer) line(buffer);
  } finally {
    if (!ended) reader.cancel().catch(() => {});
  }
}

/**
 * @param {Response} res  a streaming (text/event-stream) chat.completions response
 * @param {object} [opts]
 * @param {() => number} [opts.clock]  ms clock (default performance.now)
 * @param {number} [opts.started]  when the request was sent (default: now)
 * @param {(call: object, ms: number) => void} [opts.onToolName]
 * @param {(call: object, ms: number) => void} [opts.onToolArgs]
 * @param {(content: string, ms: number) => void} [opts.onContent]
 * @param {Promise<never>} [opts.aborted]
 */
export async function readToolStream(res, { clock = () => performance.now(), started = clock(), onToolName, onToolArgs, onContent, aborted } = {}) {
  const calls = [];
  const timings = { ttft: null, first_tool_name: null, done: null };
  let content = '';
  let finishReason = null;
  let usage = null;
  let model = null;
  let requestId = null;
  const since = () => Math.round(clock() - started);
  const safe = (fn, ...a) => {
    try {
      fn?.(...a);
    } catch {
      // a listener must never break the stream
    }
  };
  const close = (call) => {
    if (call.closed) return;
    call.closed = true;
    try {
      call.args = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    } catch (e) {
      call.args = null;
      call.error = `arguments are not JSON: ${String(e.message).slice(0, 120)}`;
    }
    safe(onToolArgs, publicCall(call), since());
  };

  await readSse(
    res.body,
    (data) => {
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      if (chunk.error) {
        const status = Number(chunk.error.code) || null;
        throw Object.assign(new Error(`stream error: ${String(chunk.error.message ?? JSON.stringify(chunk.error)).slice(0, 300)}`), { kind: 'stream', status });
      }
      if (chunk.model) model = chunk.model;
      if (chunk.id && !requestId) requestId = chunk.id;
      if (chunk.usage) usage = chunk.usage;
      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta ?? choice.message ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          timings.ttft ??= since();
          content += delta.content;
          safe(onContent, content, since());
        }
        for (const d of delta.tool_calls ?? []) {
          timings.ttft ??= since();
          // no index: a piece of the open call (no id, no name), else a new call (review 28.09)
          const last = calls.at(-1);
          const index = Number.isInteger(d.index) ? d.index : last && !last.closed && !d.id && !d.function?.name ? last.index : calls.length;
          let call = calls.find((c) => c.index === index);
          if (!call) {
            for (const open of calls) if (!open.closed) close(open); // a new index: the previous calls are complete
            call = { index, id: null, name: null, arguments: '', args: null, error: null, closed: false };
            calls.push(call);
          }
          if (d.id) call.id = d.id;
          const fn = d.function ?? {};
          if (typeof fn.name === 'string' && fn.name && !call.name) {
            call.name = fn.name;
            timings.first_tool_name ??= since();
            safe(onToolName, publicCall(call), since());
          }
          if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
          else if (fn.arguments && typeof fn.arguments === 'object') call.arguments += JSON.stringify(fn.arguments);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    },
    aborted,
  );
  for (const call of calls) close(call);
  timings.done = since();
  return { content, toolCalls: calls.map(publicCall), finish_reason: finishReason, usage, model, request_id: requestId, timings };
}

/** Tool calls of a non-streaming chat.completions JSON response, in the same shape. */
export function toolCallsOfMessage(message) {
  return (message?.tool_calls ?? []).map((c, index) => {
    const raw = typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {});
    let args = null;
    let error = null;
    try {
      args = raw.trim() ? JSON.parse(raw) : {};
    } catch (e) {
      error = `arguments are not JSON: ${String(e.message).slice(0, 120)}`;
    }
    return { index, id: c.id ?? null, name: c.function?.name ?? null, arguments: raw, args, error };
  });
}

function publicCall(c) {
  return { index: c.index, id: c.id, name: c.name, arguments: c.arguments, args: c.args, error: c.error };
}
