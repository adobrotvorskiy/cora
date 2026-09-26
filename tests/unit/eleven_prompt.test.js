// src/audio/eleven_prompt.js: the agent prompt, dynamic variables, tools and agent config (offline).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { SETTINGS_PATH } from '../../src/config.js';
import {
  ACK_SET,
  AGENT_PHASES,
  BANNED_EVALUATIVES,
  CLIENT_TOOL_NAMES,
  CLIENT_EVENTS,
  DEFAULT_LLM,
  HANDOFF_SET,
  buildAgentConfig,
  buildAgentPrompt,
  buildClientTools,
  buildKeywords,
  dynamicVariables,
  elevenLlmHuman,
  elevenSettings,
  estimateTokens,
  fillVariables,
  hostNote,
  loadAgentAssets,
  stripSection,
  toolSignature,
} from '../../src/audio/eleven_prompt.js';
import { loadRoster } from '../../src/core/state.js';

const SETTINGS = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')); // committed settings only: a local experiment (settings.local.json) must not change the tests
const ROSTER = loadRoster();
const ASSETS = loadAgentAssets({ roster: ROSTER });

describe('agent prompt', () => {
  test('compact (default): ≲ 2,300 tokens, floor principle, listener lines, banned praise, Orlov start, unhurried final, tools with person_name, 4 FAQ answers', () => {
    const p = buildAgentPrompt({ roster: ROSTER, dayMode: 'monday_focus', llm: DEFAULT_LLM, phrases: ASSETS.phrases, hostDisplayName: 'Кора (ИИ-ведущая)', times: SETTINGS.times, personaBlock: ASSETS.personaBlock, playbook: ASSETS.playbook });
    assert.ok(p.length <= 8200, `compact prompt is ${p.length} chars`);
    assert.ok(estimateTokens(p) <= 2300, `≈ ${estimateTokens(p)} tokens`);
    for (const s of ['# Кто ты', '# Как ты слышишь', '# Когда говорить', '# Как говорить', '# Стендап', '# Участники', '# Инструменты', '# Границы и вопросы о тебе']) assert.ok(p.includes(s), s);
    assert.ok(!p.includes('Говоришь только в пяти случаях'), 'no whitelist of cases (live test 19.09: she ignored «Кого ждём?»)');
    // who has the floor decides: silent during an update, the host of the meeting when nobody has it
    assert.ok(p.includes('Слово у человека (ты его дала, он ещё не закончил): молчишь (skip_turn).'));
    assert.ok(p.includes('Слово ни у кого (до старта, между выступлениями, в конце): встречу ведёшь ты.'));
    for (const q of ['«меня слышно?»', '«кого ждём?»', '«чего молчим?»', '«начинаем?»', '«он не придёт»']) assert.ok(p.includes(q), q);
    assert.ok(p.includes('— факт, а не команда'), 'silence notes are facts she interprets');
    assert.ok(p.includes('Ты активный слушатель'));
    // live test #3: a made-up name legend, a guessed time, an answer glued to a goodbye, a plan kept after an interruption
    assert.ok(p.includes('«Почему Кора?»: «Кора мозга отвечает за планирование и внимание'));
    assert.ok(p.includes('«Откуда ты?»: «Меня собрала команда'));
    assert.ok(p.includes('чего не знаешь, не выдумывай («этого мне не рассказали»)'));
    assert.ok(p.includes('Который час, знаешь только по метке последней заметки хоста'));
    assert.ok(p.includes('Тебя перебили — значит, человеку сейчас важнее сказать своё, чем тебе закончить'));
    assert.ok(p.includes('Прощание — отдельный момент: к ответу на вопрос его не прицепляй'));
    assert.ok(p.includes('Остановили на прощании — разговор продолжается, ты остаёшься, пока он не закончится.'));
    assert.ok(!p.includes('зоопарк агентов') && !p.includes('Лаборатория Acme'), 'no legend text');
    assert.ok(!p.includes('Ты ведущая, а не участница'), 'playbook not embedded');
    for (const a of ACK_SET) assert.ok(p.includes(`«${a}»`), a);
    for (const h of HANDOFF_SET) assert.ok(p.includes(`«${h}»`), h);
    for (const w of BANNED_EVALUATIVES) assert.ok(p.includes(`«${w}»`), w);
    assert.ok(p.includes('не хвалишь, не оцениваешь, не комментируешь и не пересказываешь'));
    assert.ok(p.includes('Слава на связи: приветствие дня и первое слово ему'));
    assert.ok(p.includes('Слава подключился посреди круга: хост скажет заметкой — дай ему слово после текущего, не объявляя вслух'));
    assert.ok(p.includes('Люди просят начать без него или говорят, что он не придёт, — начинай сразу'));
    assert.ok(p.includes('в 10:02 хост напомнит: спроси «Начнём, никто не против?»; тишина — согласие'));
    assert.ok(p.includes('Прощаешься, только когда хост сообщил о тишине после твоего вопроса или люди прямо сказали, что добавить нечего'));
    assert.ok(p.includes('«Принято, {имя}. Кто-то ещё?»'));
    assert.ok(p.includes('leave_meeting(): в том же ходе, что и прощание, последним действием; после него ни слова'));
    assert.ok(p.includes('give_word для неё не нужен'), '«передаю слово на дев-синк» is a phrase, not a tool call');
    assert.ok(p.includes('«Доброе утро! Понедельник — фокусы недели. Слава, начнёшь?»'), 'greeting of the day');
    assert.ok(p.includes('Прощание по-человечески, своими словами: пожелай хорошей недели и скажи, что дальше дев-синк, например «Всё, ребята, хорошей недели! Дальше дев-синк, пока!»'), 'a human farewell');
    assert.ok(p.includes('Без этого вопроса не прощаешься; оборвали его — задай ещё раз.'));
    assert.ok(p.includes('можешь разрядить её лёгкой репликой или вопросом не по делу'), 'small talk on a long pause');
    assert.ok(p.includes('«Все высказались. Кто хочет что-то добавить или спросить?» и set_phase(open_floor)'));
    assert.ok(p.includes('give_word(person_id | person_name)') && p.includes('turn_done(person_id | person_name)') && p.includes('leave_meeting()') && p.includes('skip_turn'));
    assert.ok(!p.includes('silent_mode'), 'no silent_mode tool');
    assert.ok(p.includes('уйди из встречи'), 'the kill phrase is «уйди из встречи»');
    assert.ok(p.includes('в инструменты передавай person_name'));
    assert.ok(p.includes('«Ты кто?»') && p.includes('«Ты нас записываешь?»') && p.includes('«Можно тебя выключить?»') && p.includes('«На чём ты работаешь?»'));
    assert.ok(p.includes('решения принимает Gemini 3.5 Flash Lite от Google'));
    assert.ok(!/OpenAI/.test(p));
    assert.ok(p.includes('- orlov_y: Слава (Ярослав Орлов), CEO, основатель. Всегда первый.'));
    assert.ok(p.includes('- stepanov_m: Митя (Матвей Степанов).'));
    assert.ok(p.includes('{{present}}') && p.includes('{{lead_status}}') && !p.includes('{{day_mode_text}}'));
    assert.ok(!/[̀́]/.test(p), 'no stress marks');
    assert.equal(p, buildAgentPrompt({ roster: ROSTER, dayMode: 'monday_focus', llm: DEFAULT_LLM, phrases: ASSETS.phrases, hostDisplayName: 'Кора (ИИ-ведущая)', times: SETTINGS.times }), 'deterministic, persona/playbook ignored');
    assert.throws(() => buildAgentPrompt({ mode: 'nope' }), /unknown mode/);
  });

  test('full mode: persona + playbook + roster with informal names + day mode + rules + tools; stack lines say ElevenLabs', () => {
    const p = buildAgentPrompt({ mode: 'full', personaBlock: ASSETS.personaBlock, playbook: ASSETS.playbook, roster: ROSTER, dayMode: 'monday_focus', llm: 'gemini-3.5-flash', phrases: ASSETS.phrases, hostDisplayName: 'Кора (ИИ-ведущая)', times: SETTINGS.times });
    for (const s of ['# Роль и среда', '# Персона', '# Принципы ведения (плейбук)', '# Сегодня', '# Участники', '# Когда говорить и когда молчать', '# Как говорить', '# Инструменты', '# Примеры']) assert.ok(p.includes(s), s);
    assert.ok(p.includes('Ты Кора, голосовая ведущая'), 'persona block');
    assert.ok(p.includes('Ты ведущая, а не участница'), 'playbook');
    assert.ok(!p.includes('Как это ложится на действия'), 'cascade-only playbook section stripped');
    assert.ok(!/OpenAI/.test(p), 'no OpenAI stack claims');
    assert.ok(p.includes('слух и голос у тебя от ElevenLabs, решения принимает Gemini 3.5 Flash от Google'));
    assert.ok(!p.includes('{brain_model}'));
    for (const name of ['Слава (Ярослав Орлов)', 'Глеб (Глеб Невский)', 'Тима (Тимур Ткач)', 'Серёжа (Сергей Белозерский)', 'Кир (Кирилл Зуев)', 'Савва (Савва Бойко)', 'Игнат (Игнат Галиев)', 'Митя (Матвей Степанов)']) assert.ok(p.includes(name), name);
    assert.ok(p.includes('orlov_y — Слава (Ярослав Орлов), CEO, основатель. Всегда выступает первым.'));
    assert.ok(p.includes('Понедельник: тема дня — фокус на неделю'));
    assert.ok(p.includes('{{present}}') && p.includes('{{lead_status}}'), 'placeholders stay without values');
    assert.ok(!p.includes('{{day_mode_text}}'), 'day mode rendered when given');
    for (const t of ['skip_turn', 'give_word(person_id)', 'turn_done(person_id)', 'set_phase(phase)', 'leave_meeting()']) assert.ok(p.includes(t), t);
    assert.ok(!p.includes('silent_mode'), 'no silent_mode tool');
    assert.ok(p.includes('Не отвечай на вопросы внутри чужого апдейта'));
    assert.ok(p.includes('Не комментируй разговоры коллег между собой'));
    assert.ok(p.includes('Не пересказывай апдейты'));
    assert.ok(p.includes('10:35 — хост выведет тебя'));
    assert.ok(p.includes('# Когда говорить и когда молчать') && p.includes('Слово ни у кого (до старта, между выступлениями, в конце): встречу ведёшь ты.'), 'floor principle in full mode too');
    assert.ok(!p.includes('молчи (skip_turn), даже если люди уже разговаривают'), 'no «silent until 10:00» rule');
    assert.ok(p.includes('«Доброе утро! Понедельник — фокусы недели. Слава, начнёшь?»'), 'greeting example from phrases.json');
    assert.ok(!/[̀́]/.test(p), 'no stress marks');
  });

  test('values bake the dynamic variables in; fillVariables; daily mode; deterministic', () => {
    const vars = dynamicVariables({ dayMode: 'daily_plans', presentNames: ['Тима', 'Глеб'], leadPresent: false, phrases: ASSETS.phrases, leadName: 'Слава' });
    assert.deepEqual(vars, { day_mode_text: dynamicVariables({ dayMode: 'daily_plans', phrases: ASSETS.phrases, leadName: 'Слава' }).day_mode_text, present: 'Тима, Глеб', lead_status: 'не на связи' });
    assert.ok(vars.day_mode_text.startsWith('Будний день'));
    assert.ok(vars.day_mode_text.includes('«Доброе утро! Планы на день, по очереди. Слава, начнёшь?»'));
    assert.ok(vars.day_mode_text.includes('«Всё, ребята, хорошего дня! Дальше дев-синк, пока!»'));
    for (const mode of ['compact', 'full']) {
      const a = buildAgentPrompt({ mode, roster: ROSTER, dayMode: 'daily_plans', values: vars });
      assert.ok(a.includes('Сейчас на связи: Тима, Глеб. Ярослав Орлов: не на связи.'), mode);
      assert.ok(!a.includes('{{'), mode);
      assert.equal(a, buildAgentPrompt({ mode, roster: ROSTER, dayMode: 'daily_plans', values: vars }));
    }
    assert.equal(estimateTokens('Привет, мир'), Math.ceil(10 / 3.3 + 1 / 4));
    assert.equal(estimateTokens(''), 0);
    assert.equal(fillVariables('a {{x}} b {{ y }} {{z}}', { x: 1, y: 'два' }), 'a 1 b два {{z}}');
    assert.deepEqual(dynamicVariables({}), { day_mode_text: dynamicVariables({}).day_mode_text, present: 'пока никого', lead_status: 'неизвестно' });
    assert.equal(hostNote('Говорит: Тима.', { time: '10:03:10' }), '[хост 10:03:10] Говорит: Тима.');
    assert.equal(hostNote(' x '), '[хост] x');
  });

  test('stripSection removes one heading with its body; missing heading is a no-op', () => {
    const md = '# T\n\n## A\n\na\n\n## B\n\nb\n\n## C\n\nc';
    assert.equal(stripSection(md, /^##\s+B[^\n]*$/m), '# T\n\n## A\n\na\n\n## C\n\nc');
    assert.equal(stripSection(md, /^##\s+C[^\n]*$/m), '# T\n\n## A\n\na\n\n## B\n\nb');
    assert.equal(stripSection(md, /^##\s+Z/m), md);
  });

  test('elevenLlmHuman', () => {
    assert.equal(elevenLlmHuman('gemini-3.5-flash'), 'Gemini 3.5 Flash от Google');
    assert.equal(elevenLlmHuman('gpt-5.4-mini'), 'GPT-5.4 mini от OpenAI');
    assert.equal(elevenLlmHuman('claude-haiku-4-5'), 'Claude Haiku 4 5 от Anthropic');
    assert.equal(elevenLlmHuman(''), 'отдельная языковая модель');
  });
});

describe('tools, keywords, agent config', () => {
  test('client tools: five, non-blocking by default (expects_response false), person_id or person_name, set_phase enum', () => {
    const tools = buildClientTools(ROSTER);
    assert.deepEqual(tools.map((t) => t.name), [...CLIENT_TOOL_NAMES]);
    for (const t of tools) {
      assert.equal(t.type, 'client');
      assert.equal(t.expects_response, false, `${t.name} must not block the model`);
      assert.equal(t.parameters.type, 'object');
    }
    const give = tools.find((t) => t.name === 'give_word');
    assert.deepEqual(give.parameters.required, []);
    assert.ok(give.parameters.properties.person_id.description.includes('tkach_t (Тима)'));
    assert.ok(give.parameters.properties.person_name.description.includes('гость'));
    assert.deepEqual(Object.keys(tools.find((t) => t.name === 'turn_done').parameters.properties), ['person_id', 'person_name']);
    assert.deepEqual(tools.find((t) => t.name === 'set_phase').parameters.properties.phase.enum, [...AGENT_PHASES]);
    assert.equal(toolSignature(give), toolSignature({ ...give, response_timeout_secs: 99 }), 'timeouts are not part of the signature');
    assert.notEqual(toolSignature(give), toolSignature({ ...give, description: 'x' }));
    assert.notEqual(toolSignature(give), toolSignature(buildClientTools(ROSTER, { blocking: true })[0]), 'blocking flag changes the signature (setup PATCHes the tool)');
    assert.equal(buildClientTools(ROSTER, { blocking: true })[0].expects_response, true);
  });

  test('keywords: vocabulary + names, deduplicated, capped', () => {
    const k = buildKeywords(ROSTER);
    for (const w of ['Кора', 'Acme', 'PRJX', 'Агрохолдинг', 'Blue Line', 'дев-синк', 'Слава', 'Орлов', 'Серёжа', 'Игнат', 'Митя']) assert.ok(k.includes(w), w);
    assert.equal(new Set(k.map((w) => w.toLowerCase().replace(/ё/g, 'е'))).size, k.length);
    assert.ok(k.length <= 60);
  });

  test('agent config: ru, normal turn eagerness (configurable), flash-lite LLM, pcm_24000 both ways, skip_turn + end_call, overrides, private, long enough', () => {
    const cfg = buildAgentConfig(SETTINGS, { prompt: 'P', toolIds: ['t1', 't2'], roster: ROSTER });
    const c = cfg.conversation_config;
    assert.equal(cfg.name, 'Кора (стендап)');
    assert.equal(c.agent.language, 'ru');
    assert.equal(c.agent.first_message, '');
    assert.equal(c.agent.prompt.prompt, 'P');
    assert.equal(c.agent.prompt.llm, DEFAULT_LLM);
    assert.equal(SETTINGS.voice.eleven_llm, 'gemini-3.5-flash-lite');
    assert.equal(c.agent.prompt.reasoning_effort, 'minimal');
    assert.equal(c.agent.prompt.temperature, 0.3);
    assert.equal(buildAgentConfig({ ...SETTINGS, voice: { ...SETTINGS.voice, eleven: { ...SETTINGS.voice.eleven, turn_eagerness: 'patient' } } }, { prompt: 'P', roster: ROSTER }).conversation_config.turn.turn_eagerness, 'patient');
    assert.throws(() => buildAgentConfig({ ...SETTINGS, voice: { ...SETTINGS.voice, eleven: { ...SETTINGS.voice.eleven, turn_eagerness: 'fast' } } }, { prompt: 'P', roster: ROSTER }), /turn_eagerness/);
    assert.ok(c.conversation.client_events.includes('context_usage'), 'exact context tokens are reported by the server');
    assert.deepEqual(c.agent.prompt.tool_ids, ['t1', 't2']);
    assert.equal(c.agent.prompt.built_in_tools.skip_turn.params.system_tool_type, 'skip_turn');
    assert.equal(c.agent.prompt.built_in_tools.end_call.params.system_tool_type, 'end_call');
    assert.equal(c.agent.prompt.ignore_default_personality, true);
    assert.deepEqual(Object.keys(c.agent.dynamic_variables.dynamic_variable_placeholders).sort(), ['day_mode_text', 'lead_status', 'present']);
    assert.equal(c.asr.user_input_audio_format, 'pcm_24000');
    assert.ok(c.asr.keywords.includes('Кора'));
    assert.equal(c.turn.turn_eagerness, 'normal');
    assert.equal(c.turn.turn_timeout, 20);
    assert.equal(c.turn.turn_model, 'turn_v3');
    assert.ok(c.turn.interruption_ignore_terms.includes('угу'));
    assert.ok(c.turn.interruption_ignore_terms.includes('пока'), '«пока» over her farewell is not an interruption');
    assert.ok(c.agent.prompt.built_in_tools.skip_turn.description.includes('Когда слово ни у кого, на реплики о встрече отвечай'));
    assert.equal(c.tts.voice_id, 'YjESejviApN7SHrbfnA2');
    assert.equal(c.tts.model_id, 'eleven_flash_v2_5');
    assert.equal(c.tts.agent_output_audio_format, 'pcm_24000');
    assert.equal(c.tts.speed, 1);
    assert.ok(c.conversation.max_duration_seconds >= 1800);
    for (const e of ['audio', 'interruption', 'user_transcript', 'agent_response', 'client_tool_call', 'ping']) assert.ok(c.conversation.client_events.includes(e), e);
    assert.deepEqual(c.conversation.client_events, [...CLIENT_EVENTS]);
    assert.equal(cfg.platform_settings.auth.enable_auth, true);
    assert.deepEqual(cfg.platform_settings.overrides.conversation_config_override.agent, { prompt: { prompt: true }, first_message: true, language: true });
    assert.equal(cfg.platform_settings.call_limits.daily_limit, 10);
    assert.equal(cfg.platform_settings.privacy.record_voice, false);
  });

  test('elevenSettings merges defaults with settings.voice', () => {
    const e = elevenSettings(SETTINGS);
    assert.equal(e.voice_id, 'YjESejviApN7SHrbfnA2');
    assert.equal(e.connect_before_start_s, 120, 'from 09:58: she answers people before the start');
    assert.deepEqual(e.silence_s, { round: 7, idle: 5, open_floor: 7, waiting: 6, waiting_long: 20 });
    assert.equal(e.silence_nudges_max, 2);
    assert.equal(e.leave_linger_ms, 5000);
    assert.equal(e.leave_cancels_max, 3);
    assert.ok(e.credits_per_min > 0);
    assert.equal(elevenSettings({ voice: { eleven: { turn_timeout_s: 9 } } }).turn_timeout_s, 9);
    assert.equal(elevenSettings({}).llm, DEFAULT_LLM);
    assert.equal(e.turn_eagerness, 'normal');
    assert.equal(e.chunk_ms, 50);
    assert.equal(e.prompt_mode, 'compact');
    assert.equal(e.tools_blocking, false);
  });
});

describe('agent prompt: schedule vs on-demand wording', () => {
  const base = { roster: ROSTER, dayMode: 'monday_focus', llm: DEFAULT_LLM, phrases: ASSETS.phrases, hostDisplayName: 'Кора (ИИ-ведущая)' };
  test('times given -> the start and deadlines are named; times null -> start by name, no clock deadlines', () => {
    const scheduled = buildAgentPrompt({ ...base, times: SETTINGS.times });
    assert.ok(scheduled.includes('открываешь в 10:00 по заметке хоста'), 'scheduled start');
    assert.ok(scheduled.includes('10:28: ускоряйся. 10:30: завершай.'), 'scheduled deadlines');
    const onDemand = buildAgentPrompt({ ...base, times: null });
    assert.ok(onDemand.includes('по имени'), 'on-demand start by name');
    assert.ok(onDemand.includes('сама по часам не начинай'), 'never starts by the clock herself');
    assert.ok(onDemand.includes('Дедлайнов по часам нет'), 'on-demand deadlines');
    assert.ok(!onDemand.includes('открываешь в 10:00'), 'no hardcoded start time');
    assert.ok(!onDemand.includes('10:28: ускоряйся'), 'no hardcoded deadlines');
  });
});
