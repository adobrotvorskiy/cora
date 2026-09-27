// Offline tests for src/audio/clips.js with a fake mouth (synthetic PCM, no network).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  BYTES_PER_MS,
  ClipStore,
  applyYo,
  cacheDirFor,
  classifyRenderError,
  clipHash,
  edgeSilenceMs,
  finalizeText,
  trimEdges,
  identityFromSettings,
  pcmToWav,
  selectKeys,
  spokenName,
} from '../../src/audio/clips.js';
import { loadSettings } from '../../src/config.js';
import { createYandexMouth } from '../../src/audio/yandex_mouth.js';

const ID = { provider: 'openrouter', model: 'openai/gpt-audio-mini', voice: 'shimmer', instructions: 'Ты Кора.' };

const PEOPLE = [
  { id: 'orlov_y', display: 'Ярослав Орлов', vocative: 'Яросла́в', surname_spoken: 'Орло́в' },
  { id: 'orlov_andrey', display: 'Андрей Орлов', vocative: 'Андре́й', surname_spoken: 'Орло́в', disambiguate_with_surname: true },
  { id: 'plotnikov_a', display: 'Андрей Плотников', vocative: 'Андре́й', surname_spoken: 'Пло́тников', disambiguate_with_surname: true },
  { id: 'tkach_t', display: 'Тимур Ткач', vocative: 'Тиму́р', surname_spoken: 'Тка́ч' },
  { id: 'smirnova_a', display: 'Алина Смирнова', vocative: 'Али́на', surname_spoken: 'Смирнова' },
  { id: 'ghost', display: 'Бывший Сотрудник', vocative: 'Бывший', exclude: true },
];

const PHRASES = {
  greet: { variants: ['Доброе утро!', 'Всем привет!'], per_person: false },
  handoff: { variants: ['Спасибо! Дальше {name}.', 'Спасибо. {name}, твоя очередь.', 'Спасибо! {name}, тебе слово.'], per_person: true },
  check_done: { variants: ['{name}, все?', '{name}, у тебя всё?'], per_person: true },
  start_with_lead: { variants: ['Доброе утро! {name}, начнёшь?'], per_person: true, only_for: ['orlov_y'] },
  sorry_continue: { variants: ['Извини, продолжай.'], per_person: false },
};

const tmpRoots = [];
function tmpCache() {
  const dir = mkdtempSync(join(tmpdir(), 'clips-test-'));
  tmpRoots.push(dir);
  return dir;
}
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** A mouth that renders synthetic PCM (a tone whose length follows the text). */
function fakeMouth({ identity = ID, delayMs = 3, fail = null, mismatch = () => false } = {}) {
  const m = {
    identity,
    calls: [],
    active: 0,
    maxActive: 0,
    async renderClip(text, opts = {}) {
      m.calls.push({ text, opts });
      m.active++;
      m.maxActive = Math.max(m.maxActive, m.active);
      try {
        await sleep(delayMs);
        const err = fail?.(text, m.calls.length);
        if (err) throw err;
        const pcm = synth(200 + text.length * 10);
        const wrong = mismatch(text, m.calls.length);
        if (!opts.withInfo) return pcm;
        return {
          pcm,
          transcript: wrong ? `${text} ой` : text,
          verbatim: !wrong,
          similarity: wrong ? 0.8 : 1,
          ttfa_ms: 5,
          usage: { prompt_tokens: 120, completion_tokens: 40, completion_tokens_details: { audio_tokens: 30 }, cost: 0.0005 },
        };
      } finally {
        m.active--;
      }
    },
  };
  return m;
}

/** Tone of `ms` with leadMs of silence before and tailMs after (a real render ends in silence). */
function synth(ms, leadMs = 40, tailMs = 100) {
  const n = Math.round(ms * 24);
  const buf = Buffer.alloc(n * 2);
  for (let i = Math.round(leadMs * 24); i < n - Math.round(tailMs * 24); i++) buf.writeInt16LE(Math.round(Math.sin(i / 7) * 8000), i * 2);
  return buf;
}

