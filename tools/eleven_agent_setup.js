#!/usr/bin/env node
// Create or update THE ElevenLabs agent «Кора» and its client tools from our config (WP15,
// docs/eleven_agent.md §2/§7). Idempotent: tools are matched by name, the agent by
// settings.voice.eleven_agent_id (created once, then PATCHed). Creating/updating costs no credits.
//
//   node tools/eleven_agent_setup.js                 create/update, write the agent id into config/settings.local.json
//   node tools/eleven_agent_setup.js --dry-run       build everything, call nothing, print the summary
//   node tools/eleven_agent_setup.js --print-prompt  also print the stored system prompt
//   node tools/eleven_agent_setup.js --list-voices   Russian female voices: own library + shared library
//   node tools/eleven_agent_setup.js --balance       credits used / limit of the account
//   node tools/eleven_agent_setup.js --force-new     ignore the stored id and create a new agent
//
// Keys are read by src/env.js only; nothing secret is printed or logged.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { SETTINGS_LOCAL_PATH, loadSettings } from '../src/config.js';
import { loadEnv, redactSecrets, requireKey } from '../src/env.js';
import { openLog } from '../src/log.js';
import { balanceOf, elevenRest } from '../src/audio/eleven_agent.js';
import { buildAgentConfig, buildAgentPrompt, buildClientTools, buildKeywords, elevenSettings, estimateTokens, loadAgentAssets, toolSignature } from '../src/audio/eleven_prompt.js';

const TOOLS_PATH = '/v1/convai/tools';
const AGENTS_PATH = '/v1/convai/agents';

/**
 * Make sure every desired client tool exists with the desired config. Returns the ids by name.
 * @param {object} rest  elevenRest() handle
 * @param {object[]} desired  buildClientTools() output
 */
export async function ensureTools(rest, desired, { log = null } = {}) {
  const page = await rest.get(TOOLS_PATH, { query: { page_size: 100 } });
  const existing = (page?.tools ?? []).filter((t) => t?.tool_config?.type === 'client');
  const ids = {};
  const created = [];
  const updated = [];
  const kept = [];
  for (const cfg of desired) {
    const found = existing.find((t) => t.tool_config?.name === cfg.name);
    if (!found) {
      const r = await rest.post(TOOLS_PATH, { tool_config: cfg });
      ids[cfg.name] = r.id;
      created.push(cfg.name);
    } else if (toolSignature(found.tool_config) !== toolSignature(cfg)) {
      await rest.patch(`${TOOLS_PATH}/${encodeURIComponent(found.id)}`, { tool_config: cfg });
      ids[cfg.name] = found.id;
      updated.push(cfg.name);
    } else {
      ids[cfg.name] = found.id;
      kept.push(cfg.name);
    }
  }
  log?.event?.('eleven.tools', { created, updated, kept, ids });
  return { ids, created, updated, kept };
}

/**
 * Create the agent, or PATCH the existing one (settings.voice.eleven_agent_id). A stored id that
 * the API no longer knows (404) is replaced by a new agent.
 * @returns {Promise<{agent_id: string, action: 'created'|'updated'}>}
 */
export async function ensureAgent(rest, body, { agentId = null, log = null, forceNew = false } = {}) {
  if (agentId && !forceNew) {
    let exists = true;
    try {
      await rest.get(`${AGENTS_PATH}/${encodeURIComponent(agentId)}`);
    } catch (e) {
      if (e?.status !== 404) throw e;
      exists = false;
      log?.event?.('eleven.agent_missing', { agent_id: agentId });
    }
    if (exists) {
      await rest.patch(`${AGENTS_PATH}/${encodeURIComponent(agentId)}`, body);
      log?.event?.('eleven.agent', { action: 'updated', agent_id: agentId });
      return { agent_id: agentId, action: 'updated' };
    }
  }
  const r = await rest.post(`${AGENTS_PATH}/create`, body);
  if (!r?.agent_id) throw new Error('agents/create: no agent_id in the response');
  log?.event?.('eleven.agent', { action: 'created', agent_id: r.agent_id });
  return { agent_id: r.agent_id, action: 'created' };
}

/** JSON.stringify(…, 2) that keeps short scalar arrays on one line ("viewport": [640, 480]). */
export function stringifySettings(obj) {
  const text = JSON.stringify(obj, null, 2);
  return `${text.replace(/\[\n\s+((?:(?:-?\d+(?:\.\d+)?|"[^"\n]*"|true|false|null),?\n\s+)+)\]/g, (m, inner) => {
    const items = inner.split('\n').map((s) => s.trim().replace(/,$/, '')).filter(Boolean);
    const line = `[${items.join(', ')}]`;
    return line.length <= 100 ? line : m;
  })}\n`;
}

