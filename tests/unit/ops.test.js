// Ops: Telegram alerts (mocked fetch, fake token: no network) and the STOP flag
// (temp dirs). The real .env files, process.env keys and state/STOP are never touched.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { STOP_FILE, loadSettings } from '../../src/config.js';
import { APP_ROOT } from '../../src/env.js';
import { clearStopFlag, isStopRequested, requestStop, watchStopFlag } from '../../src/ops/stopflag.js';
import { API_BASE, MAX_MESSAGE_CHARS, formatAlert, formatSummary, runCli, sendAlert, sendSummary } from '../../src/ops/telegram.js';

const TOKEN = '987654321:AAFakeTokenForUnitTestsOnly_0123456789';
const CHAT = 111111111;
const SETTINGS = { telegram: { alert_chat_id: CHAT }, keys: { telegram: 'TELEGRAM_BOT_TOKEN' } };

const tempDirs = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'standup-ops-'));
  tempDirs.push(dir);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function withTimeout(promise, ms, what = 'event') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no ${what} within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const delivered = (id = 1) => () => reply(200, { ok: true, result: { message_id: id } });

// fetch mock. Steps: an Error to throw, or a function (url, init) -> Response.
// Calls past the last step repeat the last step.
function mockFetch(steps) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const step = steps[Math.min(calls.length, steps.length) - 1];
    if (step instanceof Error) throw step;
    return step(url, init);
  };
  return Object.assign(fetch, { calls });
}

// Options that keep sendAlert fully offline: fake token, empty env, mocked fetch,
// recorded (instant) backoff, captured log events. Chat id comes from SETTINGS.
function harness(...steps) {
  const fetch = mockFetch(steps);
  const sleeps = [];
  const events = [];
  const opts = {
    token: TOKEN,
    settings: SETTINGS,
    env: {},
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: { event: (type, fields) => events.push({ type, ...fields }) },
  };
  return { fetch, sleeps, events, opts };
}

// --- telegram ---------------------------------------------------------------

test('formatAlert: «Кора: <text>», [WARN]/[ERROR] in front, unknown level = info', () => {
  assert.equal(formatAlert('тест'), 'Кора: тест');
  assert.equal(formatAlert('  тест  ', 'info'), 'Кора: тест');
  assert.equal(formatAlert('браузер упал', 'warn'), '[WARN] Кора: браузер упал');
  assert.equal(formatAlert('браузер упал', 'error'), '[ERROR] Кора: браузер упал');
  assert.equal(formatAlert('x', 'fatal'), 'Кора: x');
  assert.equal(formatAlert('x', '__proto__'), 'Кора: x');
  const long = formatAlert('ё'.repeat(5000));
  assert.equal(long.length, MAX_MESSAGE_CHARS);
  assert.ok(long.endsWith('…'));
});

test('sendAlert: one plain-text POST to sendMessage, chat from settings', async () => {
  const { fetch, sleeps, events, opts } = harness(delivered(42));
  const res = await sendAlert('тестовое сообщение, алерты работают.', opts);
  assert.deepEqual(res, { ok: true, attempts: 1, status: 200, messageId: 42 });
  assert.equal(fetch.calls.length, 1);
  const [call] = fetch.calls;
  assert.equal(call.url, `${API_BASE}/bot${TOKEN}/sendMessage`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.body.chat_id, CHAT);
  assert.equal(call.body.text, 'Кора: тестовое сообщение, алерты работают.');
  assert.equal(call.body.parse_mode, undefined);
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(sleeps, []);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'telegram.send');
  assert.equal(events[0].ok, true);
  assert.equal(events[0].message_id, 42);
});

test('sendAlert: default chat is settings.telegram.alert_chat_id (local settings); none in git -> no send; chatId overrides', async () => {
  assert.equal(loadSettings().telegram.alert_chat_id, null, 'the committed settings carry no chat id');
  const byConfig = harness(delivered());
  await sendAlert('x', { ...byConfig.opts, settings: { telegram: { alert_chat_id: 111111111 } } });
  assert.equal(byConfig.fetch.calls[0].body.chat_id, 111111111);
  const none = harness(delivered());
  delete none.opts.settings; // -> loadSettings(): no chat id
  const r = await sendAlert('x', none.opts);
  assert.equal(r.ok, false);
  assert.match(r.error, /no chat id/);
  assert.equal(none.fetch.calls.length, 0);

  const explicit = harness(delivered());
  await sendAlert('x', { ...explicit.opts, chatId: 111 });
  assert.equal(explicit.fetch.calls[0].body.chat_id, 111);
});

