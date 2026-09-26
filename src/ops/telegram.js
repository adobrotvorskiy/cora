// Telegram alerts from the standup host: a direct message to Sergey.
//
//   sendAlert(text, {level, chatId})  -> «Кора: <text>»; warn/error get a "[WARN] " / "[ERROR] "
//                                        prefix in front (no emoji)
//   sendSummary(lines, {title})       -> «Кора: итоги стендапа» + one row per line (P1)
//
// Transport: Bot API sendMessage from the TELEGRAM_BOT_TOKEN bot (settings.keys.telegram)
// to settings.telegram.alert_chat_id, plain text (no parse_mode, nothing to escape).
// Retry policy copies scripts/timesheets-create.py::_telegram_api: up to 3 attempts,
// 5 s and then 10 s between them, no retry on 400/401/403/404 (bad token, bot blocked,
// chat not found: a retry will not help). On top of that: a 10 s timeout per attempt
// and Telegram's retry_after on 429 (capped at 30 s). Worst case is about 45 s, so
// never await an alert on the host's critical path.
//
// Never throws. Every outcome is a result object:
//   {ok: true,  attempts, status, messageId}
//   {ok: false, attempts, status?, error}
// Error strings are scrubbed before they are returned or logged: the token (it travels
// in the URL path), anything shaped like a bot token and known secret values
// (env.redactSecrets) become [REDACTED].
//
// Alerts carry operational facts only (what failed, exit code, where the log is).
// Transcript text never goes into an alert: it stays on this machine (README, «Безопасность»).
//
// CLI (run-standup.ps1 sends crash alerts through it, so only Node reads the key):
//   node src/ops/telegram.js [--level info|warn|error] [--dry-run] <text...>
//   exit 0 delivered (or dry run), 1 not delivered (reason on stderr), 64 bad usage

import { parseArgs } from 'node:util';
import { loadSettings } from '../config.js';
import { hasKey, redactSecrets } from '../env.js';

export const API_BASE = 'https://api.telegram.org';
/** Telegram's limit for one message. */
export const MAX_MESSAGE_CHARS = 4096;
export const LEVELS = ['info', 'warn', 'error'];

const NAME = 'Кора';
const LEVEL_PREFIX = { info: '', warn: '[WARN] ', error: '[ERROR] ' };
const DEFAULT_KEY_NAME = 'TELEGRAM_BOT_TOKEN';
const ATTEMPTS = 3;
const MAX_ATTEMPTS = 10;
const TIMEOUT_MS = 10_000;
const BACKOFF_MS = 5_000; // before attempt n+1 wait BACKOFF_MS * n: 5 s, 10 s
const MAX_RETRY_AFTER_MS = 30_000;
const NO_RETRY_STATUS = new Set([400, 401, 403, 404]);
const TOKEN_SHAPE = /\d{6,}:[\w-]{30,}/g;
const REDACTED = '[REDACTED]';

/** «Кора: <text>», with "[WARN] " / "[ERROR] " in front for those levels. Unknown level = info. */
export function formatAlert(text, level = 'info') {
  const prefix = LEVELS.includes(level) ? LEVEL_PREFIX[level] : '';
  return fit(`${prefix}${NAME}: ${String(text ?? '').trim()}`);
}

/** «Кора: <title>» followed by the non-empty lines, one per row. */
export function formatSummary(lines, { title = 'итоги стендапа' } = {}) {
  const rows = (Array.isArray(lines) ? lines : [lines])
    .map((line) => String(line ?? '').trimEnd())
    .filter((line) => line.trim() !== '');
  return fit([`${NAME}: ${title}`, ...rows].join('\n'));
}

/**
 * Send an alert DM. Resolves, never rejects.
 * @param {string} text
 * @param {object} [opts]
 * @param {'info'|'warn'|'error'} [opts.level]  default 'info'
 * @param {number|string} [opts.chatId]  default settings.telegram.alert_chat_id
 * @param {object} [opts.settings]  merged settings (default: loadSettings(), only when needed)
 * @param {{event: Function}} [opts.log]  openLog() instance: one 'telegram.send' event per call
 * @param {Function} [opts.fetch]  default globalThis.fetch (tests inject a mock)
 * @param {(ms: number) => Promise<void>} [opts.sleep]  backoff wait (tests record the delays)
 * @param {string} [opts.token]  default: env[settings.keys.telegram]
 * @param {object} [opts.env]  default process.env
 * @param {number} [opts.attempts]  default 3
 * @param {number} [opts.timeoutMs]  per attempt, default 10000
 * @returns {Promise<{ok: boolean, attempts: number, status?: number|null, messageId?: number|null, error?: string}>}
 */
export function sendAlert(text, opts = {}) {
  const level = LEVELS.includes(opts?.level) ? opts.level : 'info';
  return deliver(() => formatAlert(text, level), { ...opts, level, kind: 'alert' });
}

/**
 * Post-standup summary (P1): «Кора: <title>» + lines. Same options and result as sendAlert.
 * @param {string[]} lines
 * @param {object} [opts]  sendAlert options plus {title}
 */
export function sendSummary(lines, opts = {}) {
  return deliver(() => formatSummary(lines, opts ?? {}), { ...opts, level: 'info', kind: 'summary' });
}

