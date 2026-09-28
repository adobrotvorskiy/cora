// Skills (src/agent/skills.js, docs/agent_plan.md step 5): the playbook cut by phase, the agent's
// prompt per phase under ~3k tokens, the phase prompt in the request.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { agentFromSettings, agentPrompts, createDraftAgent } from '../../src/agent/draft_agent.js';
import { playbookSkills } from '../../src/agent/skills.js';
import { estimateTokens } from '../../src/brain/context.js';
import { loadBrainAssets } from '../../src/brain/prompt.js';

const PLAYBOOK = `# Плейбук

Вступление: не правило.

## Роль
Ты ведущая.

## Старт [по расписанию]
В 10:00 начинаешь.

## Старт [по требованию]
Начинаешь по просьбе.

## Пока человек говорит
Не перебиваешь.

## Финал
Спрашиваешь, кто хочет добавить.

## Стоп-фразы
Код сам.

## Новый раздел владельца
Что-то важное.
`;

describe('skills: the playbook by phase', () => {
  test('sections go to their phases; the tag variant of the mode; code-handled sections dropped; unknown ones everywhere', () => {
    const s = playbookSkills(PLAYBOOK, { scheduled: false });
    assert.match(s.common, /## Роль/);
    assert.match(s.common, /## Новый раздел владельца/, 'a section the map does not know is never lost');
    assert.match(s.waiting, /Начинаешь по просьбе/);
    assert.doesNotMatch(s.waiting, /10:00/);
    assert.match(s.round, /Не перебиваешь/);
    assert.match(s.open_floor, /кто хочет добавить/);
    const all = Object.values(s).join('\n');
    assert.doesNotMatch(all, /Код сам|Вступление/);
    assert.match(playbookSkills(PLAYBOOK, { scheduled: true }).waiting, /В 10:00/);
    assert.deepEqual(
      s.sections.map((x) => [x.title, x.phases.join(',')]),
      [
        ['Роль', 'waiting,round,open_floor'],
        ['Старт', 'waiting'],
        ['Пока человек говорит', 'round'],
        ['Финал', 'open_floor'],
        ['Стоп-фразы', ''],
        ['Новый раздел владельца', 'waiting,round,open_floor'],
      ],
    );
  });

  test('the committed persona and playbook: every phase prompt <= 3000 tokens (was ~7000), variables filled', () => {
    const assets = loadBrainAssets();
    for (const scheduled of [false, true]) {
      const prompts = agentPrompts({ assets, leadId: assets.firstAlways, team: assets.teamName, scheduled, dayMode: 'daily_plans', model: 'gpt://f/aliceai-llm-flash/latest' });
      for (const phase of ['waiting', 'round', 'open_floor']) {
        const p = prompts(phase);
        assert.ok(estimateTokens(p) <= 3000, `${phase} (${scheduled ? 'scheduled' : 'on demand'}): ~${estimateTokens(p)} tokens`);
        assert.doesNotMatch(p, /\{(team|lead_full|lead_name|brain_model|voice_vendor)\}/);
        assert.doesNotMatch(p, /́/, 'stress marks are for the voice, not the prompt');
        assert.match(p, /Alice AI Flash от Яндекса/);
        assert.match(p, /Отвечай только вызовами инструментов/);
        assert.equal(prompts(phase), p, 'memoized');
      }
      assert.match(prompts('waiting'), /## Старт/);
      assert.doesNotMatch(prompts('round'), /## Старт|## Финал/);
      assert.match(prompts('open_floor'), /## Финал/);
      assert.doesNotMatch(prompts('round'), /## Как это ложится на действия|## Стоп-фразы/, 'the old brain actions never reach the agent');
    }
  });

  test('the request carries the prompt of the input phase', async () => {
    const systems = [];
    const fetch = async (url, init) => {
      systems.push(JSON.parse(init.body).messages[0].content);
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'a', type: 'function', function: { name: 'skip', arguments: '{}' } }] } }] }), { headers: { 'content-type': 'application/json' } });
    };
    const agent = createDraftAgent({ endpoint: 'http://x', apiKey: 'k', model: 'm', system: (phase) => `prompt:${phase}`, fetch, stream: false });
    await agent.decide({ phase: 'round', events: [] });
    await agent.decide({ phase: 'open_floor', events: [] });
    assert.deepEqual(systems, ['prompt:round', 'prompt:open_floor']);
  });

  test('agent.provider openrouter: the OpenRouter endpoint, its key and the model from settings', async () => {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ url, auth: init.headers.Authorization, model: JSON.parse(init.body).model });
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'a', type: 'function', function: { name: 'skip', arguments: '{}' } }] } }] }), { headers: { 'content-type': 'application/json' } });
    };
    const settings = { keys: { openrouter: 'X_OR_TEST', yandex: 'X_YA_TEST' }, brain: { openrouter_model: 'google/some-flash' }, agent: { provider: 'openrouter', model: 'google/gemini-test-flash' }, voice: {} };
    const agent = agentFromSettings({ settings, roster: { people: [], firstAlways: null }, env: { X_OR_TEST: 'k-or' }, fetch, assets: { people: [], playbook: null, personaBlock: null } });
    await agent.decide({ phase: 'waiting', present: ['a'], events: [] });
    assert.equal(agent.provider, 'openrouter');
    assert.match(seen[0].url, /openrouter\.ai/);
    assert.equal(seen[0].auth, 'Bearer k-or');
    assert.equal(seen[0].model, 'google/gemini-test-flash');
    assert.throws(() => agentFromSettings({ settings: { ...settings, agent: { provider: 'nope' } }, roster: { people: [] }, env: {}, assets: { people: [] } }), /agent.provider/);
  });

  test('agent.provider google: the Gemini API endpoint with the AI Studio key, low thinking, dropped if refused', async () => {
    const seen = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ url, auth: init.headers.Authorization, model: body.model, effort: body.reasoning_effort ?? null, max: body.max_tokens, system: body.messages[0].content });
      if (body.reasoning_effort) return new Response('{"error":{"message":"reasoning_effort is not supported for this model"}}', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'a', type: 'function', function: { name: 'skip', arguments: '{}' } }] } }] }), { headers: { 'content-type': 'application/json' } });
    };
    const settings = { keys: { google: 'X_GEMINI_TEST' }, brain: { google_model: 'gemini-test-flash' }, agent: { provider: 'google' }, voice: {} };
    const assets = { people: [], playbook: null, personaBlock: 'Решения принимает {brain_model}.' };
    const agent = agentFromSettings({ settings, roster: { people: [], firstAlways: null }, env: { X_GEMINI_TEST: 'k-g' }, fetch, assets });
    await agent.decide({ phase: 'waiting', present: ['a'], events: [] });
    await agent.decide({ phase: 'waiting', present: ['a'], events: [] });
    assert.equal(agent.provider, 'google');
    assert.match(seen[0].url, /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions$/);
    assert.equal(seen[0].auth, 'Bearer k-g');
    assert.equal(seen[0].model, 'gemini-test-flash');
    assert.deepEqual(seen.map((x) => x.effort), ['low', null, null], 'refused once, never sent again');
    assert.equal(seen[0].max, 2048, 'room for the thoughts before the tool call');
    assert.match(seen[1].system, /Gemini Test Flash от Google/);
  });
});
