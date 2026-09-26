# Ведущая стендапа: план реализации

Источник правды для агентов-исполнителей. Архитектура: Fable (18.09.2026), правки после ревью: Opus (оркестратор).

## 0. Контекст и Definition of Done

Утренний стендап Acme в Телемосте (пн–чт 10:00–10:30 МСК, постоянная комната
`https://telemost.yandex.ru/j/11111111111111111111111111111111111111`, организатор Глеб Невский). Нужен ведущий, который по очереди даёт слово. Делаем ИИ-ведущую.

DoD (от Сергея):
- Бот сам подключается к встрече и ведёт её строго женским голосом.
- В 10:00, если **Ярослав Орлов** уже подключился, предлагает стартовать и **первым всегда просит Орлова**, дальше в порядке на своё усмотрение.
- Если Орлова в 10:00 нет — действовать по принципу, не по жёсткому алгоритму: поздороваться, сказать, что начнём, когда подключится Орлов, можно попросить кого-то его пингануть; если никто не заговорил про старт и Орлова нет к 10:02 — «давайте без него стартанём, никто не против?» и начинать; когда Орлов подключится — дать ему слово, как только договорит текущий спикер.
- Пн: спрашивает фокусы на неделю. Вт–чт: планы на день.
- После всех: спрашивает, хочет ли кто-то что-то сказать или спросить; если нет — «всем хорошей недели» (пн) / «хорошего дня» (вт–чт) и **каждый день** передаёт слово на дев-синк, затем выходит.
- Отвечает на серьёзные и шутливые вопросы о себе (кто, что, откуда, куда) — легенда на основе example.com (черновик персоны: `config/persona.md`, показать Сергею до боя).
- Без тупых перебиваний и зависаний. Бюджет ~40–60 ₽ за стендап одобрен.
- Сроки: выходные — сборка и тесты (в т.ч. живой тест с Сергеем), **пн 21.09 10:00 — боевой запуск**.

## 1. Изменения после ревью архитектуры (приоритет над разделами ниже)

1. **Голос: `shimmer`** (выбор Сергея), `audio.output.speed` **строго 1.0**. Ускорение OpenAI (1.3/1.5) и локальная постобработка (сжатие пауз, WSOLA) Сергеем отвергнуты: искажают голос.
2. **Темп задаём только инструкцией** в `session.instructions` (Сергею подошли варианты brisk_strong / brisk / radio; по умолчанию brisk_strong, текст в `settings.realtime.pace_instructions`). Модуль speechproc отменён. Цепочка: OpenAI PCM → player. Длинных пауз-многоточий в текстах реплик не использовать.
3. **Бенчмарк TTFA (измерено 18.09):** gpt-realtime-2.1 verbatim out-of-band: effort default 1,11 с, **minimal 0,84 с**, low 0,90 с; mini default 0,63 с (голос не смешиваем). Все тексты зачитаны дословно.
4. **Ответы Сергея:** первым — Ярослав Орлов (не Андрей); дев-синк — каждый день; порядок после Орлова — на усмотрение ведущей; поведение без Орлова — принцип (см. DoD).
5. **Ключи:** в сессии Claude прямое чтение `.env*` заблокировано правилом — код читает ключи сам (`src/env.js`), наружу выводит только present/absent. Мозг — OpenRouter по ключу Коры **`Cora_KEY`** (`.env.personal`, `settings.keys.openrouter`). Голос/слух (Realtime API) — только прямой ключ OpenAI: у OpenRouter нет Realtime API; пока `OPENAI_API_KEY` из `.env.local`, ждём решения Сергея про отдельный OpenAI-ключ Коры. Общий `OPENROUTER_API_KEY` не использовать.
9. **Голос через OpenRouter (18.09, вечер):** у аккаунта OpenAI закончились кредиты; Сергей: голос тоже на `Cora_KEY`. Каскад с теми же интерфейсами ears/mouth (WP3b, `src/audio/voice.js`): рот — **`openai/gpt-audio-mini`** (выбор Сергея: дешевле, звучит норм) через chat completions со стримом pcm16, голос shimmer (TTFA 1,6 с; хендоффы — заранее записанные клипы); слух — локальный VAD + `/audio/transcriptions` (`openai/gpt-4o-transcribe`, 1,2–1,5 с на фразу, промежуточные окна каждые ~2,5 с). WP3 (OpenAI Realtime) остаётся альтернативным провайдером. Видео (Sora) — только после теста работающего бота.
7. **Персона (решения Сергея):** имя **Кора** (Core / кора мозга), подпись в Телемосте «Кора (ИИ-ведущая)»; ко всем всегда на «ты»; вендоров называть можно (OpenAI — слух и голос, `{brain_model}` — решения); лог с транскриптом пишем, на вопрос «записываешь?» отвечает честно. Текст: `config/persona.md`.
8. **Аватар (WP13):** камера Коры включена, видео — canvas-трек с портретом (варианты сгенерированы gpt-image-2, выбор за Сергеем) и мягкой пульсацией свечения, пока она говорит. Реализация в WP2 (`__hostOpts.avatar`), проверка приёма Телемостом — в WP1.
6. **Создать встречу гостем нельзя** (Телемост требует Яндекс ID) — ссылку на тест-комнату даёт Сергей. Pre-join проверен без входа: «Продолжить в браузере» → `orb-textinput-input` (имя), `turn-on-mic-button`, `turn-on-camera-button`, `enter-conference-button`.

