// tools/eleven_agent_setup.js against a fake REST layer: idempotent tools + agent, settings write.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { loadSettings } from '../../src/config.js';
import { ensureAgent, ensureTools, runSetup, saveAgentId, stringifySettings } from '../../tools/eleven_agent_setup.js';
import { buildClientTools } from '../../src/audio/eleven_prompt.js';
import { loadRoster } from '../../src/core/state.js';

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** In-memory ElevenLabs REST: tools and agents stores. */
function fakeApi({ tools = [], agents = {} } = {}) {
  const calls = [];
  let seq = 0;
  const store = { tools: tools.map((t, i) => ({ id: `tool_${i}`, tool_config: t })), agents: { ...agents } };
  const notFound = (path) => Object.assign(new Error(`GET ${path} -> HTTP 404`), { status: 404 });
  const rest = {
    calls,
    store,
    get: async (path, opts) => {
      calls.push(['GET', path, opts?.query ?? null]);
      if (path === '/v1/convai/tools') return { tools: store.tools, has_more: false };
      const m = /^\/v1\/convai\/agents\/(.+)$/.exec(path);
      if (m) {
        if (!store.agents[m[1]]) throw notFound(path);
        return { agent_id: m[1], ...store.agents[m[1]] };
      }
      throw notFound(path);
    },
    post: async (path, body) => {
      calls.push(['POST', path, body]);
      if (path === '/v1/convai/tools') {
        const t = { id: `tool_new_${++seq}`, tool_config: body.tool_config };
        store.tools.push(t);
        return t;
      }
      if (path === '/v1/convai/agents/create') {
        const id = `agent_new_${++seq}`;
        store.agents[id] = body;
        return { agent_id: id };
      }
      throw new Error(`unexpected POST ${path}`);
    },
    patch: async (path, body) => {
      calls.push(['PATCH', path, body]);
      const t = /^\/v1\/convai\/tools\/(.+)$/.exec(path);
      if (t) {
        const found = store.tools.find((x) => x.id === t[1]);
        found.tool_config = body.tool_config;
        return found;
      }
      const a = /^\/v1\/convai\/agents\/(.+)$/.exec(path);
      if (a) {
        store.agents[a[1]] = body;
        return { agent_id: a[1], ...body };
      }
      throw new Error(`unexpected PATCH ${path}`);
    },
  };
  return rest;
}

const ROSTER = loadRoster();
const ASSETS = { personaBlock: 'ПЕРСОНА', playbook: '## Роль\nПЛЕЙБУК', phrases: null, hostDisplayName: 'Кора (ИИ-ведущая)', warnings: [], roster: ROSTER };

