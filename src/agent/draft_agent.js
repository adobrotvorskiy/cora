// Draft of the agent brain (the plan of 27.09: one owner of the conversation — an LLM that calls
// tools — instead of the host's turn automaton plus a one-shot JSON brain). Used by the scenario
// runner (tools/run_scenarios.js) and the tool-calling probe; the agent host will grow from it.
//
//   const agent = createDraftAgent({ endpoint, apiKey, model, system });
//   const { actions, timings } = await agent.decide(input);
//   input   = {phase, speaker, queue, present, dialog: [{who, text, cut?}], events: [{type, ...}]}
//   actions = [{action: 'say'|'give_word'|'ask_done'|'open_floor'|'skip'|'leave'|'none', person?, text?}]
//
// The model answers only with tool calls (say / give_word / ask_done / open_floor / skip / leave).
// Text without a tool call becomes {action: 'none', text} (the host treats it as skip, never speaks it). The request is streamed (readToolStream): timings tell
// when the first tool name arrived — where the host would start a filler («Так…»).

import { ENDPOINTS, resolveProvider } from '../brain/client.js';
import { humanModelName, loadBrainAssets } from '../brain/prompt.js';
import { readToolStream, toolCallsOfMessage } from '../brain/tool_stream.js';
import { requireKey } from '../env.js';
import { playbookSkills } from './skills.js';

const fn = (name, description, properties = {}, required = Object.keys(properties)) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const str = (description) => ({ type: 'string', description });

export const TOOLS = Object.freeze([
  fn('say', 'Сказать вслух: ответ на вопрос, приветствие, вопрос комнате, короткую реакцию. Одна-две короткие фразы. Слово этим не передаётся, стендап не начинается, свободное слово не открывается; прощание — только через leave.', { text: str('Что сказать') }),
  fn('give_word', 'Передать слово участнику из present — единственный способ открыть стендап (первое слово) и передать слово дальше. text пустой — хост скажет стандартную передачу («Спасибо! Дальше, Глеб»); свой text — нестандартная передача (открыть стендап, ответить и передать); в нём называй только того, кому даёшь слово.', {
    person_id: str('id участника из present'),
    text: str('Своя фраза передачи или пустая строка'),
  }),
  fn('ask_done', 'Спросить у говорящего, закончил ли он («Тимур, всё?»).', { person_id: str('id говорящего') }),
  fn('open_floor', 'Все выступили (queue пуст): поблагодарить последнего и спросить, хочет ли кто-то что-то добавить или спросить. Хост скажет готовую фразу и откроет слово всем.'),
  fn('skip', 'Промолчать: говорят не с тобой, человек ещё не закончил, отвечать не нужно.'),
  fn('leave', 'Попрощаться и выйти из встречи: круг закончен и добавить нечего, или тебя по имени просят закончить.', { text: str('Прощание и передача слова на дев-синк') }),
]);

/**
 * The tools of one request: only the ones that make sense in the phase, person ids limited to the people
 * in the room (live 28.09: the model handed the word to absent people 33 times). With the host's facts
 * (conductor input): give_word only to those who may get the word (`can_give`: not the speaker, not done),
 * ask_done only when it may be asked (`ask_done`) — a tool the model cannot misuse instead of a refusal
 * after the call (review 28.09). `plain`: no enums (a server that refuses them).
 */
export function toolsFor(input, { plain = false } = {}) {
  const phase = input?.phase ?? null;
  const present = input?.present ?? [];
  const speaker = input?.speaker ?? null;
  const can = Array.isArray(input?.can_give) ? input.can_give.filter((id) => present.includes(id)) : present.filter((id) => id !== speaker);
  const byName = new Map(TOOLS.map((t) => [t.function.name, t]));
  const pick = (name, person) => {
    const t = structuredClone(byName.get(name));
    if (person && !plain) t.function.parameters.properties.person_id.enum = person;
    return t;
  };
  const out = [pick('say')];
  if (can.length) out.push(pick('give_word', can));
  if (phase === 'round' && speaker && input?.ask_done !== false) out.push(pick('ask_done', [speaker]));
  if (phase === 'round') out.push(pick('open_floor'));
  out.push(pick('skip'), pick('leave'));
  return phase ? out : TOOLS;
}