function makeLog() {
  const events = [];
  return { events, event: (type, fields = {}) => events.push({ type, ...fields }), of: (type) => events.filter((e) => e.type === type) };
}

function store(opts = {}) {
  return new ClipStore({ phrases: PHRASES, people: PEOPLE, identity: opts.mouth ? null : ID, cacheDir: tmpCache(), ...opts });
}

// ---- keys -----------------------------------------------------------------------------------------

test('clipHash: stable sha1 over provider, model, voice, instructions and text', () => {
  const text = 'Спасибо! Дальше Тиму́р.';
  assert.equal(clipHash(ID, text), 'aa40d8888e2e17afc003c4b20ca183f9bae7cda0');
  const variants = [
    { ...ID, provider: 'openai_realtime' },
    { ...ID, model: 'openai/gpt-audio' },
    { ...ID, voice: 'alloy' },
    { ...ID, instructions: 'Ты Кора. Темп бодрый.' },
  ];
  for (const v of variants) assert.notEqual(clipHash(v, text), clipHash(ID, text));
  assert.notEqual(clipHash(ID, 'Спасибо! Дальше Тимур.'), clipHash(ID, text), 'stress marks are part of the text');
  assert.equal(cacheDirFor('/c', ID).replace(/\\/g, '/'), '/c/openrouter/openai_gpt-audio-mini/shimmer');
});

test('identity follows the mouth: a new instruction text gives new keys (old clips simply miss)', async () => {
  const mouth = fakeMouth({ identity: { ...ID } });
  const s = store({ mouth });
  await s.ensure([{ text: 'Доброе утро!' }]);
  assert.ok(s.has('Доброе утро!'));
  mouth.identity = { ...ID, instructions: 'Ты Кора. Говори медленнее.' };
  assert.equal(s.has('Доброе утро!'), false);
  assert.equal(s.get('greet', { variantIndex: 0 }), null);
});

test('identityFromSettings mirrors voice.js: openrouter by default, realtime on request; instructions = persona + pace', () => {
  const settings = loadSettings();
  const def = identityFromSettings({ ...settings, voice: undefined });
  assert.deepEqual([def.provider, def.model, def.voice], ['openrouter', 'openai/gpt-audio-mini', settings.realtime.voice]);
  assert.ok(def.instructions.includes('Кора'));
  assert.ok(def.instructions.includes(settings.realtime.pace_instructions.split('\n')[0]));
  const rt = identityFromSettings({ ...settings, voice: { provider: 'openai_realtime' } });
  assert.deepEqual([rt.provider, rt.model], ['openai_realtime', settings.realtime.model]);
  assert.equal(rt.instructions, def.instructions);
  const or = identityFromSettings({ ...settings, voice: { provider: 'openrouter', tts_model: 'openai/gpt-audio', voice: 'alloy' } });
  assert.deepEqual([or.provider, or.model, or.voice], ['openrouter', 'openai/gpt-audio', 'alloy']);
});

// ---- templates ------------------------------------------------------------------------------------

test('text(): vocative with stress marks, ё fixes, only_for, unknown people', () => {
  const s = store();
  assert.equal(s.text('handoff', { person: 'tkach_t', variantIndex: 0 }), 'Спасибо! Дальше Тиму́р.');
  assert.equal(s.text('check_done', { person: 'smirnova_a', variantIndex: 0 }), 'Али́на, всё?', '"все?" after the name -> "всё?"');
  assert.equal(s.text('greet', { variantIndex: 1 }), 'Всем привет!');
  assert.equal(s.text('start_with_lead', { person: 'orlov_y' }), 'Доброе утро! Яросла́в, начнёшь?');
  assert.equal(s.text('start_with_lead', { person: 'tkach_t' }), null, 'only_for');
  assert.equal(s.text('handoff', { person: 'nobody' }), null, 'unknown id');
  assert.equal(s.text('handoff', { person: 'ghost' }), null, 'excluded person');
  assert.equal(s.text('handoff', { person: { display: 'Иван Петров' }, variantIndex: 2 }), 'Спасибо! Иван, тебе слово.', 'guest object');
  assert.throws(() => s.text('handoff'), /per-person/);
  assert.throws(() => s.text('nope'), /unknown phrase key/);
});

