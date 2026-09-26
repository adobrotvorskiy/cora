// Telemost page driver (WP1): join flow, participants, active speaker, chat, leave.
//
// Selectors come from docs/telemost_dom.md (inspected 18.09.2026 on telemost.360.yandex.ru,
// viewport 640x480 = compact toolbar with the «Ещё» popover). Everything DOM-related is
// centralised in SEL so a Telemost redesign is a one-place fix. Hashed CSS-module classes
// (e.g. avatarWithNameBlock_AOhPP) are matched by prefix: [class*="avatarWithNameBlock"].
//
// API (all functions take a playwright Page):
//   join(page, url, displayName, opts)  -> {status: 'joined'|'waiting'|'denied'|'error', detail, tookMs}
//   getParticipants(page, {selfName})   -> [{name, isSelf, muted, cameraOn, speaking, source}]
//   watchParticipants(page, cb, {intervalMs=500}) -> stop()
//   watchActiveSpeaker(page, cb, {intervalMs=250}) -> stop()   cb(namesSpeaking[])
//   installObservers(page, cb)         -> stop()   MutationObserver-driven events {type:'participants'|'speaker'|'dom', ...}
//   setMic(page, on) / setCamera(page, on)
//   openMore(page) / clickMoreOption(page, title) / openParticipants(page) / openChat(page) / openSettings(page) / closePanels(page)
//   postChat(page, text)               -> {ok, detail}
//   watchChat(page, cb, {intervalMs})  -> stop()   cb({author, text})
//   leave(page)                        -> {ok, detail}

