// Streaming tool calls (src/brain/tool_stream.js): OpenAI-compatible SSE deltas, no network.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readToolStream, toolCallsOfMessage } from '../../src/brain/tool_stream.js';

function sse(chunks, { delayMs = 0 } = {}) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        controller.enqueue(enc.encode(typeof c === 'string' ? `data: ${c}\n\n` : `data: ${JSON.stringify(c)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const tool = (index, fn, id) => ({ choices: [{ delta: { tool_calls: [{ index, ...(id ? { id, type: 'function' } : {}), function: fn }] } }] });

describe('readToolStream', () => {
  test('two streamed calls: the name is known before the arguments, each call closes when the next starts', async () => {
    const order = [];
    const r = await readToolStream(
      sse(
        [
          ': keep-alive',
          { id: 'chatcmpl-1', model: 'm', choices: [{ delta: { role: 'assistant' } }] },
          tool(0, { name: 'say', arguments: '' }, 'call_a'),
          tool(0, { arguments: '{"text": "Спасибо, Тимур' }),
          tool(0, { arguments: '!"}' }),
          tool(1, { name: 'give_word', arguments: '{"person_id":' }, 'call_b'),
          tool(1, { arguments: ' "nevsky_g"}' }),
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          { choices: [], usage: { prompt_tokens: 900, completion_tokens: 30 } },
          '[DONE]',
        ],
        { delayMs: 5 },
      ),
      { onToolName: (c) => order.push(`name:${c.name}`), onToolArgs: (c) => order.push(`args:${c.name}:${JSON.stringify(c.args)}`) },
    );
    assert.deepEqual(order, ['name:say', 'args:say:{"text":"Спасибо, Тимур!"}', 'name:give_word', 'args:give_word:{"person_id":"nevsky_g"}']);
    assert.deepEqual(r.toolCalls.map((c) => [c.id, c.name, c.args]), [['call_a', 'say', { text: 'Спасибо, Тимур!' }], ['call_b', 'give_word', { person_id: 'nevsky_g' }]]);
    assert.equal(r.finish_reason, 'tool_calls');
    assert.equal(r.usage.prompt_tokens, 900);
    assert.equal(r.request_id, 'chatcmpl-1');
    assert.ok(r.timings.first_tool_name >= r.timings.ttft && r.timings.first_tool_name < r.timings.done, JSON.stringify(r.timings));
  });

  test('a whole call in one chunk, object arguments, content without tools, broken arguments', async () => {
    const one = await readToolStream(sse([tool(0, { name: 'skip', arguments: {} }, 'c1'), '[DONE]']));
    assert.deepEqual(one.toolCalls.map((c) => [c.name, c.args]), [['skip', {}]]);
    const text = await readToolStream(sse([{ choices: [{ delta: { content: 'Привет' } }] }, { choices: [{ delta: { content: '!' }, finish_reason: 'stop' }] }]));
    assert.equal(text.content, 'Привет!');
    assert.deepEqual(text.toolCalls, []);
    const broken = await readToolStream(sse([tool(0, { name: 'say', arguments: '{"text": "обрыв' }, 'c2')]));
    assert.equal(broken.toolCalls[0].args, null);
    assert.match(broken.toolCalls[0].error, /not JSON/);
  });

  test('an error chunk rejects; non-streaming messages parse the same way', async () => {
    await assert.rejects(readToolStream(sse([{ error: { code: 429, message: 'rate limit' } }])), (e) => e.kind === 'stream' && e.status === 429);
    const calls = toolCallsOfMessage({ tool_calls: [{ id: 'x', type: 'function', function: { name: 'leave', arguments: '{"text":"Пока!"}' } }] });
    assert.deepEqual(calls.map((c) => [c.name, c.args]), [['leave', { text: 'Пока!' }]]);
    assert.deepEqual(toolCallsOfMessage({ content: 'hi' }), []);
  });

  test('review 28.09: argument deltas without an index extend the open call', async () => {
    const d = (fn, id) => ({ choices: [{ delta: { tool_calls: [{ ...(id ? { id, type: 'function' } : {}), function: fn }] } }] });
    const r = await readToolStream(sse([d({ name: 'say', arguments: '' }, 'c1'), d({ arguments: '{"text":"Слы' }), d({ arguments: 'шу!"}' }), d({ name: 'skip', arguments: '{}' }, 'c2'), '[DONE]']));
    assert.deepEqual(r.toolCalls.map((c) => [c.name, c.args]), [['say', { text: 'Слышу!' }], ['skip', {}]]);
  });
});
