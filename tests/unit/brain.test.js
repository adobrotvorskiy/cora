// Brain (WP5): action contract, context, prompt and client. The client runs against a mocked
// fetch and plain env objects: no network, no real keys, no .env files.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { CONFIG_DIR } from '../../src/config.js';
import {
  ACTIONS,
  ACTION_JSON_SCHEMA,
  completedFields,
  fixFeminine,
  parseActionText,
  sanitizeText,
  splitSentences,
  trimText,
  validate,
} from '../../src/brain/actions.js';
import { adapt, createBrain, initialCaps, priorityOf, resolveProvider } from '../../src/brain/client.js';
import { CONTEXT_KEYS, buildContext, contextTokens } from '../../src/brain/context.js';
import { buildSystemPrompt, extractPersonaBlock, humanModelName, loadBrainAssets } from '../../src/brain/prompt.js';

const tempDirs = [];
function tempDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'standup-brain-'));
  tempDirs.push(dir);
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const PARTICIPANTS = [
  { id: 'orlov_y', name: 'Ярослав Орлов', present: true, status: 'spoke' },
  { id: 'tkach_t', name: 'Тимур Ткач', present: true, status: 'speaking' },
  { id: 'nevsky_g', name: 'Глеб Невский', present: true, status: 'pending' },
  { id: 'belozerskaya_n', name: 'Нина Белозерская', present: false, status: 'absent' },
];
const CTX = {
  now: '10:05:00', day_mode: 'daily_plans', phase: 'round', deadline: { soft: '10:28', hard: '10:30' }, lead_present: true,
  participants: PARTICIPANTS, speaker: { id: 'tkach_t', conf: 'high', since_s: 40, silence_ms: 900 },
  host: { speaking: false, silent_mode: false, last_utterance: null, last_interrupted: false }, plan: { next: 'nevsky_g', then: [] },
  recent_events: [], transcript_window: [{ t: '10:04:58', who: 'tkach_t', text: 'У меня всё.' }], trigger: 'turn_end_candidate',
};
const GIVE = { why: 'Тимур закончил', action: 'give_word', to: 'nevsky_g', text: null, plan: { next: null, then: [] } };

// ------------------------------------------------------------------ actions