/** DOM selectors. */
export const SEL = {
  landing: {
    continueInBrowser: /продолжить в браузере/i, // button/link text
    continueInBrowserTid: '[data-testid="meeting-continue-in-browser-continue"]', // new landing (21.09 update)
  },
  prejoin: {
    name: '[data-testid="orb-textinput-input"]',
    // testid flips with state: turn-on-* when OFF, turn-off-* when ON (aria-label «Выключить микрофон»)
    mic: '[data-testid="turn-on-mic-button"], [data-testid="turn-off-mic-button"]',
    camera: '[data-testid="turn-on-camera-button"], [data-testid="turn-off-camera-button"]',
    enter: '[data-testid="enter-conference-button"]',
  },
  incall: {
    toolbar: '[class*="toolbar_"]',
    toolbarActive: '[class*="toolbarActive"]',
    mic: '[data-testid="turn-on-mic-button"], [data-testid="turn-off-mic-button"]',
    camera: '[data-testid="turn-on-camera-button"], [data-testid="turn-off-camera-button"]',
    share: '[data-testid="share-button"]',
    more: '[data-testid="more-popup-alt-button"], [data-testid="more-popup-button"]',
    morePopover: '[data-test-id="more-button-popover"]',
    moreOption: (title) => `[data-test-id="more-button-popover"] [title="${title}"]`,
    moreTitles: { participants: 'Участники', chat: 'Открыть чат', chatClose: 'Закрыть чат', settings: 'Открыть настройки', raiseHand: 'Поднять руку', speakerView: 'Вид докладчика' },
    leave: '[data-testid="end-call-alt-button"], [data-testid="end-call-button"]',
    leaveConfirm: null, // no confirmation dialog observed
    anyControl: '[data-testid="end-call-alt-button"], [data-testid="end-call-button"], [data-testid="more-popup-alt-button"], [class*="GoloomParticipantsRenderer"]',
    // tiles (grid)
    tilesRoot: '.GoloomParticipantsRenderer',
    tileBlock: '[class*="avatarWithNameBlock"]',         // sibling of the tile <video>; tile root = its parentElement
    tileName: '[class*="TextName"]',                     // span[title=<full name>]
    tileMutedIcon: '[data-testid="micro-off-icon"]',     // others: muted
    tileSelfMicButton: '[data-testid="mute-audio"]',     // own tile: mic control (aria-label «Выключить микрофон» when ON)
    tileStatuses: '[class*="participantStatuses"]',
    tilePlaceholder: '[data-testid="participant-video-placeholder"]',
    // Active speaker (S2, 18.09.2026): while a participant's audio is above Telemost's VAD threshold the
    // tile overlay div.root_* gets an extra class rootStroke_* (green outline); removed ~0.7 s after silence.
    // Measured on the listener: on = +390…430 ms after the host started the clip, off = +710 ms after clip end.
    speakingMarker: '[class*="rootStroke"]',
    // participants sidebar (opened via «Ещё» → Участники). At 640x480 it covers the whole viewport
    // (rowLayout): tiles + toolbar are hidden while it is open, close it with participantsClose.
    participantsPanel: '[class*="participantsSidebar"]',
    participantsClose: '[class*="participantsSidebar"] [aria-label="Закрыть раздел"]',
    participantsCount: '[class*="participantsCount"]',
    participantsSearch: '[class*="participantsSidebar"] input[data-testid="orb-textinput-input"]',
    participantItem: '[class*="participantsSidebar"] [class*="Participant_"]',
    participantTextData: '[class*="ParticipantTextData"]',
    participantRole: '[class*="ParticipantRole"]',                // «соорганизатор» / «организатор»
    participantStatusBlock: '[class*="ParticipantStatusBlock"]',
    participantMutedCtl: '[aria-label="Включить микрофон"]',     // in status block => participant is muted
    participantUnmutedCtl: '[aria-label="Выключить микрофон"]',  // => participant mic is on
    participantSelfMark: '[class*="CanModerate"]',               // own row carries CanModerate_*
    // chat: Yandex Messenger widget in a cross-origin iframe
    chatBlock: '[class*="chatBlock"]',
    chatClose: '[aria-label="Закрыть чат"]',
    chatIframe: 'iframe[data-messenger-iframe="true"], iframe.ya-chat-base__iframe',
    chatFrameUrl: /yandex\.ru\/chat/,
    chatInput: null,
    chatSend: null,
    chatMessage: null,
    // settings modal («Ещё» → «Открыть настройки»): left menu = role=menuitem, sections carry Orb switches
    settingsModal: '[data-testid="settings-modal"]',
    settingsMenuItem: (key) => `[data-testid="menu-item-${key}"]`, // Account | Sound | Camera | Help
    settingsClose: '[data-testid="settings-modal"] [data-testid="orb-button-close"]',
    settingsSwitchLabels: {
      hideIncomingVideo: 'Скрыть видео участников',       // Видео: «Снизит нагрузку на сеть» (S5 fallback)
      joinWithCameraOff: 'Подключаться с выключенной камерой',
      seeSelf: 'Видеть себя на встрече',
      noiseSuppression: 'Шумоподавление',                  // Звук → Дополнительно
      joinWithMicOff: 'Подключаться с выключенным микрофоном',
    },
    // popups
    dismissTexts: /^(отлично|понятно|хорошо|закрыть|позже|не сейчас)$/i,
    // Yandex cookie consent (appears depending on IP/geo, overlays the toolbar and swallows clicks)
    cookieBanner: '[class*="gdpr-popup-v3-main"], [id^="gdpr-popup"]',
    cookieEssential: '#gdpr-popup-v3-button-mandatory', // «Allow essential cookies» / «Только необходимые» — the privacy-preserving choice; never «Allow all»
  },
  texts: {
    waiting: /зал(е|а)? ожидания|ожидайте|организатор (впустит|подтвердит|скоро)|запрос(ил|ила)? (доступ|разрешение)|подождите, пока/i,
    denied: /только (для )?сотрудник|доступ (ограничен|запрещ)|нет доступа|не удалось подключиться|отклон(ил|ён|ена)/i,
    ended: /встреча (завершена|закончилась)|конференция завершена|вы вышли|покинули встречу|организатор завершил/i,
    notFound: /не найдена|не существует|неверная ссылка|ссылка недействительна/i,
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Toggles / pre-join
// ---------------------------------------------------------------------------

/** Read the on/off state of a mic/camera toggle (pre-join or in-call). */
export async function readToggle(page, selector) {
  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return { present: false };
  return loc.evaluate((el) => {
    const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '';
    const testid = el.getAttribute('data-testid') || '';
    let on = null;
    if (/turn-off/.test(testid)) on = true;
    else if (/turn-on/.test(testid)) on = false;
    else if (/^выключить/i.test(label)) on = true;
    else if (/^включить/i.test(label)) on = false;
    const r = el.getBoundingClientRect();
    return { present: true, on, label, testid, visible: r.width > 0 && r.height > 0, disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' };
  });
}

/** Click the toggle until it reports the desired state (max 2 attempts). */
export async function setToggle(page, selector, desired, log = () => {}) {
  let st = await readToggle(page, selector);
  log({ type: 'toggle.read', selector, ...st });
  if (!st.present) return st;
  for (let i = 0; i < 2 && st.on !== desired; i++) {
    if (!st.visible) await revealToolbar(page);
    await page.locator(selector).first().click({ timeout: 5000 }).catch((e) => log({ type: 'toggle.click.error', selector, error: String(e).slice(0, 200) }));
    await sleep(700);
    st = await readToggle(page, selector);
    log({ type: 'toggle.read', selector, attempt: i + 1, ...st });
  }
  return st;
}

export const setMic = (page, on, log) => setToggle(page, SEL.incall.mic, on, log);
export const setCamera = (page, on, log) => setToggle(page, SEL.incall.camera, on, log);

/** Page text (for state classification / diagnostics). */
export async function pageText(page, limit = 3000) {
  return page.evaluate((l) => (document.body?.innerText || '').replace(/\n{2,}/g, '\n').slice(0, l), limit).catch(() => '');
}

/**
 * The frame hosting the meeting app. Since the 21.09 Telemost update the whole meeting
 * (pre-join form AND the in-call UI) renders inside a /private-join/<id> iframe while the
 * top document stays a shell; before that it was the main document. Prefer a frame with
 * in-call controls, then one with the pre-join form; fall back to the main frame.
 */
export async function meetingFrame(page) {
  const frames = page.frames();
  for (const f of frames) {
    if ((await f.locator(SEL.incall.anyControl).count().catch(() => 0)) > 0) return f;
  }
  for (const f of frames) {
    if ((await f.locator(SEL.prejoin.enter).count().catch(() => 0)) > 0) return f;
  }
  return page.mainFrame();
}

/** Poll the frames until the pre-join form shows up; null on timeout (the bundle can be slow). */
async function waitPrejoinFrame(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const f of page.frames()) {
      if ((await f.locator(SEL.prejoin.name).count().catch(() => 0)) > 0) return f;
    }
    if (Date.now() > deadline) return null;
    await sleep(1000);
  }
}

/** Classify what the page currently shows, scanning every frame. */
export async function classifyState(page) {
  // NB: pass plain strings only — frame.evaluate cannot serialise functions/RegExps held in SEL.
  const out = [];
  for (const f of page.frames()) {
    const info = await f.evaluate(([prejoinSel, controlSel]) => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 4000);
      const has = (s) => { try { return !!document.querySelector(s); } catch { return false; } };
      return { text, prejoin: has(prejoinSel), control: has(controlSel), url: location.href };
    }, [SEL.prejoin.enter, SEL.incall.anyControl]).catch(() => null);
    if (info) out.push(info);
  }
  const t = (i) => i?.text || '';
  const by = (pred) => out.find(pred);
  const denied = by((i) => SEL.texts.denied.test(t(i)));
  if (denied) return { status: 'denied', detail: t(denied).slice(0, 300), url: denied.url };
  const gone = by((i) => SEL.texts.notFound.test(t(i)) || SEL.texts.ended.test(t(i)));
  if (gone) return { status: 'error', detail: t(gone).slice(0, 300), url: gone.url };
  const waiting = by((i) => SEL.texts.waiting.test(t(i)));
  if (waiting) return { status: 'waiting', detail: t(waiting).slice(0, 300), url: waiting.url };
  const joined = by((i) => i.control && !i.prejoin);
  if (joined) return { status: 'joined', detail: t(joined).slice(0, 200), url: joined.url };
  const prejoin = by((i) => i.prejoin);
  if (prejoin) return { status: 'prejoin', detail: t(prejoin).slice(0, 200), url: prejoin.url };
  const richest = [...out].sort((a, b) => t(b).length - t(a).length)[0];
  return { status: 'unknown', detail: t(richest).slice(0, 300), url: richest?.url ?? '' };
}

