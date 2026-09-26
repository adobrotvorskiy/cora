// Browser launcher for the standup host (WP1).
//
// One installed Chrome (channel 'chrome'), one persistent profile per guest
// (profile/host, profile/guest1, ...), headful but parked off-screen, audio output
// muted. The page adapter (WP2 page_inject.js) is injected via `initScript`.
//
// Usage:
//   const { context, page, close } = await launchBrowser({ profileDir: 'profile/host', initScript });
//   ...
//   await close();

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Origins Telemost serves the call UI from (test rooms live on the 360 host). */
export const TELEMOST_ORIGINS = [
  'https://telemost.yandex.ru',
  'https://telemost.360.yandex.ru',
];

/** Chrome switches we always pass (see PLAN.md S5). */
export const BASE_ARGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--use-fake-ui-for-media-stream',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble',
  '--lang=ru-RU',
  // Chrome 152 reports navigator.webdriver=true under remote debugging even without
  // --enable-automation; this switch turns it off (Yandex front-ends may sniff it).
  '--disable-blink-features=AutomationControlled',
];

/**
 * @param {object} [opts]
 * @param {string} [opts.profileDir='profile/host']  user-data-dir (relative to scripts/standup_host or absolute)
 * @param {boolean} [opts.offscreen=true]            park the window at --window-position=-2400,0
 * @param {[number, number]} [opts.viewport=[640,480]]
 * @param {string|Function|{path?:string,content?:string}} [opts.initScript]  passed to context.addInitScript
 * @param {string} [opts.executablePath]             override Chrome binary (default: channel 'chrome')
 * @param {string[]} [opts.extraArgs=[]]
 * @param {string[]} [opts.origins=TELEMOST_ORIGINS]  origins to grant microphone+camera to
 * @param {boolean} [opts.headless=false]
 * @param {number} [opts.timeoutMs=60000]
 * @param {(e: object) => void} [opts.log]           optional logger for {type, ...} events
 * @returns {Promise<{context: import('playwright-core').BrowserContext, page: import('playwright-core').Page, userDataDir: string, close: () => Promise<void>}>}
 */
export async function launchBrowser(opts = {}) {
  const {
    profileDir = 'profile/host',
    offscreen = true,
    viewport = [640, 480],
    initScript,
    executablePath,
    extraArgs = [],
    origins = TELEMOST_ORIGINS,
    headless = false,
    timeoutMs = 60_000,
    muteAudio = true, // false = let sound reach the real speakers (acoustic smoke guests)
    log = () => {},
  } = opts;

  const userDataDir = path.isAbsolute(profileDir) ? profileDir : path.join(ROOT, profileDir);
  fs.mkdirSync(userDataDir, { recursive: true });
  const stray = killStrayChrome(userDataDir);
  if (stray.killed.length) log({ type: 'browser.stray.killed', pids: stray.killed });

  const [width, height] = viewport;
  const args = [
    ...(muteAudio ? BASE_ARGS : BASE_ARGS.filter((a) => a !== '--mute-audio')),
    `--window-size=${width},${height}`,
    ...(offscreen ? ['--window-position=-2400,0'] : []),
    ...extraArgs,
  ];

  const launchOpts = {
    headless,
    args,
    // Keep navigator.webdriver=false: Yandex front-ends sometimes sniff it.
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width, height },
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    permissions: ['microphone', 'camera'],
    bypassCSP: true, // WP2 page adapter loads its AudioWorklet from a Blob URL (Telemost CSP would block it)
    timeout: timeoutMs,
    handleSIGINT: false, // the host process owns Ctrl+C (kill switch); we close explicitly
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
  };

  log({ type: 'browser.launch', userDataDir, args, headless, viewport });
  const context = await chromium.launchPersistentContext(userDataDir, launchOpts);

  // Permissions per origin (the context-level `permissions` option applies to all origins,
  // this is belt and braces for the two Telemost hosts).
  for (const origin of origins) {
    try {
      await context.grantPermissions(['microphone', 'camera'], { origin });
    } catch (e) {
      log({ type: 'browser.permissions.error', origin, error: String(e) });
    }
  }

  if (initScript) {
    await context.addInitScript(initScript);
  }

  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(timeoutMs);

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    log({ type: 'browser.close' });
    // context.close() on a persistent context shuts the browser down; guard against hangs.
    await Promise.race([
      context.close().catch((e) => log({ type: 'browser.close.error', error: String(e) })),
      new Promise((r) => setTimeout(r, 10_000)),
    ]);
    const browser = context.browser?.();
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
  }

  context.on('close', () => {
    closed = true;
    log({ type: 'browser.closed' });
  });

  return { context, page, userDataDir, close };
}

/**
 * Kill chrome.exe processes still holding this user-data-dir (a previous run that was SIGKILLed
 * leaves the whole tree alive — and the bot sitting in the meeting). Windows only; no-op elsewhere.
 * @param {string} userDataDir absolute path
 * @returns {{killed: number[]}}
 */
export function killStrayChrome(userDataDir) {
  if (process.platform !== 'win32') return { killed: [] };
  const needle = userDataDir.replace(/\//g, '\\');
  const script = `$n = ${JSON.stringify(needle)}; $ps = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($n, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }; $ids = @($ps | ForEach-Object { $_.ProcessId }); foreach ($i in $ids) { Stop-Process -Id $i -Force -ErrorAction SilentlyContinue }; $ids -join ','`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20_000, windowsHide: true }).trim();
    const killed = out ? out.split(',').map(Number).filter(Boolean) : [];
    if (killed.length) { const t = Date.now() + 1500; while (Date.now() < t) { /* let the OS release the profile lock */ } }
    return { killed };
  } catch (e) {
    return { killed: [], error: String(e).slice(0, 200) };
  }
}

/**
 * Helper for tools: save a screenshot under _internal/ (gitignored).
 * @param {import('playwright-core').Page} page
 * @param {string} name
 * @param {string} [dir]
 */
export async function snap(page, name, dir = path.join(ROOT, '_internal')) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false, timeout: 10_000 });
  } catch (e) {
    return null;
  }
  return file;
}

export { ROOT };
