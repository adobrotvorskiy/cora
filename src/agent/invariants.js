// What the agent may never do, whatever the model says (docs/agent_plan.md, «Остаётся в коде»).
// One list for the scenario runner (a violation fails the step) and the agent host (a violation
// rejects the call and the agent gets `rejected {tool, reason}` on its next wake).
//
//   violation(action, situation, {leadId, askedByName}) -> null | reason
//   situation = {phase, speaker, queue, present}; askedByName: a line she answers named her
//   («Кора, заканчивай»: she may say goodbye before the round is over — live 28.09)

/** «Тима, продолжай» after an answer (live 27.09, run 2): the host returns the floor itself. The imperative only («Хорошо, продолжаем.» is fine — review 28.09). */
export const NO_BRIDGE = /,\s*продолжай(те)?(?![\p{L}])/iu;
/** Rules about herself the model made up (live 27.09, run 2). Not «не вмешиваюсь»: the playbook says so itself (review 28.09). */
export const INVENTED = /не отвечаю на вопросы|таковы правила|мне нельзя|мне запрещено/i;
/** The text contract of the old brain: at most ~2 sentences / 220 chars. */
export const MAX_TEXT_CHARS = 220;

/**
 * @param {{action: string, person?: string|null, text?: string|null}} a
 * @param {{phase: string, speaker?: string|null, queue?: string[], present?: string[]}} sit
 * @param {{leadId?: string|null, askedByName?: boolean}} [opts]
 * @returns {string|null} why the action is not allowed
 */
export function violation(a, sit, { leadId = null, askedByName = false } = {}) {
  const present = new Set(sit.present ?? []);
  const text = typeof a.text === 'string' ? a.text : '';
  if (text) {
    if (NO_BRIDGE.test(text)) return 'bridge';
    if (INVENTED.test(text)) return 'invented_rule';
    if (text.length > MAX_TEXT_CHARS) return 'too_long';
  }
  switch (a.action) {
    case 'say':
      return present.size ? null : 'empty_room';
    case 'give_word':
      if (!a.person || !present.has(a.person)) return 'not_present';
      if (a.person === sit.speaker) return 'already_has_the_floor';
      if (sit.phase === 'waiting' && leadId && present.has(leadId) && a.person !== leadId) return 'lead_goes_first';
      return null;
    case 'ask_done':
      return sit.speaker && a.person === sit.speaker ? null : 'not_the_speaker';
    case 'open_floor':
      if (sit.phase !== 'round') return 'not_in_round';
      return (sit.queue ?? []).some((id) => present.has(id) && id !== sit.speaker) ? 'queue_not_empty' : null;
    case 'leave':
      return sit.phase === 'open_floor' || !present.size || askedByName ? null : 'round_not_finished';
    default:
      return null;
  }
}
