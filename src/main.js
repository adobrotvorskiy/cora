#!/usr/bin/env node
// standup-host CLI.
//   node src/main.js --check      readiness check (keys are reported present/absent only)
//   node src/main.js [--shadow] [--url <url>] [--at HH:MM] [--day mon|tue|wed|thu] [--verbose] [--no-brain]
// Host modes are wired in WP6 through startHost() below.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import * as clock from './clock.js';
import { SETTINGS_LOCAL_PATH, deriveTimes, loadSettings, selectBrainProvider, validateSettings } from './config.js';
import { selectVoiceProvider } from './audio/voice.js';
import { APP_ROOT, hasKey, keySource, loadEnv, redactSecrets, requireKey } from './env.js';
import { openLog } from './log.js';

const USAGE = `Usage: node src/main.js [options]

  --check                  readiness check: keys (present/absent), brain provider, browser,
                           settings, day mode. Exit 0 = ready, 1 = not ready
  --shadow                 join, listen and log, never speak (fallback mode)
  --url <url>              meeting URL (overrides settings.meeting_url), e.g. a test room
  --at <HH:MM>             simulated clock: act as if it were HH:MM today (MSK); time keeps flowing
  --day <mon|tue|wed|thu>  simulated weekday (Monday = weekly focus, Tue-Thu = daily plans)
  --start <HH:MM>          scheduled mode: the standup starts at HH:MM (deadlines shift with it).
                           Without --start the host has no schedule: she joins at once and opens
                           the standup when people ask her by name («Кора, начинай»)
  --verbose, -v            mirror log events to the console
  --no-brain               no LLM brain calls (scripted fallback)
  --live                   allow the REAL standup room (any time; keep her out of it without --live)
  --max-minutes <n>        leave n minutes after start (tests), closing phrase first
  --no-alert               no Telegram alerts (tests)
  --provider <name>        voice provider for this run: openrouter (cascade, default) | openai_realtime |
                           elevenlabs_agent (one ElevenLabs conversational agent, docs/eleven_agent.md)
  --help, -h               show this help`;

const OPTIONS = {
  check: { type: 'boolean', default: false },
  shadow: { type: 'boolean', default: false },
  url: { type: 'string' },
  at: { type: 'string' },
  day: { type: 'string' },
  start: { type: 'string' },
  verbose: { type: 'boolean', short: 'v', default: false },
  'no-brain': { type: 'boolean', default: false },
  live: { type: 'boolean', default: false },
  'max-minutes': { type: 'string' },
  'no-alert': { type: 'boolean', default: false },
  provider: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
};
const HOST_DAYS = ['mon', 'tue', 'wed', 'thu'];
const PROVIDERS = ['openrouter', 'openai_realtime', 'elevenlabs_agent', 'yandex_rt', 'yandex_cascade'];
const REQUIRED_NODE_MAJOR = 24;
const BROWSER_SUFFIX = {
  chrome: '\\Google\\Chrome\\Application\\chrome.exe',
  msedge: '\\Microsoft\\Edge\\Application\\msedge.exe',
};

/**
 * Flags handed to the host. By the time startHost() runs, `url` is already merged
 * into settings.meeting_url and `at`/`day` are already applied to clock.js.
 * @typedef {object} HostFlags
 * @property {boolean} check
 * @property {boolean} shadow   listen and log only, never speak
 * @property {string|null} url
 * @property {string|null} at   "HH:MM"
 * @property {string|null} day  mon|tue|wed|thu
 * @property {string|null} start  "HH:MM" — scheduled mode anchor; null = on-demand (start when asked by name)
 * @property {boolean} verbose
 * @property {boolean} brain    false with --no-brain
 * @property {boolean} live     --live: the real room is allowed (guards.realRoomAllowed)
 * @property {number|null} maxMinutes  --max-minutes
 * @property {boolean} alert    false with --no-alert
 * @property {boolean} help
 */

