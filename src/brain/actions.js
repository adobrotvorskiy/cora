// The brain's output contract (PLAN.md §2 «Контракты»): exactly one action per call.
//
//   {"why":    short reason, log only (first, so the model states it before it decides),
//    "action": wait | speak | give_word | check_done | answer | post_chat | leave,
//    "to":     participant id | null,
//    "text":   null | ≤2 sentences, ≤220 chars, Russian, feminine self-reference,
//    "plan":   null (unchanged) | {"next": id | null, "then": [id, ...]}}
//
// What the host (WP6) does with each action:
//   wait         nothing now; a non-null plan replaces the queue
//   speak        say `text` to the room (`to` = optional addressee)
//   give_word    hand the floor to `to`; text = null -> a phrases.json clip picked by the host
//                (start_*_with/without_lead, handoff, handoff_lead_joined, return_to_skipped)
//   check_done   ask `to` whether they are done; text = null -> clip (check_done, are_you_here)
//   answer       reply to a question addressed to the host; the floor does not change hands
//   post_chat    write `text` to the meeting chat
//   leave        say `text` (farewell + dev-sync handoff; null -> clip closing_monday / closing_daily),
//                then leave the call
// Standard lines come from phrases.json verbatim (the prompt shows them), so the host's clip
// cache can serve a brain text that matches a pre-rendered clip.
// plan.next = who gets the word after the current speaker (the host's fast path plays the
// handoff clip for it without asking the brain); plan.then = the rest of the queue, in order.
//
// validate() = shape check + normalization. Ids are resolved against the context's
// participants (a display name maps to its id; an unknown `to` is an error, unknown plan ids are
// dropped with a warning: the model plans from the whole roster, absent people included). Text is sanitized
// (URLs, e-mails, IPs, key-like tokens, markdown, emoji and "..." pauses removed; masculine
// self-reference such as «я понял» fixed) and trimmed to the limits at a sentence boundary.
// Errors make client.js do one repair round-trip; warnings only go to the log.

export const ACTIONS = Object.freeze(['wait', 'speak', 'give_word', 'check_done', 'answer', 'post_chat', 'leave']);
/** Actions that must address a participant who is in the meeting. */
export const TARGET_ACTIONS = new Set(['give_word', 'check_done']);
/** Actions that must carry text. */
export const TEXT_ACTIONS = new Set(['speak', 'answer', 'post_chat']);
/** Key order of an action (why first: a one-line rationale improves the decision). */
export const ACTION_KEYS = Object.freeze(['why', 'action', 'to', 'text', 'plan']);
export const ACTION_SCHEMA_NAME = 'host_action';
export const TEXT_LIMITS = Object.freeze({ maxChars: 220, maxSentences: 2 });
const WHY_MAX = 200;
const SPEECH_ACTIONS = new Set(['speak', 'give_word', 'check_done', 'leave']);

/**
 * JSON schema for structured outputs (OpenAI strict mode: every property required,
 * additionalProperties false, optional values as null unions).
 */
export const ACTION_JSON_SCHEMA = deepFreeze({
  type: 'object',
  additionalProperties: false,
  required: [...ACTION_KEYS],
  properties: {
    why: { type: 'string', description: 'Зачем это действие, до 12 слов. Только в лог.' },
    action: { type: 'string', enum: [...ACTIONS] },
    to: { type: ['string', 'null'], description: 'id участника из participants или null.' },
    text: { type: ['string', 'null'], description: 'Реплика по-русски: не больше 2 предложений и 220 символов. Или null.' },
    plan: {
      description: 'null, если план не меняется.',
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['next', 'then'],
          properties: {
            next: { type: ['string', 'null'], description: 'Кому слово после текущего спикера.' },
            then: { type: 'array', items: { type: 'string' }, description: 'Остальные невыступившие по порядку.' },
          },
        },
        { type: 'null' },
      ],
    },
  },
});

/**
 * Key order of the output. settings.brain.why_last puts `why` at the end: `text` then closes earlier in
 * the stream and the host starts synthesizing it sooner (27.09: with `why` first `text` closed only
 * 2–20 ms before the end). Why-first may decide better: compare with tools/bench_brain.js --why-last.
 */
export function actionKeys({ whyLast = false } = {}) {
  return whyLast ? ['action', 'to', 'text', 'plan', 'why'] : [...ACTION_KEYS];
}

