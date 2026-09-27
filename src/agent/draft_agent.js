// Draft of the agent brain (the plan of 27.09: one owner of the conversation — an LLM that calls
// tools — instead of the host's turn automaton plus a one-shot JSON brain). Used by the scenario
// runner (tools/run_scenarios.js) and the tool-calling probe; the agent host will grow from it.
//
//   const agent = createDraftAgent({ settings, roster });
//   const { actions, timings } = await agent.decide(input);
//   input   = {phase, speaker, queue, present, dialog: [{who, text, cut?}], events: [{type, ...}]}
//   actions = [{action: 'say'|'give_word'|'ask_done'|'open_floor'|'skip'|'leave'|'none', person?, text?}]
//
// The model answers only with tool calls (say / give_word / ask_done / open_floor / skip / leave).
// Text without a tool call becomes {action: 'none', text} (the host treats it as skip, never speaks it). The request is streamed (readToolStream): timings tell
// when the first tool name arrived — where the host would start a filler («Так…»).

import { readToolStream, toolCallsOfMessage } from '../brain/tool_stream.js';

const fn = (name, description, properties = {}, required = Object.keys(properties)) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const str = (description) => ({ type: 'string', description });

export const TOOLS = Object.freeze([
  fn('say', 'Сказать вслух: ответ на вопрос, приветствие, вопрос комнате, короткую реакцию. Одна-две короткие фразы.', { text: str('Что сказать') }),
  fn('give_word', 'Передать слово участнику. text пустой — хост скажет стандартную передачу («Спасибо! Дальше, Глеб»); свой text — нестандартная передача (открыть стендап, ответить и передать).', {
    person_id: str('id участника'),
    text: str('Своя фраза передачи или пустая строка'),
  }),
  fn('ask_done', 'Спросить у говорящего, закончил ли он («Тимур, всё?»).', { person_id: str('id говорящего') }),
  fn('open_floor', 'Все выступили (queue пуст): поблагодарить последнего и спросить, хочет ли кто-то что-то добавить или спросить. Хост скажет готовую фразу и откроет слово всем.'),
  fn('skip', 'Промолчать: говорят не с тобой, человек ещё не закончил, отвечать не нужно.'),
  fn('leave', 'Попрощаться и выйти из встречи, когда круг закончен и добавить нечего.', { text: str('Прощание и передача слова на дев-синк') }),
]);

/**
 * @param {{roster: {id: string, display: string, vocative?: string}[], leadId?: string|null, team?: string}} o
 */
export function buildSystemPrompt({ roster, leadId = null, team = 'Acme' }) {
  const lead = roster.find((p) => p.id === leadId);
  const people = roster.map((p) => `${p.id} — ${p.display}${p.vocative ? ` (зовёшь «${p.vocative.replace(/́/g, '')}»)` : ''}${p.id === leadId ? ', руководитель' : ''}`).join('; ');
  return `Ты Кора, ИИ-ведущая ежедневного стендапа команды ${team} в Яндекс Телемосте. Ты ИИ и не выдаёшь себя за человека. О себе в женском роде, по-русски, коротко: одна-две фразы.

Как идёт стендап. Начинаешь, когда попросят: по имени («Кора, начинай») или сразу в ответ на твою реплику («давай начнём»). Первое слово — ${lead ? `${lead.display}, если он на встрече` : 'первому из присутствующих'}, дальше по очереди queue; если говорящий сам назвал, кому передаёт, — ему. Каждый рассказывает свои планы. Человек закончил, если сказал «у меня всё», «как-то так», «на этом всё», «передаю» или ответил «да» на твоё «всё?».
Тишина (события silence, ms — сколько длится): 1 с после фразы — обычно ещё рано, skip, если человек не сказал, что закончил; 2,5 с без «у меня всё» — спроси «всё?» (ask_done); 6 с тишины после «всё?» — считай, что закончил. Закончил — передай слово следующему (give_word; хост сам поблагодарит). Выступил последний (queue пуст) — open_floor. На открытом слове: ответили «нет» или 6 с тишины — попрощайся и передай слово на дев-синк (leave); что-то добавили — коротко прими и спроси, кто ещё.

Когда говорить. Отвечай на реплики, обращённые к тебе, даже без имени: «ты», «почему молчишь», «я тебе вопрос задал», «ты нас слышишь». Люди говорят между собой, человек ещё рассказывает, пауза посреди фразы — skip. Не перебивай, не пересказывай и не оценивай апдейты. Если тебя перебили на передаче слова, выслушай и реагируй на сказанное.

Текст реплик — из распознавания речи: без знаков препинания, имена и слова бывают искажены; «Кора» могут расслышать как «кара» или «хара».

Правила. Не повторяй то, что уже сказала (твои реплики в dialog с who "host"); второй раз не здоровайся и не спрашивай «кто хочет добавить?», если тебе уже ответили. Не выдумывай правил, ограничений и фактов о себе. Ответила на вопрос посреди чужого отчёта — слово остаётся у говорящего, ничего вроде «продолжай» не добавляй. В пустой комнате молчи.

Вход — JSON: phase (waiting — до старта, round — идёт круг, open_floor — ты спросила, кто хочет добавить), speaker (у кого слово), queue (кто дальше по очереди), present (кто на встрече), dialog (последние реплики; who "host" — это ты, cut — тебя перебили), events (что только что случилось: heard — реплика, silence — тишина ms, joined / left — пришёл / ушёл, interrupted — тебя перебили, chorus — говорят хором, rejected — хост отклонил твой прошлый вызов, reason — почему; не повторяй его).

Участники (id — имя): ${people}.

Отвечай только вызовами инструментов, без текста.`;
}

