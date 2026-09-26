// Meeting state (WP6): roster matching, ghosts, presence, plan, Orlov principle.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createState, loadRoster, matchPerson, nameTokens } from '../../src/core/state.js';

// The fixture keeps namesakes and the ids these tests use; the real config/people.json is checked separately below.
const roster = loadRoster({ path: join(import.meta.dirname, '..', 'fixtures', 'people_test.json') });
const real = loadRoster();
const tile = (name, extra = {}) => ({ name, isSelf: false, muted: false, cameraOn: false, speaking: false, trackId: '', visible: true, ...extra });
const settings = { times: { start: '10:00', wait_lead_until: '10:02', soft_deadline: '10:28', hard_deadline: '10:30', force_leave: '10:35' } };

function mk({ now = 1_000_000 } = {}) {
  let t = now;
  const state = createState({ roster, settings, dayMode: 'monday_focus', now: () => t, hostName: 'Кора (ИИ-ведущая)' });
  return { state, tick: (ms) => (t += ms), now: () => t };
}

describe('roster matching', () => {
  test('whole-word alias match, case/ё/stress insensitive, extra tokens allowed', () => {
    assert.equal(matchPerson('Ярослав Орлов', roster.people)?.id, 'orlov_y');
    assert.equal(matchPerson('Orlov Yaroslav (Acme)', roster.people)?.id, 'orlov_y');
    assert.equal(matchPerson('ОРЛОВ ЯРОСЛАВ', roster.people)?.id, 'orlov_y');
    assert.equal(matchPerson('Алина Смирнова', roster.people)?.id, 'smirnova_a');
    assert.equal(matchPerson('Алина Смирнова', roster.people)?.id, 'smirnova_a');
    assert.equal(matchPerson('Андрей Орлов', roster.people)?.id, 'orlov_andrey');
  });

  test('substrings are not matches: «Матвей Степанов» is not Ярослав, bare names are nobody', () => {
    assert.equal(matchPerson('Матвей Степанов', roster.people)?.id, 'stepanov_m');
    assert.equal(matchPerson('Ярослав', roster.people), null);
    assert.equal(matchPerson('Орлов', roster.people), null);
    assert.equal(matchPerson('Иван Петров', roster.people), null);
    assert.deepEqual(nameTokens('  Тимур   Ткач (Tech Lead) '), ['тимур', 'ткач', 'tech', 'lead']);
  });

  test('single-word aliases («Игнат», «Савва») match whole words in longer Telemost names', () => {
    assert.equal(matchPerson('Игнат', roster.people)?.id, 'ignat');
    assert.equal(matchPerson('Игнат Иванов', roster.people)?.id, 'ignat');
    assert.equal(matchPerson('Ignat (Acme)', roster.people)?.id, 'ignat');
    assert.equal(matchPerson('Савва', roster.people)?.id, 'boyko_s');
    assert.equal(matchPerson('Игнатович Петров', roster.people), null, 'no substring match');
  });

  test('the real config/people.json: every display name and first-name alias resolves, Orlov only by full name', () => {
    assert.ok(real.people.length >= 8, 'real roster loaded');
    assert.equal(real.firstAlways, 'orlov_y');
    for (const p of real.people) {
      assert.equal(matchPerson(p.display, real.people)?.id, p.id, p.display);
      assert.equal(matchPerson(`${p.display} (Acme)`, real.people)?.id, p.id, `${p.display} with a suffix`);
    }
    assert.equal(matchPerson('Ярослав', real.people), null, 'a guest named Ярослав is not Orlov');
    assert.equal(matchPerson('Слава Орлов', real.people)?.id, 'orlov_y');
    assert.equal(matchPerson('Игнат', real.people)?.id, 'ignat');
    assert.equal(matchPerson('Игнат Галиев', real.people)?.id, 'ignat');
    assert.equal(matchPerson('Тима', real.people)?.id, 'tkach_t');
    const s = createState({ roster: real, settings: {}, dayMode: 'daily_plans', now: () => 1, hostName: 'Кора (ИИ-ведущая)' });
    s.applyParticipants([tile('Игнат'), tile('Сергей Белозерский'), tile('Ярослав Орлов')]);
    assert.deepEqual(s.presentIds(), ['orlov_y', 'belozersky_s', 'ignat']);
    assert.equal(s.vocative('belozersky_s'), 'Серёжа');
    assert.equal(s.vocative('orlov_y'), 'Сла́ва');
  });
});