## 2. Архитектура

Один Node-процесс + одна страница Телемоста под `playwright-core` (channel `chrome`, отдельный `user-data-dir`, headful, окно за экраном, `--mute-audio`). Адаптер страницы через `addInitScript`. Одна Realtime-сессия OpenAI (уши + рот). Мозг на OpenRouter с плейбуком принципов. Детерминированные guardrails снаружи LLM. Harness на фейковых гостях.

Ключевые решения:
1. **Рот = только verbatim-озвучка и кэшированные клипы.** Realtime-модель — это TTS (effort `minimal`). Весь текст — от мозга или из `phrases.json`.
2. **Мозг не на критическом пути передачи слова.** Во время монолога мозг заранее готовит `plan.next`; fast-path играет готовый клип «Тима, тебе слово» через ~0,8 с после последнего слова.
3. **semantic_vad — один из сигналов, не арбитр** (`eagerness: medium` стартово, max 4 с). Конец реплики решает floor-контроллер.
4. **Атрибуция по трекам — P1.** MVP: «презюмируемый спикер» (кому дали слово) + DOM-индикатор активного спикера.
5. **Понедельник — ручной запуск из видимой консоли** (Ctrl+C = kill switch). Планировщик — со вторника. Календарь/праздники — P2.
6. **AudioContext в странице с `sampleRate: 24000`** — Chrome сам ресемплирует входящие треки и наш «микрофон».
7. **Мозг:** OpenRouter по `Cora_KEY`, модель **`google/gemini-3.5-flash-lite`** (бенч 18.09: 5/5 разумных решений, 1,2–1,55 с, $0.0007/вызов, 100% валидный JSON); фолбэк на OpenAI `gpt-5-mini` отключён (`failover: false`), пока у OpenAI нет кредитов. `node src/main.js --check` печатает только present/absent и выбранного провайдера.

```
Telemost (Chrome, headful, окно за экраном, --mute-audio)
  page_inject.js (addInitScript):
    getUserMedia/enumerateDevices override -> «микрофон» = MediaStreamAudioDestinationNode
       <- PlayerWorklet (очередь PCM16 24k, flush() < 50 мс)
    RTCPeerConnection patch -> remote audio tracks -> CaptureWorklet
       -> микс PCM16 24k (чанки 100 мс) + RMS по трекам (50 мс) -> window.__host.audio(...)
    MutationObserver/polling -> participants, activeSpeaker, chat -> window.__host.dom(...)
    все <audio> Телемоста -> muted=true (страховка к --mute-audio)
        │ CDP (exposeFunction вверх, page.evaluate вниз)
Node host (scripts/standup_host/src)
  ears.js  — Realtime WS: input_audio_buffer.append, semantic_vad события, gpt-live-transcribe дельты/финалы
  mouth.js — та же сессия: out-of-band verbatim (стрим) + response.cancel -> player
  clips.js — кэш PCM клипов (voice + instructions + text hash), рендер через mouth
  floor.js — кто говорит / тишина / разрешение говорить / barge-in
  state.js — roster, присутствие, кто выступил, фаза, таймеры, план мозга
  host.js  — цикл: события -> (fast-path | brain) -> действия -> player/DOM
  brain/   — OpenRouter|OpenAI chat completions, prompt = playbook + persona + roster + day_mode
  ops/     — telegram DM, stop-flag, отчёт
  log.js   — JSONL logs/standup_YYYY-MM-DD.jsonl
```

