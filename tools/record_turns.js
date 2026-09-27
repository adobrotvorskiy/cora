#!/usr/bin/env node
// Reading script for the recording session (docs/smart_turn_plan.md step 1): phrases shown one by
// one in the console, read aloud in the TEST room while the host records the slots. The labels
// (finished / cut off / pause in the middle) come from the script, so no hand labelling afterwards.
//
//   terminal 1: node tools/run_testroom.js --provider yandex_cascade --record --shadow --no-brain --max-minutes 12
//   terminal 2: node tools/record_turns.js [--seed 1]
//
// Enter shows the next phrase. Say it as written: finished ones with a normal ending; cut-off ones
// stop at «…» and stay silent ~3 s; «пауза» ones: the first half, ~2 s of silence, then the rest.
// The script with its order and labels goes to _internal/rec_script_<time>.json (fictional phrases,
// no names). The recording itself: _internal/rec_<time>/ (see the host log, event record.start).

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

export const FINISHED = Object.freeze([
  'вчера закрыл два бага, сегодня на ревью',
  'у меня всё',
  'сегодня добиваю интеграцию, потом созвон с клиентом, на этом всё',
  'планы на неделю: релиз в среду и ретро в пятницу',
  'блокеров нет',
  'вчера разбирал алерты, сегодня продолжаю',
  'как-то так',
  'сегодня весь день на собеседованиях',
  'закрыл задачу по отчётам, передаю дальше',
  'вопросов нет',
  'у меня сегодня отгул после обеда',
  'всё, спасибо',
  'завтра выкатываем новую версию',
  'нужна помощь с доступом к стенду',
  'сделал ревью, жду правок',
  'сегодня пишу документацию',
  'да, всё',
  'по срокам успеваем',
  'ничего нового, продолжаю ту же задачу',
  'на этом у меня всё',
]);

export const CUT_OFF = Object.freeze([
  'сегодня я доделываю интеграцию с…',
  'вчера я занимался, э-э…',
  'и ещё я хотел сказать, что…',
  'а потом нужно будет…',
  'по релизу у нас пока…',
  'я думаю, что если мы…',
  'сегодня план такой: сначала…',
  'там есть одна проблема с…',
  'ну и, значит…',
  'в общем, я…',
  'вчера весь день, м-м…',
  'надо ещё посмотреть, как…',
  'по задаче с отчётами, там…',
  'и после обеда я…',
  'короче, смысл в том, что…',
  'у нас с клиентом, ну…',
  'то есть, если…',
  'а ещё, э-э, по поводу…',
  'сегодня, наверное, займусь…',
  'и последнее, это…',
]);

/** First half (cut off, then ~2 s of silence) + the rest (finished). */
export const PAUSED = Object.freeze([
  ['сегодня я…', 'доделываю интеграцию с платёжкой'],
  ['вчера мы с командой…', 'разобрали все алерты'],
  ['по релизу…', 'всё идёт по плану'],
  ['у меня вопрос к…', 'тому, кто отвечает за стенд'],
  ['и ещё, э-э…', 'надо обновить документацию'],
  ['в пятницу…', 'ретро как обычно'],
]);

/** The session in a fixed pseudo-random order: [{n, kind, text, say, label}]. */
export function buildScript(seed = 1) {
  const items = [
    ...FINISHED.map((text) => ({ kind: 'finished', text, label: 'finished' })),
    ...CUT_OFF.map((text) => ({ kind: 'cut_off', text, label: 'unfinished' })),
    ...PAUSED.map(([a, b]) => ({ kind: 'paused', text: `${a} ${b}`, parts: [{ text: a, label: 'unfinished' }, { text: b, label: 'finished' }] })),
  ];
  let x = seed >>> 0 || 1; // xorshift: the same order for the same seed
  const rnd = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 2 ** 32;
  };
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items.map((it, i) => ({ n: i + 1, ...it, say: sayHint(it) }));
}

function sayHint(it) {
  if (it.kind === 'finished') return `«${it.text}» — и обычная пауза`;
  if (it.kind === 'cut_off') return `«${it.text}» — оборви на «…» и помолчи 3 с`;
  return `«${it.parts[0].text}» — помолчи 2 с — «${it.parts[1].text}»`;
}

async function main() {
  const { values } = parseArgs({ options: { seed: { type: 'string', default: '1' } } });
  const script = buildScript(Number(values.seed) || 1);
  const dir = join(process.cwd(), '_internal');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = join(dir, `rec_script_${stamp}.json`);
  writeFileSync(path, JSON.stringify({ seed: Number(values.seed) || 1, created: new Date().toISOString(), script }, null, 2));
  console.log(`Сценарий чтения: ${script.length} фраз, разметка — ${path}`);
  console.log('Бот должен уже быть в тест-комнате с --record --shadow --no-brain. Enter — следующая фраза, q — выход.\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (const it of script) {
    const answer = await rl.question(`(${it.n}/${script.length}) ${it.say}  `);
    if (answer.trim().toLowerCase() === 'q') break;
  }
  rl.close();
  console.log('\nГотово. Останови бота (Ctrl+C в первом терминале): запись закроется, её папка — в событии record.done лога.');
}

if (process.argv[1]?.endsWith('record_turns.js')) {
  main().catch((e) => {
    console.error(`error: ${e?.message ?? e}`);
    process.exit(1);
  });
}