/**
 * Join a Telemost meeting as a guest.
 * @param {import('playwright-core').Page} page
 * @param {string} url  meeting link (…/j/<id>)
 * @param {string} displayName
 * @param {object} [opts]
 * @param {boolean} [opts.mic=true]       pre-join mic toggle
 * @param {boolean} [opts.camera=false]   pre-join camera toggle (true = avatar track from the page adapter)
 * @param {number} [opts.waitAdmissionMs=180000]  how long to sit in a waiting room
 * @param {number} [opts.timeoutMs=45000]
 * @param {(stage: string, extra?: object) => (void|Promise<void>)} [opts.onStage]  landing|prejoin|prejoin-ready|entering|waiting|joined|denied|error
 * @param {(e: object) => void} [opts.log]
 */
export async function join(page, url, displayName, opts = {}) {
  const { mic = true, camera = false, waitAdmissionMs = 180_000, timeoutMs = 45_000, onStage = async () => {}, log = () => {} } = opts;
  const t0 = Date.now();
  const stage = async (name, extra) => { log({ type: 'join.stage', stage: name, t: Date.now() - t0, ...extra }); await onStage(name, extra); };

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await stage('landing', { url: page.url() });

  // Landing (21.09 update): «Продолжить в браузере» opens the pre-join inside a
  // /private-join/<id> iframe; the form is not in the top document at all. The meeting
  // bundle can be slow to boot, so the form wait is longer than the navigation timeout.
  const continueBtn = page.locator(SEL.landing.continueInBrowserTid).first();
  const continueAlt = page.locator('button, a, [role="button"]').filter({ hasText: SEL.landing.continueInBrowser }).first();
  const formFrame = await (async () => {
    const deadline = Date.now() + Math.max(timeoutMs, 180_000); // the landing boot can be very slow
    let clicked = false;
    for (;;) {
      if (!clicked) {
        const btn = (await continueBtn.isVisible().catch(() => false)) ? continueBtn : (await continueAlt.isVisible().catch(() => false)) ? continueAlt : null;
        if (btn) { await btn.click().catch(() => {}); clicked = true; log({ type: 'join.landing.continue' }); }
      }
      const f = await waitPrejoinFrame(page, 0);
      if (f) return f;
      if (Date.now() > deadline) return null;
      await sleep(1000);
    }
  })();
  if (!formFrame) {
    const st = await classifyState(page);
    if (st.status === 'joined') { await stage('joined', st); return { ...st, tookMs: Date.now() - t0 }; }
    const detail = st.detail || (await pageText(page, 300));
    const status = st.status === 'denied' ? 'denied' : 'error';
    await stage(status, { detail });
    return { status, detail: `no pre-join form: ${detail}`, tookMs: Date.now() - t0 };
  }
  const scope = formFrame;
  const nameInput = scope.locator(SEL.prejoin.name);
  await stage('prejoin', { frame: formFrame.url().slice(0, 90) });
  await dismissCookieBanner(page, log); // the consent banner can already overlay the pre-join form
  await dismissCookieBanner(scope, log); // …and in the 21.09 layout it lives inside the /private-join frame

  await nameInput.click({ clickCount: 3 }).catch(() => {});
  await nameInput.fill(displayName);
  log({ type: 'join.name', typed: await nameInput.inputValue().catch(() => '') });

  const micState = await setToggle(scope, SEL.prejoin.mic, mic, log);
  const camState = await setToggle(scope, SEL.prejoin.camera, camera, log);
  await stage('prejoin-ready', { micState, camState });

  // Modals such as «Большое обновление в Телемосте» or «Включить видео не удалось … Понятно»
  // sit on top of the form and intercept the click on «Подключиться»; dismiss them first
  // (top document and the meeting frame alike) and again on retry.
  await dismissCookieBanner(page, log);
  await dismissCookieBanner(scope, log);
  await dismissPopups(page, log);
  await dismissPopups(scope, log);
  const enter = scope.locator(SEL.prejoin.enter).first();
  try {
    await enter.click({ timeout: 8_000 });
  } catch (e) {
    log({ type: 'join.enter.retry', error: String(e).slice(0, 120) });
    await dismissCookieBanner(page, log);
    await dismissCookieBanner(scope, log);
    await dismissPopups(page, log);
    await dismissPopups(scope, log);
    await enter.click({ timeout: 8_000 }).catch(() => enter.click({ timeout: 8_000, force: true }));
  }
  await stage('entering');

  const deadline = Date.now() + waitAdmissionMs;
  let sawWaiting = false;
  let last = null;
  while (Date.now() < deadline) {
    const callScope = await meetingFrame(page);
    await dismissCookieBanner(page, log);
    await dismissCookieBanner(callScope, log);
    await dismissPopups(page, log);
    await dismissPopups(callScope, log);
    const st = await classifyState(page);
    if (st.status !== last?.status) log({ type: 'join.state', ...st, detail: st.detail?.slice(0, 160) });
    last = st;
    if (st.status === 'joined') {
      await dismissPopups(page, log);
      await stage('joined', st);
      return { ...st, tookMs: Date.now() - t0, waited: sawWaiting };
    }
    if (st.status === 'denied' || st.status === 'error') { await stage(st.status, st); return { ...st, tookMs: Date.now() - t0 }; }
    if (st.status === 'waiting' && !sawWaiting) { sawWaiting = true; await stage('waiting', st); }
    await sleep(1000);
  }
  const status = sawWaiting ? 'waiting' : 'error';
  const res = { status, detail: sawWaiting ? `admission timeout after ${waitAdmissionMs} ms` : `no in-call UI detected: ${last?.detail || ''}`, tookMs: Date.now() - t0 };
  await stage(status, res);
  return res;
}