### Раскладка `scripts/standup_host/`

```
package.json (private; deps: playwright-core, ws)   .gitignore (node_modules/ profile/ cache/ logs/ state/ *.pcm *.wav)
README.md  PLAN.md
config/people.json  config/playbook.md  config/persona.md  config/phrases.json  config/settings.json
src/main.js  src/env.js  src/log.js  src/clock.js
src/browser/launch.js  src/browser/telemost.js  src/browser/page_inject.js  src/browser/worklets.js
src/audio/realtime_ws.js  src/audio/ears.js  src/audio/mouth.js  src/audio/clips.js  src/audio/player.js
src/brain/client.js  src/brain/prompt.js  src/brain/context.js  src/brain/actions.js
src/core/events.js  src/core/state.js  src/core/floor.js  src/core/attribution.js  src/core/guards.js  src/core/host.js
src/ops/telegram.js  src/ops/calendar.js (P2)
tools/inspect_dom.js  tools/render_clips.js  tools/audition_names.js  tools/replay.js  tools/bench_brain.js
tests/unit/*.test.js (node:test)  tests/harness/{run.js, fake_guest.js, scenarios/*.json, assert.js}
run-standup.ps1  register-task.ps1  stop-standup.ps1
```

### Контракты

Контекст для мозга (один JSON, ~2–3k токенов, стабильный префикс кэшируется):
```json
{"now":"10:03:12","day_mode":"monday_focus|daily_plans","phase":"waiting|starting|round|open_floor|closing|silent",
 "deadline":{"soft":"10:28","hard":"10:30"},"lead_present":false,
 "participants":[{"id":"timur","name":"Тимур Ткач","present":true,"joined":"09:59","status":"pending|spoke|speaking|absent"}],
 "speaker":{"id":"timur","conf":"high|med|low|unknown","since_s":42,"silence_ms":900},
 "host":{"speaking":false,"silent_mode":false,"last_utterance":"…","last_interrupted":false},
 "plan":{"next":"andrey_m","then":["gleb","nina"]},
 "recent_events":[{"t":"10:02:58","type":"joined","who":"andrey_m"},{"t":"10:03:05","type":"turn_end_candidate","reason":"closer|silence_2500|vad_stop","text":"…как-то так"}],
 "transcript_window":[{"t":"10:01:40","who":"timur|?","text":"…"}],
 "trigger":"turn_end_candidate|silence|joined|left|chat|question_to_host|timer|barge_in|plan_refresh"}
```
Действие мозга (ровно одно, валидация JSON-schema):
```json
{"action":"wait|speak|give_word|check_done|answer|post_chat|leave|silent_mode",
 "to":"timur","text":"опционально (≤2 предложения)","plan":{"next":"…","then":["…"]},"why":"кратко, только в лог"}
```
`give_word`/`check_done` без `text` → клип из `phrases.json` (`handoff`, `handoff_first_monday`, `check_done`, `are_you_here`). `text` — только для нестандартных фраз (живая озвучка).

**Детерминировано (код):** roster/присутствие, кто выступил, презюмируемый спикер, таймеры (10:00/10:02/10:28/10:30/10:35), floor-gate и barge-in, выбор клипа, kill switch, лимиты длины, rate-limit мозга, reconnect, выход, учёт стоимости.
**Делегировано LLM:** порядок спикеров, момент старта («принцип Орлова»), формулировки, реакция на вопросы/шутки, поздние подключения, ждать или вмешаться при обсуждении, open floor и закрытие, тон по дню недели.