/** The user message for one decision. */
export function renderInput(input) {
  return JSON.stringify({
    phase: input.phase,
    speaker: input.speaker ?? null,
    queue: input.queue ?? [],
    present: input.present ?? [],
    dialog: (input.dialog ?? []).slice(-12),
    events: input.events ?? [],
  });
}

/** Tool calls (+ stray text) -> normalized actions. */
export function toActions(toolCalls, content = '') {
  const out = [];
  for (const c of toolCalls ?? []) {
    const a = c.args ?? {};
    const text = typeof a.text === 'string' && a.text.trim() ? a.text.trim() : null;
    if (c.name === 'say') out.push({ action: 'say', text });
    else if (c.name === 'give_word') out.push({ action: 'give_word', person: a.person_id ?? null, text });
    else if (c.name === 'ask_done') out.push({ action: 'ask_done', person: a.person_id ?? null });
    else if (c.name === 'open_floor') out.push({ action: 'open_floor' });
    else if (c.name === 'skip') out.push({ action: 'skip' });
    else if (c.name === 'leave') out.push({ action: 'leave', text });
    else out.push({ action: 'unknown', name: c.name, args: c.args, error: c.error ?? null });
  }
  if (!out.length && String(content ?? '').trim()) out.push({ action: 'none', text: String(content).trim().slice(0, 300) });
  return out;
}

/**
 * @param {object} o
 * @param {string} o.endpoint  chat.completions URL
 * @param {string} o.apiKey
 * @param {string} o.model
 * @param {string} o.system    system prompt (buildSystemPrompt)
 * @param {Function} [o.fetch]
 * @param {number} [o.timeoutMs]
 * @param {boolean} [o.stream]
 * @param {number} [o.temperature]
 */
export function createDraftAgent({ endpoint, apiKey, model, system, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000, stream = true, temperature = 0.2 }) {
  let toolChoice = 'required';
  async function post(input) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = performance.now();
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: system }, { role: 'user', content: renderInput(input) }],
          tools: TOOLS,
          tool_choice: toolChoice,
          temperature,
          max_tokens: 400,
          ...(stream ? { stream: true } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { res, started };
      const text = (await res.text().catch(() => '')).slice(0, 400);
      if (res.status === 400 && toolChoice === 'required' && /tool_choice|required/i.test(text)) {
        toolChoice = 'auto'; // AI Studio may refuse "required": fall back once, for the whole session
        continue;
      }
      throw Object.assign(new Error(`HTTP ${res.status}: ${text}`), { status: res.status });
    }
    throw new Error('tool_choice fallback failed');
  }
  return {
    get toolChoice() {
      return toolChoice;
    },
    async decide(input) {
      const { res, started } = await post(input);
      if (/event-stream/i.test(res.headers.get('content-type') ?? '')) {
        const r = await readToolStream(res, { started });
        return { actions: toActions(r.toolCalls, r.content), timings: r.timings, usage: r.usage };
      }
      const json = await res.json();
      const msg = json.choices?.[0]?.message ?? {};
      return { actions: toActions(toolCallsOfMessage(msg), msg.content), timings: { done: Math.round(performance.now() - started) }, usage: json.usage ?? null };
    },
  };
}
