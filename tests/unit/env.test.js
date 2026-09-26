// All tests load temp files into plain objects: the real .env files and
// process.env are never touched.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, test } from 'node:test';
import { APP_ROOT, ENV_FILES, REPO_ROOT, hasKey, keySource, loadEnv, redactSecrets, requireKey } from '../../src/env.js';

const tempDirs = [];
function envDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'standup-env-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test('paths: env files come from the app root or the enclosing repository (<repo>/scripts/standup_host)', () => {
  assert.ok(REPO_ROOT === APP_ROOT || APP_ROOT === join(REPO_ROOT, 'scripts', 'standup_host') || Boolean(process.env.STANDUP_ENV_DIR), REPO_ROOT);
  assert.deepEqual(ENV_FILES, ['.env.personal', '.env.local']);
});

test('precedence: already-set env > .env.personal > .env.local', () => {
  const root = envDir({
    '.env.personal': 'A=personal\nB=personal\n',
    '.env.local': 'A=local\nB=local\nC=local\n',
  });
  const env = { A: 'preset' };
  const report = loadEnv({ root, env });

  assert.equal(env.A, 'preset');
  assert.equal(env.B, 'personal');
  assert.equal(env.C, 'local');
  assert.deepEqual(
    report.map((r) => [basename(r.file), r.status, r.applied]),
    [['.env.personal', 'loaded', 1], ['.env.local', 'loaded', 1]],
  );
  assert.equal(keySource('A', env), 'environment');
  assert.equal(keySource('B', env), '.env.personal');
  assert.equal(keySource('C', env), '.env.local');
  assert.equal(keySource('D', env), null);

  loadEnv({ root, env }); // idempotent
  assert.deepEqual([env.A, env.B, env.C], ['preset', 'personal', 'local']);
});

test('explicit file list: earlier file wins', () => {
  const root = envDir({ 'one.env': 'K=one\n', 'two.env': 'K=two\nL=two\n' });
  const env = {};
  loadEnv({ files: [join(root, 'one.env'), join(root, 'two.env')], env });
  assert.deepEqual([env.K, env.L], ['one', 'two']);
});

test('empty values never shadow a real key', () => {
  const root = envDir({ '.env.personal': 'K=\n', '.env.local': 'K=real\n' });
  const fromFiles = {};
  loadEnv({ root, env: fromFiles });
  assert.equal(fromFiles.K, 'real');
  const presetEmpty = { K: '' };
  loadEnv({ root, env: presetEmpty });
  assert.equal(presetEmpty.K, 'real');
});

test('missing files are reported, not thrown', () => {
  const root = envDir({ '.env.local': 'ONLY_LOCAL=1\n' });
  const env = {};
  const report = loadEnv({ root, env });
  assert.deepEqual(report.map((r) => r.status), ['missing', 'loaded']);
  assert.equal(env.ONLY_LOCAL, '1');
});

test('BOM, CRLF, quotes, export, comments and UTF-16LE files', () => {
  const root = envDir({
    '.env.personal': '﻿FIRST=one\r\n# comment\r\nQUOTED="two words"\r\nexport EXPORTED=three\r\nINLINE=four # note\r\n',
    '.env.local': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('WIDE=five\r\n', 'utf16le')]),
  });
  const env = {};
  loadEnv({ root, env });
  assert.deepEqual(env, { FIRST: 'one', QUOTED: 'two words', EXPORTED: 'three', INLINE: 'four', WIDE: 'five' });
});

test('hasKey / requireKey', () => {
  const env = { SET: '  sk-value  ', BLANK: '   ', EMPTY: '' };
  assert.equal(hasKey('SET', env), true);
  assert.equal(hasKey('BLANK', env), false);
  assert.equal(hasKey('EMPTY', env), false);
  assert.equal(hasKey('NOPE', env), false);
  assert.equal(requireKey('SET', env), 'sk-value');
  assert.throws(() => requireKey('BLANK', env), { name: 'Error', message: 'missing key BLANK' });
  assert.throws(() => requireKey('NOPE', env), { name: 'Error', message: 'missing key NOPE' });
});

test('nothing is printed while loading or querying keys', () => {
  const secret = 'sk-test-SENTINEL-0123456789';
  const root = envDir({ '.env.personal': `MY_API_KEY=${secret}\n` });
  const env = {};
  const written = [];
  const original = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = (chunk) => (written.push(String(chunk)), true);
  process.stderr.write = (chunk) => (written.push(String(chunk)), true);
  let error;
  try {
    loadEnv({ root, env });
    hasKey('MY_API_KEY', env);
    keySource('MY_API_KEY', env);
    requireKey('MY_API_KEY', env);
    try {
      requireKey('ABSENT_KEY', env);
    } catch (e) {
      error = e;
    }
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
  assert.deepEqual(written, []);
  assert.equal(error.message, 'missing key ABSENT_KEY');
});

test('redactSecrets masks values of secret-looking variables only', () => {
  const token = '123456789:AAE-secret-token-value';
  const env = {};
  loadEnv({ root: envDir({ '.env.local': `TELEGRAM_BOT_TOKEN=${token}\nMEETING_ROOM=some-long-public-value\n` }), env });
  const out = redactSecrets(`POST https://api.telegram.org/bot${token}/sendMessage (room some-long-public-value)`, env);
  assert.ok(!out.includes(token));
  assert.ok(out.includes('/bot[REDACTED]/sendMessage'));
  assert.ok(out.includes('some-long-public-value'));
});
