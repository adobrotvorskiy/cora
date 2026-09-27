#!/usr/bin/env node
// Probe for the agent host: does Yandex AI Studio call tools (function calling) for the brain model,
// in a stream, several at once, and how early does the tool name arrive (the moment a filler
// «Так…» could start)? Five situations of a standup with a fictional team, each asked twice:
// without a stream (does the API accept `tools` at all) and with one (timings). Network; synthetic
// data only; key values are never printed.
//
//   node tools/probe_agent_tools.js [--model aliceai-llm-flash/latest] [--rounds 1] [--verbose]
//        [--endpoint URL] [--folder ID]   (a local mock / another folder, for testing the probe itself)
//
// Reads settings.keys.yandex (the key env name), settings.yandex.folder, settings.brain.yandex_model.

import { parseArgs } from 'node:util';
import { ENDPOINTS } from '../src/brain/client.js';
import { readToolStream, toolCallsOfMessage } from '../src/brain/tool_stream.js';
import { loadSettings } from '../src/config.js';
import { loadEnv, requireKey } from '../src/env.js';

const { values } = parseArgs({
  options: {
    model: { type: 'string' },
    rounds: { type: 'string', default: '1' },
    timeout: { type: 'string', default: '15000' },
    verbose: { type: 'boolean', short: 'v', default: false },
    endpoint: { type: 'string' },
    folder: { type: 'string' },
  },
});

// ---- the draft agent: tools and a short prompt (fictional team) ----------------------------------

const fn = (name, description, properties = {}, required = Object.keys(properties)) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const str = (description) => ({ type: 'string', description });
export const TOOLS = [
  fn('say', 'Сказать вслух: ответ на вопрос, приветствие, вопрос комнате. Одна-две короткие фразы.', { text: str('Что сказать') }),
  fn('give_word', 'Передать слово участнику. text пустой — хост скажет стандартную передачу («Спасибо! Дальше, Глеб»).', { person_id: str('id участника'), text: str('Своя фраза передачи или пустая строка') }),
  fn('ask_done', 'Спросить у говорящего, закончил ли он («Тимур, всё?»).', { person_id: str('id говорящего') }),
  fn('skip', 'Промолчать: говорят не с тобой, человек ещё не закончил, отвечать не нужно.'),
  fn('leave', 'Попрощаться и выйти из встречи, когда круг закончен и добавить нечего.', { text: str('Прощание и передача слова на дев-синк') }),
];

const SYSTEM = `Ты Кора, ИИ-ведущая ежедневного стендапа команды Acme в Яндекс Телемосте. О себе в женском роде, коротко, по-русски.
Ты ведёшь круг: каждый по очереди рассказывает планы; ты даёшь слово, спрашиваешь «всё?», когда человек замолчал, передаёшь слово следующему, отвечаешь на вопросы к тебе (к тебе обращаются и без имени: «ты», «почему молчишь»), в конце спрашиваешь, хочет ли кто-то добавить, и прощаешься.
На каждое событие отвечай только вызовами инструментов, без текста. Если говорят не с тобой или человек не закончил — skip. Не выдумывай правил и фактов о себе.
Участники (id — имя): tkach_t — Тимур Ткач; nevsky_g — Глеб Невский; orlov_y — Ярослав Орлов (руководитель).
Событие приходит JSON-объектом: phase, speaker (у кого слово), queue (кто следующий), present (кто на встрече), dialog (последние реплики, who "host" — это ты), event (что случилось).`;

