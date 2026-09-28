import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SETTINGS_PATH, deepMerge, deriveTimes, loadSettings, selectBrainProvider, TIME_KEYS, validateSettings } from '../../src/config.js';

const tempDirs = [];
function configDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'standup-config-'));
  tempDirs.push(dir);
  for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), typeof data === 'string' ? data : JSON.stringify(data));
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
const committed = () => JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));

test('settings.json <- settings.local.json <- CLI overrides (deep merge)', () => {
  const dir = configDir({
    'settings.json': { a: 1, nested: { x: 1, y: 2 }, list: [1, 2], keep: 'k' },
    'settings.local.json': { nested: { y: 3 }, list: [9] },
  });
  const s = loadSettings({ configDir: dir, cliOverrides: { a: 2, nested: { z: 4 }, keep: undefined } });
  assert.deepEqual(s, { a: 2, nested: { x: 1, y: 3, z: 4 }, list: [9], keep: 'k' });
});

test('settings.local.json is optional; broken JSON names the file', () => {
  assert.deepEqual(loadSettings({ configDir: configDir({ 'settings.json': { a: 1 } }) }), { a: 1 });
  const broken = configDir({ 'settings.json': { a: 1 }, 'settings.local.json': '{ nope' });
  assert.throws(() => loadSettings({ configDir: broken }), /invalid JSON in .*settings\.local\.json/);
});

test('deepMerge ignores __proto__ keys', () => {
  const merged = deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}}'));
  assert.equal(merged.polluted, undefined);
  assert.equal({}.polluted, undefined);
});

test('committed settings.json: no links or chat ids in git; valid once the local meeting link is merged', () => {
  const s = committed();
  assert.equal(s.meeting_url, '');
  assert.equal(s.real_room_url, '');
  assert.equal(s.test_room_url, '');
  assert.equal(s.telegram.alert_chat_id, null);
  assert.deepEqual(validateSettings(s).errors, ['meeting_url is empty: put the meeting link into config/settings.local.json (or pass --url)']);
  s.meeting_url = 'https://telemost.yandex.ru/j/11111111111111111111111111111111111111';
  assert.deepEqual(validateSettings(s), { errors: [], warnings: [] });
  assert.deepEqual(Object.keys(s), ['meeting_url', 'real_room_url', 'test_room_url', 'display_name', 'avatar', 'timezone', 'times', 'realtime', 'voice', 'engagement', 'brain', 'floor', 'browser', 'telegram', 'keys', 'yandex']);
  assert.equal(typeof s.avatar.path, 'string');
  assert.equal(s.speech, undefined);
  assert.equal(s.realtime.voice, 'shimmer');
  assert.equal(s.realtime.speed, 1);
  assert.match(s.realtime.pace_instructions, /^# Темп\n/);
  assert.equal(s.voice.provider, 'openrouter');
  assert.equal(s.voice.tts_model, 'openai/gpt-audio-mini');
  assert.equal(s.voice.voice, 'shimmer');
  assert.equal(typeof s.voice.stt_model, 'string');
  assert.deepEqual(s.keys, { openai: 'OPENAI_API_KEY', openrouter: 'Cora_KEY', google: 'GEMINI_API_KEY', elevenlabs: 'Elevenlabs_Cora_API', yandex: 'key', yandex_folder: 'id', telegram: 'TELEGRAM_BOT_TOKEN' });
  assert.equal(typeof s.yandex.voice, 'string');
  assert.equal(typeof s.yandex.model, 'string');
  assert.equal(s.voice.eleven_voice_id, 'YjESejviApN7SHrbfnA2');
  assert.equal(typeof s.voice.eleven_llm, 'string');
  assert.equal(typeof s.voice.eleven_tts_model, 'string');
  assert.ok(s.voice.eleven_agent_id === null || typeof s.voice.eleven_agent_id === 'string');
});

test('validateSettings: the elevenlabs_agent provider needs its voice/llm/tts and key; a missing agent id is a warning', () => {
  const s = { ...committed(), meeting_url: 'https://telemost.yandex.ru/j/11111111111111111111111111111111111111' };
  s.voice.provider = 'elevenlabs_agent';
  s.voice.eleven_agent_id = null;
  const r = validateSettings(s);
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.startsWith('voice.eleven_agent_id is empty')));
  s.voice.eleven_voice_id = '';
  delete s.keys.elevenlabs;
  s.voice.eleven = 'x';
  const { errors } = validateSettings(s);
  assert.ok(errors.includes('voice.eleven_voice_id must be a non-empty string'));
  assert.ok(errors.includes('keys.elevenlabs must name an env variable (the elevenlabs_agent provider needs it)'));
  assert.ok(errors.includes('voice.eleven must be an object'));
});