/**
 * The agent's system prompt. Without persona / skills: the base alone (scenarios on the fictional team).
 * With them (the host, step 5): the persona block and the playbook blocks of `phase` (src/agent/skills.js).
 * @param {object} o
 * @param {{id: string, display: string, vocative?: string}[]} o.roster
 * @param {string|null} [o.leadId]
 * @param {string} [o.team]
 * @param {string|null} [o.persona]   persona prompt block, variables filled
 * @param {{common: string, waiting: string, round: string, open_floor: string}|null} [o.skills]
 * @param {'waiting'|'round'|'open_floor'|null} [o.phase]
 * @param {'monday_focus'|'daily_plans'|null} [o.dayMode]
 */
export function buildSystemPrompt({ roster, leadId = null, team = 'Acme', persona = null, skills = null, phase = null, dayMode = null }) {
  // no roster here: people come in the input (present with names), so the model knows only who is in the room
  const identity = `Ты Кора, ИИ-ведущая ежедневного стендапа${team ? ` команды ${team}` : ''} в Яндекс Телемосте. Ты ИИ и не выдаёшь себя за человека. О себе в женском роде, по-русски, коротко: одна-две фразы.`;
  const playbook = skills ? [skills.common, phase ? skills[phase] : null].filter(Boolean).join('\n\n') : '';
  const day = dayMode === 'monday_focus' ? 'Сегодня понедельник: каждый рассказывает фокус недели.' : dayMode === 'daily_plans' ? 'Сегодня обычный день: каждый рассказывает планы на день.' : null;
  const parts = [
    persona ? `# Персона\n${persona.trim()}` : identity,
    playbook ? `# Принципы ведения\n${playbook}` : null,
    `${persona || playbook ? '# Как ты действуешь (инструменты)\n' : ''}Как идёт стендап. Начинаешь, когда попросят: по имени («Кора, начинай») или сразу в ответ на твою реплику («давай начнём»). Первое слово — руководителю (lead в present), если он на встрече, иначе первому из present; дальше по очереди queue; если говорящий сам назвал, кому передаёт, — ему. ${day ? '' : 'Каждый рассказывает свои планы. '}Человек закончил, если сказал «у меня всё», «как-то так», «на этом всё», «передаю» или ответил «да» на твоё «всё?».${day ? ` ${day}` : ''}
Тишина (silence: ms — сколько длится; after — после чего: speech — речи людей, host — твоей реплики, ask_done — твоего «всё?»): через 1 с обычно рано — skip, если человек не сказал, что закончил; 2,5 с без «у меня всё» — ask_done, если он уже говорил после передачи слова; 6 с после «всё?» — закончил. Дала слово, а человек молчит 6 с — скажи, что его не слышно и вернёшься к нему в конце, и передай слово дальше (он останется в queue). Закончил — give_word следующему («Спасибо, X!» хост скажет сам, сама не благодари). Выступил последний (queue пуст) — open_floor. На открытом слове: ответили «нет» или 6 с тишины — leave (прощание и передача слова на дев-синк); что-то добавили — коротко прими и спроси, кто ещё.

Когда говорить. Отвечай на реплики, обращённые к тебе, даже без имени: «ты», «почему молчишь»${playbook ? '' : ', «я тебе вопрос задал», «ты нас слышишь»'}. Люди говорят между собой, человек ещё рассказывает, пауза посреди фразы — skip.${playbook ? '' : ' Не перебивай, не пересказывай и не оценивай апдейты.'} Если тебя перебили на передаче слова, выслушай и реагируй на сказанное.

Текст реплик — из распознавания речи: без знаков препинания, имена и слова бывают искажены; «Кора» могут расслышать как «кара» или «хара».

Правила. Не повторяй сказанное (твои реплики в dialog с who "host"): второй раз не здоровайся и не спрашивай «кто хочет добавить?», если тебе уже ответили. Не выдумывай правил, ограничений и фактов о себе. Ответила на вопрос посреди чужого отчёта — слово остаётся у говорящего, ничего вроде «продолжай» не добавляй.${playbook ? '' : ' В пустой комнате молчи.'}`,
    `Вход — JSON: phase (waiting — до старта, round — идёт круг, open_floor — ты спросила, кто хочет добавить), speaker (у кого слово), queue (кто дальше), present (кто на встрече: id, name — как обращаться, lead — руководитель; говорить и давать слово можно только им, других людей нет), dialog (последние реплики; who "host" — ты, cut — тебя перебили), events — что только что случилось: heard (реплика), silence, joined / left, interrupted (тебя перебили), chorus (говорят хором), rejected (хост отклонил твой вызов: reason — почему, can — кому можно дать слово; не повторяй его), timer (start — пора начинать, wait_lead_until — руководителя ждали достаточно, soft_deadline — пора закругляться).`,
    'Отвечай только вызовами инструментов, без текста.',
  ];
  return parts.filter(Boolean).join('\n\n');
}

