// Conversation scenarios for the agent (fictional team «Acme», config/people.example.json), after the
// live tests of 27.09: what happens (events) and which decisions are acceptable. They do not depend on
// how the agent is built: any `decide(input) -> actions` can be run through them
// (src/agent/scenario_runner.js; real model: tools/run_scenarios.js).
//
// Scenario: {id, title, source, state: {phase, speaker, queue, present}, dialog: [{who, text}],
//            steps: [{events, expect, forbid?, level?, ideal, note?}]}
// Events: heard {who, text} — as SpeechKit gives it after stt_fixes: lower case, no punctuation, «Кора»
//         restored (heard() does it; heardRaw() keeps a text as written, e.g. a misheard name) ·
//         silence {ms} · joined / left {who} · her_line_done {text, cut?}
//         (what she said, scripted) · interrupted {text} · chorus {who: [...]} · state {phase?, speaker?, queue?}
// expect: alternatives, any one is enough; an alternative = matchers that must all be met; [] (SILENT)
//         = skip or nothing. forbid: matchers none may meet. level 'soft' = reported, never fails.
// Matcher: {action: name | [names], person?: id | [ids], text?: RegExp (must match), notText?: RegExp}.
// ideal: a good answer (documents the intent; the runner's own tests replay it).
// Every action is also checked against the invariants of src/agent/invariants.js (the host enforces
// the same list): a violation fails the step whatever `expect` says.
// Silence ladder (docs/agent_plan.md): 1 s after a phrase — usually still early; 2.5 s — «всё?»;
// 6 s after «всё?» — the turn is over.

import { INVENTED, NO_BRIDGE } from './invariants.js';

export const SCENARIO_ROSTER = Object.freeze([
  { id: 'orlov_y', display: 'Ярослав Орлов', vocative: 'Слава' },
  { id: 'nevsky_g', display: 'Глеб Невский', vocative: 'Глеб' },
  { id: 'tkach_t', display: 'Тимур Ткач', vocative: 'Тима' },
  { id: 'belozersky_s', display: 'Сергей Белозерский', vocative: 'Серёжа' },
]);
export const SCENARIO_LEAD = 'orlov_y';