/** ACTION_JSON_SCHEMA with the properties in actionKeys() order (structured outputs follow it). */
export function actionJsonSchema({ whyLast = false } = {}) {
  if (!whyLast) return ACTION_JSON_SCHEMA;
  const keys = actionKeys({ whyLast });
  return deepFreeze({ ...ACTION_JSON_SCHEMA, required: keys, properties: Object.fromEntries(keys.map((k) => [k, ACTION_JSON_SCHEMA.properties[k]])) });
}

/** The same action with its keys in actionKeys() order (prompt examples). */
export function orderActionKeys(action, opts) {
  const keys = actionKeys(opts);
  return Object.fromEntries([...keys.filter((k) => k in action).map((k) => [k, action[k]]), ...Object.entries(action).filter(([k]) => !keys.includes(k))]);
}

/** A no-op action; `why` says why nothing happens (e.g. 'invalid_brain_output'). */
export function waitAction(why = '') {
  return { why, action: 'wait', to: null, text: null, plan: null };
}

/**
 * Extract one JSON object from model output: plain JSON, a ```json fence, or the first
 * balanced {...} inside surrounding prose.
 * @returns {{ok: true, value: object} | {ok: false, error: string}}
 */
export function parseActionText(content) {
  if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'empty output (expected one JSON object)' };
  let text = content.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence) text = fence[1];
  let value = tryParse(text);
  if (value === undefined) {
    const inner = firstJsonObject(text);
    if (inner) value = tryParse(inner);
  }
  if (value === undefined) return { ok: false, error: 'output is not valid JSON' };
  if (Array.isArray(value) && value.length === 1) value = value[0];
  if (!isPlainObject(value)) return { ok: false, error: 'output must be one JSON object' };
  return { ok: true, value };
}

/**
 * Top-level fields of a JSON object that is still streaming in, only those whose values are
 * complete: '{"why":"…","action":"answer","to":null,"text":"При' -> {why, action, to}. Anything
 * before the first «{» (a ```json fence, prose) is skipped. Lets the host start synthesizing
 * `text` while the model is still writing `plan`.
 * @param {string} content  model output so far
 * @returns {object}
 */
export function completedFields(content) {
  const s = String(content ?? '');
  const out = {};
  let i = s.indexOf('{');
  if (i < 0) return out;
  i++;
  for (;;) {
    i = skipSpace(s, i);
    if (s[i] === ',') i = skipSpace(s, i + 1);
    if (s[i] !== '"') return out;
    const keyEnd = scanJsonValue(s, i);
    if (keyEnd < 0) return out;
    const key = tryParse(s.slice(i, keyEnd));
    i = skipSpace(s, keyEnd);
    if (s[i] !== ':') return out;
    i = skipSpace(s, i + 1);
    const end = scanJsonValue(s, i);
    if (end < 0) return out;
    const value = tryParse(s.slice(i, end));
    if (typeof key !== 'string' || value === undefined) return out;
    out[key] = value;
    i = end;
  }
}

function skipSpace(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
}

/** End index (exclusive) of the JSON value starting at i, or -1 if it has not fully arrived yet. */
function scanJsonValue(s, i) {
  const c = s[i];
  if (c === '"') {
    for (let j = i + 1; j < s.length; j++) {
      if (s[j] === '\\') j++;
      else if (s[j] === '"') return j + 1;
    }
    return -1;
  }
  if (c === '{' || c === '[') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      const d = s[j];
      if (d === '"') {
        j = scanJsonValue(s, j) - 1;
        if (j < 0) return -1;
      } else if (d === '{' || d === '[') depth++;
      else if ((d === '}' || d === ']') && --depth === 0) return j + 1;
    }
    return -1;
  }
  // a literal (null, true, false, a number) is complete only once a delimiter follows it
  const m = /^[^\s,}\]]+(?=[\s,}\]])/.exec(s.slice(i));
  return m ? i + m[0].length : -1;
}

/**
 * Validate and normalize a raw action.
 * @param {unknown} raw  parsed model output
 * @param {object} [opts]
 * @param {{id: string, name?: string, present?: boolean, status?: string}[]} [opts.participants]  from the context
 * @param {object} [opts.context]  the full context: enables advisory warnings (speaking over someone, leaving early)
 * @param {{maxChars?: number, maxSentences?: number}} [opts.limits]
 * @returns {{ok: boolean, errors: string[], warnings: string[], action: object|null}}
 */
