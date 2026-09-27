#!/usr/bin/env node
// Benchmark brain candidates on realistic standup contexts (WP5).
//
//   node tools/bench_brain.js [--provider openai|openrouter|yandex|all] [--models a,b,...] [--day mon|tue]
//                             [--rounds N] [--no-warmup] [--timeout MS] [--verbose]
//                             [--or-route JSON] [--cache-control on|off] [--effort LEVEL|off]
//                             [--format json_schema|json_object|none] [--why-last]
// --or-route sets settings.brain.openrouter_provider (OpenRouter routing, e.g.
// '{"order":["google-ai-studio"],"allow_fallbacks":true}' or '{"sort":"latency"}');
// --cache-control forces the explicit cache breakpoint on the system prompt (OpenRouter);
// --effort sets the reasoning effort (OpenAI reasoning_effort / OpenRouter reasoning.effort);
// --why-last sets settings.brain.why_last (`why` after `text`: compare decisions and the text column).
//
// Candidates: OpenAI direct (key named by settings.keys.openai) and OpenRouter (key named by
// settings.keys.openrouter, e.g. Cora_KEY). The shared OPENROUTER_API_KEY is never used; key
// values are never printed. Per model: one warm-up call (primes the prompt cache and the
// schema, reported separately) + 5 contexts x rounds, sequentially, through the production
// client (createBrain), so the numbers include streaming, validation and repair.
// Cost: ~6 calls x ~6k prompt tokens per model, mostly cached after the warm-up: cents.
// Every call is logged to _internal/bench_brain_YYYY-MM-DD.jsonl (synthetic contexts only).

import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createBrain } from '../src/brain/client.js';
import { humanModelName, loadBrainAssets } from '../src/brain/prompt.js';
import { loadSettings } from '../src/config.js';
import { APP_ROOT, hasKey, loadEnv } from '../src/env.js';
import { openLog } from '../src/log.js';