describe('eleven_agent_setup', () => {
  test('ensureTools: creates missing, updates changed, keeps identical', async () => {
    const desired = buildClientTools(ROSTER);
    const changed = { ...desired[1], description: 'old text' };
    const rest = fakeApi({ tools: [desired[0], changed, { type: 'webhook', name: 'give_word' }] });
    const r = await ensureTools(rest, desired);
    assert.deepEqual(r.kept, ['give_word']);
    assert.deepEqual(r.updated, ['turn_done']);
    assert.deepEqual(r.created, ['set_phase', 'leave_meeting']);
    assert.equal(r.ids.give_word, 'tool_0');
    assert.equal(r.ids.turn_done, 'tool_1');
    assert.equal(rest.store.tools.find((t) => t.id === 'tool_1').tool_config.description, desired[1].description);
    // second run: everything kept, no writes
    const again = await ensureTools(rest, desired);
    assert.deepEqual(again.created, []);
    assert.deepEqual(again.updated, []);
    assert.equal(again.kept.length, 4);
    assert.equal(rest.calls.filter((c) => c[0] !== 'GET').length, 3);
  });

  test('ensureAgent: create when no id or the id is gone (404), PATCH when it exists', async () => {
    const rest = fakeApi({ agents: { agent_old: { name: 'x' } } });
    const body = { name: 'Кора', conversation_config: {}, platform_settings: {} };
    assert.deepEqual(await ensureAgent(rest, body, { agentId: null }), { agent_id: 'agent_new_1', action: 'created' });
    assert.deepEqual(await ensureAgent(rest, body, { agentId: 'agent_old' }), { agent_id: 'agent_old', action: 'updated' });
    assert.deepEqual(rest.store.agents.agent_old, body);
    assert.deepEqual(await ensureAgent(rest, body, { agentId: 'agent_gone' }), { agent_id: 'agent_new_2', action: 'created' });
    assert.deepEqual(await ensureAgent(rest, body, { agentId: 'agent_old', forceNew: true }), { agent_id: 'agent_new_3', action: 'created' });
  });

  test('runSetup end to end: tools + agent + settings.json id; a second run patches; dry run calls nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eleven-setup-'));
    dirs.push(dir);
    const settingsPath = join(dir, 'settings.json');
    const settings = loadSettings();
    settings.voice.eleven_agent_id = null;
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    const rest = fakeApi();
    const r = await runSetup({ settings, rest, settingsPath, assets: ASSETS });
    assert.equal(r.agent_action, 'created');
    assert.equal(r.tools_created.length, 4);
    assert.equal(r.settings_saved, true);
    const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.equal(saved.voice.eleven_agent_id, r.agent_id);
    assert.deepEqual(saved.browser.viewport, [640, 480]);
    assert.ok(readFileSync(settingsPath, 'utf8').includes('"viewport": [640, 480]'), 'scalar arrays stay on one line');
    const created = rest.store.agents[r.agent_id];
    assert.equal(created.conversation_config.agent.language, 'ru');
    assert.ok(created.conversation_config.agent.prompt.prompt.includes('# Кто ты'), 'compact prompt stored');
    assert.ok(!created.conversation_config.agent.prompt.prompt.includes('ПЕРСОНА'), 'compact mode does not embed persona.md');
    assert.ok(created.conversation_config.agent.prompt.prompt.includes('{{present}}') && created.conversation_config.agent.prompt.prompt.includes('{{day_mode_text}}'), 'stored prompt keeps the placeholders');
    assert.equal(created.conversation_config.agent.prompt.tool_ids.length, 4);
    assert.equal(created.conversation_config.turn.turn_eagerness, 'normal');
    assert.ok(rest.store.tools.every((t) => t.tool_config.expects_response === false), 'tools are non-blocking');
    assert.equal(r.prompt_tokens_est, r.prompt_chars > 0 ? r.prompt_tokens_est : 0);
    assert.ok(r.prompt_tokens_est > 0 && r.prompt_tokens_est <= 2300, `≈ ${r.prompt_tokens_est} tokens`);
    assert.ok(created.conversation_config.agent.prompt.tool_ids.every((id) => rest.store.tools.some((t) => t.id === id)));
    // second run with the saved id: PATCH, nothing created
    const settings2 = { ...settings, voice: { ...settings.voice, eleven_agent_id: r.agent_id, eleven: { ...settings.voice.eleven, tools_blocking: true, prompt_mode: 'full' } } };
    const r2 = await runSetup({ settings: settings2, rest, settingsPath, assets: ASSETS });
    assert.equal(r2.agent_action, 'updated');
    assert.equal(r2.agent_id, r.agent_id);
    assert.equal(r2.tools_created.length, 0);
    assert.equal(r2.tools_updated.length, 4, 'blocking flag flipped -> every tool PATCHed');
    assert.equal(r2.settings_saved, false);
    assert.ok(rest.store.agents[r.agent_id].conversation_config.agent.prompt.prompt.includes('ПЕРСОНА'), 'full mode embeds the persona');
    assert.ok(rest.store.tools.every((t) => t.tool_config.expects_response === true));
    // dry run
    const before = rest.calls.length;
    const dry = await runSetup({ settings, rest: null, settingsPath, assets: ASSETS });
    assert.equal(dry.dry_run, true);
    assert.equal(rest.calls.length, before);
    assert.ok(dry.config.conversation_config.tts.voice_id);
    assert.equal(dry.prompt.length, dry.prompt_chars);
  });

  test('stringifySettings / saveAgentId keep the file shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'eleven-save-'));
    dirs.push(dir);
    const p = join(dir, 's.json');
    writeFileSync(p, '﻿{"voice":{"provider":"openrouter","eleven_agent_id":null},"browser":{"viewport":[640,480]},"list":["a","b"],"n":{"x":[1.5,-2,true,null]}}');
    assert.equal(saveAgentId(p, 'agent_1'), true);
    const text = readFileSync(p, 'utf8');
    assert.ok(text.includes('"eleven_agent_id": "agent_1"'));
    assert.ok(text.includes('"viewport": [640, 480]'));
    assert.ok(text.includes('"list": ["a", "b"]'));
    assert.ok(text.includes('"x": [1.5, -2, true, null]'));
    assert.ok(text.endsWith('}\n'));
    assert.equal(saveAgentId(p, 'agent_1'), false, 'unchanged id -> no write');
    assert.equal(stringifySettings({ a: [{ b: 1 }] }), '{\n  "a": [\n    {\n      "b": 1\n    }\n  ]\n}\n', 'arrays of objects stay expanded');
  });
});
