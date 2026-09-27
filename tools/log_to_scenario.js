#!/usr/bin/env node
// A failure from a live test becomes a scenario, not a regex in the host (docs/agent_plan.md step 4):
// a window of a host log -> a draft for src/agent/scenarios.js on the fictional team (people mapped to
// Acme ids, their names in the texts replaced, inflected forms included). Runs locally, no network.
//
//   node tools/log_to_scenario.js logs/testroom_2026-09-27_run2.jsonl --from 03:10 --to 04:05 [--id why_silent]
//
// Output: the draft on stdout and in _internal/scenario_<id>.json. Replaced: people.json names (any
// ending, ё/е), guests' Telemost names, people.json keywords (-> «Acme»). Before it goes to git: write
// `expect` / `ideal` / `forbid` for each step and CHECK THE TEXT FOR REAL DATA (names nobody put in
// people.json, projects, numbers).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { clockOf, parseLog, timelineOf, toScenarioDraft } from '../src/agent/replay.js';
import { SCENARIO_LEAD, SCENARIO_ROSTER } from '../src/agent/scenarios.js';
import { loadRoster } from '../src/core/state.js';
import { APP_ROOT } from '../src/env.js';

const mmss = (s) => {
  const m = /^(\d+):(\d{2})$/.exec(String(s ?? ''));
  return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null;
};

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { from: { type: 'string' }, to: { type: 'string' }, id: { type: 'string', default: 'from_log' } },
});
const file = positionals[0];
if (!file) {
  console.error('node tools/log_to_scenario.js <log.jsonl> --from mm:ss --to mm:ss [--id name]');
  process.exit(64);
}
const tl = timelineOf(parseLog(readFileSync(file, 'utf8')));
const roster = loadRoster();
const draft = toScenarioDraft(tl, { from: mmss(values.from) ?? 0, to: mmss(values.to) ?? Infinity, roster, fake: SCENARIO_ROSTER, fakeLead: SCENARIO_LEAD, id: values.id });
const leftovers = (roster.keywords ?? []).filter((k) => JSON.stringify(draft).toLowerCase().includes(k.toLowerCase()));
const dir = join(APP_ROOT, '_internal');
mkdirSync(dir, { recursive: true });
const out = join(dir, `scenario_${values.id}.json`);
writeFileSync(out, JSON.stringify(draft, null, 2));
console.log(JSON.stringify(draft, null, 2));
console.log(`\n${draft.steps.length} step(s) from ${clockOf(mmss(values.from) ?? 0)}; draft: ${out}`);
if (leftovers.length) console.log(`!! still in the draft (people.json keywords): ${leftovers.join(', ')} — replace them by hand`);
console.log('Write expect / ideal / forbid for each step and check the text for real data before it goes to git.');