test('retries network errors and 5xx: 3 attempts, 5 s then 10 s apart', async () => {
  const dns = Object.assign(new Error('getaddrinfo ENOTFOUND api.telegram.org'), { code: 'ENOTFOUND' });
  const { fetch, sleeps, opts } = harness(
    new TypeError('fetch failed', { cause: dns }),
    () => reply(502, { ok: false, description: 'Bad Gateway' }),
    delivered(9),
  );
  const res = await sendAlert('x', opts);
  assert.deepEqual(res, { ok: true, attempts: 3, status: 200, messageId: 9 });
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(sleeps, [5000, 10000]);
});

test('gives up after 3 attempts with the last error, never throws', async () => {
  const { fetch, sleeps, opts } = harness(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
  const res = await sendAlert('x', { ...opts, level: 'error' });
  assert.deepEqual(res, { ok: false, attempts: 3, status: null, error: 'fetch failed (ECONNRESET)' });
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(sleeps, [5000, 10000]);
});

test('no retry on 400/401/403/404 (retrying will not help)', async () => {
  const cases = [
    [400, 'Bad Request: chat not found'],
    [401, 'Unauthorized'],
    [403, "Forbidden: bot can't initiate conversation with a user"],
    [404, 'Not Found'],
  ];
  for (const [status, description] of cases) {
    const { fetch, sleeps, opts } = harness(() => reply(status, { ok: false, error_code: status, description }));
    const res = await sendAlert('x', opts);
    assert.deepEqual(res, { ok: false, attempts: 1, status, error: `HTTP ${status}: ${description}` });
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
});

test('429: waits retry_after, capped at 30 s', async () => {
  const soon = harness(() => reply(429, { ok: false, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }), delivered());
  assert.equal((await sendAlert('x', soon.opts)).ok, true);
  assert.deepEqual(soon.sleeps, [7000]);
  const late = harness(() => reply(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 600 } }), delivered());
  assert.equal((await sendAlert('x', late.opts)).ok, true);
  assert.deepEqual(late.sleeps, [30000]);
});

test('each attempt is cut off by its timeout', async () => {
  const hang = (url, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  const { fetch, opts } = harness(hang);
  const t0 = Date.now();
  const res = await sendAlert('x', { ...opts, timeoutMs: 30, attempts: 2 });
  assert.deepEqual(res, { ok: false, attempts: 2, status: null, error: 'timeout after 30 ms' });
  assert.equal(fetch.calls.length, 2);
  assert.ok(Date.now() - t0 < 2000);
});

test('the token never appears in results, log events or the sent text', async () => {
  const leaky = (url) => {
    throw new TypeError(`Failed to parse URL from ${url}`, { cause: new Error(`connect ECONNREFUSED ${url}`) });
  };
  const echo = (url) => reply(500, { ok: false, description: `Internal error for ${url}` });
  const { fetch, events, opts } = harness(leaky, echo, leaky);
  const res = await sendAlert(`секрет ${TOKEN} в тексте`, opts);
  assert.equal(res.ok, false);
  assert.match(res.error, /\[REDACTED\]/);
  const seen = JSON.stringify({ res, events, sent: fetch.calls.map((c) => c.body) });
  assert.ok(!seen.includes(TOKEN), seen);
  assert.ok(!seen.includes(TOKEN.split(':')[1]), seen);

  // token taken from env (not passed in): same guarantee
  const viaEnv = harness(leaky);
  delete viaEnv.opts.token;
  const res2 = await sendAlert('x', { ...viaEnv.opts, env: { TELEGRAM_BOT_TOKEN: TOKEN } });
  assert.equal(viaEnv.fetch.calls.length, 3);
  assert.ok(!JSON.stringify({ res2, events: viaEnv.events }).includes(TOKEN));

  // unknown token-shaped strings are masked too
  const other = '123456789:AAotherTokenShapedValue_abcdefghijklmn';
  const res3 = await sendAlert('x', { ...harness(() => reply(500, { ok: false, description: other })).opts, attempts: 1 });
  assert.equal(res3.error, 'HTTP 500: [REDACTED]');
});

test('missing token or chat id: no request, clear error', async () => {
  const noToken = harness(delivered());
  delete noToken.opts.token; // env is {}
  assert.deepEqual(await sendAlert('x', noToken.opts), { ok: false, attempts: 0, error: 'TELEGRAM_BOT_TOKEN absent' });
  assert.equal(noToken.fetch.calls.length, 0);
  assert.equal(noToken.events[0].ok, false);

  const noChat = harness(delivered());
  const res = await sendAlert('x', { ...noChat.opts, settings: { telegram: {}, keys: {} } });
  assert.deepEqual(res, { ok: false, attempts: 0, error: 'no chat id (settings.telegram.alert_chat_id)' });
  assert.equal(noChat.fetch.calls.length, 0);
});

test('never throws on broken input', async () => {
  const { opts } = harness(delivered());
  assert.deepEqual(await sendAlert('x', { ...opts, fetch: 'not a function' }), { ok: false, attempts: 0, error: 'fetch is not available' });
  const badText = { toString() { throw new Error('bad text'); } };
  assert.deepEqual(await sendAlert(badText, opts), { ok: false, attempts: 0, error: 'bad text' });
  const syncThrow = () => {
    throw new Error('sync boom');
  };
  const res = await sendAlert('x', { ...opts, fetch: syncThrow });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'sync boom');
  const brokenLog = { event() { throw new Error('disk full'); } };
  assert.equal((await sendAlert('x', { ...opts, log: brokenLog })).ok, true);
});

