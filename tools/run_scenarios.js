#!/usr/bin/env node
// Conversation scenarios (src/agent/scenarios.js, fictional team) against the real model: the draft
// agent (src/agent/draft_agent.js) on Yandex AI Studio with tool calls. Network; synthetic data only;
// key values are never printed. Report: _internal/scenarios_<date>.json (gitignored).
//
//   node tools/run_scenarios.js [--provider yandex|google|openrouter] [--model <id>] [--effort low|none|...] [--only id1,id2] [--rounds 3] [--prompt skills|draft] [--verbose]
// --provider google: Gemini with the Google AI Studio key (settings.keys.google, model brain.google_model;
// reasoning_effort low unless --effort); openrouter: settings.keys.openrouter + --model <slug>.
// --prompt skills (default, step 5): persona + the playbook blocks of the phase, from the committed
// examples (config/*.example.*: the fictional team the scenarios are written on); draft: the base alone.
//
// Acceptance (docs/agent_plan.md, step 1): 0 violations (forbidden actions / invariants) and >= 90% of
// the must-steps over 3 rounds (the model is stochastic).
//        [--endpoint URL] [--folder ID]   (a mock / another folder)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ENDPOINTS } from '../src/brain/client.js';
import { SCENARIOS, SCENARIO_LEAD, SCENARIO_ROSTER } from '../src/agent/scenarios.js';
import { describe, runScenarios } from '../src/agent/scenario_runner.js';
import { agentPrompts, buildSystemPrompt, createDraftAgent } from '../src/agent/draft_agent.js';
import { loadBrainAssets } from '../src/brain/prompt.js';
import { formatMsk } from '../src/clock.js';
import { loadSettings } from '../src/config.js';
import { APP_ROOT, loadEnv, requireKey } from '../src/env.js';

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: 'string' },
      provider: { type: 'string' },
      effort: { type: 'string' },
      only: { type: 'string' },
      rounds: { type: 'string', default: '3' },
      verbose: { type: 'boolean', short: 'v', default: false },
      endpoint: { type: 'string' },
      folder: { type: 'string' },
      timeout: { type: 'string', default: '15000' },
      prompt: { type: 'string', default: 'skills' },
    },
  });
  loadEnv();
  const settings = loadSettings();
  const provider = values.provider ?? settings.agent?.provider ?? 'yandex';
  let keyName;
  let model;
  if (provider === 'openrouter' || provider === 'google') {
    keyName = settings.keys?.[provider];
    model = values.model ?? settings.agent?.model ?? (provider === 'google' ? settings.brain?.google_model : settings.brain?.openrouter_model);
    if (!keyName || !model) {
      console.error(`need settings.keys.${provider} and --model <model id>`);
      return 64;
    }
  } else {
    keyName = settings.keys?.yandex;
    const folder = values.folder ?? settings.yandex?.folder;
    if (!keyName || !folder) {
      console.error('need settings.keys.yandex (env name of the Yandex Cloud key) and settings.yandex.folder (settings.local.json)');
      return 64;
    }
    const bare = values.model ?? settings.brain?.yandex_model ?? 'aliceai-llm-flash/latest';
    model = bare.startsWith('gpt://') ? bare : `gpt://${folder}/${bare}`;
  }
  let system = buildSystemPrompt({ roster: SCENARIO_ROSTER, leadId: SCENARIO_LEAD });
  if (values.prompt === 'skills') {
    // the scenarios are written on the fictional team: its persona and playbook, never the local real ones
    const prev = process.env.STANDUP_EXAMPLES_ONLY;
    process.env.STANDUP_EXAMPLES_ONLY = '1';
    const assets = loadBrainAssets();
    if (prev === undefined) delete process.env.STANDUP_EXAMPLES_ONLY;
    else process.env.STANDUP_EXAMPLES_ONLY = prev;
    system = agentPrompts({ assets: { ...assets, people: SCENARIO_ROSTER }, leadId: SCENARIO_LEAD, team: 'Acme', scheduled: false, dayMode: 'daily_plans', model });
  }
  const agent = createDraftAgent({
    endpoint: values.endpoint ?? ENDPOINTS[provider],
    apiKey: requireKey(keyName),
    model,
    system,
    timeoutMs: Number(values.timeout),
    reasoningEffort: values.effort ?? (provider === 'google' ? 'low' : null),
  });
  const only = values.only?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  console.log(`${provider} ${model}; prompt ${values.prompt}; ${only?.length ?? SCENARIOS.length} scenarios x ${values.rounds} round(s)\n`);

  let current = null;
  const report = await runScenarios(SCENARIOS, (input) => agent.decide(input), {
    rounds: Number(values.rounds),
    only,
    leadId: SCENARIO_LEAD,
    names: Object.fromEntries(SCENARIO_ROSTER.map((p) => [p.id, p.vocative])),
    onStep: (sc, s) => {
      if (current !== sc.id) {
        current = sc.id;
        console.log(`${sc.id} — ${sc.title}`);
      }
      const mark = s.ok ? 'ok ' : s.level === 'soft' ? '~  ' : 'BAD';
      const t = s.timings?.first_tool_name != null ? ` (tool ${s.timings.first_tool_name} ms, done ${s.timings.done} ms)` : ` (${s.ms} ms)`;
      console.log(`  ${mark} #${s.i} ${s.actions.map(describe).join(' + ') || 'nothing'}${t}${!s.ok || values.verbose ? `${s.why ? `\n        ${s.why}` : ''}` : ''}`);
    },
  });

  const steps = report.results.flatMap((r) => r.steps);
  const p50 = (xs) => {
    const s = xs.filter((v) => v != null).sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : '-';
  };
  const share = report.must.total ? Math.round((report.must.ok / report.must.total) * 100) : 0;
  console.log(`\nmust: ${report.must.ok}/${report.must.total} (${share}%); soft: ${report.soft.ok}/${report.soft.total}; violations: ${report.violations}; tool_choice ${agent.toolChoice}`);
  console.log(`acceptance (0 violations, >= 90% must): ${report.violations === 0 && share >= 90 ? 'PASS' : 'FAIL'}`);
  console.log(`tool name p50 ${p50(steps.map((s) => s.timings?.first_tool_name))} ms; whole answer p50 ${p50(steps.map((s) => s.timings?.done ?? s.ms))} ms`);
  const failed = report.results.filter((r) => !r.ok).map((r) => r.id);
  if (failed.length) console.log(`failed scenarios: ${failed.join(', ')}`);
  const dir = join(APP_ROOT, '_internal');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `scenarios_${formatMsk(new Date(), 'YYYY-MM-DD_HH-mm')}_${String(model).replace(/^gpt:\/\/[^/]+\//, '').replace(/[^\w.-]+/g, '_')}.json`);
  writeFileSync(path, JSON.stringify({ model, prompt: values.prompt, ...report }, (k, v) => (v instanceof RegExp ? String(v) : v), 2));
  console.log(`report: ${path}`);
  return report.violations === 0 && share >= 90 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${e?.message ?? e}`);
    process.exit(1);
  },
);