test('text(): «Имя Фамилия» only while a namesake is present', () => {
  const s = store();
  const both = ['plotnikov_a', 'orlov_andrey', 'tkach_t'];
  assert.equal(s.text('handoff', { person: 'plotnikov_a', present: both, variantIndex: 0 }), 'Спасибо! Дальше Андре́й Пло́тников.');
  assert.equal(s.text('handoff', { person: 'orlov_andrey', present: both, variantIndex: 0 }), 'Спасибо! Дальше Андре́й Орло́в.');
  assert.equal(s.text('handoff', { person: 'plotnikov_a', present: ['plotnikov_a', 'tkach_t'], variantIndex: 0 }), 'Спасибо! Дальше Андре́й.');
  assert.equal(s.text('handoff', { person: 'plotnikov_a', variantIndex: 0 }), 'Спасибо! Дальше Андре́й.', 'no presence info');
  s.setPresent(both);
  assert.equal(s.text('handoff', { person: 'plotnikov_a', variantIndex: 0 }), 'Спасибо! Дальше Андре́й Пло́тников.', 'setPresent()');
  assert.equal(spokenName(PEOPLE[1], { withSurname: true }), 'Андре́й Орло́в');
});

test('variant rotation: never the same variant twice in a row (per phrase key)', () => {
  const s = store();
  let prev = null;
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const person = i % 2 ? 'tkach_t' : 'smirnova_a';
    const t = s.text('handoff', { person });
    const v = PHRASES.handoff.variants.findIndex((tpl) => t.startsWith(tpl.split('{name}')[0]) && t.endsWith(tpl.split('{name}')[1]));
    assert.notEqual(v, prev, `variant ${v} repeated at call ${i}`);
    seen.add(v);
    prev = v;
  }
  assert.equal(seen.size, 3, 'all variants used');
  assert.equal(s.text('sorry_continue'), s.text('sorry_continue'), 'a single variant repeats');
});

// ---- cache ------------------------------------------------------------------------------------------

test('ensure(): renders missing clips once, second run is 100% cache hit; files + sidecar', async () => {
  const mouth = fakeMouth();
  const log = makeLog();
  const s = store({ mouth, log });
  const plan = s.plan({ present: ['tkach_t', 'smirnova_a'] });
  // greet 2 + sorry 1 + (handoff 3 + check_done 2) x 2 people = 13 (start_with_lead: nobody)
  assert.equal(plan.length, 13);
  const r1 = await s.ensure(plan);
  assert.equal(r1.rendered, 13);
  assert.equal(r1.cached, 0);
  assert.equal(r1.failed, 0);
  assert.equal(mouth.calls.length, 13);
  assert.equal(r1.cost_source, 'usage.cost');
  assert.ok(Math.abs(r1.cost_usd - 13 * 0.0005) < 1e-9);
  assert.equal(r1.usage.audio_out_tokens, 13 * 30);
  const r2 = await s.ensure(plan);
  assert.equal(r2.cached, 13);
  assert.equal(r2.rendered, 0);
  assert.equal(mouth.calls.length, 13, 'no new renders');
  assert.equal(r2.audio_ms, r1.audio_ms);
  assert.equal(s.summarize(s.plan({ present: ['tkach_t', 'smirnova_a'] })).missing, 0);

  const dir = cacheDirFor(s.cacheRoot, ID);
  const files = readdirSync(dir);
  assert.equal(files.filter((f) => f.endsWith('.pcm')).length, 13);
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 13);
  assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0);
  const hash = clipHash(ID, 'Спасибо! Дальше Тиму́р.');
  const side = JSON.parse(readFileSync(join(dir, `${hash}.json`), 'utf8'));
  assert.equal(side.text, 'Спасибо! Дальше Тиму́р.');
  assert.equal(side.key, 'handoff');
  assert.equal(side.person, 'tkach_t');
  assert.equal(side.provider, 'openrouter');
  assert.ok(side.created && side.duration_ms > 0);
  assert.equal(side.lead_ms, 40);
  assert.equal(log.of('clips.render').length, 13);
  assert.equal(log.of('clips.ensure').length, 2);
});

