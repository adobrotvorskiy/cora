#!/usr/bin/env node
// The agent's prompt per phase (docs/agent_plan.md step 5): which playbook sections go where and how
// many tokens a request carries. Local, no network; prints the local persona and playbook (they may
// hold real data: do not paste the output anywhere public).
//
//   node tools/agent_prompt.js [--phase waiting|round|open_floor] [--scheduled] [--monday]
//
// Without --phase: the section map and the size of each phase's prompt (target <= 3000 tokens).

import { parseArgs } from 'node:util';
import { agentPrompts } from '../src/agent/draft_agent.js';
import { PHASES, playbookSkills } from '../src/agent/skills.js';
import { estimateTokens } from '../src/brain/context.js';
import { loadBrainAssets } from '../src/brain/prompt.js';

const { values } = parseArgs({ options: { phase: { type: 'string' }, scheduled: { type: 'boolean', default: false }, monday: { type: 'boolean', default: false } } });
const assets = loadBrainAssets();
for (const w of assets.warnings) console.error(`warning: ${w}`);
const prompts = agentPrompts({ assets, leadId: assets.firstAlways, team: assets.teamName, scheduled: values.scheduled, dayMode: values.monday ? 'monday_focus' : 'daily_plans', model: 'gpt://folder/aliceai-llm-flash/latest' });
if (values.phase) {
  if (!PHASES.includes(values.phase)) {
    console.error(`--phase: ${PHASES.join('|')}`);
    process.exit(64);
  }
  console.log(prompts(values.phase));
  console.log(`\n~${estimateTokens(prompts(values.phase))} tokens`);
} else {
  const { sections } = playbookSkills(assets.playbook ?? '', { scheduled: values.scheduled });
  console.log('playbook sections -> phases (src/agent/skills.js SECTION_PHASES; not listed = every phase):');
  for (const s of sections) console.log(`  ${s.title.padEnd(32)} ${s.phases.length ? s.phases.join(', ') : '— (not for the agent: the code or the old brain)'}`);
  console.log(`\nprompt size (${values.scheduled ? 'scheduled' : 'on demand'}), target <= 3000:`);
  for (const p of PHASES) console.log(`  ${p.padEnd(11)} ~${estimateTokens(prompts(p))} tokens`);
}