/** Write voice.eleven_agent_id into settings.local.json (created if absent). Returns true when the file changed. */
export function saveAgentId(settingsPath, agentId) {
  let text = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : '{}';
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const data = JSON.parse(text);
  data.voice = data.voice ?? {};
  if (data.voice.eleven_agent_id === agentId) return false;
  data.voice.eleven_agent_id = agentId;
  writeFileSync(settingsPath, stringifySettings(data));
  return true;
}

/**
 * The whole setup: prompt + tools + agent (+ id saved). `rest = null` means dry run.
 * @returns {Promise<object>} summary
 */
export async function runSetup({ settings, rest = null, log = null, settingsPath = SETTINGS_LOCAL_PATH, forceNew = false, assets = null, saveId = true } = {}) {
  const a = assets ?? loadAgentAssets();
  const el = elevenSettings(settings);
  const prompt = buildAgentPrompt({
    mode: el.prompt_mode,
    personaBlock: a.personaBlock,
    playbook: a.playbook,
    roster: a.roster,
    dayMode: null, // placeholders: the host fills {{day_mode_text}} / {{present}} / {{lead_status}} per session
    llm: el.llm,
    phrases: a.phrases,
    hostDisplayName: settings.display_name ?? a.hostDisplayName,
    // The baked prompt is schedule-free (on-demand wording): the fixed 10:00 schedule was
    // removed 21.09; in --start mode the host sends the times as nudges instead.
    times: null,
  });
  const tools = buildClientTools(a.roster, { blocking: Boolean(el.tools_blocking) });
  const keywords = buildKeywords(a.roster);
  const summary = {
    dry_run: !rest,
    prompt_mode: el.prompt_mode,
    prompt_chars: prompt.length,
    prompt_tokens_est: estimateTokens(prompt),
    tools: tools.map((t) => t.name),
    tools_blocking: Boolean(el.tools_blocking),
    turn_eagerness: el.turn_eagerness,
    keywords: keywords.length,
    llm: el.llm,
    reasoning_effort: el.reasoning_effort,
    temperature: el.temperature,
    voice_id: el.voice_id,
    tts_model: el.tts_model,
    warnings: a.warnings ?? [],
    agent_id: el.agent_id ?? null,
  };
  if (!rest) {
    summary.config = buildAgentConfig(settings, { prompt, toolIds: tools.map((t) => `<${t.name}>`), roster: a.roster, keywords });
    return { ...summary, prompt };
  }
  const t = await ensureTools(rest, tools, { log });
  const body = buildAgentConfig(settings, { prompt, toolIds: tools.map((x) => t.ids[x.name]), roster: a.roster, keywords });
  const agent = await ensureAgent(rest, body, { agentId: el.agent_id, log, forceNew });
  let saved = false;
  if (saveId && settingsPath) saved = saveAgentId(settingsPath, agent.agent_id);
  return { ...summary, prompt, tool_ids: t.ids, tools_created: t.created, tools_updated: t.updated, tools_kept: t.kept, agent_id: agent.agent_id, agent_action: agent.action, settings_saved: saved };
}

/** Russian female voices: own library first, then the shared library. Never fails the run. */
export async function listVoices(rest) {
  const out = { own: [], shared: [] };
  const own = await rest.get('/v1/voices');
  for (const v of own?.voices ?? []) {
    const l = v.labels ?? {};
    const langs = [...new Set((v.verified_languages ?? []).map((x) => x.language))];
    out.own.push({ voice_id: v.voice_id, name: v.name, category: v.category, gender: l.gender ?? null, age: l.age ?? null, accent: l.accent ?? null, use_case: l.use_case ?? null, language: l.language ?? null, verified: langs, free_users_allowed: v.sharing?.free_users_allowed ?? null });
  }
  try {
    const shared = await rest.get('/v1/shared-voices', { query: { language: 'ru', gender: 'female', page_size: 40 } });
    for (const v of shared?.voices ?? []) {
      out.shared.push({ voice_id: v.voice_id, name: v.name, category: v.category, gender: v.gender ?? null, age: v.age ?? null, accent: v.accent ?? null, use_case: v.use_case ?? null, language: v.language ?? null, free_users_allowed: v.free_users_allowed ?? null, cloned_by: v.cloned_by_count ?? null, notice_days: v.notice_period ?? null });
    }
  } catch (e) {
    out.shared_error = e?.message ?? String(e);
  }
  return out;
}