/** @returns {HostFlags} throws Error with a user-facing message on bad input */
export function parseFlags(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
  const flags = {
    check: values.check,
    shadow: values.shadow,
    url: values.url ?? null,
    at: values.at ?? null,
    day: values.day ? values.day.toLowerCase() : null,
    start: values.start ?? null,
    verbose: values.verbose,
    brain: !values['no-brain'],
    live: values.live,
    maxMinutes: null,
    alert: !values['no-alert'],
    provider: values.provider ?? null,
    help: values.help,
  };
  if (flags.provider !== null && !PROVIDERS.includes(flags.provider)) throw new Error(`--provider: expected one of ${PROVIDERS.join('|')}`);
  if (values['max-minutes'] !== undefined) {
    const n = Number(values['max-minutes']);
    if (!Number.isFinite(n) || n <= 0 || n > 180) throw new Error('--max-minutes: expected a number of minutes (0 < n <= 180)');
    flags.maxMinutes = n;
  }
  if (flags.url !== null) {
    let url;
    try {
      url = new URL(flags.url);
    } catch {
      throw new Error('--url: not a valid URL');
    }
    if (url.protocol !== 'https:') throw new Error('--url: expected an https:// link');
  }
  if (flags.at !== null) {
    try {
      clock.parseHHMM(flags.at);
    } catch (e) {
      throw new Error(`--at: ${e.message}`);
    }
  }
  if (flags.start !== null) {
    let parsed;
    try {
      parsed = clock.parseHHMM(flags.start);
    } catch (e) {
      throw new Error(`--start: ${e.message}`);
    }
    // the derived schedule reaches +40 min past start; keep it inside the day
    const startMin = parsed.hour * 60 + parsed.minute;
    if (startMin < 5 || startMin > 22 * 60 + 55) throw new Error('--start: expected between 00:05 and 22:55 (deadlines shift up to +40 min)');
  }
  if (flags.day !== null && !HOST_DAYS.includes(flags.day)) throw new Error(`--day: expected one of ${HOST_DAYS.join('|')}`);
  return flags;
}

/** @returns {Promise<number>} process exit code */
export async function main(argv = process.argv.slice(2)) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (e) {
    console.error(`error: ${e.message}\n\n${USAGE}`);
    return 64;
  }
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }

  const envReport = loadEnv();
  const settings = loadSettings({ cliOverrides: { meeting_url: flags.url ?? undefined, ...(flags.provider ? { voice: { provider: flags.provider } } : {}) } });
  if (flags.day) clock.setSimulatedDay(flags.day);
  if (flags.at) clock.setSimulatedStart(flags.at);

  if (flags.check) {
    const code = runCheck(settings, flags, envReport);
    if (settings.voice?.provider === 'elevenlabs_agent') await printElevenBalance(settings);
    return code;
  }
  return startHost(settings, flags);
}

/** ElevenLabs balance for --check (network; numbers only): how many agent minutes are left. */
async function printElevenBalance(settings) {
  const keyName = settings.keys?.elevenlabs;
  if (!keyName || !hasKey(keyName)) return;
  try {
    const { elevenRest, balanceOf } = await import('./audio/eleven_agent.js');
    const { elevenSettings } = await import('./audio/eleven_prompt.js');
    const b = balanceOf(await elevenRest({ apiKey: requireKey(keyName), timeoutMs: 8000 }).subscription());
    const perMin = elevenSettings(settings).credits_per_min;
    const minutes = perMin ? Math.floor(b.remaining / perMin) : null;
    const low = minutes !== null && minutes < (elevenSettings(settings).low_balance_minutes ?? 30);
    console.log(`  ${'balance'.padEnd(10)}  ElevenLabs ${b.tier}: ${b.remaining} credits left${minutes !== null ? ` ≈ ${minutes} min at ${perMin}/min` : ''}${low ? '  LOW: less than a standup, top up (Pay As You Go)' : ''}`);
  } catch (e) {
    console.log(`  ${'balance'.padEnd(10)}  ElevenLabs: unavailable (${String(e?.message ?? e).slice(0, 120)})`);
  }
}

/**
 * The only place that starts the host (WP6 core/host.js). Env is loaded, settings merged and
 * the clock simulation applied before this runs. Resolves to the process exit code.
 * @param {object} settings
 * @param {HostFlags} flags
 * @returns {Promise<number>}
 */
async function startHost(settings, flags) {
  // Schedule is optional (owner's decision, 21.09): --start anchors the day, without it times go null and
  // the host has no clock at all — she joins at once and opens the standup when asked by name.
  settings.times = flags.start ? deriveTimes(flags.start, settings.times ?? {}) : null;
  if (settings.voice?.provider === 'elevenlabs_agent' || settings.voice?.provider === 'yandex_rt') {
    const { runAgentHost } = await import('./core/agent_host.js');
    return runAgentHost(settings, flags);
  }
  const { runHost } = await import('./core/host.js');
  return runHost(settings, flags);
}

/**
 * Readiness check. Prints names and present/absent only, never values.
 * Pass = node >= 24, deps installed, keys for the configured voice/brain providers present,
 * browser for the configured channel found, no settings errors, log writable.
 * @returns {number} exit code (0 ready, 1 not ready)
 */