describe('actions: schema, validation, normalization', () => {
  test('JSON schema is strict-mode shaped (all keys required, no extra keys, null unions)', () => {
    const s = ACTION_JSON_SCHEMA;
    assert.equal(s.type, 'object');
    assert.equal(s.additionalProperties, false);
    assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
    assert.deepEqual(Object.keys(s.properties), ['why', 'action', 'to', 'text', 'plan']);
    assert.deepEqual(s.properties.action.enum, [...ACTIONS]);
    assert.deepEqual(s.properties.to.type, ['string', 'null']);
    const [planObject, planNull] = s.properties.plan.anyOf;
    assert.equal(planObject.additionalProperties, false);
    assert.deepEqual(planObject.required, ['next', 'then']);
    assert.deepEqual(planNull, { type: 'null' });
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.properties.plan.anyOf[0]));
  });

  test('a proper give_word passes; plan is deduped and cleaned', () => {
    const v = validate({ ...GIVE, plan: { next: 'orlov_y', then: ['orlov_y', 'nevsky_g', 'ghost', 'nevsky_g'] } }, { participants: PARTICIPANTS });
    assert.equal(v.ok, true, v.errors.join('; '));
    assert.deepEqual(v.action, { why: 'Тимур закончил', action: 'give_word', to: 'nevsky_g', text: null, plan: { next: 'orlov_y', then: ['nevsky_g'] } });
    assert.ok(v.warnings.some((w) => /"ghost".*dropped/.test(w)));
  });

  test('errors: unknown/absent/missing "to", missing text, bad action, English', () => {
    const errs = (raw) => validate(raw, { participants: PARTICIPANTS }).errors.join(' | ');
    assert.match(errs({ ...GIVE, to: 'timur_x' }), /to "timur_x" is not a participant id; use one of: orlov_y, tkach_t/);
    assert.match(errs({ ...GIVE, to: null }), /give_word needs "to"/);
    assert.match(errs({ ...GIVE, to: 'belozerskaya_n' }), /not in the meeting/);
    assert.match(errs({ why: '', action: 'speak', to: null, text: '  ', plan: null }), /speak needs non-empty "text"/);
    assert.match(errs({ why: '', action: 'dance', to: null, text: null, plan: null }), /action must be one of/);
    assert.match(errs({ why: '', action: 'answer', to: null, text: 'Sure, I am the host of this meeting, let me continue.', plan: null }), /Russian/);
    assert.equal(validate('nope').ok, false);
  });

  test('plan with absent roster people: dropped with a warning, no repair round-trip', () => {
    const v = (plan) => validate({ ...GIVE, plan }, { participants: PARTICIPANTS });
    const allAbsent = v({ next: 'smirnov_x', then: ['kuznetsova_y', 'belozerskaya_n'] });
    assert.equal(allAbsent.ok, true);
    assert.equal(allAbsent.action.plan, null, 'nothing valid left: the host keeps its plan');
    assert.ok(allAbsent.warnings.some((w) => w.includes('plan.next "smirnov_x"')));
    const mixed = v({ next: 'smirnov_x', then: ['kuznetsova_y', 'tkach_t', 'orlov_y'] });
    assert.equal(mixed.ok, true);
    assert.deepEqual(mixed.action.plan, { next: 'tkach_t', then: ['orlov_y'] }, 'the first present one moves up');
    assert.deepEqual(v({ next: null, then: [] }).action.plan, { next: null, then: [] }, 'an explicit empty plan stays');
  });

  test('names map to ids; wait drops text; unknown keys are dropped', () => {
    const byName = validate({ ...GIVE, to: 'Глеб', confidence: 0.9 }, { participants: PARTICIPANTS });
    assert.equal(byName.ok, true);
    assert.equal(byName.action.to, 'nevsky_g');
    assert.ok(byName.warnings.some((w) => w.includes('mapped to "nevsky_g"')));
    assert.ok(byName.warnings.some((w) => w.includes('unknown key "confidence"')));
    const wait = validate({ why: 'говорит', action: 'wait', to: null, text: 'Жду.', plan: null }, { participants: PARTICIPANTS });
    assert.equal(wait.ok, true);
    assert.equal(wait.action.text, null);
  });

  test('context warnings: speaking over someone, give_word to someone who spoke', () => {
    const ctx = { ...CTX, speaker: { id: 'tkach_t', conf: 'high', since_s: 3, silence_ms: 200 } };
    const v = validate({ why: '', action: 'give_word', to: 'orlov_y', text: null, plan: null }, { participants: PARTICIPANTS, context: ctx });
    assert.equal(v.ok, true);
    assert.ok(v.warnings.some((w) => w.includes('while tkach_t is talking')));
    assert.ok(v.warnings.some((w) => w.includes('already spoke')));
  });

  test('sanitizeText strips URLs, e-mails, IPs, key-like tokens, markdown, emoji and stress marks', () => {
    const { text, warnings } = sanitizeText(
      'Смотри **сюда**: https://example.com/x и admin@example.com, сервер 192.168.1.159, ключ sk-proj-AbC123dEf456GhI789 🙂 Яросла́в…',
    );
    assert.equal(text, 'Смотри сюда: и, сервер, ключ Ярослав.');
    assert.ok(warnings.some((w) => w.includes('URL')));
    assert.equal(sanitizeText('«Готово, идём дальше.»').text, 'Готово, идём дальше.');
    assert.equal(sanitizeText('Токен abcdef0123456789abcdef на месте').text, 'Токен на месте');
  });

  test('trimText: ≤220 chars at a sentence boundary; short greetings do not count; handoff kept', () => {
    assert.deepEqual(splitSentences('Решения: GPT-5.4 nano. Идём дальше! Ок'), ['Решения: GPT-5.4 nano.', 'Идём дальше!', 'Ок']);
    const clip = 'Доброе утро, коллеги! Понедельник, говорим про фокус на неделю. Ярослав, начнёшь?';
    assert.equal(trimText(clip), clip); // one substantive sentence + two short ones
    const long = `${'Это первое длинное предложение про устройство ведущей и её правила. '.repeat(3)}Глеб, продолжай.`;
    const out = trimText(long, { keepLast: (s) => s.includes('Глеб') });
    assert.ok(out.length <= 220, out);
    assert.match(out, /^Это первое длинное предложение.*\. Глеб, продолжай\.$/);
    assert.equal(splitSentences(out).length, 3);
    const one = trimText(`Очень ${'длинное '.repeat(40)}предложение без точек`, { maxChars: 60 });
    assert.ok(one.length <= 60 && one.endsWith('.'), one);
    const three = trimText('Первое содержательное предложение тут. Второе содержательное предложение тут. Третье содержательное предложение тут.');
    assert.equal(three, 'Первое содержательное предложение тут. Второе содержательное предложение тут.');
  });

  test('fixFeminine: self-reference only, colleagues untouched', () => {
    const fem = (s) => fixFeminine(s).text;
    assert.equal(fem('Я понял, спасибо.'), 'Я поняла, спасибо.');
    assert.equal(fem('Извини, я не расслышал.'), 'Извини, я не расслышала.');
    assert.equal(fem('Я был рад помочь.'), 'Я была рада помочь.');
    assert.equal(fem('Я ошибся, поправляюсь.'), 'Я ошиблась, поправляюсь.');
    assert.equal(fem('я вас услышал'), 'я вас услышала');
    assert.equal(fem('Понял, идём дальше.'), 'Поняла, идём дальше.');
    assert.equal(fem('Я готов продолжать.'), 'Я готова продолжать.');
    assert.equal(fem('Тимур, ты готов? Он подключился.'), 'Тимур, ты готов? Он подключился.');
    assert.equal(fem('Я поняла и готова.'), 'Я поняла и готова.');
    const v = validate({ why: '', action: 'answer', to: null, text: 'Я понял вопрос. Отвечу в конце.', plan: null }, { participants: PARTICIPANTS });
    assert.equal(v.action.text, 'Я поняла вопрос. Отвечу в конце.');
    assert.ok(v.warnings.some((w) => w.includes('feminine')));
  });

  test('parseActionText: plain, fenced, wrapped in prose, broken', () => {
    const raw = JSON.stringify(GIVE);
    assert.deepEqual(parseActionText(raw).value, GIVE);
    assert.deepEqual(parseActionText(`\`\`\`json\n${raw}\n\`\`\``).value, GIVE);
    assert.deepEqual(parseActionText(`Вот ответ: ${raw} — готово`).value, GIVE);
    assert.deepEqual(parseActionText(`[${raw}]`).value, GIVE);
    assert.equal(parseActionText('{"action": "wait"').ok, false);
    assert.equal(parseActionText('').ok, false);
  });

  test('completedFields: only values that fully arrived, as the stream grows', () => {
    const full = JSON.stringify({ why: 'вопрос "про" меня', action: 'answer', to: null, text: 'Да, слышу. Всё хорошо!', plan: { next: 'nevsky_g', then: ['tkach_t'] } });
    const at = (needle) => full.slice(0, full.indexOf(needle));
    assert.deepEqual(completedFields(''), {});
    assert.deepEqual(completedFields('{"why":"вопрос \\"про'), {});
    assert.deepEqual(completedFields(at('"action"')), { why: 'вопрос "про" меня' });
    assert.deepEqual(completedFields(at('"to"')), { why: 'вопрос "про" меня', action: 'answer' });
    assert.deepEqual(Object.keys(completedFields(at(',"text"'))), ['why', 'action'], 'null is complete only once a delimiter follows it');
    assert.equal(completedFields(at('"text"')).to, null);
    assert.equal('text' in completedFields(at('Всё хорошо')), false);
    const withText = completedFields(at('"plan"'));
    assert.equal(withText.text, 'Да, слышу. Всё хорошо!');
    assert.equal('plan' in withText, false);
    assert.equal('plan' in completedFields(full.slice(0, -3)), false, 'a nested object counts only when closed');
    assert.deepEqual(completedFields(full).plan, { next: 'nevsky_g', then: ['tkach_t'] });
    assert.deepEqual(completedFields(`\`\`\`json\n{ "action" : "wait" , "text" : null }`), { action: 'wait', text: null });
    assert.deepEqual(completedFields('{"text": "a}b", "n": 12'), { text: 'a}b' });
  });
});