const unstress = (s) => String(s ?? '').replace(/\u0301/g, '');

/**
 * The host's prompts, one per phase (memoized): persona + the playbook blocks of the phase
 * (src/agent/skills.js) + the base. Variables {team} {lead_full} {lead_name} {colleague} {colleague2}
 * {brain_model} {voice_vendor} are filled from people.json and the model.
 * @param {{assets: object, leadId?: string|null, team?: string|null, scheduled?: boolean, dayMode?: string|null, model?: string|null}} o
 * @returns {(phase: string|null) => string}
 */
export function agentPrompts({ assets, leadId = null, team = null, scheduled = false, dayMode = null, model = null }) {
  const people = (assets?.people ?? []).filter((p) => !p.exclude).map((p) => ({ id: p.id, display: p.display, vocative: unstress(p.vocative ?? p.spoken ?? '') || null }));
  const lead = people.find((p) => p.id === leadId);
  const others = people.filter((p) => p.id !== leadId);
  const vars = {
    team: team || 'команды',
    lead_full: lead?.display ?? 'руководитель',
    lead_name: lead?.vocative ?? lead?.display?.split(/\s+/)[0] ?? 'руководитель',
    colleague: others[0]?.vocative ?? 'коллега',
    colleague2: others[1]?.vocative ?? 'коллега',
    brain_model: humanModelName(model),
    voice_vendor: 'Яндекс SpeechKit',
  };
  const fill = (t) => unstress(t).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
  const persona = assets?.personaBlock ? fill(assets.personaBlock) : null;
  const skills = assets?.playbook ? playbookSkills(fill(assets.playbook), { scheduled }) : null;
  const cache = new Map();
  return (phase = null) => {
    const key = phase ?? '';
    if (!cache.has(key)) cache.set(key, buildSystemPrompt({ roster: people, leadId, team: team ?? '', persona, skills, phase, dayMode }));
    return cache.get(key);
  };
}