/**
 * Yandex cookie-consent banner (gdpr-popup-v3): pick «Allow essential cookies» — the privacy-preserving
 * option — never «Allow all». The choice is persisted in the profile, so it happens once per profile/geo.
 */
export async function dismissCookieBanner(page, log = () => {}) {
  const banner = page.locator(SEL.incall.cookieBanner).first();
  if (!(await banner.isVisible().catch(() => false))) return false;
  const btn = page.locator(SEL.incall.cookieEssential).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click({ timeout: 3000 }).catch(() => {});
    await sleep(500);
    log({ type: 'cookie.banner', action: 'essential-only', gone: !(await banner.isVisible().catch(() => false)) });
    return true;
  }
  log({ type: 'cookie.banner', action: 'no-essential-button', text: (await banner.innerText().catch(() => '')).slice(0, 200) });
  return false;
}

/** Dismiss informational popups (e.g. «Можно включить ИИ-конспект звонка» → «Отлично»). Never clicks consent/agree/start buttons. */
export async function dismissPopups(page, log = () => {}) {
  const clicked = await page.evaluate((reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const out = [];
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    for (const b of document.querySelectorAll('button')) {
      const t = (b.textContent || '').trim();
      if (t && re.test(t) && visible(b)) { b.click(); out.push(t); }
    }
    // an open orb-modal2 without a recognised text button: use its close (×) button
    for (const m of document.querySelectorAll('[data-testid="orb-modal2"]')) {
      if (!visible(m)) continue;
      const x = m.querySelector('[data-testid="orb-button-close"]');
      if (x && visible(x) && !out.length) { x.click(); out.push('×:' + ((m.textContent || '').trim().slice(0, 60))); }
    }
    return out;
  }, SEL.incall.dismissTexts.source).catch(() => []);
  if (clicked.length) log({ type: 'popup.dismissed', buttons: clicked });
  return clicked;
}