// ------------------------------------------------------------------ context

describe('context', () => {
  test('contract key order, window, events, time formatting, lead_present', () => {
    const base = Date.parse('2026-09-21T07:05:00Z'); // 10:05:00 MSK
    const ctx = buildContext(
      {
        now: base,
        day_mode: 'monday_focus',
        phase: 'round',
        deadline: { soft: '10:28', hard: '10:30' },
        participants: [
          { id: 'orlov_y', name: 'Ярослав Орлов', present: true, joined: base - 300_000, status: 'spoke' },
          { id: 'tkach_t', name: 'Тимур Ткач', present: true },
        ],
        speaker: { id: 'tkach_t', conf: 'med', since: base - 42_000, silence_ms: 812.4 },
        host: { last_utterance: 'Спасибо! Дальше Тимур.' },
        plan: { next: 'nevsky_g', then: ['x'] },
        events: Array.from({ length: 30 }, (_, i) => ({ t: base - (30 - i) * 1000, type: 'vad.stop', who: 'tkach_t', nested: { skip: true } })),
        transcript: [
          { t: base - 60_000, who: 'tkach_t', text: 'старое, за окном' },
          { t: base - 20_000, who: null, text: 'свежее' },
          { t: '10:04:58', who: 'tkach_t', text: 'у меня всё' },
        ],
        trigger: 'turn_end_candidate',
      },
      { leadId: 'orlov_y' },
    );
    assert.deepEqual(Object.keys(ctx), [...CONTEXT_KEYS]);
    assert.equal(ctx.now, '10:05:00');
    assert.equal(ctx.lead_present, true);
    assert.equal(ctx.participants[0].joined, '10:00:00');
    assert.equal(ctx.participants[1].status, 'pending');
    assert.deepEqual(ctx.speaker, { id: 'tkach_t', conf: 'med', since_s: 42, silence_ms: 812 });
    assert.equal(ctx.recent_events.length, 20);
    assert.equal(ctx.recent_events.at(-1).t, '10:04:59');
    assert.equal(ctx.recent_events[0].nested, undefined);
    assert.deepEqual(ctx.transcript_window.map((e) => [e.t, e.who, e.text]), [['10:04:40', '?', 'свежее'], ['10:04:58', 'tkach_t', 'у меня всё']]);
    assert.equal(buildContext({ participants: [] }).lead_present, null, 'unknown without leadId');
  });

  test('token budget: oldest transcript goes first, newest survives', () => {
    const transcript = Array.from({ length: 80 }, (_, i) => ({ t: `10:04:${String(i % 60).padStart(2, '0')}`, who: 'tkach_t', text: `фраза номер ${i} `.repeat(12) }));
    const ctx = buildContext({ now: '10:05:00', participants: PARTICIPANTS, transcript, trigger: 'silence' }, { windowSec: 3600, maxTokens: 1200 });
    assert.ok(contextTokens(ctx) <= 1200, `${contextTokens(ctx)} tokens`);
    assert.ok(ctx.transcript_window.length >= 1 && ctx.transcript_window.length < 80);
    assert.match(ctx.transcript_window.at(-1).text, /фраза номер 79/);
    assert.equal(ctx.participants.length, PARTICIPANTS.length);
  });
});

// ------------------------------------------------------------------ prompt

const PEOPLE = {
  host_display_name: 'Кора (ИИ-ведущая)',
  first_always: 'orlov_y',
  people: [
    { id: 'orlov_y', display: 'Ярослав Орлов', vocative: 'Яросла́в', role: 'CEO, основатель', gender: 'm' },
    { id: 'nevsky_g', display: 'Глеб Невский', vocative: 'Гле́б', role: 'CTO', gender: 'm' },
    { id: 'tkach_t', display: 'Тимур Ткач', vocative: 'Тиму́р', role: 'техлид', gender: 'm' },
    { id: 'belozerskaya_n', display: 'Нина Белозерская', vocative: 'Ни́на', gender: 'f' },
    { id: 'plotnikov_a', display: 'Андрей Плотников', vocative: 'Андре́й', gender: 'm', disambiguate_with_surname: true },
    { id: 'guest_bot', display: 'Хранитель', exclude: true },
  ],
};
const PERSONA_MD = '# Персона\n\n## 6. Промпт-блок\n\nГотов к вставке.\n\n```text\nТы Кора. Решения принимает {brain_model}.\n```\n\n## 7. Вопросы\n';