**Персона:** `config/persona.md` → секция «Персона» system-prompt мозга + короткая выжимка (имя, женский род, тон) в `session.instructions` realtime-сессии. Правила безопасности (1–2 предложения, «я ИИ», никакой конфиденциальной информации/секретов, назад к повестке) — в `playbook.md`.

**Логи:** `logs/standup_YYYY-MM-DD.jsonl`, записи `{ts, type, ...}`: `page.participants`, `page.speaker`, `vad.start|stop`, `stt.final` (+ `stt.delta` для fast-path), `brain.request|action` (trigger, latency_ms, usage), `speech.start|end|abort` (text, source clip|live, ttfa_ms), `guard.*`, `error.*`, `cost.summary`. Только локально (содержат транскрипты). Обёртка планировщика — текстовый лог в `%USERPROFILE%\sync\logs\standup_YYYY-MM-DD.txt`.

## 3. Turn-taking и фасилитация

**Сигналы** (с таймстампами в `floor.js`): (a) энергия микса и по трекам, 50 мс → `room_active`; (b) `speech_started/stopped` semantic_vad (`eagerness: medium`, тюнить в harness); (c) дельты gpt-live-transcribe → детектор closers («у меня всё», «как-то так», «передаю», «на этом всё», «всё, спасибо»); (d) DOM active speaker; (e) presence.

**Конец реплики:** тишина ≥ 700 мс И (closer ИЛИ `speech_stopped`) → **fast-path**: клип `plan.next` без мозга. Тишина ≥ 2500 мс без семантического завершения → клип `check_done` («Тима, всё?»); «да/всё» → handoff; продолжил → ждём. Мозг вызывается на: смену присутствия, вопрос к ведущей (имя/«ведущая»), чат, barge-in, таймеры, `plan_refresh` (~15 с после начала монолога) и на turn_end без готового плана. Rate-limit ≤ 1 вызов / 1,5 с, события коалесцируются; во время своей речи мозг не зовём (кроме barge-in).

**Бюджет задержек:** handoff по closer ≈ 0,8–1,0 с. Неявный конец → 2,5 с + уточнение. Q&A: 0,7 + мозг ~1,3 + TTS 0,85 ≈ 2,9 с (P1 потоковая озвучка первого предложения ≈ 2,3 с). Barge-in: энергия ≥ порога 200 мс подряд → `flush()` → ≤ 300 мс.

**Не говорить поверх людей:** разрешение говорить только при `room_silence ≥ 700 мс` и без незакрытого `speech_started`; любая речь во время нашей → abort + `barge_in{played_ratio}`; сыграно < 30% → «не доставлена», мозг решает, повторять ли; два barge-in подряд → бэкофф 3 с. Порог выше остаточного эха.

**Обсуждение:** спикер ≠ презюмируемый → `interjection`; плейбук: ждать 20–30 с; > 60 с и не про стендап — мягко предложить вынести на дев-синк. **Поздние/ушедшие:** presence → мозг обновляет план; Орлов подключился → слово ему сразу после текущего (`plan.next`). Ушёл до очереди → пропуск, вернулся → в конец.

**Плейбук (фрагмент `playbook.md`):**
- Ты ведущая, а не участница: коротко, по делу, содержание апдейтов не комментируешь.
- 10:00 и Ярослав Орлов на связи → предложи начать; первое слово всегда ему. Дальше порядок твой: разумный, стабильный.
- Его нет: поздоровайся, скажи, что начнём, когда он подключится, можно попросить кого-то пингануть. Если к 10:02 никто не предложил начать и его нет — предложи стартовать без него, спроси, никто ли не против; 5–7 с тишины = согласие. Появился — слово ему сразу после текущего спикера.
- Пн: фокус на неделю. Вт–чт: планы на день.
- Не уверена, что человек закончил — мягко уточни. Не перебивай. Вопрос к тебе — 1–2 предложения и назад к повестке. Ты ИИ, не притворяйся человеком; ни клиентов, ни проектов, ни секретов.
- После всех: спроси, хочет ли кто-то что-то сказать или спросить; пауза 5 с; пожелание (пн — «всем хорошей недели», вт–чт — «хорошего дня»); передай слово на дев-синк; выйди.
- 10:28 — ускоряйся; 10:30 — завершай. Принудительный выход 10:35 — в коде.