test('get(): cached clip with pcm/text/duration; miss -> null + clips.miss; rotation among cached variants', async () => {
  const mouth = fakeMouth();
  const log = makeLog();
  const s = store({ mouth, log });
  assert.equal(s.get('handoff', { person: 'tkach_t' }), null);
  assert.equal(log.of('clips.miss').length, 1);
  assert.equal(log.of('clips.miss')[0].key, 'handoff');
  // cache only variants 0 and 2
  const v = s.variants('handoff', { person: 'tkach_t' });
  await s.ensure([v[0], v[2]].map((x) => ({ text: x.text, key: 'handoff', person: 'tkach_t', variant: x.variant })));
  const got = [];
  for (let i = 0; i < 10; i++) {
    const c = s.get('handoff', { person: 'tkach_t' });
    assert.ok(Buffer.isBuffer(c.pcm));
    assert.equal(c.duration_ms, Math.round(c.pcm.length / BYTES_PER_MS));
    assert.equal(c.text, v[c.variant].text);
    assert.equal(c.source, 'clip');
    assert.equal(c.lead_ms, 40);
    got.push(c.variant);
  }
  assert.ok(got.every((x) => x === 0 || x === 2), 'uncached variant 1 never chosen');
  for (let i = 1; i < got.length; i++) assert.notEqual(got[i], got[i - 1]);
  assert.equal(s.get('handoff', { person: 'tkach_t', variantIndex: 1 }), null, 'explicit uncached variant misses');
  assert.equal(s.get('start_with_lead', { person: 'tkach_t' }), null, 'not applicable');
  assert.equal(s.stats().hits, 10);
});

test('a render that stops mid-sound is retried once; a second cut one is kept and flagged', async () => {
  let n = 0;
  const flaky = { identity: ID, calls: 0, renderClip: async () => (++n === 1 ? synth(500, 50, 0) : synth(500, 50, 200)) };
  const s1 = store({ mouth: flaky });
  const r1 = await s1.ensure([{ text: 'Доброе утро!' }]);
  assert.deepEqual([r1.rendered, r1.attempts, r1.cut], [1, 2, 0]);
  assert.equal(s1.getByHash(s1.hash('Доброе утро!')).meta.cut, false);
  const s2 = store({ mouth: { identity: ID, renderClip: async () => synth(500, 50, 0) } });
  const r2 = await s2.ensure([{ text: 'Всем привет!', key: 'greet' }]);
  assert.deepEqual([r2.rendered, r2.attempts, r2.cut], [1, 2, 1]);
  assert.equal(r2.warnings[0].code, 'cut_audio');
  assert.equal(s2.getByHash(s2.hash('Всем привет!')).meta.cut, true);
});

test('get() trims edge silence to 20/80 ms pads (models append ~0.4 s); trim: false gives the file as is', async () => {
  const withTail = { identity: ID, renderClip: async () => Buffer.concat([synth(600, 120, 0), Buffer.alloc(400 * BYTES_PER_MS)]) };
  const s = store({ mouth: withTail });
  await s.ensure([{ text: s.variants('greet')[0].text }]);
  const c = s.get('greet', { variantIndex: 0 });
  assert.equal(c.lead_ms, 120);
  assert.equal(c.tail_ms, 400);
  assert.equal(c.trimmed_ms, 100 + 320);
  assert.equal(c.duration_ms, 1000 - 420);
  const raw = s.get('greet', { variantIndex: 0, trim: false });
  assert.equal(raw.duration_ms, 1000);
  assert.equal(raw.trimmed_ms, 0);
});