// ---------------------------------------------------------------------------
// Toolbar / popover navigation
// ---------------------------------------------------------------------------

/** Telemost hides the toolbar when idle; a mouse move over the bottom edge brings it back. Accepts a Page or a Frame. */
export async function revealToolbar(page) {
  const vp = page.viewportSize ? page.viewportSize() || { width: 640, height: 480 } : { width: 640, height: 480 };
  if (page.mouse) {
    await page.mouse.move(vp.width / 2, vp.height - 30).catch(() => {});
    await page.mouse.move(vp.width / 2 + 5, vp.height - 28).catch(() => {});
    const scope = await meetingFrame(page);
    await scope.locator(SEL.incall.toolbarActive).first().waitFor({ state: 'attached', timeout: 2000 }).catch(() => {});
  } else {
    await page.locator(SEL.incall.toolbarActive).first().waitFor({ state: 'attached', timeout: 2000 }).catch(() => {});
  }
}

export async function openMore(page) {
  const scope = await meetingFrame(page);
  const pop = scope.locator(SEL.incall.morePopover);
  if (await pop.count()) return true;
  await dismissCookieBanner(page);
  await revealToolbar(page);
  await scope.locator(SEL.incall.more).first().click({ timeout: 5000 });
  await pop.first().waitFor({ state: 'visible', timeout: 3000 });
  return true;
}

export async function closePopover(page) {
  const scope = await meetingFrame(page);
  if (await scope.locator(SEL.incall.morePopover).count()) {
    await page.keyboard.press('Escape').catch(() => {});
    await sleep(300);
  }
}

/** Open «Ещё» and click an option by its title attribute (e.g. «Участники»). */
export async function clickMoreOption(page, title) {
  await openMore(page);
  const opt = (await meetingFrame(page)).locator(SEL.incall.moreOption(title)).first();
  await opt.waitFor({ state: 'visible', timeout: 3000 });
  await opt.click({ timeout: 3000 });
  await sleep(500);
  return true;
}

export async function openParticipants(page) {
  const scope = await meetingFrame(page);
  if (await scope.locator(SEL.incall.participantsPanel).first().isVisible().catch(() => false)) return true;
  await closePanels(page);
  await clickMoreOption(page, SEL.incall.moreTitles.participants);
  await scope.locator(SEL.incall.participantsPanel).first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {});
  return true;
}
export async function closeParticipants(page) {
  const c = (await meetingFrame(page)).locator(SEL.incall.participantsClose).first();
  if (await c.isVisible().catch(() => false)) { await c.click({ timeout: 2000 }).catch(() => {}); await sleep(300); return true; }
  return false;
}
export async function openSettings(page) { await closePanels(page); return clickMoreOption(page, SEL.incall.moreTitles.settings); }
export async function openChat(page) {
  const scope = await meetingFrame(page);
  if (await scope.locator(SEL.incall.chatClose).first().isVisible().catch(() => false)) return true;
  await closePanels(page);
  await clickMoreOption(page, SEL.incall.moreTitles.chat);
  await scope.locator(SEL.incall.chatIframe).first().waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
  return true;
}

/**
 * Flip an Orb switch inside the settings modal by its label text (see SEL.incall.settingsSwitchLabels).
 * @param {'Camera'|'Sound'|'Account'} section  left-menu item
 * @param {string} label   visible label of the list item (e.g. «Скрыть видео участников»)
 * @param {boolean} desired
 * @returns {Promise<{found: boolean, before: boolean|null, after: boolean|null}>}
 */
