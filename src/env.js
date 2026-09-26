// Loads API keys for the standup host from the repo-root .env files.
//
// Precedence (first wins): variables already set in the process environment,
// then <repo>/.env.personal, then <repo>/.env.local. Empty values never count
// as "set", so an empty placeholder cannot shadow a real key.
//
// This module never prints or logs values: callers get present/absent
// (hasKey), the value itself (requireKey) or where it came from (keySource).
//
// Why not process.loadEnvFile(): it has the right precedence (verified on
// Node 24.13: it never overrides a set variable) but keeps a UTF-8 BOM glued
// to the first key ("﻿KEY" silently reads as absent). So we read the file
// ourselves, strip the BOM (or decode UTF-16LE), and parse it with
// util.parseEnv(), the same built-in dotenv parser loadEnvFile uses.

import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** scripts/standup_host */
export const APP_ROOT = resolve(SRC_DIR, '..');
/** Repository root (holds .env.personal / .env.local). */
export const REPO_ROOT = resolve(SRC_DIR, '../../..');
/** Env files in precedence order (first wins). */
export const ENV_FILES = ['.env.personal', '.env.local'];

const SECRET_NAME = /KEY|TOKEN|SECRET|PASS|PWD|AUTH|CRED/i;
const MIN_SECRET_LEN = 12;

const sources = new WeakMap(); // env object -> Map(name -> file basename)
const secretCache = new WeakMap(); // env object -> secret values, longest first
let defaultLoaded = false;

/**
 * Load env files into `env` without overriding variables that are already set.
 * Missing or unreadable files are reported, never thrown.
 *
 * @param {object} [opts]
 * @param {string} [opts.root]  directory with .env.personal/.env.local (default REPO_ROOT)
 * @param {string[]} [opts.files]  explicit file list, highest precedence first (overrides root)
 * @param {Record<string, string|undefined>} [opts.env]  target (default process.env; tests pass a plain object)
 * @returns {{file: string, status: 'loaded'|'missing'|'unreadable', applied: number, error?: string}[]}
 */
export function loadEnv({ root = REPO_ROOT, files, env = process.env } = {}) {
  const list = files ?? ENV_FILES.map((name) => join(root, name));
  const src = sourcesOf(env);
  const report = [];
  for (const file of list) {
    const { text, error } = readEnvText(file);
    if (text === null) {
      report.push({ file, status: error === 'ENOENT' ? 'missing' : 'unreadable', applied: 0, ...(error === 'ENOENT' ? {} : { error }) });
      continue;
    }
    let parsed;
    try {
      parsed = parseEnv(text);
    } catch {
      report.push({ file, status: 'unreadable', applied: 0, error: 'PARSE' }); // never echo content
      continue;
    }
    let applied = 0;
    for (const [name, value] of Object.entries(parsed)) {
      if (value === '' || isSet(env[name])) continue; // already set (or set by an earlier file) wins
      env[name] = value;
      src.set(name, basename(file));
      applied++;
    }
    report.push({ file, status: 'loaded', applied });
  }
  secretCache.delete(env);
  if (env === process.env) defaultLoaded = true;
  return report;
}

/** True if `name` is set to a non-blank value. Loads the default env files on first use. */
export function hasKey(name, env = process.env) {
  ensureDefaultLoaded(env);
  return isSet(env[name]);
}

/** Value of `name` (trimmed); throws Error("missing key NAME") if absent. */
export function requireKey(name, env = process.env) {
  if (!hasKey(name, env)) throw new Error(`missing key ${name}`);
  return env[name].trim();
}

/** Where a present key came from: '.env.personal' | '.env.local' | 'environment'; null if absent. */
export function keySource(name, env = process.env) {
  if (!hasKey(name, env)) return null;
  return sourcesOf(env).get(name) ?? 'environment';
}

/**
 * Mask secret values in `text`: values (>= 12 chars) of variables whose names
 * look secret (KEY/TOKEN/SECRET/PASS/PWD/AUTH/CRED). Used by log.js as a safety net.
 */
export function redactSecrets(text, env = process.env) {
  if (typeof text !== 'string' || text === '') return text;
  let secrets = secretCache.get(env);
  if (!secrets) {
    secrets = Object.entries(env)
      .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.trim().length >= MIN_SECRET_LEN)
      .map(([, value]) => value.trim())
      .sort((a, b) => b.length - a.length);
    secretCache.set(env, secrets);
  }
  for (const secret of secrets) {
    if (text.includes(secret)) text = text.split(secret).join('[REDACTED]');
  }
  return text;
}

function isSet(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function ensureDefaultLoaded(env) {
  if (env === process.env && !defaultLoaded) loadEnv();
}

function sourcesOf(env) {
  let map = sources.get(env);
  if (!map) sources.set(env, (map = new Map()));
  return map;
}

function readEnvText(file) {
  let buf;
  try {
    buf = readFileSync(file);
  } catch (e) {
    return { text: null, error: e.code ?? 'ERROR' };
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.toString('utf16le', 2) }; // UTF-16LE (PowerShell 5 redirect)
  const text = buf.toString('utf8');
  return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
}