test('fatal credit error: ensure() stops at once, nothing retried, the rest skipped', async () => {
  const credit = () => Object.assign(new Error('You have no credits remaining'), { code: 'credit_balance_exhausted', status: 429 });
  const mouth = fakeMouth({ fail: credit });
  const log = makeLog();
  const s = store({ mouth, log });
  const plan = s.plan();
  const r = await s.ensure(plan);
  assert.equal(r.fatal.code, 'credit_balance_exhausted');
  assert.match(r.fatal.message, /no credits/);
  assert.equal(r.rendered, 0);
  assert.ok(mouth.calls.length <= 2, `only the in-flight requests went out (${mouth.calls.length})`);
  assert.equal(r.skipped, plan.length - r.failed - r.mismatched);
  assert.equal(log.of('clips.fatal').length, 1);
});

test('transient errors are retried once; verbatim mismatch is retried then not cached; breaker stops runaway failures', async () => {
  const s1 = store({
    mouth: fakeMouth({ fail: (t, n) => (n === 1 ? Object.assign(new Error('rate limited'), { code: 'rate_limit_exceeded' }) : null) }),
    retryDelayMs: 5,
  });
  const r1 = await s1.ensure([{ text: 'Доброе утро!' }]);
  assert.equal(r1.rendered, 1);
  assert.equal(r1.attempts, 2);

  const mouth2 = fakeMouth({ mismatch: (t) => t.includes('утро') });
  const s2 = store({ mouth: mouth2, retryDelayMs: 5 });
  const r2 = await s2.ensure([{ text: 'Доброе утро!' }, { text: 'Всем привет!' }]);
  assert.equal(r2.mismatched, 1);
  assert.equal(r2.rendered, 1);
  assert.equal(mouth2.calls.filter((c) => c.text === 'Доброе утро!').length, 2, 'retried once');
  assert.equal(s2.has('Доброе утро!'), false, 'mismatch not cached');
  assert.equal(r2.errors[0].code, 'verbatim_mismatch');
  const r2b = await s2.ensure([{ text: 'Доброе утро!' }], { keepMismatch: true });
  assert.equal(r2b.rendered, 1);

  const mouth3 = fakeMouth({ fail: () => Object.assign(new Error('bad request'), { code: 'invalid_value' }) });
  const s3 = store({ mouth: mouth3, maxConsecutiveFailures: 3 });
  const plan = s3.plan();
  const r3 = await s3.ensure(plan);
  assert.equal(r3.fatal.code, 'too_many_failures');
  assert.ok(mouth3.calls.length <= 4, `stopped after ${mouth3.calls.length} calls`);
  assert.equal(r3.rendered + r3.failed + r3.skipped, plan.length);
});

test('ensure(): concurrency bounded at 2, deduplicates identical texts, empty audio is a failure', async () => {
  const mouth = fakeMouth({ delayMs: 15 });
  const s = store({ mouth });
  const r = await s.ensure([...s.plan(), { text: 'Доброе утро!' }, { text: '  Доброе   утро! ' }]);
  assert.equal(mouth.maxActive, 2);
  assert.equal(r.unique, r.rendered);
  assert.equal(new Set(mouth.calls.map((c) => c.text)).size, mouth.calls.length);

  const empty = store({ mouth: { identity: ID, renderClip: async () => Buffer.alloc(100) }, retries: 0 });
  const r2 = await empty.ensure([{ text: 'Секунду.' }]);
  assert.equal(r2.failed, 1);
  assert.equal(r2.errors[0].code, 'empty_audio');
});

test('plan(): surname forms for roster namesakes, plain forms shared, excluded people skipped', () => {
  const s = store();
  const plan = s.plan({ keys: ['handoff'] });
  // 5 roster people x 3 plain, minus 3 shared by the two Андрей, + 2 namesakes x 3 surname forms
  assert.equal(plan.length, 5 * 3 - 3 + 2 * 3);
  assert.ok(plan.some((e) => e.text === 'Спасибо! Дальше Андре́й Пло́тников.' && e.surname));
  assert.ok(!plan.some((e) => e.person === 'ghost'));
  assert.equal(s.plan({ keys: ['handoff'], surnames: false }).length, 5 * 3 - 3);
  assert.deepEqual(selectKeys(s.phrases, 'start_*'), ['start_with_lead']);
  assert.throws(() => selectKeys(s.phrases, ['nope']), /no key matches/);
});