test('sendSummary: title + one row per non-empty line, fits Telegram limit', async () => {
  const { fetch, opts } = harness(delivered(5));
  const res = await sendSummary(['Выступили: 9 из 10', '', 'Длительность: 24 мин'], opts);
  assert.equal(res.ok, true);
  assert.equal(fetch.calls[0].body.text, 'Кора: итоги стендапа\nВыступили: 9 из 10\nДлительность: 24 мин');
  assert.equal(formatSummary(['a'], { title: 'итоги дня' }), 'Кора: итоги дня\na');
  const long = formatSummary(Array.from({ length: 500 }, (_, i) => `строка ${i} ${'x'.repeat(20)}`));
  assert.equal(long.length, MAX_MESSAGE_CHARS);
  assert.ok(long.endsWith('…'));
});

test('CLI: usage errors and --dry-run send nothing; exit codes', async () => {
  const sent = [];
  const send = async (...args) => {
    sent.push(args);
    return { ok: true, attempts: 1, messageId: 1 };
  };
  const lines = [];
  const out = { log: (s) => lines.push(s), error: (s) => lines.push(s) };
  assert.equal(await runCli([], { send, out }), 64);
  assert.equal(await runCli(['--level', 'fatal', 'x'], { send, out }), 64);
  assert.equal(await runCli(['--bogus', 'x'], { send, out }), 64);
  assert.equal(await runCli(['--dry-run', '--level', 'warn', 'тест'], { send, out }), 0);
  assert.match(lines.at(-1), /chat \?: \[WARN\] Кора: тест$/, 'no chat id in the committed settings');
  assert.equal(sent.length, 0);

  assert.equal(await runCli(['--level', 'error', 'хост', 'упал'], { send, out }), 0);
  assert.deepEqual(sent, [['хост упал', { level: 'error' }]]);
  const failing = async () => ({ ok: false, attempts: 3, error: 'HTTP 403: Forbidden' });
  assert.equal(await runCli(['x'], { send: failing, out }), 1);
  assert.match(lines.at(-1), /NOT delivered after 3 attempt\(s\): HTTP 403: Forbidden/);
});

// --- stop flag ---------------------------------------------------------------

test('STOP_FILE is state/STOP inside the app', () => {
  assert.equal(STOP_FILE, join(APP_ROOT, 'state', 'STOP'));
});