export function validate(raw, { participants = [], context = null, limits = {} } = {}) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) return { ok: false, errors: ['output must be one JSON object'], warnings, action: null };
  const lim = { ...TEXT_LIMITS, ...limits };
  const people = (Array.isArray(participants) ? participants : []).filter((p) => p && p.id != null);
  const byId = new Map(people.map((p) => [String(p.id), p]));
  const knownIds = () => [...byId.keys()].join(', ') || '(none)';

  for (const key of Object.keys(raw)) {
    if (!ACTION_KEYS.includes(key)) warnings.push(`unknown key "${key}" dropped`);
  }

  const action = typeof raw.action === 'string' ? raw.action.trim().toLowerCase() : raw.action;
  const actionOk = ACTIONS.includes(action);
  if (!actionOk) errors.push(`action must be one of ${ACTIONS.join('|')}; got ${JSON.stringify(raw.action ?? null)}`);

  let to = raw.to === undefined || raw.to === '' ? null : raw.to;
  let toError = false;
  if (to !== null) {
    const id = typeof to === 'string' ? resolveId(to, people) : null;
    if (!id) {
      errors.push(`to ${JSON.stringify(to)} is not a participant id; use one of: ${knownIds()}`);
      toError = true;
      to = null;
    } else {
      if (id !== to) warnings.push(`to "${to}" mapped to "${id}"`);
      to = id;
    }
  }
  if (TARGET_ACTIONS.has(action)) {
    if (!to && !toError) errors.push(`${action} needs "to" (a participant id)`);
    else if (to && byId.get(to)?.present === false) errors.push(`${action}: "${to}" is not in the meeting (present=false)`);
  }

  let text = raw.text === undefined ? null : raw.text;
  if (text !== null && typeof text !== 'string') {
    errors.push('text must be a string or null');
    text = null;
  }
  if (typeof text === 'string') {
    if (action === 'wait') {
      if (text.trim()) warnings.push('text dropped: wait says nothing');
      text = null;
    } else {
      const cleaned = sanitizeText(text, { maxChars: lim.maxChars, maxSentences: lim.maxSentences, keepLast: pinLastSentence(to, byId) });
      warnings.push(...cleaned.warnings);
      text = cleaned.text || null;
      if (text && !isMostlyRussian(text)) errors.push('text must be in Russian');
    }
  }
  if (TEXT_ACTIONS.has(action) && !text) errors.push(`${action} needs non-empty "text"`);

  let plan = raw.plan === undefined ? null : raw.plan;
  if (plan !== null) {
    if (!isPlainObject(plan)) {
      errors.push('plan must be {"next": id|null, "then": [ids]} or null');
      plan = null;
    } else {
      // live 27.09: the model put absent roster people into the plan; a repair round-trip cost 1.4 s or
      // the whole decision. Unknown and absent ids are dropped with a warning instead.
      const planId = (value) => {
        const id = typeof value === 'string' ? resolveId(value, people) : null;
        return id && byId.get(id)?.present !== false ? id : null;
      };
      let next = plan.next === undefined || plan.next === '' ? null : plan.next;
      let dropped = 0;
      if (next !== null) {
        const id = planId(next);
        if (!id) {
          warnings.push(`plan.next ${JSON.stringify(next)} is not a present participant: dropped`);
          dropped++;
        }
        next = id;
      }
      let then = plan.then ?? [];
      if (!Array.isArray(then)) {
        errors.push('plan.then must be an array of participant ids');
        then = [];
      }
      const seen = new Set(next ? [next] : []);
      const queue = [];
      for (const item of then) {
        const id = planId(item);
        if (!id) {
          warnings.push(`plan.then: ${JSON.stringify(item)} is not a present participant: dropped`);
          dropped++;
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push(id);
      }
      if (!next && queue.length && dropped) next = queue.shift();
      // nothing valid left of a plan that named people: keep the host's plan (null = unchanged), not an empty one
      plan = dropped && !next ? null : { next, then: queue };
    }
  }

  const why = typeof raw.why === 'string' ? raw.why.replace(/\s+/g, ' ').trim().slice(0, WHY_MAX) : '';
  const out = { why, action: actionOk ? action : null, to, text, plan };
  if (context && errors.length === 0) warnings.push(...contextWarnings(out, context, byId));
  return { ok: errors.length === 0, errors, warnings, action: out };
}