test('real config: phrases.json x people.json plan (full and core)', () => {
  const s = new ClipStore({ settings: loadSettings(), identity: ID, cacheDir: tmpCache() });
  const full = s.plan();
  const core = s.plan({ keys: 'core' });
  assert.ok(full.length > core.length && core.length > 0);
  const roster = s.people.map((p) => p.id);
  for (const key of ['handoff', 'check_done', 'are_you_here']) {
    for (const id of roster) {
      const texts = s.variants(key, { person: id });
      assert.ok(texts.every((t) => core.some((e) => e.text === t.text)), `${key} for ${id} is in the core plan`);
    }
  }
  assert.ok(core.filter((e) => e.key.startsWith('start_') && e.key.includes('with_lead')).every((e) => e.person === 'orlov_y'));
  assert.ok(full.every((e) => !/\{\w+\}/.test(e.text)), 'no unfilled placeholders');
  const sum = s.summarize(core);
  assert.equal(sum.total, core.length);
  assert.ok(sum.est_cost_usd > 0 && sum.est_cost_usd < 3, `core estimate $${sum.est_cost_usd}`);
});

// ---- helpers ------------------------------------------------------------------------------------------

test('applyYo: unambiguous words and «всё» contexts only', () => {
  assert.equal(applyYo('Еще вопрос: все равно идет отчет?'), 'Ещё вопрос: всё равно идёт отчёт?');
  assert.equal(applyYo('Тима, все?'), 'Тима, всё?');
  assert.equal(applyYo('У тебя все? На этом все.'), 'У тебя всё? На этом всё.');
  assert.equal(applyYo('Все высказались. Спасибо всем, все молодцы.'), 'Все высказались. Спасибо всем, все молодцы.');
  assert.equal(applyYo('Андре́й, ее отчёт.'), 'Андре́й, её отчёт.');
  assert.equal(applyYo(applyYo('ещё идёт')), 'ещё идёт');
  assert.equal(finalizeText('  Дальше   Тима.  '), 'Дальше Тима.');
});

test('classifyRenderError: credits/auth are fatal, rate limits transient, the rest per clip', () => {
  const E = (props, msg = 'x') => Object.assign(new Error(msg), props);
  assert.equal(classifyRenderError(E({ code: 'credit_balance_exhausted' })), 'fatal');
  assert.equal(classifyRenderError(E({ status: 429 }, 'You have no credits remaining')), 'fatal');
  assert.equal(classifyRenderError(E({ code: 'insufficient_quota' })), 'fatal');
  assert.equal(classifyRenderError(E({ status: 402 }, 'Insufficient credits')), 'fatal');
  assert.equal(classifyRenderError(E({ status: 401 })), 'fatal');
  assert.equal(classifyRenderError(E({ code: 'closed' }, 'mouth is closed')), 'fatal');
  assert.equal(classifyRenderError(E({ code: 'renderClip failed', result: { error: { code: 'insufficient_quota' } } })), 'fatal');
  assert.equal(classifyRenderError(E({ code: 'rate_limit_exceeded' })), 'retry');
  assert.equal(classifyRenderError(E({ code: 'http_429' })), 'retry');
  assert.equal(classifyRenderError(E({ status: 503 })), 'retry');
  assert.equal(classifyRenderError(E({ code: 'timeout' })), 'retry');
  assert.equal(classifyRenderError(E({ code: 'invalid_value' })), 'fail');
});