const OPENAI_MODELS = ['gpt-5-mini', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-nano'];
const OPENROUTER_MODELS = [
  'google/gemini-3-flash-preview',
  'anthropic/claude-haiku-4.5',
  'openai/gpt-5-mini',
  'google/gemini-3.1-flash-lite',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.8-flash',
];
const YANDEX_MODELS = ['yandexgpt-lite/latest', 'aliceai-llm-flash/latest', 'yandexgpt-5.1/latest', 'qwen3.6-35b-a3b/latest'];
const SKIP_KINDS = new Set(['model_unavailable', 'auth', 'payment', 'bad_request']);

const USAGE = `Usage: node tools/bench_brain.js [--provider openai|openrouter|yandex|all] [--models a,b] [--day mon|tue]
                               [--rounds N] [--no-warmup] [--timeout MS] [--verbose]
                               [--or-route JSON] [--cache-control on|off] [--effort LEVEL|off]
                               [--format json_schema|json_object|none] [--why-last]`;

async function main() {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', default: 'all' },
      models: { type: 'string' },
      day: { type: 'string', default: 'mon' },
      rounds: { type: 'string', default: '1' },
      'no-warmup': { type: 'boolean', default: false },
      timeout: { type: 'string', default: '10000' },
      verbose: { type: 'boolean', short: 'v', default: false },
      'or-route': { type: 'string' },
      'cache-control': { type: 'string' },
      effort: { type: 'string' },
      format: { type: 'string' },
      'why-last': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  loadEnv();
  const base = loadSettings();
  const timeoutMs = Number(values.timeout);
  const productionTimeout = base.brain.timeout_ms;
  const overrides = { min_interval_ms: 0, timeout_ms: timeoutMs };
  if (values['or-route']) overrides.openrouter_provider = JSON.parse(values['or-route']);
  if (values['cache-control']) overrides.cache_control = values['cache-control'] === 'on';
  if (values.format) overrides.response_format = values.format;
  if (values['why-last']) overrides.why_last = true;
  if (values.effort) {
    overrides.reasoning_effort = values.effort === 'off' ? null : values.effort;
    overrides.openrouter_reasoning = values.effort === 'off' ? null : { effort: values.effort };
  }
  const settings = { ...base, brain: { ...base.brain, ...overrides } };
  const variant = Object.keys(overrides).filter((k) => !['min_interval_ms', 'timeout_ms'].includes(k)).map((k) => `${k}=${JSON.stringify(overrides[k])}`).join(' ');
  if (variant) console.log(`variant: ${variant}`);
  const dayMode = values.day === 'tue' ? 'daily_plans' : 'monday_focus';
  const rounds = Math.max(1, Number(values.rounds) || 1);

  const keys = { openai: base.keys.openai, openrouter: base.keys.openrouter, yandex: base.keys.yandex };
  const has = { openai: hasKey(keys.openai), openrouter: keys.openrouter !== 'OPENROUTER_API_KEY' && hasKey(keys.openrouter), yandex: Boolean(keys.yandex) && hasKey(keys.yandex) };
  console.log(`keys: ${keys.openai} ${has.openai ? 'present' : 'absent'}, ${keys.openrouter} ${has.openrouter ? 'present' : 'absent'}, ${keys.yandex} ${has.yandex ? 'present' : 'absent'}`);

  const plan = [];
  const want = (p) => values.provider === 'all' || values.provider === p;
  const explicit = values.models?.split(',').map((s) => s.trim()).filter(Boolean);
  if (values.provider === 'yandex') {
    // Yandex AI Studio model ids look like OpenRouter ones ("yandexgpt-lite/latest"): only on explicit --provider yandex
    if (has.yandex) for (const m of explicit ?? YANDEX_MODELS) plan.push({ provider: 'yandex', model: m });
  } else {
    if (want('openai') && has.openai) {
      for (const m of explicit ?? OPENAI_MODELS) if (!m.includes('/')) plan.push({ provider: 'openai', model: m });
    }
    if (want('openrouter') && has.openrouter) {
      const list = explicit ?? [...new Set([base.brain.openrouter_model, ...OPENROUTER_MODELS])];
      for (const m of list) if (m.includes('/')) plan.push({ provider: 'openrouter', model: m });
    }
  }
  if (!plan.length) {
    console.error('nothing to benchmark: no key for the requested provider(s)');
    return 1;
  }

  const assets = loadBrainAssets();
  const cast = castFrom(assets);
  const contexts = buildContexts(cast, dayMode);
  const log = openLog({ name: 'bench_brain', dir: join(APP_ROOT, '_internal') });
  console.log(`day: ${dayMode}; contexts: ${contexts.length} x ${rounds}; timeout ${timeoutMs} ms (production ${productionTimeout} ms); log ${log.path}`);
  console.log(`cast: lead ${cast.lead.id}, others ${cast.others.map((p) => p.id).join(', ')}\n`);

  const summaries = [];
  for (const { provider, model } of plan) {
    summaries.push(await benchModel({ provider, model, settings, dayMode, contexts, rounds, warmup: !values['no-warmup'], log, verbose: values.verbose, productionTimeout }));
  }
  log.close();
  printSummary(summaries, productionTimeout);
  return 0;
}

async function benchModel({ provider, model, settings, dayMode, contexts, rounds, warmup, log, verbose, productionTimeout }) {
  const label = `${{ openai: 'openai:', yandex: 'ya:' }[provider] ?? 'or:'}${model}`;
  console.log(`== ${label} (${humanModelName(model)})`);
  let brain;
  try {
    brain = createBrain({ settings, provider, model, dayMode, log });
  } catch (e) {
    console.log(`   skipped: ${e.message}\n`);
    return { label, skipped: e.message };
  }
  const summary = { label, provider, model, calls: [], warm: null, cost: 0 };
  try {
    if (warmup) {
      const w = await brain.decide(contexts[0].context);
      summary.cost += w.usage.cost_usd ?? 0;
      summary.warm = w;
      console.log(`   warm-up: ${w.status} ${w.latency_ms} ms (ttft ${w.ttft_ms ?? '-'}), prompt ${w.usage.prompt_tokens} tok, cached ${w.usage.cached_tokens}${w.response_provider ? `, ${w.response_provider}` : ''}`);
      if (w.status === 'error' && SKIP_KINDS.has(w.error?.kind)) {
        console.log(`   skipped: ${w.error.kind}: ${w.error.message}\n`);
        return { label, skipped: `${w.error.kind}: ${w.error.message.slice(0, 120)}` };
      }
    }
    for (let round = 0; round < rounds; round++) {
      for (const c of contexts) {
        const r = await brain.decide(c.context, { onText: () => {} }); // onText: report text_ms (when speech could start)
        summary.cost += r.usage.cost_usd ?? 0;
        const verdict = r.status === 'ok' ? c.check(r.action) : { ok: false, note: r.status };
        summary.calls.push({ id: c.id, r, verdict });
        const a = r.action;
        const flags = [r.repaired ? 'repaired' : '', r.latency_ms > productionTimeout ? `>${productionTimeout}ms` : '', r.warnings.some((w) => w.includes('feminine')) ? 'fem-fixed' : '']
          .filter(Boolean)
          .join(',');
        const served = `${r.response_provider ? `${r.response_provider}, ` : ''}cached ${r.usage.cached_tokens}/${r.usage.prompt_tokens}`;
        console.log(
          `   ${c.id} ${verdict.ok ? 'OK ' : 'BAD'} ${String(r.latency_ms).padStart(5)} ms ttft ${String(r.ttft_ms ?? '-').padStart(5)} text ${String(r.text_ms ?? '-').padStart(5)} | ${a.action}${a.to ? ` -> ${a.to}` : ''}${a.plan ? ` | plan ${a.plan.next ?? '-'} [${a.plan.then.join(',')}]` : ''}${flags ? ` | ${flags}` : ''} | ${served}`,
        );
        if (a.text) console.log(`        text: ${a.text}`);
        if (!verdict.ok || verbose) console.log(`        why: ${a.why}${verdict.note ? ` | check: ${verdict.note}` : ''}${r.errors.length ? ` | errors: ${r.errors.join('; ')}` : ''}`);
      }
    }
  } finally {
    brain.close();
  }
  console.log('');
  return summary;
}

function printSummary(summaries, productionTimeout) {
  const rows = [];
  for (const s of summaries) {
    if (s.skipped) {
      rows.push([s.label, 'skipped', s.skipped]);
      continue;
    }
    const n = s.calls.length;
    const firstTry = s.calls.filter((c) => c.r.status === 'ok' && !c.r.repaired).length;
    const valid = s.calls.filter((c) => c.r.status === 'ok').length;
    const sensible = s.calls.filter((c) => c.verdict.ok).length;
    const lat = s.calls.map((c) => c.r.latency_ms);
    const ttft = s.calls.map((c) => c.r.ttft_ms).filter((v) => v != null);
    const over = lat.filter((v) => v > productionTimeout).length;
    const avg = (f) => Math.round(s.calls.reduce((sum, c) => sum + f(c.r.usage), 0) / Math.max(1, n));
    s.metrics = { n, firstTry, valid, sensible, latP50: pct(lat, 50), latMax: Math.max(...lat), ttftP50: pct(ttft, 50), over };
    rows.push([
      s.label,
      `${firstTry}/${n}`,
      `${valid}/${n}`,
      `${sensible}/${n}`,
      fmt(pct(ttft, 50)),
      fmt(Math.max(...ttft, 0) || null),
      fmt(pct(lat, 50)),
      fmt(Math.max(...lat)),
      String(over),
      fmt(s.warm?.latency_ms),
      `${avg((u) => u.prompt_tokens)}/${avg((u) => u.cached_tokens)}/${avg((u) => u.completion_tokens)}`,
      s.cost ? `$${s.cost.toFixed(4)}` : '-',
    ]);
  }
  const header = ['model', 'json 1st', 'valid', 'sensible', 'ttft p50', 'ttft max', 'total p50', 'total max', `>${productionTimeout}`, 'cold', 'tok in/cached/out', 'cost'];
  const table = [header, ...rows];
  const measured = table.filter((r) => r.length !== 3); // skipped rows print their reason free-form
  const widths = header.map((_, i) => Math.max(...measured.map((r) => String(r[i] ?? '').length)));
  console.log('== summary (ms; json 1st = valid on the first try; valid = after one repair; cold = warm-up call)');
  for (const r of table) console.log(r.length === 3 ? `${r[0].padEnd(widths[0])}  ${r[1]}: ${r[2]}` : r.map((v, i) => String(v).padEnd(widths[i])).join('  '));
  const total = summaries.reduce((sum, s) => sum + (s.cost ?? 0), 0);
  console.log(`total cost: $${total.toFixed(4)}`);

  for (const provider of ['openai', 'openrouter']) {
    const ok = summaries
      .filter((s) => s.provider === provider && s.metrics && s.metrics.valid === s.metrics.n && s.metrics.sensible >= Math.ceil(s.metrics.n * 0.8))
      .sort((a, b) => a.metrics.latP50 - b.metrics.latP50);
    if (ok.length) {
      console.log(`recommended ${provider}: ${ok[0].model} (total p50 ${ok[0].metrics.latP50} ms, sensible ${ok[0].metrics.sensible}/${ok[0].metrics.n})${ok[1] ? `; runner-up ${ok[1].model} (${ok[1].metrics.latP50} ms)` : ''}`);
    } else if (summaries.some((s) => s.provider === provider)) {
      console.log(`recommended ${provider}: none met 100% valid and >=80% sensible`);
    }
  }
}

// ------------------------------------------------------------------ contexts

function castFrom(assets) {
  const people = (assets.people ?? []).filter((p) => !p.exclude).map((p) => ({ id: p.id, name: unstress(p.display ?? p.id), namesake: Boolean(p.disambiguate_with_surname) }));
  const lead = people.find((p) => p.id === assets.firstAlways) ?? { id: 'orlov_y', name: 'Ярослав Орлов' };
  const others = people.filter((p) => p.id !== lead.id && !p.namesake).slice(0, 6);
  const fallback = [['nevsky_g', 'Глеб Невский'], ['tkach_t', 'Тимур Ткач'], ['belozersky_s', 'Сергей Белозерский'], ['belozerskaya_n', 'Нина Белозерская'], ['zuev_k', 'Кирилл Зуев'], ['stepanov_m', 'Матвей Степанов']];
  for (const [id, name] of fallback) if (others.length < 6 && !others.some((p) => p.id === id)) others.push({ id, name });
  return { lead, others };
}

function buildContexts({ lead, others }, dayMode) {
  const [p1, p2, p3, p4, p5, p6] = others;
  const all = [lead, ...others];
  const monday = dayMode === 'monday_focus';
  const person = (p, status, extra = {}) => ({ id: p.id, name: p.name, present: status !== 'absent', joined: status === 'absent' ? null : '09:58:40', status, ...extra });
  const host = (last = null) => ({ speaking: false, silent_mode: false, last_utterance: last, last_interrupted: false });
  const common = { day_mode: dayMode, deadline: { soft: '10:28', hard: '10:30' } };
  const text = (a) => String(a.text ?? '').toLowerCase();
  return [
    {
      id: 'C1',
      title: '10:00, Орлов на связи',
      context: {
        now: '10:00:04', ...common, phase: 'waiting', lead_present: true,
        participants: all.map((p) => person(p, 'pending')), speaker: null, host: host(), plan: { next: null, then: [] },
        recent_events: [{ t: '09:59:12', type: 'joined', who: p5.id }, { t: '10:00:00', type: 'timer', name: 'start' }],
        transcript_window: [{ t: '09:59:31', who: p1.id, text: 'Всем привет!' }, { t: '09:59:40', who: p3.id, text: 'Привет. Ну что, все в сборе?' }],
        trigger: 'timer',
      },
      check: (a) => {
        if (a.action !== 'give_word' || a.to !== lead.id) return { ok: false, note: `expected give_word -> ${lead.id}` };
        if (a.text && monday && !/недел/.test(text(a))) return { ok: false, note: 'Monday opener should mention the week' };
        if (a.plan?.next === lead.id) return { ok: false, note: 'plan.next must be the one after the lead' };
        return { ok: true };
      },
    },
    {
      id: 'C2',
      title: '10:02, Орлова нет, про старт никто не сказал',
      context: {
        now: '10:02:05', ...common, phase: 'waiting', lead_present: false,
        participants: [person(lead, 'absent'), ...others.map((p) => person(p, 'pending'))], speaker: null,
        host: host('Доброе утро, коллеги! Ждём Ярослава, начнём, как только он подключится.'), plan: { next: null, then: [] },
        recent_events: [{ t: '10:00:06', type: 'host_speech', text: 'Доброе утро, коллеги! Ждём Ярослава, начнём, как только он подключится.' }, { t: '10:02:00', type: 'timer', name: 'wait_lead_until' }],
        transcript_window: [
          { t: '10:01:25', who: p2.id, text: 'Я ему написал, пока не ответил.' },
          { t: '10:01:33', who: p4.id, text: 'Меня хорошо слышно?' },
          { t: '10:01:36', who: p1.id, text: 'Да, всё отлично.' },
        ],
        trigger: 'timer',
      },
      check: (a) => {
        const t = text(a);
        if (a.action === 'speak' && /без/.test(t) && /\?/.test(t)) return { ok: true };
        if (a.action === 'give_word' && a.to !== lead.id && /без/.test(t)) return { ok: true, note: 'started without asking' };
        return { ok: false, note: 'expected: propose to start without him and ask' };
      },
    },
    {
      id: 'C3',
      title: 'Орлов подключился посреди круга',
      context: {
        now: '10:06:40', ...common, phase: 'round', lead_present: true,
        participants: [person(lead, 'pending', { joined: '10:06:31' }), person(p1, 'spoke'), person(p2, 'speaking'), ...[p3, p4, p5, p6].map((p) => person(p, 'pending'))],
        speaker: { id: p2.id, conf: 'high', since_s: 52, silence_ms: 300 }, host: host('Спасибо! Дальше Тимур.'),
        plan: { next: p3.id, then: [p4.id, p5.id, p6.id] },
        recent_events: [{ t: '10:05:48', type: 'give_word', to: p2.id }, { t: '10:06:31', type: 'joined', who: lead.id }],
        transcript_window: [
          { t: '10:06:05', who: p2.id, text: 'По проекту сегодня добиваю миграцию данных, там осталось два скрипта.' },
          { t: '10:06:28', who: p2.id, text: 'Потом хочу посмотреть логи ночного прогона, там были странные падения,' },
        ],
        trigger: 'joined',
      },
      check: (a) => {
        if (a.action !== 'wait') return { ok: false, note: `speaks over ${p2.id}` };
        if (a.plan?.next !== lead.id) return { ok: false, note: `plan.next should be ${lead.id}` };
        return { ok: true };
      },
    },
    {
      id: 'C4',
      title: 'вопрос ведущей: на чём ты работаешь',
      context: {
        now: '10:09:15', ...common, phase: 'round', lead_present: true,
        participants: [person(lead, 'spoke'), person(p1, 'spoke'), person(p2, 'spoke'), person(p3, 'speaking'), person(p4, 'pending'), person(p5, 'pending'), person(p6, 'pending')],
        speaker: { id: p5.id, conf: 'med', since_s: 4, silence_ms: 900 }, host: host(),
        plan: { next: p4.id, then: [p5.id, p6.id] },
        recent_events: [{ t: '10:08:31', type: 'give_word', to: p3.id }],
        transcript_window: [
          { t: '10:08:50', who: p3.id, text: 'Сегодня у меня ревью двух задач, потом созвон по срокам.' },
          { t: '10:09:08', who: p5.id, text: 'Кора, слушай, а ты вообще на чём работаешь?' },
        ],
        trigger: 'question_to_host',
      },
      check: (a) => {
        if (!['answer', 'give_word'].includes(a.action)) return { ok: false, note: 'expected an answer' };
        if (!/openai|оупен/.test(text(a))) return { ok: false, note: 'should name OpenAI (voice/ears)' };
        if (a.action === 'give_word' && a.to === p5.id) return { ok: false, note: `gives the floor to the asker while ${p3.id} is mid-update` };
        const asker = p5.name.split(/\s+/)[0].toLowerCase();
        if (new RegExp(`${asker}, (продолжай|твоя очередь|тебе слово)`).test(text(a))) return { ok: false, note: `bridge goes to the asker, not to ${p3.id}` };
        return { ok: true };
      },
    },
    {
      id: 'C5',
      title: 'открытое слово, тишина: закрытие',
      context: {
        now: '10:19:40', ...common, phase: 'open_floor', lead_present: true,
        participants: all.map((p) => person(p, 'spoke')), speaker: null,
        host: host('Все высказались. Кто хочет что-то добавить или спросить?'), plan: { next: null, then: [] },
        recent_events: [{ t: '10:19:33', type: 'host_speech', text: 'Все высказались. Кто хочет что-то добавить или спросить?' }, { t: '10:19:40', type: 'silence', ms: 6500 }],
        transcript_window: [{ t: '10:19:05', who: p6.id, text: 'И после обеда демо. У меня всё.' }],
        trigger: 'silence',
      },
      check: (a) => {
        if (a.action !== 'leave') return { ok: false, note: 'expected leave' };
        if (!a.text) return { ok: true, note: 'closing clip' };
        const t = text(a);
        if (!/дев.?синк/.test(t)) return { ok: false, note: 'no dev-sync handoff' };
        if (monday ? !/недел/.test(t) : !/дня/.test(t)) return { ok: false, note: 'wrong wish for the day' };
        return { ok: true };
      },
    },
  ];
}

function pct(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function fmt(v) {
  return v == null ? '-' : String(Math.round(v));
}

function unstress(s) {
  return String(s).replace(/[̀́]/g, '');
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(`fatal: ${e?.stack ?? e}`);
    process.exitCode = 1;
  },
);
