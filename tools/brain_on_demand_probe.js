#!/usr/bin/env node
// Live check of the brain in on-demand mode (no --start, the way the host runs by default): the
// decisions for the situations of a test call. Network (Yandex AI Studio for yandex_cascade, else
// the configured brain); synthetic contexts only; key values are never printed.
//
//   node tools/brain_on_demand_probe.js [--provider yandex_cascade]

import { parseArgs } from 'node:util';
import { createBrain } from '../src/brain/client.js';
import { buildContext } from '../src/brain/context.js';
import { loadBrainAssets } from '../src/brain/prompt.js';
import { loadSettings } from '../src/config.js';
import { loadEnv } from '../src/env.js';

const { values } = parseArgs({ options: { provider: { type: 'string' } } });
loadEnv();
const settings = loadSettings({ cliOverrides: values.provider ? { voice: { provider: values.provider } } : {} });
settings.times = null; // on demand
settings.brain = { ...settings.brain, min_interval_ms: 0 };
const people = loadBrainAssets().people;
const me = 'belozersky_s';
const roster = (present, statuses = {}) =>
  people.map((p) => ({ id: p.id, name: p.display, present: present.includes(p.id), status: statuses[p.id] ?? (present.includes(p.id) ? 'pending' : 'absent') }));
const base = { now: '10:00:05', day_mode: 'daily_plans', phase: 'waiting', speaker: null, host: { speaking: false, silent_mode: false, last_utterance: null, last_interrupted: false }, plan: { next: null, then: [] } };

const cases = [
  {
    name: 'до старта: «Кора, привет! Ты меня слышишь?», Ярослава нет',
    expect: 'answer без «ждём Ярослава»',
    ctx: { ...base, participants: roster([me]), transcript_window: [{ t: '10:00:02', who: me, text: 'Кора, привет! Ты меня слышишь?' }], recent_events: [{ t: '10:00:02', type: 'question_to_host', who: me, how: 'name' }], trigger: 'question_to_host' },
  },
  {
    name: 'до старта: «Кора, а на чём ты работаешь?»',
    expect: 'answer: SpeechKit + модель Яндекса',
    ctx: { ...base, participants: roster([me]), transcript_window: [{ t: '10:00:02', who: me, text: 'Кора, а на чём ты работаешь?' }], recent_events: [{ t: '10:00:02', type: 'question_to_host', who: me, how: 'name' }], trigger: 'question_to_host' },
  },
  {
    name: '«Кора, начинай!», Ярослава нет, на связи только Серёжа',
    expect: `give_word -> ${me}`,
    ctx: { ...base, phase: 'starting', participants: roster([me]), transcript_window: [{ t: '10:00:02', who: me, text: 'Кора, начинай!' }], recent_events: [{ t: '10:00:02', type: 'start_requested', who: me }], trigger: 'start_requested' },
  },
  {
    name: '«Кора, начинай!», Ярослав на связи',
    expect: 'give_word -> orlov_y',
    ctx: { ...base, phase: 'starting', lead_present: true, participants: roster([me, 'orlov_y', 'tkach_t']), transcript_window: [{ t: '10:00:02', who: me, text: 'Кора, начинай!' }], recent_events: [{ t: '10:00:02', type: 'start_requested', who: me }], trigger: 'start_requested' },
  },
];

const brain = createBrain({ settings, dayMode: 'daily_plans' });
console.log(`brain ${brain.model} (on demand)\n`);
for (const c of cases) {
  const r = await brain.decide(buildContext(c.ctx), { trigger: c.ctx.trigger });
  const a = r.action ?? {};
  console.log(`${c.name}\n  ждём: ${c.expect}\n  вышло: ${r.status} ${r.latency_ms} ms -> ${a.action}${a.to ? ` -> ${a.to}` : ''} «${a.text ?? ''}»${r.errors?.length ? `  errors: ${JSON.stringify(r.errors)}` : ''}\n`);
}
brain.close();