/** Alias kept for readers of the WP5 brief: normalization is part of validate(). */
export const normalizeAction = validate;

// ---------------------------------------------------------------- text

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/giu;
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const IPV4_RE = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?(?![\d.])/g;
const KEY_PREFIX_RE = /(?<![\p{L}\p{N}])(?:sk|pk|rk|ghp|gho|glpat|xox[abp]|AKIA|AIza)[-_A-Za-z0-9]{8,}/gu;
// 16+ ASCII letters/digits/-/_ with at least one letter and one digit: tokens, hashes, ids.
const SECRETISH_RE = /(?<![\p{L}\p{N}_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{16,}(?![\p{L}\p{N}_-])/gu;
const LONG_DIGITS_RE = /(?<!\d)\+?\d(?:[\s-]?\d){9,}(?!\d)/g; // phone / account numbers
const EMOJI_RE = /\p{Extended_Pictographic}️?|[​-‍⁠﻿]/gu;
const STRESS_RE = /[̀́]/g; // combining grave/acute stress marks («Яросла́в»)
const SENTENCE_RE = /[^]*?[.!?…]+["»”'’)\]]*(?=\s|$)|[^]+$/gu;

/** Split into sentences at . ! ? … followed by whitespace or the end ("5.4" stays whole). */
export function splitSentences(text) {
  const out = [];
  for (const m of String(text).matchAll(SENTENCE_RE)) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * Make model text safe to speak: strip URLs, e-mails, IPs, key-like tokens, long numbers,
 * markdown, emoji and "..." pauses; fix masculine self-reference; trim to the limits.
 * @param {string} input
 * @param {{maxChars?: number, maxSentences?: number, keepLast?: (sentence: string) => boolean}} [opts]
 * @returns {{text: string, warnings: string[]}}
 */
export function sanitizeText(input, { maxChars = TEXT_LIMITS.maxChars, maxSentences = TEXT_LIMITS.maxSentences, keepLast = null } = {}) {
  const warnings = [];
  let text = String(input ?? '');
  const raw = text;
  text = text
    .replace(URL_RE, ' ')
    .replace(EMAIL_RE, ' ')
    .replace(IPV4_RE, ' ')
    .replace(KEY_PREFIX_RE, ' ')
    .replace(SECRETISH_RE, ' ')
    .replace(LONG_DIGITS_RE, ' ');
  if (text !== raw) warnings.push('text: removed a URL / e-mail / address / key-like token');
  text = text
    .replace(EMOJI_RE, '')
    .replace(STRESS_RE, '') // names stay plain: the voice layer adds stress from people.json "spoken"
    .replace(/[*#`~|<>\\]/g, '')
    .replace(/_/g, ' ')
    .replace(/(?:…|\.{3,})(?=["»”')\]]*(?:\s|$))/g, '.') // no long pauses: "Ждём…" -> "Ждём."
    .replace(/…|\.{3,}/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?:;])/g, '$1')
    .replace(/[,;:]+(?=[.!?])/g, '')
    .replace(/([,;:]){2,}/g, '$1')
    .replace(/\(\s*\)|\[\s*\]/g, '')
    .replace(/^[\s,.;:!?—–-]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const quoted = /^["«„“'](.*)["»“”']$/su.exec(text);
  if (quoted && !/["«»“”„]/.test(quoted[1])) text = quoted[1].trim();

  const fem = fixFeminine(text);
  if (fem.fixes.length) {
    text = fem.text;
    warnings.push(`text: feminine forms fixed (${fem.fixes.join(', ')})`);
  }
  const trimmed = trimText(text, { maxChars, maxSentences, keepLast });
  if (trimmed !== text) {
    warnings.push(`text: trimmed from ${text.length} to ${trimmed.length} chars (limits ${maxSentences} sentences / ${maxChars} chars)`);
    text = trimmed;
  }
  return { text, warnings };
}

/** Sentences shorter than this («Доброе утро, коллеги!», «Ярослав, начнёшь?») do not count toward maxSentences. */
export const SHORT_SENTENCE_CHARS = 24;

/**
 * Trim to maxSentences / maxChars at sentence boundaries. Short greetings and addresses do
 * not count as sentences (phrases.json lines look like «Доброе утро, коллеги! Понедельник,
 * говорим про фокус на неделю. Ярослав, начнёшь?»), but at most maxSentences + 2 are kept.
 * Keeps sentences from the start; when keepLast(lastSentence) is true (a handoff to `to`,
 * the dev-sync handoff, a question to the room) the last sentence survives instead of the
 * middle. A first sentence longer than maxChars is cut at a clause or word boundary.
 */
export function trimText(text, { maxChars = TEXT_LIMITS.maxChars, maxSentences = TEXT_LIMITS.maxSentences, keepLast = null } = {}) {
  const sentences = splitSentences(text);
  const fits = (list) => list.filter((s) => s.length >= SHORT_SENTENCE_CHARS).length <= maxSentences && list.length <= maxSentences + 2;
  if (fits(sentences) && text.length <= maxChars) return text;
  if (sentences.length === 0) return '';
  const last = sentences[sentences.length - 1];
  const pin = sentences.length > 1 && typeof keepLast === 'function' && keepLast(last) && last.length <= maxChars && fits([last]);
  const pool = pin ? sentences.slice(0, -1) : sentences;
  const kept = [];
  let length = pin ? last.length : 0;
  for (const s of pool) {
    const add = s.length + (length > 0 ? 1 : 0);
    if (length + add > maxChars || !fits(pin ? [...kept, s, last] : [...kept, s])) break;
    kept.push(s);
    length += add;
  }
  if (pin) kept.push(last);
  return kept.length ? kept.join(' ') : cutAtWord(sentences[0], maxChars);
}

function cutAtWord(sentence, max) {
  if (sentence.length <= max) return sentence;
  const hard = sentence.slice(0, max - 1); // room for the final period
  const clause = Math.max(hard.lastIndexOf(', '), hard.lastIndexOf('; '), hard.lastIndexOf(' — '), hard.lastIndexOf(': '));
  const cut = clause >= max * 0.5 ? hard.slice(0, clause) : hard.slice(0, Math.max(hard.lastIndexOf(' '), 1));
  return `${cut.replace(/[\s,;:—–-]+$/u, '')}.`;
}

// Feminine self-reference safety net (persona §3: «О себе только в женском роде»). Only
// fixes words right after «я» (optionally with particles) plus a few self-report openers,
// so addressing a male colleague («Тимур, ты готов?») is never touched.
const PARTICLE =
  '(?:не|уже|тоже|же|ведь|просто|только|сейчас|сразу|бы|вот|так|ещё|еще|очень|правда|честно|точно|сегодня|всегда|была|буду' +
  '|вас|тебя|его|её|ее|их|вам|тебе|ему|ей|им|это|всё|все|вроде|наверное)';
const SELF = `(?<!\\p{L})([Яя])((?:\\s+${PARTICLE})*\\s+)`;
const FEM_WORDS = {
  рад: 'рада', готов: 'готова', уверен: 'уверена', должен: 'должна', согласен: 'согласна', обязан: 'обязана',
  способен: 'способна', намерен: 'намерена', счастлив: 'счастлива', занят: 'занята', свободен: 'свободна',
  прав: 'права', виноват: 'виновата', благодарен: 'благодарна', вынужден: 'вынуждена', сам: 'сама',
  один: 'одна', создан: 'создана', новенький: 'новенькая', ошибся: 'ошиблась', мог: 'могла', смог: 'смогла',
  помог: 'помогла', пришёл: 'пришла', пришел: 'пришла', ушёл: 'ушла', ушел: 'ушла', шёл: 'шла', шел: 'шла',
  нашёл: 'нашла', нашел: 'нашла', зашёл: 'зашла', зашел: 'зашла', вышел: 'вышла', дошёл: 'дошла', дошел: 'дошла',
  подошёл: 'подошла', подошел: 'подошла', перешёл: 'перешла', перешел: 'перешла', привык: 'привыкла',
};
const FEM_WORD_RE = new RegExp(`${SELF}(${Object.keys(FEM_WORDS).join('|')})(?!\\p{L})`, 'giu');
const PAST_RE = new RegExp(`${SELF}(\\p{Ll}{2,}?л)(ся)?(?!\\p{L})`, 'gu'); // «я понял» -> «я поняла», «я старался» -> «я старалась»
const OPENERS = {
  понял: 'поняла', услышал: 'услышала', принял: 'приняла', ошибся: 'ошиблась', перепутал: 'перепутала',
  пропустил: 'пропустила', забыл: 'забыла', 'не расслышал': 'не расслышала', 'не понял': 'не поняла', рад: 'рада',
};
const OPENER_RE = new RegExp(`(^|[.!?]\\s+)(${Object.keys(OPENERS).join('|')})(?=[\\s,.!?]|$)`, 'giu');

/** @returns {{text: string, fixes: string[]}} */
export function fixFeminine(input) {
  const fixes = [];
  const note = (from, to) => {
    fixes.push(`${from}→${to}`);
    return to;
  };
  const byDict = (m, ya, gap, word) => `${ya}${gap}${note(word, matchCase(word, FEM_WORDS[word.toLowerCase()]))}`;
  let text = String(input);
  text = text.replace(FEM_WORD_RE, byDict);
  text = text.replace(PAST_RE, (m, ya, gap, stem, sya) => `${ya}${gap}${note(stem + (sya ?? ''), stem + (sya ? 'ась' : 'а'))}`);
  text = text.replace(FEM_WORD_RE, byDict); // «я был рад» -> «я была рад» -> «я была рада»
  text = text.replace(OPENER_RE, (m, lead, word) => `${lead}${note(word, matchCase(word, OPENERS[word.toLowerCase()]))}`);
  return { text, fixes };
}

function matchCase(original, replacement) {
  return original[0] === original[0].toUpperCase() ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
}

function isMostlyRussian(text) {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 8) return true;
  const cyrillic = letters.filter((ch) => /[Ѐ-ӿ]/.test(ch)).length;
  return cyrillic / letters.length >= 0.3;
}

// Keep the last sentence when trimming if it carries the point: a handoff to `to`,
// the dev-sync handoff, or a question to the room («Никто не против?»).
function pinLastSentence(to, byId) {
  const name = to ? plain(String(byId.get(to)?.name ?? '').split(/\s+/)[0]) : '';
  const stem = name.length >= 4 ? name.slice(0, 4) : null;
  return (sentence) => {
    const s = plain(sentence);
    return /[?]["»”)]*$/.test(sentence) || /дев[\s-]?синк/.test(s) || (stem !== null && s.includes(stem));
  };
}

function contextWarnings(action, context, byId) {
  const warnings = [];
  const speaker = context.speaker;
  const talking = speaker?.id && Number.isFinite(speaker.silence_ms) && speaker.silence_ms < 700;
  if (talking && SPEECH_ACTIONS.has(action.action) && context.trigger !== 'question_to_host') {
    warnings.push(`${action.action} while ${speaker.id} is talking (silence ${speaker.silence_ms} ms): the floor gate must hold it`);
  }
  if (action.action === 'give_word' && byId.get(action.to)?.status === 'spoke') warnings.push(`give_word to ${action.to}, who already spoke`);
  if (action.action === 'leave' && ['waiting', 'starting', 'round'].includes(context.phase)) {
    const waiting = [...byId.values()].filter((p) => p.present !== false && (p.status === 'pending' || p.status === 'speaking'));
    if (waiting.length) warnings.push(`leave in phase ${context.phase} with ${waiting.length} participant(s) not done`);
  }
  return warnings;
}

function resolveId(value, people) {
  const v = String(value).trim().replace(/^@/, '');
  if (!v) return null;
  const exact = people.find((p) => String(p.id) === v);
  if (exact) return String(exact.id);
  const low = plain(v);
  const unique = (list) => (list.length === 1 ? String(list[0].id) : null);
  return (
    unique(people.filter((p) => plain(p.id) === low)) ??
    unique(people.filter((p) => typeof p.name === 'string' && plain(p.name) === low)) ??
    unique(people.filter((p) => typeof p.name === 'string' && plain(p.name).split(/\s+/)[0] === low))
  );
}

/** Lower case, no stress marks, ё = е: for matching names. */
function plain(s) {
  return String(s).replace(STRESS_RE, '').toLowerCase().replace(/ё/g, 'е');
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function firstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