export function runCheck(settings, flags, envReport) {
  const fails = [];
  const lines = [];
  const row = (label, text) => lines.push(`  ${label.padEnd(10)}  ${text}`);

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < REQUIRED_NODE_MAJOR) fails.push(`node ${process.version} < ${REQUIRED_NODE_MAJOR}`);
  row('node', `${process.version}${nodeMajor < REQUIRED_NODE_MAJOR ? `  (need >= ${REQUIRED_NODE_MAJOR})` : ''}`);

  const deps = ['playwright-core', 'ws'].map((name) => ({ name, version: depVersion(name) }));
  for (const d of deps) if (!d.version) fails.push(`${d.name} not installed (run npm install)`);
  row('deps', deps.map((d) => `${d.name} ${d.version ?? 'MISSING'}`).join(', '));

  row('env files', envReport.map((r) => `${basename(r.file)} ${r.status}${r.error ? ` (${r.error})` : ''}`).join(', '));

  const { errors, warnings } = validateSettings(settings);
  const keys = {};
  let voiceSel = null;
  try {
    voiceSel = selectVoiceProvider(settings);
  } catch (e) {
    fails.push(`voice: ${e.message}`);
  }
  if (settings.keys) {
    const width = Math.max(...Object.values(settings.keys).map((name) => String(name).length));
    for (const name of Object.values(settings.keys)) {
      const present = hasKey(name);
      keys[name] = present ? 'present' : 'absent';
      row('key', `${String(name).padEnd(width)}  ${present ? `present  (${keySource(name)})` : 'absent'}`);
    }
    // the voice provider decides which key is mandatory (openrouter -> Cora_KEY; openai_realtime -> OPENAI_API_KEY)
    if (voiceSel && !hasKey(voiceSel.keyName)) fails.push(`${voiceSel.keyName} absent (voice provider ${voiceSel.provider} needs it)`);
  }
  if (voiceSel) row('voice', `${voiceSel.provider}: tts ${voiceSel.tts_model}, stt ${voiceSel.stt_model}, voice ${voiceSel.voice}, key ${voiceSel.keyName}`);
  if (voiceSel?.provider === 'yandex_rt') {
    row('folder', `${voiceSel.folderName}  ${hasKey(voiceSel.folderName) ? `present (${keySource(voiceSel.folderName)})` : 'absent — это id каталога облака (строка 122–124 .env.local)'}`);
    if (!hasKey(voiceSel.keyName)) fails.push(`${voiceSel.keyName} absent (yandex_rt needs it)`);
    if (!hasKey(voiceSel.folderName)) fails.push(`${voiceSel.folderName} absent (cloud folder id for yandex_rt)`);
    // если ключ есть, но прав нет — это видно только в живом подключении; подсказка по ролям:
    row('note', 'yandex_rt: сервисному аккаунту нужны роли ai.models.user (+ai.speechkit-*.user для пер-трекового STT); ключ — без scope-ограничения');
  }
  if (voiceSel?.provider === 'yandex_cascade') {
    row('folder', `${voiceSel.folder}  (settings.yandex.folder)`);
    row('cascade', `ears SpeechKit STT per SFU slot (${voiceSel.stt_model}), mouth ${voiceSel.mouth === 'speechkit' ? `SpeechKit TTS ${voiceSel.voice}` : `ElevenLabs ${voiceSel.voice}`}, brain ${settings.brain?.provider === 'yandex' ? `Yandex AI Studio ${voiceSel.llm}` : settings.brain?.provider ?? 'auto'}`);
    if (voiceSel.mouth === 'elevenlabs' && !hasKey(settings.keys?.elevenlabs)) fails.push(`${settings.keys?.elevenlabs} absent (yandex.cascade_mouth elevenlabs needs it)`);
    row('note', 'yandex_cascade: ключу нужны роли ai.speechkit-stt.user, ai.speechkit-tts.user, ai.languageModels.user на каталоге; проверка вживую — node tools/yandex_cascade_probe.js');
  }
  if (voiceSel?.provider === 'elevenlabs_agent') {
    row('agent', voiceSel.agent_id ? `${voiceSel.agent_id}  llm ${voiceSel.llm}` : 'absent — run node tools/eleven_agent_setup.js');
    if (!voiceSel.agent_id) fails.push('no ElevenLabs agent id (voice.eleven_agent_id): run node tools/eleven_agent_setup.js');
  }

  let brain = { provider: 'disabled', model: null };
  if (voiceSel?.provider === 'elevenlabs_agent') {
    row('brain', 'inside the ElevenLabs agent (no OpenRouter brain calls in this mode)');
  } else if (flags.brain && settings.keys && settings.brain) {
    brain = selectBrainProvider(settings);
    const text = {
      openrouter: `openrouter / ${brain.model}`,
      openai: `openai / ${brain.model}  (fallback: ${settings.keys.openrouter} absent)`,
      yandex: `yandex / ${brain.model}  (Yandex AI Studio, key ${brain.keyName})`,
      none: 'none — cannot start',
    }[brain.provider];
    row('brain', text);
  } else if (!flags.brain) {
    row('brain', 'disabled (--no-brain)');
  }

  const channel = settings.browser?.channel;
  const browsers = { chrome: findBrowser('chrome'), msedge: findBrowser('msedge') };
  row('browser', `chrome: ${browsers.chrome ?? 'not found'}${channel === 'chrome' ? '  [channel]' : ''}`);
  row('', `msedge: ${browsers.msedge ?? 'not found'}${channel === 'msedge' ? '  [channel]' : ''}`);
  if (!browsers[channel]) fails.push(`browser for channel "${channel}" not found`);

  const rt = settings.realtime ?? {};
  row('realtime', `${rt.voice} speed=${rt.speed} model=${rt.model} effort=${rt.reasoning_effort} pace_instructions=${rt.pace_instructions ? 'set' : 'missing'}${voiceSel?.provider === 'openrouter' ? '  (fallback provider)' : ''}`);
  row('meeting', `${settings.meeting_url}  as "${settings.display_name}"`);
  if (flags.start) {
    const t = deriveTimes(flags.start, settings.times ?? {});
    row('times', `--start ${flags.start}: join ${t.join}, soft ${t.soft_deadline}, hard ${t.hard_deadline}, leave ${t.force_leave}`);
  } else {
    row('times', 'on-demand (no --start): no clock, opens when people ask her by name');
  }
  row('overrides', `settings.local.json ${existsSync(SETTINGS_LOCAL_PATH) ? 'applied' : 'none'}${flags.url ? ', --url' : ''}`);
  for (const w of warnings) row('warning', w);
  for (const e of errors) {
    row('error', e);
    fails.push(e);
  }

  const sim = clock.simulation();
  const today = clock.nowMsk();
  const mode = clock.dayMode();
  const simText = sim.active ? `  [simulated:${sim.at ? ` --at ${sim.at}` : ''}${sim.day ? ` --day ${sim.day}` : ''}]` : '';
  row('clock', `${today.ymd} ${today.hms} MSK, ${clock.formatMsk(today.date, 'ddd')}${simText}`);
  row('day mode', mode === 'off' ? 'off (Fri-Sun: no standup; --day simulates a weekday)' : mode);

  try {
    const log = openLog({ verbose: flags.verbose });
    log.event('check', {
      ok: fails.length === 0,
      fails,
      keys,
      brain: { provider: brain.provider, model: brain.model },
      browser: { channel, found: Boolean(browsers[channel]) },
      day_mode: mode,
      simulated: sim.active,
    });
    log.close();
    row('log', log.path);
  } catch (e) {
    fails.push(`log not writable: ${e.code ?? e.message}`);
    row('log', 'NOT WRITABLE');
  }

  lines.push(fails.length ? `  RESULT      FAIL: ${fails.join('; ')}` : '  RESULT      OK');
  console.log(`standup-host --check\n${lines.join('\n')}`);
  return fails.length ? 1 : 0;
}

/** Same lookup order as playwright-core's channel resolution on Windows. */
function findBrowser(channel) {
  const suffix = BROWSER_SUFFIX[channel];
  if (!suffix) return null;
  const env = process.env;
  const prefixes = [
    env.LOCALAPPDATA,
    env.PROGRAMFILES,
    env['PROGRAMFILES(X86)'],
    env.HOMEDRIVE && `${env.HOMEDRIVE}\\Program Files`,
    env.HOMEDRIVE && `${env.HOMEDRIVE}\\Program Files (x86)`,
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].filter(Boolean);
  return prefixes.map((prefix) => join(prefix, suffix)).find((path) => existsSync(path)) ?? null;
}

function depVersion(name) {
  try {
    return JSON.parse(readFileSync(join(APP_ROOT, 'node_modules', name, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`fatal: ${redactSecrets(err?.message ?? String(err))}`);
      process.exitCode = 1;
    },
  );
}