function printVoices(list) {
  const row = (v) => `  ${v.voice_id}  ${String(v.name).padEnd(22)} ${String(v.category ?? '').padEnd(12)} ${[v.gender, v.age, v.accent, v.use_case].filter(Boolean).join('/')}${v.verified?.length ? `  verified:${v.verified.join(',')}` : ''}${v.free_users_allowed === false ? '  [not for free tier]' : v.free_users_allowed === true ? '  [free ok]' : ''}`;
  console.log(`own library (${list.own.length}):`);
  for (const v of list.own) console.log(row(v));
  console.log(`\nshared library, ru + female (${list.shared.length})${list.shared_error ? ` [error: ${list.shared_error}]` : ''}:`);
  for (const v of list.shared) console.log(row(v));
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'dry-run': { type: 'boolean', default: false },
      'print-prompt': { type: 'boolean', default: false },
      'list-voices': { type: 'boolean', default: false },
      balance: { type: 'boolean', default: false },
      'force-new': { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log('node tools/eleven_agent_setup.js [--dry-run] [--print-prompt] [--list-voices] [--balance] [--force-new] [--verbose]');
    return 0;
  }
  loadEnv();
  const settings = loadSettings();
  const keyName = settings.keys?.elevenlabs;
  const dry = values['dry-run'];
  let rest = null;
  if (!dry) {
    let apiKey;
    try {
      apiKey = requireKey(keyName);
    } catch {
      console.error(`ElevenLabs key ${keyName ?? '(settings.keys.elevenlabs)'} is absent (.env.personal)`);
      return 1;
    }
    rest = elevenRest({ apiKey });
  }
  const log = openLog({ name: 'eleven_setup', verbose: values.verbose });
  try {
    if (values['list-voices']) {
      if (!rest) throw new Error('--list-voices needs the API (drop --dry-run)');
      printVoices(await listVoices(rest));
      return 0;
    }
    if (values.balance) {
      if (!rest) throw new Error('--balance needs the API (drop --dry-run)');
      const b = balanceOf(await rest.subscription());
      console.log(`tier ${b.tier}: credits used ${b.used} / ${b.limit} (remaining ${b.remaining}; at ≈${elevenSettings(settings).credits_per_min} credits/min ≈ ${(b.remaining / elevenSettings(settings).credits_per_min).toFixed(1)} agent minutes)`);
      log.event('eleven.balance', b);
      return 0;
    }
    const r = await runSetup({ settings, rest, log, forceNew: values['force-new'] });
    log.event('eleven.setup', { ...r, prompt: undefined, config: undefined });
    const lines = [
      `mode        ${r.dry_run ? 'dry run (nothing called)' : 'live'}`,
      `agent       ${r.agent_id ?? 'none'}${r.agent_action ? ` (${r.agent_action})` : ''}${r.settings_saved ? '  -> saved to config/settings.local.json' : ''}`,
      `llm/voice   ${r.llm} (reasoning ${r.reasoning_effort ?? 'default'}, temperature ${r.temperature}) / ${r.voice_id} (${r.tts_model})`,
      `turn        eagerness ${r.turn_eagerness}; client tools ${r.tools_blocking ? 'blocking (model waits for results)' : 'non-blocking (expects_response false)'}`,
      `tools       ${r.tools.join(', ')}${r.tool_ids ? `  created ${r.tools_created.length}, updated ${r.tools_updated.length}, kept ${r.tools_kept.length}` : ''}`,
      `prompt      mode ${r.prompt_mode}: ${r.prompt_chars} chars ≈ ${r.prompt_tokens_est} tokens, ${r.keywords} ASR keywords`,
      ...r.warnings.map((w) => `warning     ${w}`),
    ];
    console.log(lines.join('\n'));
    if (values['print-prompt']) console.log(`\n----- prompt -----\n${r.prompt}\n----- end -----`);
    if (r.dry_run && values.verbose) console.log(JSON.stringify(r.config, null, 2));
    return 0;
  } catch (e) {
    log.event('eleven.setup_error', { message: e?.message ?? String(e), status: e?.status ?? null, body: e?.body ?? null });
    console.error(`setup failed: ${redactSecrets(e?.message ?? String(e))}`);
    if (e?.body) console.error(redactSecrets(JSON.stringify(e.body).slice(0, 600)));
    return 1;
  } finally {
    log.close();
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