test('validateSettings checks the voice section', () => {
  const s = committed();
  s.voice.provider = 'elevenlabs';
  s.voice.vad.stop_db = 20; // above start_db
  s.voice.stt.early_final_ms = 900; // beyond the hangover
  s.voice.stt.timeout_ms = 'soon';
  const { errors, warnings } = validateSettings(s);
  assert.ok(errors.includes('voice.provider must be one of openrouter|openai_realtime|elevenlabs_agent|yandex_rt|yandex_cascade'));
  assert.ok(errors.includes('voice.vad.stop_db must be below voice.vad.start_db'));
  assert.ok(errors.includes('voice.stt.timeout_ms must be a number'));
  assert.ok(warnings.some((w) => w.startsWith('voice.stt.early_final_ms (900) >= voice.vad.stop_ms')));
  const t = committed();
  t.voice.tts_model = ' ';
  assert.ok(validateSettings(t).errors.includes('voice.tts_model must be a non-empty string'));
  delete t.voice;
  assert.ok(validateSettings(t).errors.includes('settings.voice is missing'));
});

test('validateSettings: voice.host agent needs the AI Studio folder and ears; agent settings are checked', () => {
  const s = { ...committed(), meeting_url: 'https://telemost.yandex.ru/j/11111111111111111111111111111111111111' };
  s.voice.host = 'agent';
  s.yandex = { folder: 'folder-x' };
  s.agent = { model: 'aliceai-llm-flash/latest', timeout_ms: 8000, budget: { max_calls: 600 }, pricing: null };
  assert.deepEqual(validateSettings(s).errors, []);
  delete s.yandex;
  s.voice.provider = 'elevenlabs_agent';
  s.agent = { timeout_ms: 'soon', budget: 3 };
  const { errors } = validateSettings(s);
  assert.ok(errors.includes('yandex.folder must be the cloud folder id for voice.host agent'));
  assert.ok(errors.includes('voice.host agent needs ears and a mouth (yandex_cascade or openrouter), not elevenlabs_agent'));
  assert.ok(errors.includes('agent.timeout_ms must be a number'));
  assert.ok(errors.includes('agent.budget must be an object {max_calls, max_tokens, max_rub}'));
  const g = { ...committed(), meeting_url: 'https://telemost.yandex.ru/j/11111111111111111111111111111111111111' };
  g.voice.host = 'agent';
  g.agent = { provider: 'google' };
  assert.deepEqual(validateSettings(g).errors, [], 'google needs no Yandex folder; keys.google is in settings.json');
  delete g.keys.google;
  assert.ok(validateSettings(g).errors.includes('keys.google must name the env variable with the Google AI Studio (Gemini API) key'));
  g.agent = { provider: 'gigachat' };
  assert.ok(validateSettings(g).errors.includes('agent.provider must be yandex|google|openrouter'));
  const t = committed();
  t.voice.host = 'robot';
  assert.ok(validateSettings(t).errors.includes('voice.host must be automaton|agent'));
});

test('validateSettings catches broken times, URL and speed', () => {
  const s = committed();
  s.times.hard_deadline = '10:20'; // before soft_deadline 10:28
  s.times.join = '9:58';
  s.meeting_url = 'telemost';
  s.realtime.speed = 1.3;
  const { errors, warnings } = validateSettings(s);
  assert.ok(errors.some((e) => e.startsWith('times.hard_deadline (10:20) must be after times.soft_deadline')));
  assert.ok(errors.includes('times.join must be "HH:MM"'));
  assert.ok(errors.includes('meeting_url is not a valid URL'));
  assert.ok(warnings.some((w) => w.startsWith('realtime.speed is 1.3')));
});

test('brain provider: OpenRouter > OpenAI fallback > none', () => {
  const s = committed();
  assert.deepEqual(selectBrainProvider(s, { has: () => true }), {
    provider: 'openrouter',
    model: s.brain.openrouter_model,
    keyName: s.keys.openrouter,
  });
  assert.deepEqual(selectBrainProvider(s, { has: (name) => name === 'OPENAI_API_KEY' }), {
    provider: 'openai',
    model: 'gpt-5-mini',
    keyName: 'OPENAI_API_KEY',
  });
  assert.deepEqual(selectBrainProvider(s, { has: () => false }), { provider: 'none', model: null, keyName: null });
});

test('deriveTimes: shifts the whole schedule from its anchor, "--start 10:00" reproduces the template', () => {
  const template = committed().times;
  assert.deepEqual(deriveTimes('10:00', template), template);
  const shifted = deriveTimes('11:30', template);
  assert.equal(shifted.start, '11:30');
  assert.equal(shifted.join, '11:28');
  assert.equal(shifted.wait_lead_until, '11:32');
  assert.equal(shifted.soft_deadline, '11:58');
  assert.equal(shifted.hard_deadline, '12:00');
  assert.equal(shifted.force_leave, '12:05');
  assert.equal(shifted.transcription_cutoff, '12:10');
  assert.deepEqual(Object.keys(shifted), TIME_KEYS);
  const early = deriveTimes('09:00', template);
  assert.equal(early.force_leave, '09:35');
});

test('deriveTimes: a sparse template falls back to the built-in defaults', () => {
  assert.equal(deriveTimes('12:00', {}).start, '12:00');
  assert.equal(deriveTimes('12:00', {}).soft_deadline, '12:28');
  assert.equal(deriveTimes('12:00', {}).force_leave, '12:35'); // 10:35 + 2 h
  assert.equal(deriveTimes('12:00', { join: 'soon' }).join, '11:58'); // invalid template value -> default offset
});
