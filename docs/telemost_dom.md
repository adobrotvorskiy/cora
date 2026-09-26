# Telemost DOM: селекторы и поведение (спайки S0/S1/S2/S5)

Снято 18.09.2026 в тест-комнате `telemost.360.yandex.ru/j/0372…522`, Chrome 152 + playwright-core 1.63,
viewport 640×480 (компактный тулбар с попапом «Ещё»). Все селекторы собраны в `SEL` в
`src/browser/telemost.js`; сырые дампы — `_internal/inspect_*/` (gitignored).

Хешированные CSS-module классы (`avatarWithNameBlock_AOhPP`) матчим по префиксу:
`[class*="avatarWithNameBlock"]`. `data-testid` — стабильнее всего.

## S0. Вход гостем

| Шаг | Что видим | Селектор / действие |
|---|---|---|
| Лендинг | «Вы подключаетесь к видеовстрече» | кнопка/ссылка с текстом «Продолжить в браузере» (`locator('button, a').filter({hasText: /продолжить в браузере/i})`) |
| Pre-join, имя | input с дефолтом «Гость» | `[data-testid="orb-textinput-input"]` → `fill(name)` |
| Pre-join, микрофон | по умолчанию ВКЛ | `[data-testid="turn-off-mic-button"]` (когда включён; aria-label «Выключить микрофон»), `[data-testid="turn-on-mic-button"]` (когда выключен). **testid меняется вместе с состоянием.** |
| Pre-join, камера | по умолчанию ВКЛ | `[data-testid="turn-off-camera-button"]` / `[data-testid="turn-on-camera-button"]`, aria-label «Выключить камеру»/«Включить камеру» |
| Войти | «Подключиться» | `[data-testid="enter-conference-button"]` |
| Результат | в тест-комнате — **мгновенный вход, без зала ожидания и ограничений** | вход занял ~21 с от `goto` (лендинг грузится ~10 с) |
| После входа | попап «Можно включить ИИ-конспект звонка… Отлично» | `dismissPopups()` кликает кнопку с текстом «Отлично» |

getUserMedia Телемост вызывает один раз для аудио+видео:
`{"audio":{"autoGainControl":{"ideal":true},"channelCount":{"exact":1},"echoCancellation":{"ideal":true},"noiseSuppression":{"ideal":true},"deviceId":{"exact":"<id>"}},"video":{"height":{"ideal":720}}}`
— наш override (WP2 `page_inject.js`, здесь `buildFakeMediaScript`) отдаёт audio-трек из `MediaStreamAudioDestinationNode`
и video-трек из `canvas.captureStream(15)` 640×480; оба приняты, `enumerateDevices` подменён (fake mic + fake cam + реальные audiooutput).

Состояния, которые распознаёт `classifyState()` по тексту страницы: `waiting` (зал ожидания), `denied`
(«только для сотрудников», «нет доступа»), `error` (встреча завершена / не найдена), `joined` (есть тулбар/кнопка выхода).
Зал ожидания и org-only в тест-комнате не воспроизводятся — регэкспы в `SEL.texts` предположительные, проверить на боевой комнате.

## S1. In-call

### Тулбар (640×480, класс `toolbar_*`, скрывается при бездействии → `revealToolbar()` двигает мышь к нижнему краю)

| Кнопка | Селектор | aria-label / title |
|---|---|---|
| Пригласить | `[data-testid="share-button"]` | «Пригласить на встречу» |
| Микрофон | `[data-testid="turn-off-mic-button"]` / `turn-on-mic-button` | «Выключить/Включить микрофон» |
| Камера | `[data-testid="turn-off-camera-button"]` / `turn-on-camera-button` | «Выключить/Включить камеру» |
| ИИ-конспект | `[data-testid="orb-button"][aria-label="Запустить ИИ-конспект"]` (disabled для гостя) | |
| Ещё | `[data-testid="more-popup-alt-button"]` | «Ещё» |
| Выйти | `[data-testid="end-call-alt-button"]` | «Выйти из встречи»; **без подтверждения**, страница уходит на `telemost.yandex.ru/` |

### Попап «Ещё» (`[data-test-id="more-button-popover"]`, `[data-testid="orb-popover"]`, role=dialog)

Пункты — `div.option_*[title="…"]`: «Записать на Яндекс Диск», «Записать на компьютер», «Поднять руку»,
«Вид докладчика», «Начать демонстрацию экрана», **«Участники»** (с бейджем-счётчиком `div.badge_*`),
**«Открыть чат»**, **«Открыть настройки»**. Клик: `[data-test-id="more-button-popover"] [title="Участники"]`.
Закрыть попап — `Escape`.

### Cookie-баннер Яндекса (важно!)

