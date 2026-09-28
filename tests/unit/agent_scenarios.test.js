// Scenario suite for the agent (src/agent/scenarios.js) and its runner: well-formed data, the ideal
// answers pass, typical failures of the live tests of 27.09 are caught. No model, no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { SCENARIOS, SCENARIO_LEAD, SCENARIO_ROSTER } from '../../src/agent/scenarios.js';
import { applyEvent, checkStep, runScenarios } from '../../src/agent/scenario_runner.js';
import { violation } from '../../src/agent/invariants.js';
import { sttLike } from '../../src/agent/scenarios.js';
import { TOOLS, buildSystemPrompt, createDraftAgent, renderInput, toActions, toolsFor } from '../../src/agent/draft_agent.js';

const ids = new Set(SCENARIO_ROSTER.map((p) => p.id));
const byIndex = (sc, i) => sc.steps[i];
/** Replays each step's `ideal` answer. */
const idealAgent = async (input, { step }) => ({ actions: step.ideal });

describe('scenarios: data', () => {
  test('unique ids, known people, every step has expectations and an ideal answer', () => {
    assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
    assert.ok(SCENARIOS.length >= 15);
    for (const sc of SCENARIOS) {
      const known = (id) => ids.has(id) || Object.hasOwn(sc.names ?? {}, id); // guests are named in the scenario
      for (const id of [...sc.state.present, ...(sc.state.queue ?? []), ...(sc.state.speaker ? [sc.state.speaker] : [])]) assert.ok(known(id), `${sc.id}: ${id}`);
      for (const step of sc.steps) {
        assert.ok(Array.isArray(step.expect) && step.expect.length, `${sc.id}: expect`);
        assert.ok(Array.isArray(step.ideal) && step.ideal.length, `${sc.id}: ideal`);
        for (const e of step.events) {
          assert.ok(['heard', 'silence', 'joined', 'left', 'her_line_done', 'interrupted', 'chorus', 'rejected', 'state'].includes(e.type), `${sc.id}: ${e.type}`);
          if (e.who && e.who !== '?' && !Array.isArray(e.who)) assert.ok(known(e.who), `${sc.id}: ${e.who}`);
        }
        for (const m of [...step.expect.flat(), ...(step.forbid ?? [])]) {
          for (const p of [m.person].flat().filter(Boolean)) assert.ok(known(p), `${sc.id}: matcher person ${p}`);
        }
      }
    }
    assert.ok(ids.has(SCENARIO_LEAD));
  });

  test('no real people or company in the suite (fictional Acme only)', () => {
    const text = readFileSync(new URL('../../src/agent/scenarios.js', import.meta.url), 'utf8');
    const example = JSON.parse(readFileSync(new URL('../../config/people.example.json', import.meta.url), 'utf8'));
    const allowed = new Set(example.people.flatMap((p) => [p.display, ...String(p.display).split(' ')]));
    for (const p of SCENARIO_ROSTER) assert.ok(allowed.has(p.display), p.display);
    assert.ok(!/telemost\.|https?:\/\//.test(text), 'no links');
  });
});

describe('scenario runner', () => {
  test('the ideal answers pass every step, invariants included', async () => {
    const report = await runScenarios(SCENARIOS, idealAgent, { leadId: SCENARIO_LEAD });
    const failed = report.results.flatMap((r) => r.steps.filter((s) => !s.ok).map((s) => `${r.id}#${s.i}: ${s.why}`));
    assert.deepEqual(failed, []);
    assert.equal(report.must.ok, report.must.total);
    assert.equal(report.violations, 0);
  });

  test('invariants: the same list the host will enforce', () => {
    const sit = { phase: 'round', speaker: 'tkach_t', queue: ['nevsky_g'], present: ['tkach_t', 'nevsky_g', 'orlov_y'] };
    assert.equal(violation({ action: 'give_word', person: 'belozersky_s' }, sit), 'not_present');
    assert.equal(violation({ action: 'give_word', person: 'tkach_t' }, sit), 'already_has_the_floor');
    assert.equal(violation({ action: 'ask_done', person: 'nevsky_g' }, sit), 'not_the_speaker');
    assert.equal(violation({ action: 'open_floor' }, sit), 'queue_not_empty');
    assert.equal(violation({ action: 'open_floor' }, { ...sit, queue: [] }), null);
    assert.equal(violation({ action: 'leave', text: 'Пока!' }, sit), 'round_not_finished');
    assert.equal(violation({ action: 'leave' }, { ...sit, present: [] }), null);
    assert.equal(violation({ action: 'say', text: 'Я не отвечаю на вопросы во время отчётов.' }, sit), 'invented_rule');
    assert.equal(violation({ action: 'say', text: 'Да, слышу. Тима, продолжай.' }, sit), 'bridge');
    assert.equal(violation({ action: 'say', text: 'а'.repeat(300) }, sit), 'too_long');
    assert.equal(violation({ action: 'say', text: 'Есть кто?' }, { ...sit, present: [] }), 'empty_room');
    const waiting = { phase: 'waiting', speaker: null, queue: [], present: ['tkach_t', 'orlov_y'] };
    assert.equal(violation({ action: 'give_word', person: 'tkach_t' }, waiting, { leadId: 'orlov_y' }), 'lead_goes_first');
    assert.equal(violation({ action: 'give_word', person: 'orlov_y' }, waiting, { leadId: 'orlov_y' }), null);
  });

  test('a violation fails the step even when the expectation is met; the report counts it', async () => {
    const sc = SCENARIOS.filter((x) => x.id === 'turn_end_closer');
    const report = await runScenarios(sc, async () => ({ actions: [{ action: 'give_word', person: 'nevsky_g', text: 'Спасибо! Тима, продолжай.' }] }), { leadId: SCENARIO_LEAD });
    assert.equal(report.violations, 1);
    assert.match(report.results[0].steps[0].why, /invariant bridge/);
  });

  test('scenario input looks like SpeechKit: lower case, no punctuation, «Кора» restored', () => {
    assert.equal(sttLike('Кора, привет! Ты меня слышишь?'), 'Кора привет ты меня слышишь');
    assert.equal(sttLike('КОРА начинай.'), 'Кора начинай');
    const greet = SCENARIOS.find((x) => x.id === 'greet_by_name').steps[0].events[0].text;
    assert.ok(!/[?!,.]/.test(greet), greet);
  });

  test('the failures of the live tests are caught', async () => {
    const find = (id) => SCENARIOS.find((s) => s.id === id);
    // «Я не отвечаю на вопросы во время апдейтов. Тима, продолжай.»
    assert.equal(checkStep(byIndex(find('question_no_name_in_turn'), 0), [{ action: 'say', text: 'Я не отвечаю на вопросы во время апдейтов. Тима, продолжай.' }]).ok, false);
    // silence on «я тебе вопрос задал»
    assert.match(checkStep(byIndex(find('question_no_name_in_turn'), 0), [{ action: 'skip' }]).why, /expected say/);
    // «Все высказались…» again instead of answering
    assert.equal(checkStep(byIndex(find('open_floor_question_to_her'), 0), [{ action: 'say', text: 'Все высказались. Кто хочет что-то добавить или спросить?' }]).ok, false);
    // a second «Привет»
    assert.equal(checkStep(byIndex(find('no_second_greeting'), 0), [{ action: 'say', text: 'Привет, Тима!' }]).ok, false);
    // lines to an empty room
    assert.match(checkStep(byIndex(find('everyone_left'), 0), [{ action: 'say', text: 'Я Кора. Кто ещё хочет поделиться?' }]).why, /forbidden/);
    // the floor back to the previous speaker after a handoff was cut off by the next one
    assert.equal(checkStep(byIndex(find('handoff_interrupted_by_next'), 0), [{ action: 'ask_done', person: 'tkach_t' }]).ok, false);
    // an answer that is not about the question
    assert.equal(checkStep(byIndex(find('open_floor_colleagues'), 1), [{ action: 'say', text: 'Привет! Я тут.' }]).ok, false);
    // text instead of tools
    assert.match(checkStep(byIndex(find('greet_by_name'), 0), [{ action: 'none', text: 'Привет!' }]).why, /text instead of a tool call/);
  });

  test('a talkative agent and a silent agent both fail; soft steps never fail a scenario', async () => {
    const talkative = await runScenarios(SCENARIOS, async () => ({ actions: [{ action: 'say', text: 'Привет, коллеги!' }] }));
    const silent = await runScenarios(SCENARIOS, async () => ({ actions: [{ action: 'skip' }] }));
    assert.ok(talkative.must.ok < talkative.must.total / 2, `talkative ${talkative.must.ok}/${talkative.must.total}`);
    assert.ok(silent.must.ok < silent.must.total / 2, `silent ${silent.must.ok}/${silent.must.total}`);
    const chorus = silent.results.find((r) => r.id === 'chorus');
    assert.equal(chorus.ok, true);
    const errors = await runScenarios(SCENARIOS.slice(0, 1), async () => {
      throw new Error('HTTP 500');
    });
    assert.match(errors.results[0].steps[0].why, /error: HTTP 500/);
  });

  test('teacher forcing: her lines and presence follow the script, not the agent', async () => {
    const seen = [];
    await runScenarios(SCENARIOS.filter((s) => ['long_silence_ask_done', 'everyone_left'].includes(s.id)), async (input) => {
      seen.push(input);
      return { actions: [{ action: 'skip' }] };
    });
    assert.deepEqual(seen[1].dialog.at(-1), { who: 'host', text: 'Тима, всё?' }, 'her scripted line, although the agent skipped');
    assert.deepEqual(seen[2].present, []);
    const sit = { phase: 'round', speaker: 'a', queue: [], present: ['a'], dialog: [] };
    applyEvent(sit, { type: 'state', phase: 'open_floor', speaker: null });
    assert.equal(sit.phase, 'open_floor');
  });
});

describe('draft agent', () => {
  test('prompt from the roster, input rendering, tool calls -> actions', () => {
    const prompt = buildSystemPrompt({ roster: SCENARIO_ROSTER, leadId: SCENARIO_LEAD });
    assert.match(prompt, /руководителю \(lead в present\)/);
    assert.match(prompt, /Отвечай только вызовами инструментов/);
    assert.deepEqual(TOOLS.map((t) => t.function.name), ['say', 'give_word', 'ask_done', 'open_floor', 'skip', 'leave']);
    assert.match(prompt, /2,5 с без «у меня всё» — ask_done, если он уже говорил/);
    assert.match(prompt, /rejected/);
    const input = JSON.parse(renderInput({ phase: 'round', speaker: 'tkach_t', present: ['tkach_t'], dialog: Array.from({ length: 20 }, (_, i) => ({ who: 'tkach_t', text: `${i}` })), events: [] }));
    assert.equal(input.dialog.length, 12);
    assert.deepEqual(toActions([{ name: 'give_word', args: { person_id: 'nevsky_g', text: '' } }, { name: 'say', args: { text: ' Привет ' } }]), [
      { action: 'give_word', person: 'nevsky_g', text: null },
      { action: 'say', text: 'Привет' },
    ]);
    assert.deepEqual(toActions([], 'Привет!'), [{ action: 'none', text: 'Привет!' }]);
  });

  test('decide(): streamed tool calls; tool_choice "required" falls back to "auto" once', async () => {
    const bodies = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.tool_choice === 'required') return new Response('{"error":{"message":"tool_choice required is not supported"}}', { status: 400 });
      const enc = new TextEncoder();
      const chunks = [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'say', arguments: '' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":"Слышу!"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ];
      return new Response(new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(x)}\n\n`)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    const agent = createDraftAgent({ endpoint: 'http://mock', apiKey: 'k', model: 'm', system: 'S', fetch });
    const r = await agent.decide({ phase: 'waiting', present: ['tkach_t'], dialog: [], events: [] });
    assert.deepEqual(r.actions, [{ action: 'say', text: 'Слышу!' }]);
    assert.ok(Number.isFinite(r.timings.first_tool_name));
    assert.equal(agent.toolChoice, 'auto');
    assert.deepEqual(bodies.map((b) => b.tool_choice), ['required', 'auto']);
    // waiting, one person: say / give_word (only to present ids) / skip / leave — no ask_done or open_floor before the round
    assert.deepEqual(bodies[1].tools.map((t) => t.function.name), ['say', 'give_word', 'skip', 'leave']);
    assert.deepEqual(bodies[1].tools[1].function.parameters.properties.person_id.enum, ['tkach_t']);
  });

  test('tools per phase; a server that refuses enum gets plain ids from then on', async () => {
    assert.deepEqual(
      toolsFor({ phase: 'round', speaker: 'tkach_t', present: ['tkach_t', 'nevsky_g'] }).map((t) => [t.function.name, t.function.parameters.properties.person_id?.enum ?? null]),
      [['say', null], ['give_word', ['nevsky_g']], ['ask_done', ['tkach_t']], ['open_floor', null], ['skip', null], ['leave', null]],
    );
    assert.equal(TOOLS[1].function.parameters.properties.person_id.enum, undefined, 'the shared definitions stay untouched');
    const bodies = [];
    const fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.tools.some((t) => t.function.parameters.properties.person_id?.enum)) return new Response('{"error":{"message":"invalid tool parameters schema: enum"}}', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'a', type: 'function', function: { name: 'skip', arguments: '{}' } }] } }] }), { headers: { 'content-type': 'application/json' } });
    };
    const agent = createDraftAgent({ endpoint: 'http://mock', apiKey: 'k', model: 'm', system: 'S', fetch, stream: false });
    await agent.decide({ phase: 'waiting', present: ['tkach_t'], events: [] });
    await agent.decide({ phase: 'waiting', present: ['tkach_t'], events: [] });
    assert.equal(bodies.length, 3, 'one refused request, then plain tools for good');
  });

  test('the input names the people in the room; the prompt has no roster', () => {
    const input = JSON.parse(renderInput({ phase: 'waiting', present: ['orlov_y', 'guest_1'], names: { orlov_y: 'Слава', guest_1: 'Зоя' }, lead: 'orlov_y', events: [] }));
    assert.deepEqual(input.present, [{ id: 'orlov_y', name: 'Слава', lead: true }, { id: 'guest_1', name: 'Зоя' }]);
    const prompt = buildSystemPrompt({ roster: SCENARIO_ROSTER, leadId: SCENARIO_LEAD });
    assert.doesNotMatch(prompt, /nevsky_g|Невский/);
  });
});