**Атрибуция:** `high` — DOM совпал с презюмируемым; `med` — только презюмируемый; `low` — энергия есть, DOM молчит; `unknown`. Маппинг трек↔участник учится корреляцией с DOM (P1). Без атрибуции работаем на презюмируемом спикере + обращениях по имени; при `conf: low` не называть, кто говорит.

## 4. Голос

Один движок и один голос везде: `gpt-realtime-2.1`, voice `shimmer`, speed 1.0, effort `minimal`, темп — блок `pace_instructions` в `session.instructions`. Никакой постобработки. mini не смешиваем.
- **A. Клипы (0 мс):** `phrases.json` × roster: handoff, handoff первый (пн — «…какой фокус на неделю»), check_done, are_you_here, приветствие, «начнём, когда подключится Ярослав», «давайте без него стартанём, никто не против?», open floor, оба пожелания, «передаю слово на дев-синк», «извини, продолжай», «секунду». Кэш `cache/<voice>/<sha1(instructions + text)>.pcm`, прогрев на старте для roster (≈40 клипов ≈ $0,02 один раз).
- **B. Живой verbatim (~0,85 с):** текст мозга → `{"response_text":…,"require_repeat_verbatim":true}`, стрим дельт → player.
- **C. Свободная генерация realtime-моделью:** не используется.

**Ударения/ё:** `people.json`: `display`, `aliases` (варианты имён в Телемосте), `spoken` («Ти́ма»), `vocative`; перед озвучкой — подстановка `spoken` и ё-словарь (всё/ещё/идёт…). `tools/audition_names.js` — прослушивание всех именных клипов Сергеем в вс; спорные правим в `spoken` и перерендериваем.

## 5. Q&A с персоной

Ответ генерирует мозг, realtime читает verbatim. Детекция: имя персоны/«ведущая» в транскрипте + turn_end → `trigger: question_to_host`. Контекст — обычный + последние 30 с транскрипта. Ограничения: 1–2 предложения, ≤ 220 символов, женский род, без клиентов/проектов/ключей/URL + детерминированная обрезка по границе предложения и regex-фильтр. Фолбэк при долгих 2,9 с — потоковая озвучка первого предложения (P1).

## 6. Стоимость, лимиты, сессия

На 30 мин + 2 мин до: транскрипция 32 мин × $0,017 ≈ 46 ₽ (с энергетическим гейтингом P1 ≈ 30 ₽); мозг ≈ 5 ₽; живая речь ≈ 7 ₽; клипы бесплатны после первого дня. Итого ≈ 42 ₽ с гейтингом / ≈ 58 ₽ без. В пн допускаем ~55 ₽. Сверить `cost.summary` с дашбордом OpenAI (подтвердить, что закоммиченное VAD-аудио не биллится как model input). TPM: out-of-band ≈ 300 текстовых + ≤ 300 audio out токенов. Раз в 2 мин `conversation.item.delete` старых user-items. Сессия ≤ 60 мин: подключаемся 09:58, выходим ≤ 10:35; `realtime_ws.js` умеет reconnect (0,5/1/2 с). Падение браузера → Telegram DM + одна попытка перезахода (P1).

## 7. Риски и спайки