В части сессий (зависит от IP/гео: с прокси показывается английский `gdpr-popup-v3`) поверх тулбара
появляется баннер «Yandex uses cookies … Allow all / Allow essential cookies / Settings». Он **перехватывает
клики по тулбару** (все `click()` по «Ещё»/«Выйти» падают по таймауту). `dismissCookieBanner()` нажимает
`#gdpr-popup-v3-button-mandatory` («Allow essential cookies» — только необходимые, вариант с минимумом
cookies; «Allow all» не нажимаем никогда). Выбор сохраняется в профиле. Вызывается из `join()`, `openMore()`, `leave()`.

### Плитки участников (grid)

Контейнер `.GoloomParticipantsRenderer`. Точная структура (из `outer_tiles.html`):

```
div.item_*.newGridItem_*[.selfView_*]            ← элемент сетки; СВОЯ плитка несёт класс selfView_*
  div (position:relative)
    video[data-g_track_id][data-g_track_muted][data-g_track_enabled][data-g_track_state=live]   (свой — transform: scaleX(-1))
    div.root_*[.rootModerator_*]                 ← оверлей
      div[class*="avatarWithNameBlock"]
        div[data-testid="participant-video-placeholder"] > div[class*="AvatarBlock"] (> div[class*="Avatar"] с инициалами, когда видео нет)
        div[class*="participantName"] > div[class*="Name"] > span[class*="TextName"][title="<полное имя>"]
            + (чужой, mute)  svg[data-testid="micro-off-icon"]
            + (свой)         button[data-testid="mute-audio"][aria-label="Выключить микрофон"|"Включить микрофон"]
      div[class*="participantStatuses"]          (пустой в тишине; см. active speaker)
```

`getParticipants(page, {selfName})` читает от `[class*="avatarWithNameBlock"]` вверх (overlay → wrapper → item):
`[{name, isSelf, muted, cameraOn, speaking, statuses, itemClass, trackId}]`,
`isSelf` = `selfView_*` на item (или совпадение имени), `cameraOn` = `data-g_track_state=live && data-g_track_enabled=true`.
Плитка без видео: `data-g_track_*=""`.

### Панель «Участники» (sidebar)

«Ещё» → «Участники» открывает `div[class*="participantsSidebar"]`. **При 640×480 она занимает весь viewport**
(`rowLayout_*` на корне): плитки и тулбар под ней недоступны, пока не нажать `[aria-label="Закрыть раздел"]`
(`closeParticipants()` / `closePanels()`). Структура:

```
div[class*="participantsSidebar"]
  button[aria-label="Закрыть раздел"]                       (612,0 — правый верхний угол)
  div[class*="participantsCount"] "2"                       (счётчик)
  input[data-testid="orb-textinput-input"][aria-label="Имя"]  (поиск; тот же testid, что у имени в pre-join!)
  div[class*="Participant_"][.CanModerate_*]                (строка; CanModerate_* = своя)
    div[class*="ParticipantData"] > аватар + div[class*="ParticipantTextData"] (имя + span[class*="ParticipantRole"] «соорганизатор»)
    div[class*="ParticipantStatusBlock"]
        [aria-label="Включить микрофон"]   → участник в mute
        [aria-label="Выключить микрофон"]  → микрофон включён (у себя — button[data-testid="turn-on-mic-button"], скрыт до hover)
  внизу: share-link-{tg,whatsapp,messenger,slack}-button + copyButton_*
```

`getParticipantsFromPanel(page)` → `{count, list:[{name, role, isSelf, muted}]}` — полный ростер (список
прокручивается, не пагинируется, в отличие от плиток). Сергей в тест-комнате — «соорганизатор».

### Медиа-элементы

Входящий звук — по одному `<audio class="goloom_mid_audio" id="goloom_midaudio_<mid>_<sessionId>">` на mid
(«AA», «AB», …), `srcObject` с одним audio-треком: **SFU отдаёт звук отдельными треками по слотам** (не микс) —
важно для S3/атрибуции (WP2). `<video>` плиток: `data-g_track_id` = id трека.

### Чат

Кнопка «Ещё» → «Открыть чат» показывает `div[class*="chatBlock"]` с кнопкой `[aria-label="Закрыть чат"]` и
**кросс-доменным iframe** Яндекс Мессенджера `iframe[data-messenger-iframe="true"]`
(`https://yandex.ru/chat?config=production&build=telemost&parentOrigin=…`). Доступ через `page.frames()` (`chatFrame(page)`).

**Для анонимного гостя чат встречи недоступен**: через 4 с после открытия iframe показывает только пустое
состояние мессенджера «Выберите чат, в который хотите написать» (без ленты сообщений и поля ввода; в DOM основной
страницы — скрытый блок «Не удалось загрузить чат / Попробовать ещё раз»). Нужен Яндекс ID. Поэтому
`SEL.incall.chatInput/chatMessage = null`, `postChat()` возвращает `{ok:false}`, `watchChat()` бросает
`not discovered`. Чат в MVP не входит (PLAN §8); при необходимости — профиль с ручным логином под Яндекс ID
(тогда селекторы внутри iframe снимать заново).