/** The user message for one decision. present: [{id, name, lead?}] — the only people she may address or give the word to. */
export function renderInput(input) {
  const names = input.names ?? {};
  return JSON.stringify({
    phase: input.phase,
    speaker: input.speaker ?? null,
    queue: input.queue ?? [],
    present: (input.present ?? []).map((id) => ({ id, name: names[id] ?? id, ...(id === input.lead ? { lead: true } : {}) })),
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
 * @param {string|((phase: string|null) => string)} o.system  system prompt (buildSystemPrompt), or one per phase (agentPrompts)
 * @param {Function} [o.fetch]
 * @param {number} [o.timeoutMs]
 * @param {boolean} [o.stream]
 * @param {number} [o.temperature]
 * @param {string|null} [o.reasoningEffort]  reasoning_effort for models that think (Gemini): less thinking, faster answers
 * @param {number} [o.maxTokens]  output cap; a thinking model spends part of it on thoughts (Gemini: 2048)
 * @param {boolean} [o.streamUsage]  ask for token usage in the stream (stream_options.include_usage; Gemini sends none otherwise)
 * @param {'openai'|'openrouter'} [o.reasoningFormat]  how the effort is sent: reasoning_effort (Gemini API), or
 *   OpenRouter's reasoning: {effort} / {enabled: false} for "none"
 */
export function createDraftAgent({ endpoint, apiKey, model, system, fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000, stream = true, temperature = 0.2, reasoningEffort = null, maxTokens = 400, streamUsage = false, reasoningFormat = 'openai' }) {
  let toolChoice = 'required';
  let plainTools = false; // the server refused enum in the tool schema: plain ids from then on
  let effort = reasoningEffort; // dropped for good if the server refuses it
  let usageOpt = streamUsage; // dropped for good if the server refuses it
  async function post(input, signal) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const started = performance.now();
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'system', content: typeof system === 'function' ? system(input.phase ?? null) : system }, { role: 'user', content: renderInput(input) }],
          tools: toolsFor(input, { plain: plainTools }),
          tool_choice: toolChoice,
          temperature,
          max_tokens: maxTokens,
          ...(effort ? (reasoningFormat === 'openrouter' ? { reasoning: effort === 'none' ? { enabled: false } : { effort } } : { reasoning_effort: effort }) : {}),
          ...(stream ? { stream: true, ...(usageOpt ? { stream_options: { include_usage: true } } : {}) } : {}),
        }),
        signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return { res, started };
      const text = (await res.text().catch(() => '')).slice(0, 400);
      if (res.status === 400 && toolChoice === 'required' && /tool_choice|required/i.test(text)) {
        toolChoice = 'auto'; // AI Studio may refuse "required": fall back once, for the whole session
        continue;
      }
      if (res.status === 400 && usageOpt && /stream_options|include_usage/i.test(text)) {
        usageOpt = false;
        continue;
      }
      if (res.status === 400 && effort && /reasoning|thinking/i.test(text)) {
        effort = null;
        continue;
      }
      if (res.status === 400 && !plainTools && /enum|schema|parameters/i.test(text)) {
        plainTools = true;
        continue;
      }
      throw Object.assign(new Error(`HTTP ${res.status}: ${text}`), { status: res.status });
    }
    throw new Error('tool schema fallback failed');
  }
  return {
    get toolChoice() {
      return toolChoice;
    },
    /** @param {object} input  @param {{signal?: AbortSignal}} [o]  signal: the host aborts a decision a newer event made stale */
    async decide(input, { signal } = {}) {
      const { res, started } = await post(input, signal);
      if (/event-stream/i.test(res.headers.get('content-type') ?? '')) {
        const r = await readToolStream(res, { started });
        return { actions: toActions(r.toolCalls, r.content), timings: r.timings, usage: r.usage, finish_reason: r.finish_reason ?? null };
      }
      const json = await res.json();
      const msg = json.choices?.[0]?.message ?? {};
      return { actions: toActions(toolCallsOfMessage(msg), msg.content), timings: { done: Math.round(performance.now() - started) }, usage: json.usage ?? null, finish_reason: json.choices?.[0]?.finish_reason ?? null };
    },
  };
}

export const AGENT_PROVIDERS = Object.freeze(['yandex', 'google', 'openrouter']);

/**
 * The agent for the host (voice.host = "agent"). settings.agent.provider:
 * - "yandex" (default): Yandex AI Studio, key and folder as for the brain (settings.keys.yandex,
 *   settings.yandex.folder), model settings.agent.model or brain.yandex_model;
 * - "google": Gemini through the Gemini API with a Google AI Studio key (the owner's choice of 28.09,
 *   after aliceai-llm-flash kept ignoring the tools' rules), its OpenAI-compatible endpoint; key
 *   settings.keys.google, model settings.agent.model or brain.google_model; thinking kept low
 *   (agent.reasoning_effort, default "low" — dropped if the model refuses it);
 * - "openrouter": any model with tool calls behind OpenRouter, key settings.keys.openrouter, model
 *   settings.agent.model or brain.openrouter_model.
 * @param {{settings: object, roster: {people: object[], firstAlways?: string|null, teamName?: string|null}, env?: object, fetch?: Function}} o
 */
export function agentFromSettings({ settings, roster, dayMode = null, env = process.env, fetch: fetchImpl, assets = loadBrainAssets(), log = null, now = () => Date.now() }) {
  const primary = oneAgent({ settings, roster, dayMode, env, fetchImpl, assets });
  // a cloud model that is overloaded or out of quota (live 28.09, Gemini: 503 and 429 on 18 of 21 calls) must not
  // leave her mute: the decision goes to the fallback (Yandex by default), and for a while every decision does
  const fb = settings.agent?.fallback === undefined ? (primary.provider === 'yandex' ? null : 'yandex') : settings.agent.fallback;
  if (!fb || fb === primary.provider) return primary;
  let secondary = null;
  try {
    // the primary's model, endpoint and thinking settings are not the fallback's (review 28.09: a proxy for Gemini got the Yandex key)
    secondary = oneAgent({ settings: { ...settings, agent: { ...(settings.agent ?? {}), provider: fb, model: undefined, endpoint: undefined, reasoning_effort: undefined, max_tokens: undefined } }, roster, dayMode, env, fetchImpl, assets });
  } catch (e) {
    log?.event?.('agent.fallback_unavailable', { provider: fb, message: String(e?.message ?? e).slice(0, 200) });
    return primary;
  }
  return withFallback(primary, secondary, { log, now });
}