export const SILENT = Object.freeze([]);
const say = (text, notText) => ({ action: 'say', ...(text ? { text } : {}), ...(notText ? { notText } : {}) });
const give = (person, extra = {}) => ({ action: 'give_word', person, ...extra });
const ask = (person) => ({ action: 'ask_done', person });
const leave = () => ({ action: 'leave' });
/** What STT + stt_fixes make of a phrase: lower case, no punctuation, «Кора» with a capital. */
export function sttLike(text) {
  return String(text)
    .toLowerCase()
    .replace(/[.,!?;:«»"()—–]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)кора(?=\s|$)/g, '$1Кора');
}
const heard = (who, text) => ({ type: 'heard', who, text: sttLike(text) });
const heardRaw = (who, text) => ({ type: 'heard', who, text });
const her = (text, cut = false) => ({ type: 'her_line_done', text, ...(cut ? { cut: true } : {}) });
const silence = (ms) => ({ type: 'silence', ms });

const round = (speaker, queue, present = ['orlov_y', 'nevsky_g', 'tkach_t']) => ({ phase: 'round', speaker, queue, present });

export const SCENARIOS = Object.freeze([
  // ---- before the start ------------------------------------------------------------------------
  {
    id: 'greet_by_name',
    title: 'здороваются по имени до старта: ответить, стендап не открывать',
    source: 'run1',
    state: { phase: 'waiting', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g'] },
    steps: [
      {
        events: [heard('tkach_t', 'Кора, привет! Ты меня слышишь?')],
        expect: [[say()]],
        forbid: [give('tkach_t'), give('nevsky_g')],
        ideal: [{ action: 'say', text: 'Привет, Тима! Слышу хорошо.' }],
      },
    ],
  },
  {
    id: 'no_second_greeting',
    title: 'уже поздоровалась, спрашивают «что молчишь»: ответить без нового «привет»',
    source: 'run1',
    state: { phase: 'waiting', speaker: null, queue: [], present: ['tkach_t'] },
    dialog: [
      { who: 'tkach_t', text: 'Кора привет' },
      { who: 'host', text: 'Привет, Тима! Я тут, слышу тебя хорошо.' },
    ],
    steps: [
      {
        events: [heard('tkach_t', 'что молчишь')],
        expect: [[say(null, /привет/i)]],
        ideal: [{ action: 'say', text: 'Жду, когда попросишь начать стендап.' }],
      },
    ],
  },
  {
    id: 'start_without_name',
    title: 'она сказала «начну, когда попросите», в ответ «давай начнём» без имени',
    source: 'run1',
    state: { phase: 'waiting', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g'] },
    dialog: [{ who: 'tkach_t', text: 'Кора привет' }],
    steps: [
      {
        events: [her('Привет, Тима! Начну, когда попросите.'), heard('tkach_t', 'да давай начнём')],
        expect: [[give(['tkach_t', 'nevsky_g'])]],
        ideal: [{ action: 'give_word', person: 'tkach_t', text: 'Доброе утро, коллеги! Тима, начнёшь?' }],
      },
    ],
  },
  {
    id: 'start_with_lead',
    title: '«Кора, начинай», руководитель на встрече: первое слово ему',
    source: 'design',
    state: { phase: 'waiting', speaker: null, queue: [], present: ['tkach_t', 'orlov_y', 'nevsky_g'] },
    steps: [
      {
        events: [heard('tkach_t', 'Кора, начинай')],
        expect: [[give('orlov_y')]],
        ideal: [{ action: 'give_word', person: 'orlov_y', text: 'Доброе утро, коллеги! Слава, начнёшь?' }],
      },
    ],
  },
  {
    id: 'waiting_colleagues_chat',
    title: 'до старта коллеги болтают между собой',
    source: 'design',
    state: { phase: 'waiting', speaker: null, queue: [], present: ['tkach_t', 'orlov_y', 'nevsky_g'] },
    steps: [
      {
        events: [heard('nevsky_g', 'Тима, ты вчера билд поправил?'), heard('tkach_t', 'да, вечером')],
        expect: [SILENT],
        ideal: [{ action: 'skip' }],
      },
    ],
  },

  // ---- during a turn -----------------------------------------------------------------------------
  {
    id: 'question_no_name_in_turn',
    title: '«я тебе вопрос задал» в ответ на её «всё?» (прогон 2): ответить, слово остаётся у говорящего',
    source: 'run2',
    state: round('tkach_t', ['nevsky_g']),
    dialog: [
      { who: 'host', text: 'Доброе утро, коллеги! Тима, начнёшь?' },
      { who: 'tkach_t', text: 'давай начнём а что ты до этого молчала' },
    ],
    steps: [
      {
        events: [her('Тима, всё?'), heard('tkach_t', 'я тебе вопрос задал')],
        expect: [[say(null, NO_BRIDGE)]],
        forbid: [give('nevsky_g'), say(INVENTED)],
        ideal: [{ action: 'say', text: 'Ждала, пока попросят начать: сама стендап не открываю.' }],
      },
    ],
  },
  {
    id: 'question_you_in_turn',
    title: 'посреди своего отчёта спрашивают её «а ты вообще кто?»',
    source: 'design',
    state: round('tkach_t', ['nevsky_g']),
    dialog: [{ who: 'tkach_t', text: 'сегодня добиваю интеграцию' }],
    steps: [
      {
        events: [heard('nevsky_g', 'Кора, а ты вообще кто?')],
        expect: [[say(null, NO_BRIDGE)]],
        forbid: [give('nevsky_g'), say(INVENTED)],
        ideal: [{ action: 'say', text: 'Я Кора, ИИ-ведущая наших стендапов.' }],
      },
    ],
  },
  {
    id: 'colleague_asks_colleague',
    title: 'коллега спрашивает говорящего — не ей',
    source: 'design',
    state: round('tkach_t', ['nevsky_g']),
    dialog: [{ who: 'tkach_t', text: 'сегодня добиваю интеграцию потом ревью' }],
    steps: [
      {
        events: [heard('nevsky_g', 'Тима, а по срокам интеграции что?')],
        expect: [SILENT],
        ideal: [{ action: 'skip' }],
      },
    ],
  },
  {
    id: 'pause_mid_update',
    title: 'пауза посреди отчёта — не конец',
    source: 'design',
    state: round('tkach_t', ['nevsky_g']),
    steps: [
      {
        events: [heard('tkach_t', 'сегодня делаю интеграцию, потом'), silence(1500)],
        expect: [SILENT],
        ideal: [{ action: 'skip' }],
      },
    ],
  },
  {
    id: 'turn_end_closer',
    title: '«у меня всё»: поблагодарить и передать слово следующему',
    source: 'run1',
    state: round('tkach_t', ['nevsky_g', 'orlov_y']),
    steps: [
      {
        events: [heard('tkach_t', 'сегодня добиваю интеграцию, потом ревью, у меня всё'), silence(800)],
        expect: [[give('nevsky_g')]],
        forbid: [give(['tkach_t', 'orlov_y'])],
        ideal: [{ action: 'give_word', person: 'nevsky_g', text: '' }],
      },
    ],
  },
  {
    id: 'long_silence_ask_done',
    title: 'замолчал на 3 с без «у меня всё»: спросить «всё?», потом тишина — дальше',
    source: 'run1',
    state: round('tkach_t', ['nevsky_g']),
    steps: [
      {
        events: [heard('tkach_t', 'выжить, захватить мир, ну и немножко позависать в телефоне'), silence(3000)],
        expect: [[ask('tkach_t')]],
        ideal: [{ action: 'ask_done', person: 'tkach_t' }],
      },
      {
        events: [her('Тима, всё?'), silence(6000)],
        expect: [[give('nevsky_g')]],
        ideal: [{ action: 'give_word', person: 'nevsky_g', text: '' }],
      },
    ],
  },
  {
    id: 'ask_done_answers',
    title: 'на «всё?» отвечают «нет, ещё одно» — слушать; потом «да» — дальше',
    source: 'design',
    state: round('tkach_t', ['nevsky_g']),
    dialog: [{ who: 'tkach_t', text: 'сегодня делаю интеграцию' }],
    steps: [
      {
        events: [her('Тима, всё?'), heard('tkach_t', 'нет подожди ещё одно')],
        expect: [SILENT],
        ideal: [{ action: 'skip' }],
      },
      {
        events: [heard('tkach_t', 'после обеда созвон с клиентом'), silence(3000)],
        expect: [[ask('tkach_t')], [give('nevsky_g')]],
        ideal: [{ action: 'ask_done', person: 'tkach_t' }],
      },
      {
        events: [her('Тима, у тебя всё?'), heard('tkach_t', 'да')],
        expect: [[give('nevsky_g')]],
        ideal: [{ action: 'give_word', person: 'nevsky_g', text: '' }],
      },
    ],
  },
  {
    id: 'handoff_interrupted_by_next',
    title: 'передачу «Спасибо! Дальше Глеб» перебил сам Глеб вопросом к ней (прогон 2)',
    source: 'run2',
    state: round('tkach_t', ['nevsky_g']),
    dialog: [{ who: 'tkach_t', text: 'у меня всё' }],
    steps: [
      {
        events: [her('Спасибо! Дальше Глеб', true), { type: 'interrupted', text: 'почему ты молчала' }, heard('nevsky_g', 'почему ты раньше молчала')],
        expect: [[say(null, NO_BRIDGE)], [say(null, NO_BRIDGE), give('nevsky_g')], [give('nevsky_g', { text: /./ })]],
        forbid: [give('tkach_t'), ask('tkach_t'), say(/тим/i)],
        ideal: [{ action: 'give_word', person: 'nevsky_g', text: 'Ждала, пока попросят начать. Глеб, твоя очередь.' }],
      },
    ],
  },
  {
    id: 'chorus',
    title: 'двое заговорили хором посреди отчёта',
    source: 'design',
    level: 'soft',
    state: round('tkach_t', ['nevsky_g']),
    steps: [
      {
        events: [heard('tkach_t', 'сегодня делаю'), { type: 'chorus', who: ['tkach_t', 'nevsky_g'] }, heard('?', 'а я вот хотел сказать что')],
        expect: [SILENT, [say()]],
        forbid: [give('nevsky_g')],
        ideal: [{ action: 'skip' }],
      },
    ],
  },
  {
    id: 'lead_joins_mid_round',
    title: 'руководитель пришёл посреди чужого отчёта: не перебивать',
    source: 'design',
    state: round('tkach_t', ['nevsky_g'], ['nevsky_g', 'tkach_t']),
    steps: [
      {
        events: [{ type: 'joined', who: 'orlov_y' }, heard('tkach_t', 'и ещё ревью после обеда')],
        expect: [SILENT],
        forbid: [give('orlov_y')],
        ideal: [{ action: 'skip' }],
      },
    ],
  },

  {
    id: 'greet_misheard_name',
    title: '«Кора» расслышали как «хара» (прогон 2): лучше ответить, но молчание не провал',
    source: 'run2',
    level: 'soft',
    state: { phase: 'waiting', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g'] },
    steps: [
      {
        events: [heardRaw('nevsky_g', 'хара привет')],
        expect: [[say()], SILENT],
        forbid: [give(['tkach_t', 'nevsky_g'])],
        ideal: [{ action: 'say', text: 'Привет, Глеб!' }],
      },
    ],
  },
  {
    id: 'start_lead_absent',
    title: '«Кора, начинай», руководителя нет: первое слово первому из присутствующих',
    source: 'run1',
    state: { phase: 'waiting', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g'] },
    steps: [
      {
        events: [heard('nevsky_g', 'Кора, начинай')],
        expect: [[give(['tkach_t', 'nevsky_g'])]],
        ideal: [{ action: 'give_word', person: 'nevsky_g', text: 'Доброе утро, коллеги! Глеб, начнёшь?' }],
      },
    ],
  },
  {
    id: 'long_update_many_phrases',
    title: 'длинный отчёт: много фраз с паузами по секунде — молчать до «у меня всё»',
    source: 'design',
    state: round('nevsky_g', ['tkach_t'], ['orlov_y', 'nevsky_g', 'tkach_t', 'belozersky_s']),
    steps: [
      ...['вчера закончил миграцию базы', 'сегодня разбираю алерты после неё', 'потом созвон с подрядчиком по интеграции', 'там вопрос по срокам', 'если успею посмотрю ревью Тимура'].map((text) => ({
        events: [heard('nevsky_g', text), silence(1000)],
        expect: [SILENT],
        ideal: [{ action: 'skip' }],
      })),
      {
        events: [heard('nevsky_g', 'вот такие планы у меня всё'), silence(1000)],
        expect: [[give('tkach_t')]],
        ideal: [{ action: 'give_word', person: 'tkach_t', text: '' }],
      },
    ],
  },
  {
    id: 'speaker_hands_over',
    title: 'говорящий сам передал слово по имени, не по очереди',
    source: 'design',
    state: round('tkach_t', ['nevsky_g', 'orlov_y']),
    steps: [
      {
        events: [heard('tkach_t', 'у меня всё передаю Славе'), silence(1000)],
        expect: [[give('orlov_y')]],
        forbid: [give('nevsky_g')],
        ideal: [{ action: 'give_word', person: 'orlov_y', text: '' }],
      },
    ],
  },
  {
    id: 'next_in_queue_left',
    title: 'следующий по очереди ушёл из звонка',
    source: 'design',
    state: round('tkach_t', ['nevsky_g', 'orlov_y']),
    steps: [
      {
        events: [{ type: 'left', who: 'nevsky_g' }, { type: 'state', queue: ['orlov_y'] }, heard('tkach_t', 'у меня всё'), silence(1000)],
        expect: [[give('orlov_y')]],
        ideal: [{ action: 'give_word', person: 'orlov_y', text: '' }],
      },
    ],
  },
  {
    id: 'noise_in_turn',
    title: 'обрывки «а», «м» посреди отчёта',
    source: 'design',
    state: round('tkach_t', ['nevsky_g']),
    dialog: [{ who: 'tkach_t', text: 'сегодня делаю интеграцию' }],
    steps: [
      {
        events: [heardRaw('?', 'а'), heardRaw('tkach_t', 'м')],
        expect: [SILENT],
        ideal: [{ action: 'skip' }],
      },
    ],
  },
  {
    id: 'round_last_done',
    title: 'выступил последний: открыть слово всем',
    source: 'design',
    state: round('orlov_y', []),
    dialog: [{ who: 'host', text: 'Спасибо! Дальше Слава.' }],
    steps: [
      {
        events: [heard('orlov_y', 'по мне всё как планировали у меня всё'), silence(1000)],
        expect: [[{ action: 'open_floor' }]],
        forbid: [leave()],
        ideal: [{ action: 'open_floor' }],
      },
    ],
  },
  {
    id: 'her_line_cut',
    title: 'её перебили вопросом: выслушать, не договаривать своё',
    source: 'design',
    state: { phase: 'open_floor', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g', 'orlov_y'] },
    steps: [
      {
        events: [her('Все высказались. Кто хочет что-то', true), { type: 'interrupted', text: 'подожди' }, heard('nevsky_g', 'подожди Кора у меня вопрос к Славе')],
        expect: [SILENT],
        forbid: [say(/все высказались|добавить/i)],
        ideal: [{ action: 'skip' }],
      },
    ],
  },

  // ---- open floor and the end -----------------------------------------------------------------------
  {
    id: 'open_floor_question_to_her',
    title: 'после «кто хочет добавить?» спрашивают её без имени: ответить, вопрос не повторять',
    source: 'run1',
    state: { phase: 'open_floor', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g'] },
    steps: [
      {
        events: [her('Все высказались. Кто хочет что-то добавить или спросить?'), heard('tkach_t', 'ты нас вообще слышишь')],
        expect: [[say(/слыш|да/i, /добавить|спросить/i)]],
        forbid: [say(INVENTED), leave()],
        ideal: [{ action: 'say', text: 'Да, слышу вас обоих.' }],
      },
    ],
  },
  {
    id: 'open_floor_colleagues',
    title: 'на открытом слове коллеги обсуждают своё: слушать; затихли — прощаться или «кто-то ещё?»',
    source: 'design',
    state: { phase: 'open_floor', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g', 'orlov_y'] },
    steps: [
      {
        events: [her('Все высказались. Кто хочет что-то добавить или спросить?'), heard('nevsky_g', 'Слава, а ретро в пятницу будет?'), heard('orlov_y', 'да, в пятницу в четыре')],
        expect: [SILENT],
        ideal: [{ action: 'skip' }],
      },
      {
        events: [silence(6000)],
        expect: [[leave()], [say(/ещё|еще|кто-то|кто-нибудь/i, /все высказались/i)]],
        ideal: [{ action: 'leave', text: 'Тогда всем хорошей недели! Передаю слово на дев-синк.' }],
      },
    ],
  },
  {
    id: 'open_floor_nothing',
    title: '«нет, спасибо» на «кто хочет добавить?»: попрощаться',
    source: 'run1',
    state: { phase: 'open_floor', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g'] },
    steps: [
      {
        events: [her('Все высказались. Кто хочет что-то добавить или спросить?'), heard('tkach_t', 'нет спасибо'), silence(2000)],
        expect: [[leave()]],
        forbid: [say(/добавить|спросить/i)],
        ideal: [{ action: 'leave', text: 'Тогда всем хорошей недели! Передаю слово на дев-синк.' }],
      },
    ],
  },
  {
    id: 'open_floor_addition',
    title: 'на открытом слове добавили новость: принять и спросить, кто ещё',
    source: 'design',
    level: 'soft',
    state: { phase: 'open_floor', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g', 'orlov_y'] },
    steps: [
      {
        events: [her('Все высказались. Кто хочет что-то добавить или спросить?'), heard('nevsky_g', 'я добавлю: завтра деплой в шесть утра'), silence(2500)],
        expect: [[say()], SILENT],
        forbid: [leave()],
        ideal: [{ action: 'say', text: 'Принято, Глеб. Кто-то ещё?' }],
      },
    ],
  },
  {
    id: 'repeat_please',
    title: 'просят повторить её вопрос: повторить его',
    source: 'design',
    state: { phase: 'open_floor', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g'] },
    steps: [
      {
        events: [her('Все высказались. Кто хочет что-то добавить или спросить?'), heard('tkach_t', 'повтори пожалуйста я не расслышал')],
        expect: [[say(/добав|спрос/i)]],
        ideal: [{ action: 'say', text: 'Все высказались. Кто хочет что-то добавить или спросить?' }],
      },
    ],
  },
  {
    id: 'why_no_answers',
    title: '«почему ты не отвечаешь на вопросы?» (прогон 2): ответить по делу, без выдуманных правил',
    source: 'run2',
    state: { phase: 'open_floor', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g'] },
    dialog: [{ who: 'host', text: 'Все высказались. Кто хочет что-то добавить или спросить?' }],
    steps: [
      {
        events: [heard('nevsky_g', 'Кора, почему ты не отвечаешь на вопросы')],
        expect: [[say(null, INVENTED)]],
        forbid: [say(NO_BRIDGE)],
        ideal: [{ action: 'say', text: 'Прости, могла не расслышать. Повтори, пожалуйста, вопрос.' }],
      },
    ],
  },
  {
    id: 'everyone_left',
    title: 'все ушли: ни слова в пустую комнату',
    source: 'run2',
    state: { phase: 'open_floor', speaker: null, queue: [], present: ['tkach_t', 'nevsky_g'] },
    dialog: [{ who: 'nevsky_g', text: 'до свидания' }],
    steps: [
      {
        events: [{ type: 'left', who: 'tkach_t' }, { type: 'left', who: 'nevsky_g' }, silence(5000)],
        expect: [SILENT, [leave()]],
        forbid: [say(), give(['tkach_t', 'nevsky_g'])],
        ideal: [{ action: 'skip' }],
      },
    ],
  },
]);