describe('prompt', () => {
  test('persona block: extracted from config/persona.md', { skip: !existsSync(join(CONFIG_DIR, 'persona.md')) }, () => {
    const block = extractPersonaBlock(readFileSync(join(CONFIG_DIR, 'persona.md'), 'utf8'));
    assert.match(block, /^Ты Кора/);
    assert.match(block, /\{brain_model\}/);
    assert.equal(extractPersonaBlock('# no block here'), null);
  });

  test('roster, persona with {brain_model}, contract, rules, 6 examples; byte-stable', () => {
    const args = { personaBlock: extractPersonaBlock(PERSONA_MD), people: PEOPLE.people, firstAlways: PEOPLE.first_always, hostDisplayName: PEOPLE.host_display_name, brainModelHuman: humanModelName('gpt-5-mini') };
    const monday = buildSystemPrompt({ ...args, dayMode: 'monday_focus' });
    assert.equal(monday, buildSystemPrompt({ ...args, dayMode: 'monday_focus' }), 'byte-stable');
    assert.match(monday, /Ты Кора\. Решения принимает GPT-5 mini от OpenAI\./);
    assert.doesNotMatch(monday, /\{brain_model\}/);
    assert.match(monday, /- orlov_y — Ярослав Орлов; CEO, основатель\. Всегда выступает первым\./);
    assert.match(monday, /- belozerskaya_n — Нина Белозерская \(она\)\./);
    assert.match(monday, /- plotnikov_a — Андрей Плотников; есть тёзка/);
    assert.match(monday, /Вне круга.*guest_bot — Хранитель/);
    assert.doesNotMatch(monday, /́/, 'no stress marks in the prompt');
    assert.match(monday, /«Кора \(ИИ-ведущая\)»/);
    for (const a of ACTIONS) assert.ok(monday.includes(`${a}:`), `contract describes ${a}`);
    assert.match(monday, /# Жёсткие правила/);
    assert.match(monday, /хорошей недели/);
    assert.equal((monday.match(/^Пример \d+:/gm) ?? []).length, 6);
    const tuesday = buildSystemPrompt({ ...args, dayMode: 'daily_plans' });
    assert.match(tuesday, /«Тогда всем хорошего дня! Передаю слово на дев-синк\.»/);
    assert.notEqual(tuesday, monday);
  });

  test('every few-shot answer is itself a valid action for its example input', () => {
    const prompt = buildSystemPrompt({ people: PEOPLE.people, firstAlways: 'orlov_y', dayMode: 'monday_focus' });
    const lines = prompt.split('\n');
    let checked = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('Вход: ')) continue;
      const input = JSON.parse(lines[i].slice(6));
      const answer = JSON.parse(lines[i + 1].slice('Ответ: '.length));
      const participants = input.participants.map((p) => ({ ...p, name: PEOPLE.people.find((x) => x.id === p.id)?.display }));
      const v = validate(answer, { participants });
      assert.equal(v.ok, true, `${lines[i - 1]} ${v.errors.join('; ')}`);
      assert.deepEqual(v.action, answer, `${lines[i - 1]} is already normalized`);
      checked++;
    }
    assert.equal(checked, 6);
  });

  test('humanModelName', () => {
    assert.equal(humanModelName('gpt-5-mini'), 'GPT-5 mini от OpenAI');
    assert.equal(humanModelName('gpt-5.4-nano'), 'GPT-5.4 nano от OpenAI');
    assert.equal(humanModelName('google/gemini-3-flash-preview'), 'Gemini 3 Flash от Google');
    assert.equal(humanModelName('anthropic/claude-haiku-4.5'), 'Claude Haiku 4.5 от Anthropic');
    assert.equal(humanModelName(null), 'отдельная языковая модель');
  });

  test('loadBrainAssets tolerates missing files and supports both first_always forms', () => {
    const empty = loadBrainAssets({ configDir: tempDir() });
    assert.deepEqual([empty.playbook, empty.personaBlock, empty.people, empty.firstAlways, empty.phrases], [null, null, null, null, null]);
    assert.equal(empty.warnings.length, 4);
    assert.match(buildSystemPrompt({ ...empty }), /руководитель всегда выступает первым/);
    const flagged = loadBrainAssets({ configDir: tempDir({ 'people.json': { people: [{ id: 'boss', display: 'Босс', first_always: true }] }, 'persona.md': PERSONA_MD }) });
    assert.equal(flagged.firstAlways, 'boss');
    assert.equal(flagged.personaBlock, 'Ты Кора. Решения принимает {brain_model}.');
    assert.ok(loadBrainAssets({ configDir: tempDir({ 'people.json': '{ broken' }) }).warnings.some((w) => w.includes('invalid JSON')));
  });
});

// ------------------------------------------------------------------ client

const SETTINGS = {
  keys: { openai: 'OPENAI_API_KEY', openrouter: 'Cora_KEY', telegram: 'TELEGRAM_BOT_TOKEN' },
  brain: { openrouter_model: 'google/gemini-3-flash-preview', openai_fallback_model: 'gpt-5-mini', timeout_ms: 4000, min_interval_ms: 0 },
};
const settings = (brain = {}, keys = {}) => ({ keys: { ...SETTINGS.keys, ...keys }, brain: { ...SETTINGS.brain, ...brain } });
const OPENAI_KEY = 'sk-test-openai-0123456789abcdef';
const OR_KEY = 'sk-or-v1-test-0123456789abcdef';
const SHARED_KEY = 'sk-or-v1-shared-must-not-be-used-000';
const ENV_OPENAI = { OPENAI_API_KEY: OPENAI_KEY };
const ENV_BOTH = { OPENAI_API_KEY: OPENAI_KEY, Cora_KEY: OR_KEY };

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
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_test' } });
}
function sseText(text, { usage = { prompt_tokens: 5000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 4096 } }, delayMs = 0 } = {}) {
  const third = Math.ceil(text.length / 3);
  const parts = [text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)].filter(Boolean);
  return sse(
    [
      ': OPENROUTER PROCESSING',
      { id: 'gen-1', model: 'm', choices: [{ delta: { role: 'assistant', content: '' } }] },
      ...parts.map((p) => ({ choices: [{ delta: { content: p } }] })),
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage },
      '[DONE]',
    ],
    { delayMs },
  );
}
const sseAction = (action, opts) => sseText(JSON.stringify(action), opts);
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const hang = (call) =>
  new Promise((_, reject) => {
    if (call.signal.aborted) reject(call.signal.reason);
    call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
  });

/** fetch whose n-th call is answered by handlers[n] (the last handler repeats). */
function scriptedFetch(handlers) {
  const calls = [];
  const fn = async (url, init) => {
    const call = { url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal, at: performance.now() };
    calls.push(call);
    return handlers[Math.min(calls.length - 1, handlers.length - 1)](call);
  };
  fn.calls = calls;
  return fn;
}

