#!/usr/bin/env node
// Replay a host log through the agent (docs/agent_plan.md step 4, src/agent/replay.js): what would the
// agent on tools have decided in a past run? Network (Yandex AI Studio) unless --scripted; the log and
// the report hold transcripts and stay local (logs/, _internal/ are gitignored).
//
//   node tools/replay_log.js logs/testroom_2026-09-27_run2.jsonl [--mode forced|free] [--latency 1200]
//        [--provider yandex|google|openrouter] [--model <id>] [--from mm:ss] [--to mm:ss] [--scripted] [--quiet]
// --provider google: the same run through Gemini (Google AI Studio key) — compare the summaries.
//
// forced (default): people's lines and her ORIGINAL lines at their times, the agent is asked at every
// wake and its calls are only recorded. free: the agent's own lines replace hers.
// Acceptance for step 4: the 27.09 runs replay with no refused calls that point at a prompt problem
// (agent.rejected by reason) and no lines to an empty room.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { agentFromSettings } from '../src/agent/draft_agent.js';
import { clockOf, parseLog, replayTimeline, timelineOf } from '../src/agent/replay.js';
import { loadSettings } from '../src/config.js';
import { loadRoster } from '../src/core/state.js';
import { APP_ROOT, loadEnv } from '../src/env.js';

const mmss = (s) => {
  const m = /^(\d+):(\d{2})$/.exec(String(s ?? ''));
  return m ? (Number(m[1]) * 60 + Number(m[2])) * 1000 : null;
};

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string', default: 'forced' },
      latency: { type: 'string' },
      model: { type: 'string' },
      provider: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      scripted: { type: 'boolean', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
    },
  });
  const file = positionals[0];
  if (!file || !['forced', 'free'].includes(values.mode)) {
    console.error('node tools/replay_log.js <log.jsonl> [--mode forced|free] [--latency ms] [--model m] [--from mm:ss] [--to mm:ss] [--scripted] [--quiet]');
    return 64;
  }
  const tl = timelineOf(parseLog(readFileSync(file, 'utf8')));
  const from = mmss(values.from);
  const to = mmss(values.to);
  if (from !== null || to !== null) {
    // people present before the window stay: presence and turns are kept, lines outside the window go
    tl.events = tl.events.filter((e) => ['joined', 'left', 'turn', 'open_floor', 'closing'].includes(e.type) || ((from === null || e.at >= from) && (to === null || e.at <= to)));
    tl.duration = Math.min(tl.duration, to ?? Infinity);
  }
  loadEnv();
  const settings = loadSettings();
  const roster = loadRoster();
  const agent = values.scripted
    ? { decide: async () => ({ actions: [{ action: 'skip' }], timings: { done: 1000 } }) } // the event path only, no network
    : agentFromSettings({ settings: { ...settings, agent: { ...(settings.agent ?? {}), ...(values.provider ? { provider: values.provider } : {}), ...(values.model ? { model: values.model } : {}) } }, roster });
  console.log(`${basename(file)}: ${tl.events.filter((e) => e.type === 'heard').length} lines, ${clockOf(tl.duration)}; mode ${values.mode}; agent ${values.scripted ? 'scripted (skip)' : agent.model}\n`);
  const r = await replayTimeline(tl, {
    agent,
    roster,
    mode: values.mode,
    latencyMs: values.latency ? Number(values.latency) : null,
    conductor: { budget: settings.agent?.budget },
    onEvent: (e) => {
      if (values.quiet) return;
      if (e.type === 'agent.wake') {
        const what = e.events
          .filter((x) => x.type !== 'silence' || e.reason === 'silence')
          .slice(-3)
          .map((x) => (x.type === 'heard' ? `${x.who}: «${x.text}»` : x.type === 'her_line_done' ? `она: «${x.text}»${x.cut ? ' (оборвали)' : ''}` : x.type === 'silence' ? `тишина ${x.ms} мс` : x.type))
          .join(' · ');
        console.log(`${clockOf(e.at)} wake ${e.reason.padEnd(8)} ${e.phase}${e.speaker ? `/${e.speaker}` : ''}  ${what}`);
      } else if (e.type === 'agent.decision') {
        const acts = e.actions.filter((a) => a.action !== 'skip');
        if (acts.length) console.log(`${clockOf(e.at)}   -> ${acts.map((a) => `${a.action}${a.person ? `(${a.person})` : ''}${a.text ? ` «${a.text}»` : ''}`).join(' + ')}`);
      } else if (e.type === 'agent.rejected') console.log(`${clockOf(e.at)}   !! rejected ${e.tool}: ${e.reason}`);
      else if (e.type === 'agent.aborted') console.log(`${clockOf(e.at)}   .. aborted by a newer line`);
      else if (e.type === 'agent.held') console.log(`${clockOf(e.at)}   .. held ${e.ms} ms while ${e.who}'s tile was lit (${e.why})`);
    },
  });
  console.log(`\n${JSON.stringify(r.summary, null, 2)}`);
  const dir = join(APP_ROOT, '_internal');
  mkdirSync(dir, { recursive: true });
  const tag = String(agent.model ?? 'scripted').replace(/^gpt:\/\/[^/]+\//, '').replace(/[^\w.-]+/g, '_');
  const out = join(dir, `replay_${basename(file, '.jsonl')}_${values.mode}_${tag}.json`);
  writeFileSync(out, JSON.stringify({ file: basename(file), mode: values.mode, model: agent.model ?? 'scripted', summary: r.summary, calls: r.calls, lines: r.lines, events: r.events }, null, 2));
  console.log(`report: ${out}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`error: ${e?.message ?? e}`);
    process.exit(1);
  },
);