/** Status codes worth moving to the fallback for: overloaded, out of quota, down. */
const retryable = (e) => e?.status === 429 || (e?.status >= 500 && e?.status < 600) || e?.name === 'TimeoutError' || e?.name === 'TypeError';
const COOLDOWN_MS = { 429: 60_000, default: 20_000 };

/**
 * The primary agent, and the secondary one when it fails (429 / 5xx / timeout / network). After a failure the
 * secondary answers directly for a cooldown (60 s after 429, 20 s otherwise), then the primary is tried again.
 * The secondary failing during the cooldown ends it: the next decision tries the primary (review 28.09).
 * The result carries fallback: {from, to, reason}.
 */
export function withFallback(primary, secondary, { log = null, now = () => Date.now() } = {}) {
  let coolUntil = 0;
  let lastReason = null;
  const tag = (r, reason) => ({ ...r, fallback: { from: primary.provider, to: secondary.provider, reason } });
  return {
    model: primary.model,
    provider: primary.provider,
    prompt: primary.prompt,
    get toolChoice() {
      return primary.toolChoice;
    },
    async decide(input, o = {}) {
      if (now() < coolUntil) {
        try {
          return tag(await secondary.decide(input, o), lastReason);
        } catch (e) {
          if (!o.signal?.aborted) {
            coolUntil = 0;
            log?.event?.('agent.fallback_failed', { provider: secondary.provider, message: String(e?.message ?? e).slice(0, 160) });
          }
          throw e;
        }
      }
      try {
        return await primary.decide(input, o);
      } catch (e) {
        if (o.signal?.aborted || !retryable(e)) throw e;
        lastReason = e.status ?? e.name;
        coolUntil = now() + (COOLDOWN_MS[e.status] ?? COOLDOWN_MS.default);
        log?.event?.('agent.fallback', { from: primary.provider, to: secondary.provider, reason: lastReason, cooldown_ms: coolUntil - now(), message: String(e?.message ?? e).slice(0, 160) });
        return tag(await secondary.decide(input, o), lastReason);
      }
    },
  };
}

function oneAgent({ settings, roster, dayMode, env, fetchImpl, assets }) {
  const provider = settings.agent?.provider ?? 'yandex';
  if (!AGENT_PROVIDERS.includes(provider)) throw new Error(`agent.provider must be ${AGENT_PROVIDERS.join('|')}`);
  const sel = resolveProvider(settings, { env, provider, model: settings.agent?.model });
  const system = agentPrompts({
    assets: { ...assets, people: roster?.people ?? assets.people },
    leadId: roster?.firstAlways ?? assets.firstAlways ?? null,
    team: roster?.teamName ?? assets.teamName ?? null,
    scheduled: Boolean(settings.times?.start),
    dayMode,
    model: provider === 'google' && !sel.model.includes('/') ? `google/${sel.model}` : sel.model, // «Gemini … от Google» in the persona
  });
  const agent = createDraftAgent({
    endpoint: settings.agent?.endpoint ?? ENDPOINTS[provider],
    apiKey: requireKey(sel.keyName, env),
    model: sel.model,
    system,
    timeoutMs: settings.agent?.timeout_ms ?? 8000,
    temperature: settings.agent?.temperature ?? 0.2,
    reasoningEffort: settings.agent?.reasoning_effort ?? (provider === 'google' ? 'low' : null),
    reasoningFormat: provider === 'openrouter' ? 'openrouter' : 'openai',
    // thinking models count their thoughts in the cap (live 28.09, gemini-3.8-flash via OpenRouter: ~180 tokens of
    // thought per decision, one empty answer at the 400 cap)
    maxTokens: settings.agent?.max_tokens ?? (provider === 'yandex' ? 400 : 2048),
    streamUsage: provider !== 'yandex',
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return Object.assign(agent, { model: sel.model, provider, prompt: system });
}