export const CASES = [
  {
    id: 'greeting',
    expect: ['say'],
    event: { phase: 'waiting', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g'], dialog: [{ who: 'tkach_t', text: 'Кора, привет! Ты меня слышишь?' }], event: 'heard' },
  },
  {
    id: 'no_name_question',
    expect: ['say'],
    event: {
      phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'], present: ['tkach_t', 'nevsky_g'],
      dialog: [{ who: 'host', text: 'Тимур, всё?' }, { who: 'tkach_t', text: 'я тебе вопрос задал почему ты до этого молчала' }], event: 'heard',
    },
  },
  {
    id: 'colleagues',
    expect: ['skip'],
    event: {
      phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'], present: ['tkach_t', 'nevsky_g', 'orlov_y'],
      dialog: [{ who: 'tkach_t', text: 'сегодня добиваю интеграцию потом ревью' }, { who: 'nevsky_g', text: 'Тимур а ты вчера билд поправил' }], event: 'heard',
    },
  },
  {
    id: 'turn_end',
    expect: ['give_word'],
    event: {
      phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'], present: ['tkach_t', 'nevsky_g', 'orlov_y'],
      dialog: [{ who: 'tkach_t', text: 'сегодня добиваю интеграцию потом ревью вот у меня всё' }], event: 'silence_1s',
    },
  },
  {
    id: 'open_floor_done',
    expect: ['leave'],
    event: {
      phase: 'open_floor', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g', 'orlov_y'],
      dialog: [{ who: 'host', text: 'Все высказались. Кто хочет что-то добавить?' }, { who: 'nevsky_g', text: 'нет вроде всё' }], event: 'silence_3s',
    },
  },
];

// ---- run ------------------------------------------------------------------------------------------

async function main() {
  loadEnv();
  const settings = loadSettings();
  const keyName = settings.keys?.yandex;
  const folder = values.folder ?? settings.yandex?.folder;
  const endpoint = values.endpoint ?? ENDPOINTS.yandex;
  if (!keyName || !folder) {
    console.error('need settings.keys.yandex (env name of the Yandex Cloud key) and settings.yandex.folder (settings.local.json)');
    return 64;
  }
  const apiKey = requireKey(keyName);
  const bare = values.model ?? settings.brain?.yandex_model ?? 'aliceai-llm-flash/latest';
  const model = bare.startsWith('gpt://') ? bare : `gpt://${folder}/${bare}`;
  const timeoutMs = Number(values.timeout);
  console.log(`model ${model}; key ${keyName} present; ${CASES.length} situations x ${values.rounds} round(s)\n`);

  let toolChoice = 'required';
  const post = async (event, stream) => {
    const body = {
      model,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: JSON.stringify(event) }],
      tools: TOOLS,
      tool_choice: toolChoice,
      temperature: 0.2,
      max_tokens: 400,
      ...(stream ? { stream: true } : {}),
    };
    const started = performance.now();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { res, started };
  };
  /** One request; a 400 about tool_choice drops to 'auto' once. */
  const ask = async (event, stream) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { res, started } = await post(event, stream);
      if (res.ok) return { res, started };
      const text = (await res.text().catch(() => '')).slice(0, 400);
      if (res.status === 400 && toolChoice === 'required' && /tool_choice|required/i.test(text)) {
        console.log(`   tool_choice "required" refused (${text.slice(0, 160)}); retrying with "auto"`);
        toolChoice = 'auto';
        continue;
      }
      throw Object.assign(new Error(`HTTP ${res.status}: ${text}`), { status: res.status });
    }
    throw new Error('unreachable');
  };

  const rows = [];
  let toolsWork = null;
  for (let round = 0; round < Number(values.rounds); round++) {
    for (const c of CASES) {
      const row = { id: c.id, expect: c.expect.join('+') };
      try {
        // 1) no stream: are tools accepted and used?
        const a = await ask(c.event, false);
        const json = await a.res.json();
        const msg = json.choices?.[0]?.message ?? {};
        const calls = toolCallsOfMessage(msg);
        row.plain = calls.length ? calls.map(show).join(' ') : `text: «${String(msg.content ?? '').slice(0, 80)}»`;
        row.plain_ms = Math.round(performance.now() - a.started);
        row.prompt_tokens = json.usage?.prompt_tokens ?? null;
        if (calls.length) toolsWork = true;
        else toolsWork ??= false;
        if (values.verbose) console.log(`   ${c.id} raw: ${JSON.stringify(json).slice(0, 600)}`);
        // 2) stream: when does the tool name arrive?
        const b = await ask(c.event, true);
        const streamed = /event-stream/i.test(b.res.headers.get('content-type') ?? '');
        if (!streamed) {
          row.stream = 'no event-stream (API ignored stream: true)';
        } else {
          const r = await readToolStream(b.res, { started: b.started });
          row.stream = r.toolCalls.length ? r.toolCalls.map(show).join(' ') : `text: «${r.content.slice(0, 80)}»`;
          row.ttft = r.timings.ttft;
          row.name_ms = r.timings.first_tool_name;
          row.done_ms = r.timings.done;
          row.parallel = r.toolCalls.length > 1;
          row.ok = c.expect.every((name) => r.toolCalls.some((t) => t.name === name));
        }
      } catch (e) {
        row.error = e.message.slice(0, 300);
      }
      rows.push(row);
      console.log(
        `${row.ok ? 'OK ' : row.error ? 'ERR' : '?? '} ${c.id.padEnd(17)} expect ${row.expect.padEnd(10)} | plain ${row.plain_ms ?? '-'} ms: ${row.plain ?? '-'}\n` +
          `${' '.repeat(22)}stream: ttft ${row.ttft ?? '-'} ms, tool name ${row.name_ms ?? '-'} ms, done ${row.done_ms ?? '-'} ms: ${row.stream ?? '-'}` +
          `${row.prompt_tokens ? ` | prompt ${row.prompt_tokens} tok` : ''}${row.error ? `\n${' '.repeat(22)}${row.error}` : ''}`,
      );
    }
  }
  const ok = rows.filter((r) => r.ok).length;
  const names = rows.map((r) => r.name_ms).filter((v) => v != null).sort((x, y) => x - y);
  const dones = rows.map((r) => r.done_ms).filter((v) => v != null).sort((x, y) => x - y);
  const p50 = (xs) => (xs.length ? xs[Math.floor(xs.length / 2)] : '-');
  console.log(`\ntool_choice used: ${toolChoice}`);
  console.log(`tools accepted and called: ${toolsWork === null ? 'unknown (all requests failed)' : toolsWork ? 'yes' : 'NO (the model answered with text)'}`);
  console.log(`streamed tool calls: ${rows.some((r) => r.name_ms != null) ? 'yes' : 'no'}; several calls in one answer: ${rows.some((r) => r.parallel) ? 'yes' : 'not seen'}`);
  console.log(`expected action: ${ok}/${rows.length}; tool name p50 ${p50(names)} ms, whole answer p50 ${p50(dones)} ms`);
  return rows.some((r) => r.error) ? 1 : 0;
}

function show(c) {
  const args = c.args ? Object.entries(c.args).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ') : `<${c.error}>`;
  return `${c.name}(${args})`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('probe_agent_tools.js')) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`error: ${e?.message ?? e}`);
      process.exit(1);
    },
  );
}