/** fetch that the test answers by hand: await f.call(n) then call.resolve(response). */
function manualFetch() {
  const calls = [];
  const waiters = [];
  const fn = (url, init) =>
    new Promise((resolve, reject) => {
      const call = { url, body: JSON.parse(init.body), signal: init.signal, at: performance.now(), resolve, aborted: false };
      init.signal.addEventListener('abort', () => {
        call.aborted = true;
        reject(init.signal.reason);
      }, { once: true });
      calls.push(call);
      for (const w of waiters.splice(0)) w();
    });
  fn.calls = calls;
  fn.call = async (n) => {
    while (calls.length < n) await new Promise((r) => waiters.push(r));
    return calls[n - 1];
  };
  return fn;
}

function brainWith({ env = ENV_OPENAI, brain = {}, keys = {}, fetch, log, ...rest } = {}) {
  const events = [];
  const b = createBrain({
    settings: settings(brain, keys),
    env,
    fetch,
    systemPrompt: 'TEST SYSTEM PROMPT (JSON)',
    log: log ?? { event: (type, fields) => events.push({ type, ...fields }) },
    ...rest,
  });
  return { brain: b, events };
}
const userContext = (call) => JSON.parse(call.body.messages[1].content);

describe('client: provider selection', () => {
  test('OpenAI fallback: endpoint, key, model, reasoning_effort minimal, strict schema, no temperature', async () => {
    const fetch = scriptedFetch([() => sseAction(GIVE)]);
    const { brain, events } = brainWith({ fetch });
    assert.equal(brain.provider, 'openai');
    assert.equal(brain.model, 'gpt-5-mini');
    const r = await brain.decide(CTX);
    assert.equal(r.status, 'ok');
    const [call] = fetch.calls;
    assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(call.headers.Authorization, `Bearer ${OPENAI_KEY}`);
    assert.equal(call.body.model, 'gpt-5-mini');
    assert.equal(call.body.reasoning_effort, 'minimal');
    assert.equal(call.body.temperature, undefined);
    assert.equal(call.body.max_completion_tokens, 1200);
    assert.deepEqual(call.body.stream_options, { include_usage: true });
    assert.equal(call.body.response_format.type, 'json_schema');
    assert.equal(call.body.response_format.json_schema.strict, true);
    assert.match(call.body.prompt_cache_key, /^standup-brain-[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(events).includes(OPENAI_KEY), 'key value never logged');
  });

  test('OpenRouter via the key NAME from settings (Cora_KEY): endpoint, reasoning, usage accounting', async () => {
    const fetch = scriptedFetch([() => sseAction(GIVE)]);
    const { brain } = brainWith({ env: ENV_BOTH, fetch });
    assert.equal(brain.provider, 'openrouter');
    assert.equal(brain.keyName, 'Cora_KEY');
    await brain.decide(CTX);
    const [call] = fetch.calls;
    assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(call.headers.Authorization, `Bearer ${OR_KEY}`);
    assert.equal(call.body.model, 'google/gemini-3-flash-preview');
    assert.deepEqual(call.body.reasoning, { effort: 'minimal', exclude: true });
    assert.deepEqual(call.body.usage, { include: true });
    assert.deepEqual(call.body.provider, { sort: 'latency' });
    assert.equal(call.body.max_tokens, 1200);
    assert.equal(call.body.reasoning_effort, undefined);
    assert.equal(call.body.stream_options, undefined);
    assert.deepEqual(call.body.messages[0].content, [{ type: 'text', text: 'TEST SYSTEM PROMPT (JSON)', cache_control: { type: 'ephemeral' } }]);
    const plain = initialCaps('openrouter', 'openai/gpt-5-mini', { openrouter_provider: null });
    assert.deepEqual([plain.cacheControl, plain.route], [false, null]);
  });

  test('the shared OPENROUTER_API_KEY is never used', async () => {
    assert.throws(() => resolveProvider(settings(), { env: { OPENROUTER_API_KEY: SHARED_KEY } }), /no LLM key.*Cora_KEY.*OPENAI_API_KEY/);
    const fetch = scriptedFetch([() => sseAction(GIVE)]);
    const { brain } = brainWith({ env: { OPENROUTER_API_KEY: SHARED_KEY, OPENAI_API_KEY: OPENAI_KEY }, fetch });
    assert.equal(brain.provider, 'openai');
    await brain.decide(CTX);
    assert.ok(!JSON.stringify(fetch.calls[0].headers).includes(SHARED_KEY));
    assert.throws(() => resolveProvider(settings({}, { openrouter: 'OPENROUTER_API_KEY' }), { env: { OPENROUTER_API_KEY: SHARED_KEY } }), /shared/);
    assert.throws(() => resolveProvider(settings(), { env: {} }), /no LLM key/);
    assert.throws(() => resolveProvider(settings(), { env: ENV_OPENAI, provider: 'openrouter' }), /Cora_KEY is absent/);
  });

  test('caps: effort per model family; priorities', () => {
    assert.equal(initialCaps('openai', 'gpt-5-nano', {}).effort, 'minimal');
    assert.equal(initialCaps('openai', 'gpt-5.4-mini', {}).effort, 'none');
    assert.equal(initialCaps('openai', 'gpt-4.1-mini', {}).effort, null);
    assert.equal(initialCaps('openrouter', 'anthropic/claude-haiku-4.5', {}).orReasoning, null);
    assert.equal(initialCaps('openrouter', 'anthropic/claude-haiku-4.5', {}).cacheControl, true);
    assert.equal(priorityOf(undefined, 'question_to_host'), 1);
    assert.equal(priorityOf(undefined, 'barge_in'), 1);
    assert.equal(priorityOf(undefined, 'joined'), 0);
    assert.equal(priorityOf('high', 'joined'), 1);
  });

  test('prompt built from config: persona {brain_model} = the active model', () => {
    const configDir = tempDir({ 'persona.md': PERSONA_MD, 'people.json': PEOPLE });
    const b = createBrain({ settings: settings(), env: ENV_BOTH, fetch: async () => sseAction(GIVE), configDir, dayMode: 'monday_focus', log: null });
    assert.match(b.systemPrompt, /Ты Кора\. Решения принимает Gemini 3 Flash от Google\./);
    assert.match(b.systemPrompt, /orlov_y — Ярослав Орлов/);
  });
});

describe('client: one decision', () => {
  test('streams: TTFT, latency, usage with cached tokens, estimated cost, stable system prompt', async () => {
    const fetch = scriptedFetch([() => sseAction(GIVE, { delayMs: 15 })]);
    const { brain, events } = brainWith({ fetch });
    const r = await brain.decide(CTX);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.action, GIVE);
    assert.ok(r.ttft_ms !== null && r.ttft_ms >= 0 && r.ttft_ms <= r.latency_ms, `ttft ${r.ttft_ms} latency ${r.latency_ms}`);
    assert.equal(r.usage.cached_tokens, 4096);
    assert.ok(Math.abs(r.usage.cost_usd - (904 * 0.25 + 4096 * 0.025 + 40 * 2) / 1e6) < 1e-12);
    assert.deepEqual([r.provider, r.model, r.attempts, r.repaired], ['openai', 'gpt-5-mini', 1, false]);
    const action = events.find((e) => e.type === 'brain.action');
    assert.equal(action.request_id, 'gen-1');
    assert.equal(events.find((e) => e.type === 'brain.request').context.trigger, 'turn_end_candidate');
    await brain.decide({ ...CTX, now: '10:05:09' });
    assert.equal(fetch.calls[1].body.messages[0].content, fetch.calls[0].body.messages[0].content);
    assert.equal(userContext(fetch.calls[1]).now, '10:05:09');
  });

  test('onText: the normalized line arrives while the stream is still on `plan`, once per decision', async () => {
    const answer = { why: 'вопрос ко мне', action: 'answer', to: null, text: 'Я понял, отвечаю: да, слышу!', plan: { next: 'nevsky_g', then: [] } };
    const raw = JSON.stringify(answer);
    const cut = raw.indexOf('"plan"');
    const pieces = [raw.slice(0, 20), raw.slice(20, cut), raw.slice(cut, cut + 12), raw.slice(cut + 12)];
    const fetch = scriptedFetch([
      () => sse([...pieces.map((p) => ({ choices: [{ delta: { content: p } }] })), { choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]'], { delayMs: 25 }),
    ]);
    const { brain, events } = brainWith({ fetch });
    const early = [];
    let resolved = false;
    const r = await brain.decide(CTX, { trigger: 'question_to_host', onText: (e) => early.push({ ...e, resolved }) }).then((x) => ((resolved = true), x));
    assert.equal(early.length, 1);
    assert.deepEqual(
      { action: early[0].action, to: early[0].to, text: early[0].text, trigger: early[0].trigger, resolved: early[0].resolved },
      { action: 'answer', to: null, text: 'Я поняла, отвечаю: да, слышу!', trigger: 'question_to_host', resolved: false },
    );
    assert.equal(r.action.text, early[0].text, 'the early line is exactly the validated one');
    assert.ok(Number.isFinite(r.text_ms) && r.text_ms <= r.latency_ms - 20, `text ${r.text_ms} ms, total ${r.latency_ms} ms`);
    assert.equal(events.find((e) => e.type === 'brain.action').text_ms, r.text_ms);
  });

  test('why_last: schema, prompt, examples and repair put `why` after `text`; the line is out before `plan` and `why`', async () => {
    const whyLast = { action: 'answer', to: null, text: 'Да, слышу!', plan: null, why: 'вопрос ко мне' };
    const raw = JSON.stringify(whyLast);
    const cut = raw.indexOf('"plan"');
    const fetch = scriptedFetch([
      () => sse([raw.slice(0, cut), raw.slice(cut)].map((p) => ({ choices: [{ delta: { content: p } }] })).concat([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, '[DONE]']), { delayMs: 40 }),
    ]);
    const { brain, events } = brainWith({ fetch, brain: { why_last: true } });
    const early = [];
    const r = await brain.decide(CTX, { onText: (e) => early.push(e) });
    assert.equal(r.status, 'ok');
    assert.equal(r.action.why, 'вопрос ко мне');
    assert.equal(early[0]?.text, 'Да, слышу!');
    assert.ok(r.text_ms <= r.latency_ms - 30, `text ${r.text_ms} ms, total ${r.latency_ms} ms`);
    const schema = fetch.calls[0].body.response_format.json_schema.schema;
    assert.deepEqual(Object.keys(schema.properties), ['action', 'to', 'text', 'plan', 'why']);
    assert.deepEqual([...schema.required].sort(), [...ACTION_JSON_SCHEMA.required].sort());
    assert.equal(events.find((e) => e.type === 'brain.init').why_last, true);
    const assets = loadBrainAssets();
    const prompt = buildSystemPrompt({ ...assets, dayMode: 'daily_plans', whyLast: true });
    assert.match(prompt, /\{"action": "…", "to": "…", "text": "…", "plan": \{"next": "…", "then": \["…"\]\}, "why": "…"\}/);
    assert.match(prompt, /- why: последним ключом/);
    assert.equal((prompt.match(/- why:/g) ?? []).length, 1);
    assert.ok(!/Ответ: \{"why"/.test(prompt), 'examples answer with why last');
    assert.match(prompt, /Ответ: \{"action"/);
    assert.match(buildSystemPrompt({ ...assets, dayMode: 'daily_plans' }), /Ответ: \{"why"/, 'default stays why-first');
  });

  test('onText: silent for wait, a null or invalid text, and without a listener', async () => {
    const cases = [
      GIVE,
      { why: '', action: 'wait', to: null, text: 'шепчу', plan: null },
      { why: '', action: 'speak', to: null, text: 'Hello everyone, this is an English line', plan: null },
    ];
    for (const action of cases) {
      const early = [];
      const r = await brainWith({ fetch: scriptedFetch([() => sseAction(action)]) }).brain.decide(CTX, { onText: (e) => early.push(e) });
      assert.equal(early.length, 0, JSON.stringify(action));
      assert.equal(r.text_ms, null);
    }
    const plain = await brainWith({ fetch: scriptedFetch([() => sseAction({ ...GIVE, action: 'speak', to: null, text: 'Всем привет!' })]) }).brain.decide(CTX);
    assert.equal(plain.text_ms, null);
  });

  test('retry once on 5xx', async () => {
    const fetch = scriptedFetch([() => jsonResponse(503, { error: { message: 'overloaded' } }), () => sseAction(GIVE)]);
    const r = await brainWith({ fetch, brain: { retry_backoff_ms: 5 } }).brain.decide(CTX);
    assert.deepEqual([r.status, r.attempts, fetch.calls.length], ['ok', 2, 2]);
  });

  test('timeout -> one retry; two timeouts -> wait with brain_error:timeout', async () => {
    const once = scriptedFetch([hang, () => sseAction(GIVE)]);
    const ok = await brainWith({ fetch: once, brain: { timeout_ms: 60, retry_backoff_ms: 5 } }).brain.decide(CTX);
    assert.deepEqual([ok.status, ok.attempts], ['ok', 2]);
    assert.equal(once.calls[0].signal.aborted, true);

    const twice = scriptedFetch([hang]);
    const t0 = performance.now();
    const failed = await brainWith({ fetch: twice, brain: { timeout_ms: 60, retry_backoff_ms: 5 } }).brain.decide(CTX);
    assert.equal(failed.status, 'error');
    assert.deepEqual(failed.action, { why: 'brain_error:timeout', action: 'wait', to: null, text: null, plan: null });
    assert.equal(failed.error.kind, 'timeout');
    assert.equal(twice.calls.length, 2);
    assert.ok(performance.now() - t0 < 1000);
  });

  test('a fetch that ignores its signal still times out', async () => {
    const deaf = scriptedFetch([() => new Promise(() => {})]);
    const r = await brainWith({ fetch: deaf, brain: { timeout_ms: 40, retries: 0 } }).brain.decide(CTX);
    assert.equal(r.error.kind, 'timeout');
  });

  test('401 and an exhausted quota (429 "no credits") are not retried', async () => {
    const fetch = scriptedFetch([() => jsonResponse(401, { error: { message: 'Incorrect API key provided' } })]);
    const r = await brainWith({ fetch }).brain.decide(CTX);
    assert.deepEqual([r.status, r.error.kind, fetch.calls.length], ['error', 'auth', 1]);
    const broke = scriptedFetch([() => jsonResponse(429, { error: { message: 'You have no credits remaining. Add credits to continue using the API.', code: 'insufficient_quota' } })]);
    const q = await brainWith({ fetch: broke }).brain.decide(CTX);
    assert.deepEqual([q.status, q.error.kind, q.action.why, broke.calls.length], ['error', 'payment', 'brain_error:payment', 1]);
  });

  test('OpenRouter out of credits (402) -> fail over to OpenAI', async () => {
    const fetch = scriptedFetch([() => jsonResponse(402, { error: { message: 'Insufficient credits', code: 402 } }), () => sseAction(GIVE)]);
    const r = await brainWith({ env: ENV_BOTH, fetch }).brain.decide(CTX);
    assert.deepEqual([r.status, r.provider, fetch.calls[1].url], ['ok', 'openai', 'https://api.openai.com/v1/chat/completions']);
  });

  test('invalid output -> one repair round-trip with the validator errors', async () => {
    const fetch = scriptedFetch([() => sseAction({ ...GIVE, to: 'romka' }), () => sseAction(GIVE)]);
    const r = await brainWith({ fetch }).brain.decide(CTX);
    assert.deepEqual([r.status, r.repaired, r.attempts], ['ok', true, 2]);
    const repair = fetch.calls[1].body.messages;
    assert.equal(repair.length, 4);
    assert.equal(repair[2].role, 'assistant');
    assert.match(repair[3].content, /to "romka" is not a participant id/);
    assert.equal(repair[0].content, fetch.calls[0].body.messages[0].content, 'same cached prefix');
  });

  test('still invalid -> {"action":"wait","why":"invalid_brain_output"}', async () => {
    const fetch = scriptedFetch([() => sseText('Конечно! Дам слово Глебу.')]);
    const r = await brainWith({ fetch }).brain.decide(CTX);
    assert.equal(r.status, 'invalid');
    assert.deepEqual(r.action, { why: 'invalid_brain_output', action: 'wait', to: null, text: null, plan: null });
    assert.equal(fetch.calls.length, 2);
  });

  test('400 on an unsupported parameter adapts the request and remembers it', async () => {
    const fetch = scriptedFetch([
      () => jsonResponse(400, { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model.", param: 'temperature', code: 'unsupported_value' } }),
      () => jsonResponse(400, { error: { message: "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model. Supported values are: 'low', 'medium', and 'high'.", param: 'reasoning_effort' } }),
      () => sseAction(GIVE),
    ]);
    const { brain, events } = brainWith({ fetch, brain: { temperature: 0.2 } });
    const r = await brain.decide(CTX);
    assert.equal(r.status, 'ok');
    assert.equal(fetch.calls[0].body.temperature, 0.2);
    assert.equal(fetch.calls[2].body.temperature, undefined);
    assert.equal(fetch.calls[2].body.reasoning_effort, 'low');
    assert.deepEqual(events.filter((e) => e.type === 'brain.adapt').map((e) => e.change), ['temperature: dropped', 'reasoning_effort: minimal -> low']);
    await brain.decide(CTX);
    assert.equal(fetch.calls[3].body.reasoning_effort, 'low');
    const caps = initialCaps('openai', 'gpt-5-mini', {});
    assert.equal(adapt(caps, { param: 'stream', message: 'Your organization must be verified to stream this model.' }), 'stream: off');
    assert.equal(adapt(caps, { message: "Invalid schema for response_format 'host_action'" }), 'response_format: json_schema -> json_object');
  });

  test('OpenRouter model unavailable -> fail over to OpenAI once', async () => {
    const fetch = scriptedFetch([() => jsonResponse(400, { error: { message: 'google/gemini-3-flash is not a valid model ID', code: 400 } }), () => sseAction(GIVE)]);
    const { brain, events } = brainWith({ env: ENV_BOTH, fetch, systemPrompt: null, configDir: tempDir({ 'persona.md': PERSONA_MD }) });
    const r = await brain.decide(CTX);
    assert.deepEqual([r.status, r.provider, r.model], ['ok', 'openai', 'gpt-5-mini']);
    assert.equal(fetch.calls[1].url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(fetch.calls[1].headers.Authorization, `Bearer ${OPENAI_KEY}`);
    assert.match(fetch.calls[1].body.messages[0].content, /Решения принимает GPT-5 mini от OpenAI/);
    assert.equal(events.filter((e) => e.type === 'brain.failover').length, 1);
    assert.equal(brain.provider, 'openai');
  });

  test('a context factory that throws resolves to a wait, never rejects', async () => {
    const r = await brainWith({ fetch: scriptedFetch([() => sseAction(GIVE)]) }).brain.decide(() => {
      throw new Error('boom');
    }, { trigger: 'silence' });
    assert.deepEqual([r.status, r.action.action, r.action.why], ['error', 'wait', 'brain_error:context']);
  });
});

describe('client: rate limit and coalescing', () => {
  const ctxAt = (now, trigger = 'turn_end_candidate') => ({ ...CTX, now, trigger });

  test('calls during a request coalesce into one pending request; the newest input wins', async () => {
    const fetch = manualFetch();
    const { brain } = brainWith({ fetch, brain: { min_interval_ms: 50 } });
    const built = [];
    const factory = (now) => () => {
      built.push(now);
      return ctxAt(now);
    };
    const p1 = brain.decide(factory('10:00:01'), { trigger: 'joined' });
    const c1 = await fetch.call(1);
    const p2 = brain.decide(factory('10:00:02'), { trigger: 'left' });
    const p3 = brain.decide(factory('10:00:03'), { trigger: 'chat' });
    const r2 = await p2;
    assert.deepEqual([r2.status, r2.action.action], ['superseded', 'wait']);
    c1.resolve(sseAction(GIVE));
    assert.equal((await p1).status, 'ok');
    const c2 = await fetch.call(2);
    assert.ok(c2.at - c1.at >= 45, `second start ${c2.at - c1.at} ms after the first`);
    assert.equal(userContext(c2).now, '10:00:03');
    assert.equal(userContext(c2).trigger, 'chat');
    assert.deepEqual(built, ['10:00:01', '10:00:03'], 'factories run only when a request starts');
    c2.resolve(sseAction(GIVE));
    assert.equal((await p3).status, 'ok');
    assert.equal(fetch.calls.length, 2);
  });

  test('question_to_host pre-empts a normal request at once; the pre-empted caller is superseded', async () => {
    const fetch = manualFetch();
    const { brain } = brainWith({ fetch, brain: { min_interval_ms: 5000 } });
    const pNormal = brain.decide(ctxAt('10:01:00', 'plan_refresh'));
    const c1 = await fetch.call(1);
    const pQ = brain.decide(ctxAt('10:01:01', 'question_to_host'));
    const c2 = await fetch.call(2);
    assert.equal(c1.aborted, true);
    assert.ok(c2.at - c1.at < 1000, 'no min_interval wait for a pre-empting call');
    assert.equal((await pNormal).status, 'superseded');
    const answer = { why: 'вопрос', action: 'answer', to: 'nevsky_g', text: 'Я Кора, ИИ-ведущая. Тимур, продолжай.', plan: null };
    c2.resolve(sseAction(answer));
    const rQ = await pQ;
    assert.deepEqual([rQ.status, rQ.action.action, rQ.trigger], ['ok', 'answer', 'question_to_host']);
  });

  test('a normal call waits behind a high-priority request (no abort); pending keeps the higher trigger', async () => {
    const fetch = manualFetch();
    const { brain } = brainWith({ fetch, brain: { min_interval_ms: 10 } });
    const pQ = brain.decide(ctxAt('10:02:00', 'question_to_host'));
    const c1 = await fetch.call(1);
    const pA = brain.decide(ctxAt('10:02:01', 'barge_in'));
    const pB = brain.decide(ctxAt('10:02:02', 'joined'));
    assert.equal(c1.aborted, false);
    assert.equal((await pA).status, 'superseded');
    c1.resolve(sseAction(GIVE));
    assert.equal((await pQ).status, 'ok');
    const c2 = await fetch.call(2);
    assert.equal(userContext(c2).now, '10:02:02', 'newest input');
    assert.equal(userContext(c2).trigger, 'barge_in', 'highest-priority trigger kept');
    c2.resolve(sseAction(GIVE));
    assert.equal((await pB).status, 'ok');
  });

  test('min_interval_ms spaces sequential requests', async () => {
    const fetch = scriptedFetch([() => sseAction(GIVE)]);
    const { brain } = brainWith({ fetch, brain: { min_interval_ms: 120 } });
    await brain.decide(CTX);
    const r = await brain.decide(CTX);
    assert.ok(fetch.calls[1].at - fetch.calls[0].at >= 110, `${fetch.calls[1].at - fetch.calls[0].at} ms`);
    assert.ok(r.queue_ms >= 60, `queue ${r.queue_ms} ms`);
  });

  test('caller abort and close() resolve as aborted', async () => {
    const fetch = manualFetch();
    const { brain } = brainWith({ fetch });
    const ac = new AbortController();
    const p = brain.decide(CTX, { signal: ac.signal });
    const c1 = await fetch.call(1);
    ac.abort();
    assert.equal((await p).status, 'aborted');
    assert.equal(c1.aborted, true);
    const p2 = brain.decide(CTX);
    await fetch.call(2);
    brain.close();
    assert.equal((await p2).status, 'aborted');
    assert.equal((await brain.decide(CTX)).status, 'aborted');
    assert.equal(brain.stats().aborted, 1);
  });
});