export async function setSettingsSwitch(page, section, label, desired, { log = () => {} } = {}) {
  await openSettings(page);
  const scope = await meetingFrame(page);
  await scope.locator(SEL.incall.settingsMenuItem(section)).first().click({ timeout: 3000 }).catch(() => {});
  await sleep(500);
  const read = () => scope.evaluate(([modalSel, lbl]) => {
    const modal = document.querySelector(modalSel);
    if (!modal) return { found: false };
    const items = [...modal.querySelectorAll('[data-testid="orb-text"]')].filter((t) => (t.textContent || '').trim() === lbl);
    for (const t of items) {
      let el = t;
      for (let i = 0; i < 6 && el; i++) { const sw = el.querySelector('input[role="switch"]'); if (sw) return { found: true, on: sw.getAttribute('aria-checked') === 'true' || sw.checked === true }; el = el.parentElement; }
    }
    return { found: false };
  }, [SEL.incall.settingsModal, label]);
  const before = await read();
  if (!before.found) { log({ type: 'settings.switch', section, label, found: false }); await closePanels(page); return { found: false, before: null, after: null }; }
  if (before.on !== desired) {
    await scope.evaluate(([modalSel, lbl]) => {
      const modal = document.querySelector(modalSel);
      const t = [...modal.querySelectorAll('[data-testid="orb-text"]')].find((x) => (x.textContent || '').trim() === lbl);
      let el = t;
      for (let i = 0; i < 6 && el; i++) { const sw = el.querySelector('input[role="switch"]'); if (sw) { sw.click(); return; } el = el.parentElement; }
    }, [SEL.incall.settingsModal, label]);
    await sleep(500);
  }
  const after = await read();
  log({ type: 'settings.switch', section, label, before: before.on, after: after.on });
  await closePanels(page);
  return { found: true, before: before.on, after: after.on };
}

/** S5 fallback: «Скрыть видео участников» (stops decoding incoming video; lowers CPU/network). */
export const setHideIncomingVideo = (page, on = true, opts) => setSettingsSwitch(page, 'Camera', SEL.incall.settingsSwitchLabels.hideIncomingVideo, on, opts);

/** Close whatever panel/popover/modal is open (participants sidebar, chat, popover, modal). */
export async function closePanels(page) {
  await closePopover(page);
  await closeParticipants(page);
  const scope = await meetingFrame(page);
  const cc = scope.locator(SEL.incall.chatClose).first();
  if (await cc.isVisible().catch(() => false)) await cc.click({ timeout: 2000 }).catch(() => {});
  const mc = scope.locator('[data-testid="orb-button-close"]').first();
  if (await mc.isVisible().catch(() => false)) await mc.click({ timeout: 2000 }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(200);
}

// ---------------------------------------------------------------------------
// Participants / active speaker (tile grid)
// ---------------------------------------------------------------------------

/** Page-side tile reader; shared by getParticipants and the observers. */
function tilesReaderMain(sel, selfName) {
  // Tile structure (18.09.2026):
  //   div.item_*[.selfView_*]            grid item (own tile carries selfView_*)
  //     div                              position:relative wrapper
  //       video[data-g_track_*]          remote/local video
  //       div.root_*[.rootModerator_*]   overlay
  //         div[class*=avatarWithNameBlock] > placeholder + name (+ mute icon / own mic button)
  //         div[class*=participantStatuses]
  const blocks = [...document.querySelectorAll(sel.incall.tileBlock)];
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const cls = (el) => (el ? String(el.className || '') : '');
  return blocks.map((block) => {
    const overlay = block.parentElement;
    const wrapper = overlay ? overlay.parentElement : null;
    const item = wrapper ? wrapper.parentElement : null;
    const nameEl = block.querySelector(sel.incall.tileName);
    const name = norm(nameEl?.getAttribute('title') || nameEl?.textContent);
    const video = wrapper ? wrapper.querySelector(':scope > video') || wrapper.querySelector('video') : null;
    const selfBtn = block.querySelector(sel.incall.tileSelfMicButton);
    const isSelf = /selfView/i.test(cls(item)) || (selfName ? name === norm(selfName) : !!selfBtn);
    const mutedIcon = !!block.querySelector(sel.incall.tileMutedIcon);
    const selfMuted = selfBtn ? /^включить/i.test(selfBtn.getAttribute('aria-label') || '') : null;
    const muted = mutedIcon || (selfMuted === true);
    const cameraOn = !!(video && video.getAttribute('data-g_track_state') === 'live' && video.getAttribute('data-g_track_enabled') === 'true');
    const statusEls = overlay ? [...(overlay.querySelector(sel.incall.tileStatuses)?.querySelectorAll('*') || [])] : [];
    const statuses = statusEls.map((c) => c.getAttribute('data-testid') || c.getAttribute('aria-label') || String(c.className).slice(0, 40)).filter(Boolean);
    let speaking = null;
    if (sel.incall.speakingMarker) {
      try { speaking = [item, wrapper, overlay].some((el) => el && (el.matches(sel.incall.speakingMarker) || el.querySelector(sel.incall.speakingMarker))); } catch { speaking = null; }
    }
    const r = (item || overlay) ? (item || overlay).getBoundingClientRect() : { width: 0, height: 0 };
    return { name, isSelf, muted, cameraOn, speaking, statuses, itemClass: cls(item).slice(0, 120), overlayClass: cls(overlay).slice(0, 80), trackId: video ? video.getAttribute('data-g_track_id') || '' : '', visible: r.width > 0 && r.height > 0, source: 'tiles' };
  }).filter((p) => p.name);
}

/**
 * Participants as shown in the tile grid.
 * @param {import('playwright-core').Page} page
 * @param {{selfName?: string}} [opts]
 */
export async function getParticipants(page, { selfName } = {}) {
  const scope = await meetingFrame(page);
  return scope.evaluate(`(${tilesReaderMain.toString()})(${JSON.stringify(SEL)}, ${JSON.stringify(selfName || null)})`);
}

/**
 * Full roster from the participants sidebar (opens it if needed; leaves it open unless {close:true}).
 * The sidebar covers the tiles at 640x480, so callers should close it after reading.
 * @returns {Promise<{count: number|null, list: Array<{name, role, isSelf, muted}>}>}
 */
export async function getParticipantsFromPanel(page, { close = true } = {}) {
  await openParticipants(page);
  // plain-string subset: frame.evaluate cannot serialise SEL.incall.moreOption (a function)
  const s = SEL.incall;
  const sub = { participantsCount: s.participantsCount, participantItem: s.participantItem, participantTextData: s.participantTextData, participantRole: s.participantRole, participantStatusBlock: s.participantStatusBlock, participantMutedCtl: s.participantMutedCtl, participantUnmutedCtl: s.participantUnmutedCtl, participantSelfMark: s.participantSelfMark };
  const res = await (await meetingFrame(page)).evaluate((sel) => {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const countEl = document.querySelector(sel.participantsCount);
    const count = countEl ? Number(norm(countEl.textContent)) || null : null;
    const list = [...document.querySelectorAll(sel.participantItem)].map((it) => {
      const td = it.querySelector(sel.participantTextData);
      const roleEl = td ? td.querySelector(sel.participantRole) : null;
      const role = norm(roleEl?.textContent) || null;
      let name = norm(td?.textContent);
      if (role && name.endsWith(role)) name = norm(name.slice(0, -role.length));
      const status = it.querySelector(sel.participantStatusBlock);
      const muted = status ? (!!status.querySelector(sel.participantMutedCtl) ? true : (!!status.querySelector(sel.participantUnmutedCtl) ? false : null)) : null;
      return { name, role, isSelf: it.matches(sel.participantSelfMark) || !!it.querySelector(sel.participantSelfMark), muted, source: 'panel' };
    }).filter((p) => p.name);
    return { count, list };
  }, sub);
  if (close) await closeParticipants(page);
  return res;
}

/** Poll participants; cb(list) on change. Returns stop(). */
export function watchParticipants(page, cb, { intervalMs = 500, selfName } = {}) {
  let prev = '';
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const list = await getParticipants(page, { selfName });
      const key = JSON.stringify(list.map((p) => [p.name, p.muted, p.cameraOn, p.speaking]));
      if (key !== prev) { prev = key; cb(list); }
    } catch (e) { /* page navigating */ }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  tick();
  return () => { stopped = true; };
}