describe('presence', () => {
  test('ignore list, self tile and ghost duplicates', () => {
    const { state } = mk();
    const diff = state.applyParticipants([
      tile('Кора (ИИ-ведущая)', { isSelf: true }),
      tile('Кора (ИИ-ведущая)'), // ghost of ourselves after a crash
      tile('Синк Стендапов'),
      tile('Тимур Ткач', { trackId: 'abc' }),
      tile('Тимур Ткач'), // ghost
      tile('Ярослав Орлов'),
    ]);
    assert.deepEqual(diff.joined, ['orlov_y', 'tkach_t']);
    assert.deepEqual(state.presentIds(), ['orlov_y', 'tkach_t']);
    assert.equal(state.get('tkach_t').tiles, 2);
    assert.equal(state.get('tkach_t').track_id, 'abc');
    assert.equal(state.get('orlov_y').status, 'pending');
    assert.equal(state.leadPresent(), true);
    assert.ok(!state.all().some((r) => r.name.includes('Кора') || r.name.includes('Синк')));
  });

  test('unknown names become guests, listed last in the default order', () => {
    const { state } = mk();
    state.applyParticipants([tile('Иван Петров'), tile('Глеб Невский')]);
    const guest = state.all().find((r) => !r.known);
    assert.ok(guest && guest.id.startsWith('guest_'));
    assert.equal(guest.name, 'Иван Петров');
    assert.deepEqual(state.defaultOrder(), ['nevsky_g', guest.id]);
    assert.equal(state.vocative(guest.id), 'Иван');
    assert.deepEqual(state.pendingIds(), ['nevsky_g'], 'guests never enter the pending queue on their own');
  });

  test('leaving and coming back: absent -> pending again, plan updated', () => {
    const { state, tick } = mk();
    state.applyParticipants([tile('Ярослав Орлов'), tile('Тимур Ткач'), tile('Глеб Невский')]);
    state.setPlan({ next: 'tkach_t', then: ['nevsky_g'] });
    tick(1000);
    const d1 = state.applyParticipants([tile('Ярослав Орлов'), tile('Глеб Невский')]);
    assert.deepEqual(d1.left, ['tkach_t']);
    assert.equal(state.get('tkach_t').status, 'absent');
    assert.deepEqual(state.plan, { next: 'nevsky_g', then: [] }, 'the queue shifts up');
    tick(1000);
    const d2 = state.applyParticipants([tile('Ярослав Орлов'), tile('Глеб Невский'), tile('Тимур Ткач')]);
    assert.deepEqual(d2.joined, ['tkach_t']);
    assert.equal(state.get('tkach_t').status, 'pending');
    state.planInsert('tkach_t', { front: false });
    assert.deepEqual(state.plan, { next: 'nevsky_g', then: ['tkach_t'] });
  });
});