### Active speaker (найден в S2 по логу мутаций слушателя)

Единственное изменение DOM, когда участник говорит: оверлей плитки `div.root_*` получает класс **`rootStroke_*`**
(зелёная обводка плитки); при тишине класс снимается. Никаких `aria-*`/`data-*`/индикаторов уровня нет;
`div[class*="participantStatuses"]` остаётся пустым. Селектор: `SEL.incall.speakingMarker = '[class*="rootStroke"]'`,
проверяется на оверлее плитки (`tilesReaderMain`), имя — из `span[class*="TextName"][title]` той же плитки.

Тайминги (слушатель, 3 повтора клипа 3,2 с): класс появляется через **+429 / +388 / +401 мс** после старта
воспроизведения у хоста и снимается через **+719 / +719 / +707 мс** после конца клипа (в клипе ~0,4 с хвостовой
тишины, т.е. ≈1,1 с после реального конца звука). `watchActiveSpeaker(page, cb)` — polling 250 мс,
`installObservers(page, cb)` — MutationObserver с коалесцией 100 мс, события `{type:'speaker', names[]}`.
Индикатор ведёт себя как VAD с hangover ≈0,7–1,1 с: для floor-контроллера годится как подтверждение «кто», не как
момент конца реплики (см. PLAN §3 — конец реплики по тишине/closer).

### Настройки («Ещё» → «Открыть настройки», `[data-testid="settings-modal"]`)

Левое меню — `[data-testid="menu-item-Account|Sound|Camera|Help"]` (role=menuitem, не tabs). Секции:

| Секция | Элементы |
|---|---|
| Аккаунт | «Войдите с Яндекс ID» + `[data-testid="sign-in-button"]` — гость не залогинен |
| Звук | select «Микрофон» (Kora virtual microphone), «Проверить», switch «Подключаться с выключенным микрофоном», select «Динамик», **Дополнительно → switch «Шумоподавление»** (вкл. по умолчанию: клиентское шумодавление Телемоста поверх Chrome APM — синтетическую речь SAPI пропустило) |
| Видео | select «Камера» (`[data-testid="orb-select2"][aria-label="Камера"]`, Kora virtual camera), switch «Подключаться с выключенной камерой» (off), switch «Видеть себя на встрече» (on), **switch «Скрыть видео участников» — «Снизит нагрузку на сеть»** (S5 fallback: не декодировать входящее видео) |

Все switch — `input[role="switch"][aria-checked]` внутри `Orb-ListItem`; `setSettingsSwitch(page, section, label, on)`
находит его по тексту лейбла, `setHideIncomingVideo(page, true)` — обёртка для «Скрыть видео участников».
Закрыть модалку: `[data-testid="orb-button-close"]` / Escape.

## S2. Микрофон и аватар через реальный Телемост (`tools/telemost_spike.js`, 18.09 16:41, run `_internal/spike_2026-09-18T16-41-00`)

Два гостя в тест-комнате: хост «Кора (ИИ-ведущая)» (fake mic + canvas-аватар `assets/avatar.png`), слушатель
«Тест-слушатель» (fake mic, камера выкл.; хук `RTCPeerConnection` → `AnalyserNode` на удалённых аудиотреках, RMS 50 мс).
Клип: SAPI «Microsoft Irina Desktop», «Это тест бота, не обращайте внимания», 3,23 с, 48 кГц, 3 повтора с паузой 2,5 с.

| Метрика | Результат |
|---|---|
| Вход хоста / слушателя | joined за 12,9 с / 14,6 с, без зала ожидания |
| getUserMedia хоста | `{audio:{echoCancellation, noiseSuppression, autoGainControl, channelCount:1, deviceId}, video:{width:1280, height:720, frameRate:24 (ideal)}}` — принял 640×480@15 канвас без applyConstraints-ошибок |
| Слушатель слышит хоста | да: RMS удалённого трека **0,0296 / 0,0287 / 0,0291 (среднее), пик 0,108–0,117** при базе **0,0** (порог 0,004); второй аудиотрек (Сергей, mute) = 0 |
| Латентность play → энергия у слушателя | **341 / 332 / 361 мс** (тот же ПК, общий wall-clock) |
| Конец звука у слушателя | за 443 / 403 / 423 мс до `endedAt` (хвостовая тишина клипа) |
| WebRTC | хост `media-source` audio `totalAudioEnergy` 0,557 (микрофон реально питает sender); слушатель `inbound-rtp` audio 90 КБ/1443 пакета, `totalAudioEnergy` 0,41 |
| Индикатор «говорит» у слушателя | `rootStroke_*` на плитке Коры: on **+429/+388/+401 мс**, off +719/+719/+707 мс после конца клипа (см. выше) |
| Аватар у слушателя | плитка Коры получает live video-трек (`data-g_track_state=live`, `enabled=true`), декодируется **320×240 @ 2 fps** (SFU отдаёт нижний слой simulcast `L2T3_KEY`), средний цвет [42,46,66], центр [69,51,47] — картинка, не чёрное; скриншоты `listener_view_avatar.png`, `listener_kora_tile.png` |
| Своя плитка хоста | `cameraOn:true`, `data-g_track_*` live, превью `transform: scaleX(-1)` |