| # | Спайк | Когда | Fallback |
|---|---|---|---|
| S0 | Гость входит в тест-комнату headful через playwright-core; waiting room / org-only реальной комнаты | как только будет ссылка | Профиль с ручным логином Сергея под Яндекс ID; при waiting room — впускают Глеб/Сергей |
| S1 | In-call DOM: участники, active speaker, выход, чат | сб утро | Polling 500 мс; без чата |
| S2 | Наш getUserMedia-микрофон принят, участники слышат клип | сб утро | `RTCRtpSender.replaceTrack` |
| S3 | Захват удалённых треков: per-participant или микс, уровни ненулевые | сб | Подцепить трек к muted `<audio>`; при одном миксе — атрибуция только по DOM |
| S4 | semantic_vad + gpt-live-transcribe в одной сессии 30 мин, качество русского | сб | Две сессии: transcription для ушей + realtime для рта |
| S5 | Headful за экраном + `--mute-audio --autoplay-policy=no-user-gesture-required --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`, viewport 640×480; CPU при 12–15 видео | сб/вс | Отключить входящее видео в настройках Телемоста; крайний случай `direction='inactive'` у video-receiver'ов |
| S6 | Латентность e2e (handoff ≤ 1,5 с, Q&A ≤ 3 с) | вс | Больше клипов, быстрее мозг, потоковая озвучка |
| S7 | Атрибуция по трекам | вс (P1) | Презюмируемый + DOM |
| S8 | Хранитель примет бота за «не команду», routine не разложит саммари | до пн (нужен OK) | Одна строка в `.claude/skills/meeting-summary/SKILL.md` |
| S9 | Планировщик из скрытого pwsh поднимает headful Chrome | вт | Пн — ручной запуск |

## 8. Декомпозиция

| WP | Цель / файлы | Приёмка | Зависит | ч | Модель | Статус |
|---|---|---|---|---|---|---|
| 0 | Скаффолд: `package.json`, `.gitignore`, `env.js`, `log.js`, `clock.js`, `settings.json`, `README`, `main.js --check/--shadow/--url/--at` | `--check` печатает present/absent по ключам и провайдера мозга; JSONL пишется; ставятся только playwright-core + ws | — | 1,5 | Opus | |
| 1 | Спайки S0/S1/S2/S5: `launch.js`, `telemost.js` (join по data-testid, участники, активный спикер, чат, leave), `tools/inspect_dom.js`, документ селекторов | Бот входит в тест-комнату; участники и активный спикер приходят событиями ≤ 500 мс; клип слышен; CPU измерен | 0, ссылка | 3 | Fable | ждёт ссылку |
| 2 | Аудиоадаптер страницы: `page_inject.js`, `worklets.js` (Capture/Player), overrides getUserMedia/enumerateDevices/permissions, mute `<audio>`, loopback-страница | `window.__host.audio(b64, levels[])`, `__host.play(b64)` / `__host.flush()`; loopback: PCM слышен второй странице, уровни корректны, abort ≤ 50 мс | 0 | 5 | Fable | |
| 2b | ~~`speechproc.js`~~ | — | — | — | — | отменён (Сергей выбрал темп инструкцией) |
| 3 | `realtime_ws.js`, `ears.js`, `mouth.js`: session.update, append, VAD/STT, out-of-band verbatim стрим, cancel, reconnect, TTFA, гигиена items | WAV → финалы + VAD; readout 3 фраз TTFA ≤ 1,0 с; разрыв WS → восстановление ≤ 3 с | 0 | 3 | Opus | |
| 4 | `clips.js`, `player.js`, `phrases.json`, `tools/render_clips.js`, `tools/audition_names.js`, ё-словарь + `spoken` | Roster рендерится; повторный запуск — 100% cache hit; очередь с abort и таймингами | 3 | 2 | Opus | |
| 5 | `brain/*`: клиент (OpenRouter → OpenAI фолбэк, JSON-schema, timeout 4 с, 1 retry), prompt, context, actions, `tools/bench_brain.js` | Бенч моделей: TTFT и полный ответ; валидный JSON ≥ 99%; провайдер в логе | 0 | 2,5 | Opus | |
| 6 | Ядро: `events.js`, `state.js`, `floor.js`, `guards.js`, `attribution.js`, `host.js` | floor: closer → handoff 0,8–1,0 с; тишина 2,5 с → check_done; barge-in abort; ни одного `speech.start` при `room_active`; kill switch → silent ≤ 1 с | 2, 3, 4, 5 | 6 | Fable | |
| 7 | `playbook.md`, `people.json`, интеграция `persona.md`, `tools/replay.js` | Replay 3 сценариев: старт с Орловым / без / поздний Орлов | 5, персона | 2,5 | Opus + ревью Fable | |
| 8 | Harness: `fake_guest.js`, `scenarios/*.json`, `assert.js` | overlap ≤ 300 мс, handoff ≤ 2 с, Орлов сразу после текущего, все выступили, закрытие + leave, kill switch | 1, 2, 3 | 4 | Opus | |
| 9 | Ops: `telegram.js` (DM 111111111), `run-standup.ps1`, `register-task.ps1` (пн–чт 09:55), `stop-standup.ps1` | Обёртка поднимает бота; DM при падении; stop-flag ≤ 1 с | 0 | 1,5 | Opus | |
| 10 | E2E + живой тест с Сергеем, тюнинг порогов, аудишн имён, сверка стоимости, чеклист | Два полных прогона с Сергеем + 2 фейка без overlap; ≤ 60 ₽/30 мин | 6, 7, 8, 9 | 4 | Fable | |
| 11 | Строка в `.claude/skills/meeting-summary/SKILL.md` (бот = команда) | Только после явного OK Сергея | OK | 0,2 | Opus | ждёт OK |
| 13 | Аватар: портрет выбран (киберпанк, вариант 2) → `assets/avatar.png`, `settings.avatar`; canvas video-трек с пульсацией при речи (WP2), приём Телемостом (WP1) | Слушатель видит портрет на плитке Коры; свечение синхронно речи; CPU с камерой приемлем | 1, 2 | 1 | Fable (в WP1/WP2) | в работе |
| 14 | После пн, по решению Сергея: провайдер ElevenLabs — слух на Scribe v2 Realtime (потоковые частичные ~150 мс, русский, ~$0,39/ч звука) с тем же интерфейсом ears; опционально родной русский голос вместо shimmer. Оплату Сергей знает как провести. | Handoff после closer ≤ 1,2 с; STT-частичные по ходу речи | 10 | 4–8 | Opus (слух — Fable) | бэклог |
| 12 | P1/P2: гейтинг аудио, потоковая озвучка первого предложения, атрибуция по трекам, сводка в Telegram, `calendar.js` | ≤ 45 ₽; Q&A ≤ 2,5 с | 10 | 3+ | Opus (треки — Fable) | |