test('renderText(): one ad-hoc text through the cache; fatal errors reject with fatal: true', async () => {
  const mouth = fakeMouth();
  const s = store({ mouth });
  const a = await s.renderText('Секунду.', { key: 'adhoc' });
  assert.equal(a.text, 'Секунду.');
  assert.ok(a.pcm.length > 0);
  const b = await s.renderText('Секунду.');
  assert.equal(b.hash, a.hash);
  assert.equal(mouth.calls.length, 1, 'second call is a cache hit');
  const dead = store({ mouth: fakeMouth({ fail: () => Object.assign(new Error('Insufficient credits'), { status: 402 }) }) });
  await assert.rejects(dead.renderText('Одну секунду.'), (err) => err.fatal === true && /402|credits/i.test(err.message));
});

test('OpenRouter mouth (or_mouth.js, stubbed fetch): identity, usage.cost, HTTP 402 stops the run', async (t) => {
  let createOrMouth;
  try {
    ({ createOrMouth } = await import('../../src/audio/or_mouth.js'));
  } catch {
    t.skip('src/audio/or_mouth.js not present');
    return;
  }
  const requests = [];
  let mode = 'ok';
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    if (mode === 'broke') {
      return new Response(JSON.stringify({ error: { message: 'Insufficient credits. Add more using https://openrouter.ai/credits', code: 402 } }), { status: 402, headers: { 'content-type': 'application/json' } });
    }
    const text = JSON.parse(body.messages[1].content).response_text;
    const pcm = synth(200 + text.length * 10).toString('base64');
    const sse = [
      { id: 'gen-1', model: body.model, choices: [{ delta: { audio: { transcript: text } } }] },
      { choices: [{ delta: { audio: { data: pcm } } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 150, completion_tokens: 60, cost: 0.00042, completion_tokens_details: { audio_tokens: 45 } } },
    ].map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const settings = { ...loadSettings(), voice: { provider: 'openrouter', tts_model: 'openai/gpt-audio-mini', stt_model: 'x', voice: 'shimmer' } };
  const mouth = createOrMouth({ settings, apiKey: 'test-key-not-real', fetch, retryBackoffMs: 1 });
  const s = new ClipStore({ settings, mouth, phrases: PHRASES, people: PEOPLE, cacheDir: tmpCache() });
  const id = s.identity;
  assert.deepEqual([id.provider, id.model, id.voice], ['openrouter', 'openai/gpt-audio-mini', 'shimmer']);
  assert.equal(id.instructions, mouth.instructions);
  assert.deepEqual(identityFromSettings(settings), id, 'dry-run identity from settings matches the mouth');
  assert.ok(s.dir.replace(/\\/g, '/').endsWith('/openrouter/openai_gpt-audio-mini/shimmer'));

  const r = await s.ensure([{ text: 'Доброе утро!' }, { text: 'Всем привет!' }]);
  assert.equal(r.rendered, 2);
  assert.equal(r.cost_source, 'usage.cost');
  assert.ok(Math.abs(r.cost_usd - 0.00084) < 1e-9);
  assert.equal(requests[0].audio.format, 'pcm16');
  const c = s.get('greet', { variantIndex: 0 });
  assert.equal(c.text, 'Доброе утро!');

  mode = 'broke';
  const before = requests.length;
  const r2 = await s.ensure(s.plan());
  assert.equal(r2.fatal.code, 'payment');
  assert.equal(r2.fatal.status, 402);
  assert.ok(requests.length - before <= 2, `requests after the 402: ${requests.length - before}`);
  mouth.close();
});

test('edgeSilenceMs: sustained 10 ms windows, clicks at the edges ignored, cut = sound at the last window; pcmToWav', () => {
  const pcm = synth(500, 100);
  const e = edgeSilenceMs(pcm);
  assert.deepEqual(e, { lead_ms: 100, tail_ms: 100, cut: false });
  assert.equal(edgeSilenceMs(synth(500, 100, 0)).cut, true, 'still sounding at the end');
  const click = synth(800, 100, 400);
  for (let i = 0; i < 5; i++) click.writeInt16LE(12000 * (i % 2 ? -1 : 1), click.length - 2 - i * 2);
  assert.deepEqual(edgeSilenceMs(click), { lead_ms: 100, tail_ms: 400, cut: false }, 'an isolated click at the end is silence');
  assert.equal(trimEdges(click).length, (800 - 80 - 320) * BYTES_PER_MS, 'the click goes with the trimmed tail');
  const wav = pcmToWav(pcm);
  assert.equal(wav.length, pcm.length + 44);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.ok(existsSync(tmpdir()));
});

test('warmup cost with the SpeechKit mouth: per 250-character request, not the OpenAI audio tariff', async () => {
  const fetch = async () => new Response(`${JSON.stringify({ result: { audioChunk: { data: synth(600).toString('base64') } } })}\n`, { status: 200 });
  const mouth = createYandexMouth({ apiKey: 'k', fetch, usdRub: 100 });
  const phrases = { greet: { variants: ['Доброе утро!'], per_person: false }, long: { variants: ['а'.repeat(260)], per_person: false } };
  const s = new ClipStore({ phrases, people: [], identity: { provider: 'yandex_tts', model: 'speechkit', voice: 'alena', instructions: 'x' }, mouth, cacheDir: tmpCache() });
  const r = await s.warmup({ keys: ['greet', 'long'], surnames: false });
  assert.equal(r.rendered, 2);
  assert.equal(r.cost_source, 'usage.cost');
  assert.equal(r.cost_usd, Math.round(((1 + 2) * 0.1626) / 100 * 1e6) / 1e6, '1 unit + 2 units (260 chars)');
  assert.equal(mouth.stats().units, 3);
  assert.equal(mouth.stats().cost_usd, r.cost_usd);
  const again = await s.warmup({ keys: ['greet', 'long'], surnames: false });
  assert.equal(again.rendered, 0);
  assert.equal(again.cost_usd, 0, 'cached clips cost nothing');
});

test('concurrent warmups (core set + people in the room) render each clip once', async () => {
  const mouth = fakeMouth({ delayMs: 15 });
  const s = store({ mouth });
  const [a, b] = await Promise.all([s.warmup({ keys: ['greet', 'sorry_continue'], surnames: false }), s.warmup({ keys: ['greet', 'handoff'], present: ['tkach_t'], surnames: false })]);
  const texts = mouth.calls.map((c) => c.text);
  assert.equal(new Set(texts).size, texts.length, `rendered twice: ${texts}`);
  assert.equal(a.rendered + b.rendered, texts.length);
  assert.equal(a.skipped + b.skipped, 0);
  assert.ok(a.cached + b.cached >= 2, 'the shared greet variants count as cached for the second warmup');
});

test('SpeechKit / ElevenLabs mouths key the clip cache by their own voice, not the settings OpenAI voice', async () => {
  const yandex = (tts) => new ClipStore({ phrases: PHRASES, people: PEOPLE, mouth: createYandexMouth({ apiKey: 'k', tts }), cacheDir: tmpCache(), settings: { voice: { provider: 'yandex_cascade' } } });
  const alena = yandex({ voice: 'alena', role: 'good', speed: 1.1 });
  assert.deepEqual([alena.identity.provider, alena.identity.model, alena.identity.voice], ['yandex_tts', 'speechkit-tts-v3', 'alena']);
  assert.notEqual(alena.hash('Доброе утро!'), yandex({ voice: 'marina' }).hash('Доброе утро!'));
  assert.notEqual(alena.hash('Доброе утро!'), yandex({ voice: 'alena', role: 'good', speed: 1.0 }).hash('Доброе утро!'));
  const { ElevenMouth } = await import('../../src/audio/eleven_mouth.js');
  const eleven = new ClipStore({ phrases: PHRASES, people: PEOPLE, mouth: new ElevenMouth({ apiKey: 'k', voiceId: 'voice123' }), cacheDir: tmpCache() });
  assert.equal(eleven.identity.provider, 'elevenlabs');
  assert.equal(eleven.identity.voice, 'voice123');
  assert.notEqual(eleven.hash('Доброе утро!'), alena.hash('Доброе утро!'));
});