/** Poll the speaking marker; cb(namesSpeaking[]) on change. Returns stop(). */
export function watchActiveSpeaker(page, cb, { intervalMs = 250 } = {}) {
  if (!SEL.incall.speakingMarker) throw new Error('watchActiveSpeaker: SEL.incall.speakingMarker not discovered yet');
  let prev = '';
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const list = await getParticipants(page);
      const names = list.filter((p) => p.speaking).map((p) => p.name);
      const key = names.join('|');
      if (key !== prev) { prev = key; cb(names); }
    } catch (e) { /* ignore */ }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  tick();
  return () => { stopped = true; };
}

/**
 * MutationObserver-driven observers (preferred over polling): one exposeFunction callback per page.
 * Emits {type:'participants', list} and {type:'speaker', names} on change, coalesced to ~100 ms.
 * Since the 21.09 Telemost update the call (and its tiles) lives in the /private-join/ iframe, so the
 * observer runs in meetingFrame(); a watchdog re-installs it when that frame is replaced.
 * Returns stop().
 */
export async function installObservers(page, cb, { selfName, recheckMs = 5000 } = {}) {
  const fnName = '__tmObserverCb';
  if (!page.__tmObserverInstalled) {
    await page.exposeFunction(fnName, (ev) => { try { cb(ev); } catch (e) { /* consumer error */ } });
    page.__tmObserverInstalled = true;
  }
  let frame = await installObserverScript(page, fnName, selfName);
  let stopped = false;
  const watchdog = setInterval(async () => {
    if (stopped) return;
    try {
      const alive = frame && !frame.isDetached() && (await frame.evaluate(() => Boolean(window.__tmObs)).catch(() => false));
      if (!alive && !stopped) frame = await installObserverScript(page, fnName, selfName);
    } catch { /* page navigating or closed */ }
  }, recheckMs);
  watchdog.unref?.();
  return async () => {
    stopped = true;
    clearInterval(watchdog);
    await frame?.evaluate(() => { if (window.__tmObs) { window.__tmObs.disconnect(); window.__tmObs = null; } }).catch(() => {});
  };
}