**Критический путь:** ссылка на тест-комнату → WP1 → WP2 → WP6 → WP10.
**MVP-линия:** остаются вход гостем, уши, клипы + живой verbatim, список участников, мозг с плейбуком (Орлов, пн-режим), floor-gate + barge-in, kill switch (голос + file-flag + Ctrl+C), выход, JSONL, Telegram DM, ручной запуск. Режем атрибуцию по трекам, чат, календарь, гейтинг, потоковую озвучку, сложные harness-сценарии, планировщик.

**Чеклист go-live пн 09:50:** `--check` зелёный; тест-звонок в вс пройден; `people.json` сверен с именами в Телемосте; `day_mode=monday_focus`; окно бота за экраном и `--mute-audio`; Сергей в звонке со своего клиента; kill switch проверен трижды (голосом «<имя>, стоп», `stop-standup.ps1`, Ctrl+C); в silent-mode ведёт Сергей; Telegram DM приходит; транскрипция обрывается в 10:40; `--shadow` — запасной режим.

## 9. Открытые вопросы к Сергею

1. ~~Ссылка на тест-комнату~~ — есть: https://telemost.360.yandex.ru/j/22222222222222222222222222222222222222 (только для тестов). Открыто: пускает ли реальная комната гостей без зала ожидания (спросить Глеба)? Если нет — аккаунт для ведущей или ручной логин в профиль бота.
2. Имя: рабочее «Кора» (Core / кора мозга), черновик персоны — `config/persona.md`, ждёт ревью Сергея. Подпись в Телемосте: «Кора (ИИ-ведущая)»?
3. ~~Темп речи~~ — решено: shimmer, speed 1.0, темп инструкцией (brisk_strong).
4. ~~Ключ OpenRouter~~ — решено: `Cora_KEY`.
5. Дев-синк: просто фраза «передаю слово на дев-синк» и выход, или передать конкретному человеку?
6. OK на строку в `meeting-summary/SKILL.md`.
7. Пн — ручной запуск из видимой консоли в 09:55, планировщик со вторника.
