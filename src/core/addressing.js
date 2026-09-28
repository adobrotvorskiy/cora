// Is a recognized line addressed to her? SpeechKit gives no «?» and no commas, so this looks at her
// name, the words and the moment (right after her own line). Two users:
// - the old host (src/core/host.js, questionToHost): which lines wake the brain as questions to her;
// - the agent (src/agent/conductor.js): the output filter — in a group of 3+ a `say` during
//   someone's update goes out only when one of the lines it answers was addressed to her
//   (docs/agent_plan.md, «Остаётся в коде»).

export const QUESTION_RE = /\?\s*$|^(?:а\s+|и\s+|ну\s+|слушай[, ]+)?(?:кто|что|чего|как|какой|какая|какие|какое|почему|зачем|где|когда|откуда|куда|сколько|чем|чей|можешь|умеешь|расскажи|скажи)(?![\p{L}])/iu;
// STT gives no «?»: a question word among the first four words, not the indefinite «кто-то / что-нибудь»
export const QUESTION_NEAR_START_RE = /^(?:\S+\s+){0,3}(?:кто|что|чего|как|какой|какая|какие|какое|почему|зачем|где|когда|откуда|куда|сколько|чем|чей|можешь|умеешь|расскажи|скажи)(?![\p{L}])(?![\s-]+(?:то|нибудь|либо)(?![\p{L}]))/iu;
export const YOU_RE = /(?:^|[^\p{L}])(?:ты|тебя|тебе|тобой|твой|твоя|твоё|твое|твои)(?![\p{L}])/iu;
export const AI_RE = /(?:^|[^\p{L}])(?:ии|искусствен|нейросет|бот|робот|модель|ведущ|алгоритм|нейронк|железяк)/iu;
/** Words of a «nothing to add» reply to her open-floor question. */
export const NOTHING_TO_ADD = new Set(['нет', 'неа', 'не', 'да', 'спасибо', 'всё', 'все', 'ничего', 'вопросов', 'нечего', 'добавить', 'у', 'меня', 'нас', 'пожалуй', 'наверное', 'вроде', 'ок', 'окей', 'хорошо', 'пока', 'нету', 'никаких']);
/** «ты» this soon after her own line is to her. */
export const OWN_UTTERANCE_WINDOW_MS = 8000;

export const foldWords = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length >= 2);

/** Does the line look like a question (for questions to the host without her name)? */
export function looksLikeQuestion(text) {
  const s = String(text ?? '').trim();
  return Boolean(s) && QUESTION_RE.test(s);
}

/** «нет, спасибо», «да всё» — nothing to add. */
export function nothingToAdd(text) {
  return foldWords(text).every((w) => NOTHING_TO_ADD.has(w));
}

/**
 * The old host's rule: which lines are questions to her (they wake the brain with high priority).
 * @param {string} text
 * @param {{mentionsHost: (t: string) => boolean, phase: string, openFloorAsked?: boolean, present: number, sinceOwnLineMs?: number}} o
 * @returns {'name'|'open_floor'|'small_group'|'after_own_utterance'|'about_ai'|null}
 */
export function questionToHost(text, { mentionsHost, phase, openFloorAsked = false, present, sinceOwnLineMs = Infinity }) {
  if (mentionsHost(text)) return 'name';
  // her «кто хочет добавить или спросить?» in a 1:1: whatever the one person says next is for her, unless it is
  // «нет, спасибо» (live 27.09: STT gives no «?», and «а тут кто-то есть кроме меня» went unanswered)
  if (phase === 'open_floor' && openFloorAsked && present <= 1 && !nothingToAdd(text)) return 'open_floor';
  const question = looksLikeQuestion(text);
  if (question && present <= 2) return 'small_group';
  // a group: «ты» right after her own line is to her, even with the question word further in («а ты во сколько начнёшь»)
  if (sinceOwnLineMs < OWN_UTTERANCE_WINDOW_MS && YOU_RE.test(text) && (question || QUESTION_NEAR_START_RE.test(text))) return 'after_own_utterance';
  if (question && AI_RE.test(text)) return 'about_ai';
  return null;
}

/**
 * The agent's output filter: may she answer this line in a group? Wider than questionToHost —
 * the agent decides, this only blocks the clear cases of a line meant for a colleague.
 * «я тебе вопрос задал» right after her «Тима, всё?» (live 27.09, run 2) passes; «Тима, а по срокам
 * что?» does not.
 * @param {string} text
 * @param {{mentionsHost: (t: string) => boolean, present: number, sinceOwnLineMs?: number}} o
 * @returns {'name'|'small_group'|'after_own_utterance'|'about_ai'|null}
 */
export function mayAnswer(text, { mentionsHost, present, sinceOwnLineMs = Infinity }) {
  if (mentionsHost(text)) return 'name';
  // a small group: a question, «ты», or a reply to her line (live 28.09: she answered chit-chat between two people)
  if (present <= 2 && (looksLikeQuestion(text) || YOU_RE.test(text) || QUESTION_NEAR_START_RE.test(text) || sinceOwnLineMs < OWN_UTTERANCE_WINDOW_MS)) return 'small_group';
  if (sinceOwnLineMs < OWN_UTTERANCE_WINDOW_MS && YOU_RE.test(text)) return 'after_own_utterance';
  if (looksLikeQuestion(text) && AI_RE.test(text)) return 'about_ai';
  return null;
}