describe('turns and plan', () => {
  test('Orlov first, roster order after; giveWord/finishTurn statuses', () => {
    const { state } = mk();
    state.applyParticipants([tile('Глеб Невский'), tile('Тимур Ткач'), tile('Ярослав Орлов')]);
    assert.deepEqual(state.pendingIds(), ['orlov_y', 'nevsky_g', 'tkach_t']);
    state.setPhase('round');
    state.giveWord('orlov_y');
    assert.equal(state.current, 'orlov_y');
    assert.equal(state.get('orlov_y').status, 'speaking');
    const plan = state.ensurePlan();
    assert.deepEqual(plan, { next: 'nevsky_g', then: ['tkach_t'] });
    state.finishTurn();
    assert.equal(state.get('orlov_y').status, 'spoke');
    assert.equal(state.current, null);
    state.giveWord('nevsky_g');
    assert.deepEqual(state.plan, { next: 'tkach_t', then: [] });
    state.finishTurn({ status: 'skipped' });
    assert.equal(state.get('nevsky_g').status, 'skipped');
    assert.deepEqual(state.defaultOrder(), ['tkach_t', 'nevsky_g'], 'skipped people come back at the end');
  });

  test('late Orlov goes to the front of the plan; a late joiner to the end; the brain plan is validated', () => {
    const { state, tick } = mk();
    state.applyParticipants([tile('Тимур Ткач'), tile('Глеб Невский'), tile('Нина Белозерская')]);
    state.setPhase('round');
    state.giveWord('tkach_t');
    state.ensurePlan();
    tick(5000);
    state.applyParticipants([tile('Тимур Ткач'), tile('Глеб Невский'), tile('Нина Белозерская'), tile('Ярослав Орлов')]);
    state.planInsert('orlov_y', { front: true });
    assert.deepEqual(state.plan, { next: 'orlov_y', then: ['nevsky_g', 'belozerskaya_n'] });
    state.applyParticipants([tile('Тимур Ткач'), tile('Глеб Невский'), tile('Нина Белозерская'), tile('Ярослав Орлов'), tile('Савва Бойко')]);
    state.planInsert('boyko_s');
    assert.deepEqual(state.plan.then, ['nevsky_g', 'belozerskaya_n', 'boyko_s']);
    // brain plan with an absent id and the current speaker: both dropped
    state.setPlan({ next: 'nevsky_g', then: ['rybakov_o', 'tkach_t', 'orlov_y', 'belozerskaya_n'] });
    assert.deepEqual(state.plan, { next: 'nevsky_g', then: ['orlov_y', 'belozerskaya_n'] });
  });

  test('vocative adds the surname only when a namesake is present', () => {
    const { state } = mk();
    state.applyParticipants([tile('Олег Рыбаков')]);
    assert.equal(state.vocative('rybakov_o'), 'О́лег');
    state.applyParticipants([tile('Олег Рыбаков'), tile('Олег Лапин')]);
    assert.equal(state.vocative('rybakov_o'), 'О́лег Рыбако́в');
    assert.equal(state.vocative('lapin_o'), 'О́лег Ла́пин');
    assert.equal(state.vocative('orlov_y'), 'Яросла́в');
  });
});

describe('context snapshot (Orlov principle)', () => {
  test('lead_present, statuses and plan land in the snapshot', () => {
    const { state } = mk();
    state.applyParticipants([tile('Тимур Ткач')]);
    let snap = state.snapshot({ trigger: 'timer' });
    assert.equal(snap.lead_present, false);
    assert.equal(snap.phase, 'waiting');
    assert.equal(snap.day_mode, 'monday_focus');
    assert.deepEqual(snap.deadline, { soft: '10:28', hard: '10:30' });
    assert.equal(snap.participants.find((p) => p.id === 'tkach_t').status, 'pending');
    state.applyParticipants([tile('Тимур Ткач'), tile('Ярослав Орлов')]);
    state.setPhase('round');
    state.giveWord('orlov_y');
    state.finishTurn();
    state.giveWord('tkach_t');
    state.setStatus('tkach_t', 'skipped');
    snap = state.snapshot({ trigger: 'turn_end_candidate' });
    assert.equal(snap.lead_present, true);
    assert.equal(snap.participants.find((p) => p.id === 'orlov_y').status, 'spoke');
    assert.equal(snap.participants.find((p) => p.id === 'tkach_t').status, 'pending', 'skipped is pending for the brain');
    assert.equal(snap.trigger, 'turn_end_candidate');
    assert.ok(snap.now instanceof Date);
    assert.equal(state.timeAt('hard_deadline') > 0, true);
  });
});