Наблюдения/quirks:
- **Призрак после аварийного выхода:** после `kill` процесса Chrome участник остаётся в комнате несколько минут
  («Загружаем видео», без треков). При повторном входе в сетке две «Кора (ИИ-ведущая)» (см. скриншот). Roster-логике
  дедуплицировать по имени и предпочитать плитку с треком; `launch.js` теперь убивает «свои» chrome.exe по user-data-dir
  перед стартом; штатный выход — только через `leave()`.
- Модалка «Включить видео не удалось … Понятно» появляется, если video-запрос отклонён (`NotFoundError`), и
  перехватывает клик по «Подключиться»: `join()` вызывает `dismissPopups()` перед кликом и на ретрае. Слушателю проще
  дать fake-камеру и выключить её тумблером в pre-join.
- Собственную камеру хост выключает/включает `[data-testid="turn-off/on-camera-button"]` в тулбаре (`setCamera`);
  трек при этом `enabled=false`, upload video → 0.
- Размытие фона в настройках гостя не обнаружено (нет пункта), мешать не должно.

## S5. CPU / память / канал (тот же прогон, 2 фазы по 30 с; Intel Core Ultra 7 155H, 22 лог. ядер, Chrome 152, окно 640×480 за экраном, `--mute-audio`)

| Фаза | Chrome хоста, % одного ядра (renderer / GPU / audio / net) | % машины | RSS / private, МБ (9 проц.) | Upload video / audio, кбит/с | Chrome слушателя |
|---|---|---|---|---|---|
| Камера ВКЛ (аватар 640×480, ~2 fps) | **57,7** (28,8 / 23,2 / 2,2 / 3,0) | 2,6 | 1240 / 933 | **278,5** / 12,8 (`L2T3_KEY`, 289 кадров) | 56,2 % |
| Камера ВЫКЛ | **52,6** (25,2 / 22,8 / 2,2 / 2,1) | 2,4 | 1225 / 916 | **0** / 12,8 | 54,1 % |

- Аватар стоит ≈5 % одного ядра и ≈280 кбит/с исходящего (кодер шлёт 2 spatial-слоя даже для статичной картинки).
- В 2-местной комнате основная нагрузка — renderer + GPU (композиция окна и декод 1 входящего видео).
  В боевой комнате с 12–15 видео вырастет декод → fallback **«Скрыть видео участников»** (`setHideIncomingVideo`)
  или `direction='inactive'` на video-receiver'ах (PLAN S5). Замер с 12+ видео не делали (нет участников).
- Метод: CDP `SystemInfo.getProcessInfo` (cpuTime по процессам Chrome, Δ за 30 с), память — `Get-Process` по PID.

## API `src/browser/telemost.js`

```
join(page, url, displayName, {mic=true, camera=false, waitAdmissionMs=180000, timeoutMs=45000, onStage, log})
  -> {status:'joined'|'waiting'|'denied'|'error', detail, url, tookMs, waited}
classifyState(page) -> {status: joined|waiting|denied|error|prejoin|unknown, detail, url}
dismissCookieBanner(page, log) / dismissPopups(page, log)
getParticipants(page, {selfName}) -> [{name, isSelf, muted, cameraOn, speaking, statuses, itemClass, trackId, visible}]   (плитки)
getParticipantsFromPanel(page, {close=true}) -> {count, list:[{name, role, isSelf, muted}]}                          (sidebar)
watchParticipants(page, cb, {intervalMs=500, selfName}) -> stop()
watchActiveSpeaker(page, cb, {intervalMs=250}) -> stop()              cb(names[])
installObservers(page, cb, {selfName}) -> stop()                      MutationObserver + exposeFunction: {type:'participants'|'speaker', t, ...}
setMic(page, on) / setCamera(page, on) / readToggle / setToggle
openMore / clickMoreOption(page, title) / openParticipants / closeParticipants / openChat / openSettings / closePanels / revealToolbar
setSettingsSwitch(page, 'Camera'|'Sound', label, on) / setHideIncomingVideo(page, on)
postChat(page, text) -> {ok:false} (чат недоступен гостю) / watchChat -> throws / chatFrame(page)
leave(page, {log}) -> {ok, detail, url}
```
