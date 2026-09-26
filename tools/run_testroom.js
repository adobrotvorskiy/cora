#!/usr/bin/env node
// Convenience runner for the TEST ROOM ONLY (WP6). Starts the host in the test room with a
// simulated clock and prints a compact live timeline (one line per interesting log event)
// while the full JSONL goes to logs/. Never points at the real standup room.
//
//   node tools/run_testroom.js [--at 09:59] [--day mon|tue|wed|thu] [--start HH:MM] [--shadow] [--no-brain]
//                              [--max-minutes 4] [--verbose] [--alert] [--url <another TEST url>]
//
// Defaults: --at 09:59 (the start timer fires one minute after the join), --day = today if
// Mon–Thu else mon, --max-minutes 4, Telegram alerts off (pass --alert to enable), timeline on.
// --start HH:MM = scheduled mode anchored at HH:MM; without it the host is on-demand (starts
// when people ask her by name). Exit code = the host's exit code.

import { parseArgs } from 'node:util';
import * as clock from '../src/clock.js';
import { VOICE_PROVIDERS, deriveTimes, loadSettings } from '../src/config.js';
import { loadEnv, redactSecrets } from '../src/env.js';
import { openLog } from '../src/log.js';
import { createHost } from '../src/core/host.js';
import { createAgentHost } from '../src/core/agent_host.js';
import { isRealRoom, testRoomUrl } from '../src/core/guards.js';

const TIMELINE = /^(host\.|round\.|turn\.|timer|presence\.|speech\.|say\.|transcript|brain\.action|brain\.skipped|brain\.unusable|brain\.warmup|brain\.init|brain\.disabled|voice\.|join\.result|join\.stage|leave\.|guard\.|floor\.barge_in|floor\.turn_end|floor\.no_speech|floor\.check_done|clips\.warmup|clips\.miss|page\.speaker|page\.track\.(added|unmuted|ended)|page\.worklet|page\.avatar\.(loaded|start|fallback|segments_ready)|cost\.summary|error\.|rt\.connect|rt\.error|rt\.reconnect|vad\.|stt\.final|plan\.|agent\.(?!speech\.eos|init$)|eleven\.)/;
const PROVIDERS = VOICE_PROVIDERS;
const SKIP_FIELDS = new Set(['ts', 't_msk', 'type', 'stack', 'context', 'statuses', 'attribution_hints']);

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    at: { type: 'string', default: '09:59' },
    day: { type: 'string' },
    start: { type: 'string' },
    shadow: { type: 'boolean', default: false },
    'no-brain': { type: 'boolean', default: false },
    'max-minutes': { type: 'string', default: '4' },
    verbose: { type: 'boolean', short: 'v', default: false },
    alert: { type: 'boolean', default: false },
    url: { type: 'string', default: testRoomUrl() ?? '' },
    provider: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(`node tools/run_testroom.js [--at HH:MM] [--day mon|tue|wed|thu] [--start HH:MM] [--shadow] [--no-brain] [--max-minutes N] [--verbose] [--alert] [--url <test url>] [--provider ${PROVIDERS.join('|')}]`);
  process.exit(0);
}
if (values.provider && !PROVIDERS.includes(values.provider)) {
  console.error(`--provider: expected one of ${PROVIDERS.join('|')}`);
  process.exit(64);
}
if (values.start) {
  try {
    clock.parseHHMM(values.start);
  } catch (e) {
    console.error(`--start: ${e.message}`);
    process.exit(64);
  }
}
if (!values.url) {
  console.error('no test room: set test_room_url in config/settings.local.json or pass --url <test room link>');
  process.exit(64);
}
if (isRealRoom(values.url)) {
  console.error('run_testroom.js refuses the real standup room. Use node src/main.js --live for that.');
  process.exit(64);
}

loadEnv();
const settings = loadSettings({ cliOverrides: { meeting_url: values.url, ...(values.provider ? { voice: { provider: values.provider } } : {}) } });
settings.times = values.start ? deriveTimes(values.start, settings.times ?? {}) : null; // no --start = on-demand mode
const agentMode = settings.voice?.provider === 'elevenlabs_agent' || settings.voice?.provider === 'yandex_rt';
const today = clock.dayMode();
const day = values.day ?? (today === 'off' ? 'mon' : clock.nowMsk().dow);
clock.setSimulatedDay(day);
clock.setSimulatedStart(values.at);
const flags = {
  shadow: values.shadow,
  verbose: values.verbose,
  brain: !values['no-brain'],
  live: false,
  maxMinutes: Number(values['max-minutes']) || 4,
  alert: values.alert,
  url: values.url,
  at: values.at,
  day,
  start: values.start ?? null,
};

const log = openLog({ name: 'testroom', verbose: values.verbose });
const t0 = Date.now();
const baseEvent = log.event;
log.event = (type, fields = {}) => {
  const rec = baseEvent(type, fields);
  if (!values.verbose && TIMELINE.test(type)) console.log(redactSecrets(line(rec)));
  return rec;
};

function line(rec) {
  const parts = [];
  for (const [k, v] of Object.entries(rec)) {
    if (SKIP_FIELDS.has(k) || v === undefined || v === null) continue;
    let s = typeof v === 'string' ? v : JSON.stringify(v);
    if (s.length > 110) s = `${s.slice(0, 109)}…`;
    parts.push(`${k}=${s}`);
  }
  const rel = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
  return `${rel}s ${rec.t_msk.slice(0, 8)} ${rec.type.padEnd(22)} ${parts.join(' ')}`;
}

console.log(`test room: ${values.url}\nsimulated ${day} ${values.at} MSK, mode=${values.start ? `scheduled --start ${values.start}` : 'on-demand'}, provider=${settings.voice?.provider}, shadow=${flags.shadow}, brain=${flags.brain}, max ${flags.maxMinutes} min, alerts=${flags.alert}\nlog: ${log.path}\nCtrl+C = leave and exit\n`);
const host = agentMode ? createAgentHost({ settings, flags, log }) : createHost({ settings, flags, log });
host
  .run()
  .then((code) => {
    log.close();
    console.log(`\nexit ${code} after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    process.exitCode = code;
  })
  .catch((e) => {
    log.close();
    console.error(`fatal: ${redactSecrets(e?.stack ?? String(e))}`);
    process.exitCode = 1;
  });