async function deliver(compose, opts) {
  const started = Date.now();
  const env = opts.env ?? process.env;
  let token = typeof opts.token === 'string' && opts.token.trim() ? opts.token.trim() : null;
  let text = '';
  let result;
  try {
    text = compose();
    const settings = opts.settings ?? (opts.chatId == null || !token ? loadSettings() : null);
    const keyName = settings?.keys?.telegram ?? DEFAULT_KEY_NAME;
    if (!token && hasKey(keyName, env)) token = env[keyName].trim();
    const chatId = opts.chatId ?? settings?.telegram?.alert_chat_id;
    if (!token) result = { ok: false, attempts: 0, error: `${keyName} absent` };
    else if (chatId == null || chatId === '') result = { ok: false, attempts: 0, error: 'no chat id (settings.telegram.alert_chat_id)' };
    else result = await post({ token, chatId, text: scrub(text, token, env) }, opts);
  } catch (e) {
    result = { ok: false, attempts: 0, error: describe(e) };
  }
  if (result.error) result.error = scrub(result.error, token, env);
  record(opts.log, {
    kind: opts.kind,
    level: opts.level,
    ok: result.ok,
    attempts: result.attempts,
    status: result.status ?? null,
    message_id: result.messageId ?? null,
    error: result.error,
    latency_ms: Date.now() - started,
    text: scrub(text, token, env),
  });
  return result;
}

async function post({ token, chatId, text }, opts) {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, attempts: 0, error: 'fetch is not available' };
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const wanted = Math.trunc(Number(opts.attempts ?? ATTEMPTS));
  const attempts = wanted >= 1 ? Math.min(wanted, MAX_ATTEMPTS) : ATTEMPTS;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : TIMEOUT_MS;
  const url = `${opts.apiBase ?? API_BASE}/bot${token}/sendMessage`;
  const body = JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } });

  let last = { status: null, error: 'not sent' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let waitMs = BACKOFF_MS * attempt;
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await readJson(res);
      if (res.ok && data?.ok === true) {
        return { ok: true, attempts: attempt, status: res.status, messageId: data.result?.message_id ?? null };
      }
      last = { status: res.status, error: `HTTP ${res.status}: ${data?.description || res.statusText || 'no description'}` };
      if (NO_RETRY_STATUS.has(res.status)) return { ok: false, attempts: attempt, ...last };
      const retryAfterS = Number(data?.parameters?.retry_after);
      if (res.status === 429 && retryAfterS > 0) waitMs = Math.max(waitMs, Math.min(retryAfterS * 1000, MAX_RETRY_AFTER_MS));
    } catch (e) {
      last = { status: null, error: describe(e, timeoutMs) };
    }
    if (attempt < attempts) await sleep(waitMs);
  }
  return { ok: false, attempts, ...last };
}

async function readJson(res) {
  try {
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

function describe(e, timeoutMs) {
  if (e?.name === 'TimeoutError') return `timeout after ${timeoutMs} ms`;
  if (e?.name === 'AbortError') return 'request aborted';
  const message = String(e?.message ?? e);
  const cause = e?.cause;
  const detail = cause ? cause.code ?? cause.message ?? String(cause) : e?.code;
  return detail && !message.includes(String(detail)) ? `${message} (${detail})` : message;
}

function scrub(text, token, env) {
  let out = String(text ?? '');
  if (token) out = out.split(token).join(REDACTED);
  out = out.replace(TOKEN_SHAPE, REDACTED);
  try {
    out = redactSecrets(out, env);
  } catch {
    // best effort: the explicit token pass above already ran
  }
  return out;
}

function record(log, fields) {
  if (!log || typeof log.event !== 'function') return;
  try {
    log.event('telegram.send', fields);
  } catch {
    // logging must never break alerting
  }
}

function fit(text) {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  let cut = text.slice(0, MAX_MESSAGE_CHARS - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1); // do not split a surrogate pair
  return `${cut}…`;
}

const CLI_USAGE = `Usage: node src/ops/telegram.js [--level info|warn|error] [--dry-run] <text...>

  Sends "Кора: <text>" (warn/error: "[WARN] "/"[ERROR] " in front) to
  settings.telegram.alert_chat_id from the TELEGRAM_BOT_TOKEN bot.
  --dry-run   print the message and the target chat, send nothing
  Exit 0 delivered (or dry run), 1 not delivered, 64 bad usage.`;

/**
 * CLI entry point; returns the exit code. `send` and `out` are injectable for tests.
 * @param {string[]} argv
 */
export async function runCli(argv, { send = sendAlert, out = console } = {}) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        level: { type: 'string', default: 'info' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    out.error(`error: ${e.message}\n\n${CLI_USAGE}`);
    return 64;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out.log(CLI_USAGE);
    return 0;
  }
  const level = values.level.toLowerCase();
  if (!LEVELS.includes(level)) {
    out.error(`error: --level must be one of ${LEVELS.join('|')}\n\n${CLI_USAGE}`);
    return 64;
  }
  const text = positionals.join(' ').trim();
  if (!text) {
    out.error(`error: nothing to send\n\n${CLI_USAGE}`);
    return 64;
  }
  if (values['dry-run']) {
    let chat = '?';
    try {
      chat = loadSettings().telegram?.alert_chat_id ?? '?';
    } catch (e) {
      chat = `? (${e.message})`;
    }
    out.log(`dry run, chat ${chat}: ${formatAlert(text, level)}`);
    return 0;
  }
  const res = await send(text, { level });
  if (res.ok) {
    out.log(`telegram: delivered (attempts ${res.attempts}, message_id ${res.messageId})`);
    return 0;
  }
  out.error(`telegram: NOT delivered after ${res.attempts} attempt(s): ${res.error}`);
  return 1;
}

if (import.meta.main) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`telegram: ${redactSecrets(String(err?.message ?? err))}`);
      process.exitCode = 1;
    },
  );
}