async function installObserverScript(page, fnName, selfName) {
  const frame = await meetingFrame(page);
  await frame.evaluate(`(() => {
    const reader = ${tilesReaderMain.toString()};
    const sel = ${JSON.stringify(SEL)};
    const selfName = ${JSON.stringify(selfName || null)};
    if (window.__tmObs) window.__tmObs.disconnect();
    let prevP = '', prevS = '', timer = null;
    const emit = () => {
      timer = null;
      let list; try { list = reader(sel, selfName); } catch (e) { return; }
      const kp = JSON.stringify(list.map((p) => [p.name, p.muted, p.cameraOn, p.visible]));
      if (kp !== prevP) { prevP = kp; window.${fnName}({ type: 'participants', t: Date.now(), list }); }
      const names = list.filter((p) => p.speaking).map((p) => p.name);
      const ks = names.join('|');
      if (ks !== prevS) { prevS = ks; window.${fnName}({ type: 'speaker', t: Date.now(), names }); }
    };
    const mo = new MutationObserver(() => { if (!timer) timer = setTimeout(emit, 100); });
    mo.observe(document.body, { attributes: true, childList: true, subtree: true, characterData: true });
    window.__tmObs = mo;
    emit();
  })()`);
  return frame;
}

// ---------------------------------------------------------------------------
// Chat (Yandex Messenger iframe)
// ---------------------------------------------------------------------------

export function chatFrame(page) {
  return page.frames().find((f) => SEL.incall.chatFrameUrl.test(f.url())) || null;
}

/** Post a message to the meeting chat. Requires SEL.incall.chatInput (filled after S1 chat inspection). */
export async function postChat(page, text, { log = () => {} } = {}) {
  await openChat(page);
  const frame = chatFrame(page);
  if (!frame) return { ok: false, detail: 'chat iframe not found' };
  if (!SEL.incall.chatInput) return { ok: false, detail: 'chat input selector not discovered yet' };
  const input = frame.locator(SEL.incall.chatInput).first();
  await input.waitFor({ state: 'visible', timeout: 10_000 });
  await input.click();
  await input.fill(text).catch(async () => { await input.type(text); });
  if (SEL.incall.chatSend) await frame.locator(SEL.incall.chatSend).first().click({ timeout: 3000 }).catch(() => frame.locator(SEL.incall.chatInput).first().press('Enter'));
  else await input.press('Enter');
  log({ type: 'chat.posted', text });
  return { ok: true, detail: 'sent' };
}

/** Poll chat messages inside the iframe; cb({author, text}) for each new message. Returns stop(). */
export function watchChat(page, cb, { intervalMs = 500 } = {}) {
  if (!SEL.incall.chatMessage) throw new Error('watchChat: SEL.incall.chatMessage not discovered yet');
  const seen = new Set();
  let stopped = false;
  let primed = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const frame = chatFrame(page);
      if (frame) {
        const msgs = await frame.evaluate((sel) => [...document.querySelectorAll(sel.chatMessage)].map((m) => ({
          id: m.getAttribute('data-message-id') || m.id || (m.textContent || '').slice(0, 80),
          author: (sel.chatAuthor && m.querySelector(sel.chatAuthor)?.textContent || '').trim(),
          text: (sel.chatText && m.querySelector(sel.chatText)?.textContent || m.textContent || '').trim().slice(0, 500),
        })), { chatMessage: SEL.incall.chatMessage, chatAuthor: SEL.incall.chatAuthor, chatText: SEL.incall.chatText });
        for (const m of msgs) { if (!seen.has(m.id)) { seen.add(m.id); if (primed) cb(m); } }
        primed = true;
      }
    } catch (e) { /* frame navigating */ }
    if (!stopped) setTimeout(tick, intervalMs);
  };
  tick();
  return () => { stopped = true; };
}

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

export async function leave(page, { log = () => {} } = {}) {
  await closePanels(page).catch(() => {});
  await dismissCookieBanner(page, log);
  await dismissCookieBanner(await meetingFrame(page), log);
  await revealToolbar(page);
  const scope = await meetingFrame(page);
  const btn = scope.locator(SEL.incall.leave).first();
  if ((await btn.count()) === 0) return { ok: false, detail: 'leave button not found' };
  await btn.click({ timeout: 5000 });
  await sleep(800);
  if (SEL.incall.leaveConfirm) {
    const c = scope.locator(SEL.incall.leaveConfirm).first();
    if (await c.count()) await c.click({ timeout: 5000 }).catch(() => {});
  }
  await sleep(1000);
  const st = await classifyState(page);
  log({ type: 'leave.state', ...st, detail: st.detail?.slice(0, 160) });
  return { ok: st.status !== 'joined', detail: st.detail?.slice(0, 200), url: st.url };
}
