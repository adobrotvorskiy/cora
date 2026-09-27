// Skills for the agent (docs/agent_plan.md, step 5): the playbook is cut into blocks by its «##»
// sections; a request carries the common blocks and the blocks of the current phase, not the whole
// playbook (AI Studio does not cache the prompt: ~7k tokens on every call for the old brain).
//
//   const skills = playbookSkills(markdown, { scheduled });   // {common, waiting, round, open_floor, sections}
//   skills.round -> text of the sections for the round
//
// Which section goes where — by its heading (the variant tags [по расписанию] / [по требованию] are
// resolved first, src/brain/prompt.js playbookForMode). A heading not in SECTION_PHASES goes to every
// phase, so a new section in the local playbook is never lost; SKIP drops sections the code handles
// or that describe the old brain's JSON actions.

import { playbookForMode } from '../brain/prompt.js';

export const PHASES = Object.freeze(['waiting', 'round', 'open_floor']);
const ALL = PHASES;
const SKIP = Object.freeze([]);

/** Heading (lower case, no tag) -> phases. */
export const SECTION_PHASES = Object.freeze({
  роль: ALL,
  всегда: ALL,
  'вопросы к тебе': ALL,
  старт: ['waiting'],
  очередь: ['round'],
  'пока человек говорит': ['round'],
  время: ['round', 'open_floor'],
  финал: ['open_floor'],
  'стоп-фразы': SKIP, // the code: «Кора, стоп» / «Кора, уйди» never reach the agent
  'как это ложится на действия': SKIP, // the old brain's actions (wait / answer / check_done)
});

const norm = (h) =>
  String(h ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
const PHASES_BY_NORM = new Map(Object.entries(SECTION_PHASES).map(([k, v]) => [norm(k), v]));

/**
 * @param {string} markdown  playbook.md
 * @param {{scheduled?: boolean}} [o]
 * @returns {{common: string, waiting: string, round: string, open_floor: string, sections: {title: string, phases: string[]}[]}}
 */
export function playbookSkills(markdown, { scheduled = false } = {}) {
  const text = playbookForMode(markdown ?? '', { scheduled });
  const parts = text.split(/^##\s+/m);
  parts.shift(); // the intro under «# Плейбук…»: framing, not rules — left out to keep a request under ~3k tokens
  const sections = [];
  const out = { common: [], waiting: [], round: [], open_floor: [] };
  for (const part of parts) {
    const nl = part.indexOf('\n');
    const title = (nl >= 0 ? part.slice(0, nl) : part).trim();
    const body = (nl >= 0 ? part.slice(nl + 1) : '').trim();
    if (!body) continue;
    const phases = PHASES_BY_NORM.get(norm(title)) ?? ALL;
    sections.push({ title, phases: [...phases] });
    if (!phases.length) continue;
    const block = `## ${title}\n${body}`;
    if (phases.length === ALL.length) out.common.push(block);
    else for (const p of phases) out[p].push(block);
  }
  return { common: out.common.join('\n\n'), waiting: out.waiting.join('\n\n'), round: out.round.join('\n\n'), open_floor: out.open_floor.join('\n\n'), sections };
}