test('stop flag: request / detect / clear, directory created on demand', () => {
  const file = join(tempDir(), 'nested', 'state', 'STOP');
  assert.equal(isStopRequested({ file }), false);
  assert.equal(clearStopFlag({ file }), false);
  assert.equal(requestStop('unit test', { file }), file);
  assert.equal(isStopRequested({ file }), true);
  assert.equal(clearStopFlag({ file }), true);
  assert.equal(isStopRequested({ file }), false);
  assert.equal(clearStopFlag({ file }), false);
});

test('watchStopFlag: creates the dir, fires within the interval, once per appearance, stop() silences it', async () => {
  const file = join(tempDir(), 'state', 'STOP');
  const fires = [];
  let wake = null;
  const watcher = watchStopFlag((info) => {
    fires.push(info);
    wake?.();
  }, { file, intervalMs: 20 });
  try {
    assert.ok(existsSync(dirname(file)), 'state dir is created');
    await delay(60);
    assert.equal(fires.length, 0);

    let fired = new Promise((resolve) => (wake = resolve));
    const t0 = Date.now();
    writeFileSync(file, '2026-09-21 10:12:03 stop-standup.ps1 (aleks)\r\n');
    await withTimeout(fired, 1000, 'fire');
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(fires[0].file, file);
    assert.equal(fires[0].reason, '2026-09-21 10:12:03 stop-standup.ps1 (aleks)');
    assert.ok(fires[0].at instanceof Date);

    await delay(100);
    assert.equal(fires.length, 1, 'a flag that stays does not fire again');

    unlinkSync(file);
    await delay(60);
    fired = new Promise((resolve) => (wake = resolve));
    writeFileSync(file, ''); // New-Item state\STOP: empty file
    await withTimeout(fired, 1000, 'second fire');
    assert.equal(fires.length, 2);
    assert.equal(fires[1].reason, '');
    assert.equal(watcher.fired, 2);
  } finally {
    watcher.stop();
  }
  unlinkSync(file);
  await delay(60);
  writeFileSync(file, '');
  await delay(100);
  assert.equal(fires.length, 2, 'a stopped watcher stays quiet');
});

test('watchStopFlag: existing flag fires at once; default 250 ms poll is inside the 1 s budget', async () => {
  const dir = tempDir();
  const existing = join(dir, 'STOP');
  // Windows PowerShell 5.1 "echo ... > state\STOP" writes UTF-16LE with a BOM
  writeFileSync(existing, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('из PowerShell 5.1', 'utf16le')]));
  const t0 = Date.now();
  const info = await withTimeout(
    new Promise((resolve) => {
      const w = watchStopFlag((i) => {
        w.stop();
        resolve(i);
      }, { file: existing });
    }),
    1000,
    'fire for an existing flag',
  );
  assert.equal(info.reason, 'из PowerShell 5.1');
  assert.ok(Date.now() - t0 < 200, `existing flag took ${Date.now() - t0} ms`);

  const file = join(dir, 'later', 'STOP');
  let resolveFire;
  const fired = new Promise((resolve) => (resolveFire = resolve));
  const watcher = watchStopFlag(() => resolveFire(Date.now()), { file }); // default intervalMs
  try {
    await delay(300);
    const created = Date.now();
    writeFileSync(file, '');
    const latency = (await withTimeout(fired, 1000, 'fire with the default interval')) - created;
    assert.ok(latency < 1000, `latency ${latency} ms`);
  } finally {
    watcher.stop();
  }
});

test('watchStopFlag: callback errors (sync and async) are reported and do not stop it', async () => {
  const file = join(tempDir(), 'STOP');
  const errors = [];
  let calls = 0;
  let wake = null;
  const watcher = watchStopFlag(() => {
    calls++;
    wake?.();
    if (calls === 1) throw new Error('sync failure');
    return Promise.reject(new Error('async failure'));
  }, { file, intervalMs: 20, onError: (e) => errors.push(e.message) });
  try {
    let fired = new Promise((resolve) => (wake = resolve));
    writeFileSync(file, '');
    await withTimeout(fired, 1000, 'first fire');
    unlinkSync(file);
    await delay(60);
    fired = new Promise((resolve) => (wake = resolve));
    writeFileSync(file, '');
    await withTimeout(fired, 1000, 'second fire');
    await delay(10);
    assert.deepEqual(errors, ['sync failure', 'async failure']);
  } finally {
    watcher.stop();
  }
  assert.throws(() => watchStopFlag(null, { file }), TypeError);
});
