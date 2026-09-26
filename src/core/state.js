// Meeting state (WP6): roster from config/people.json matched to Telemost participant names,
// presence, per-person status, phase, the speaking plan and the brain-context snapshot.
//
//   const state = createState({ roster: loadRoster(), settings, dayMode, now });
//   const diff = state.applyParticipants(tiles);   // [{name, isSelf, muted, cameraOn, speaking, trackId, visible}]
//   state.giveWord('tkach_t'); state.finishTurn(); state.setPlan({next, then});
//   state.snapshot({trigger, speaker, host, recent_events, transcript_window})  -> context.js input
//
// Name matching (docs/content_notes.md): whole-word tokens, case-insensitive, ё = е, stress
// marks ignored. An alias matches when every one of its tokens is a token of the Telemost name
// («Ярослав Орлов (Acme)» matches «Ярослав Орлов»; «Матвей Степанов» never matches
// «Ярослав»). Names in people.json "ignore_participants" and our own tile are skipped. Ghost
// tiles (the same name twice after a crash) count as one participant. Unknown names become
// guests (id guest_<n>) so the brain can still address them; they never enter the default order.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { now as clockNow, todayAt } from '../clock.js';
import { CONFIG_DIR, contentPath } from '../config.js';
import { PHASES } from './events.js';

const STRESS_RE = /[̀́]/g;

/** Lower case, no stress marks, ё = е, one space between words. */
export function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(STRESS_RE, '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word tokens (letters/digits only) of a normalized name. */
export function nameTokens(s) {
  return normalizeName(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Read config/people.json.
 * @returns {{people: object[], firstAlways: string|null, ignore: string[], hostName: string|null}}
 */
export function loadRoster({ configDir = CONFIG_DIR, path } = {}) {
  const file = path ?? contentPath('people.json', configDir);
  let text = readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const data = JSON.parse(text);
  const people = (Array.isArray(data.people) ? data.people : []).filter((p) => p && typeof p.id === 'string' && p.id);
  return {
    people,
    firstAlways: typeof data.first_always === 'string' ? data.first_always : (people.find((p) => p.first_always === true)?.id ?? null),
    ignore: Array.isArray(data.ignore_participants) ? data.ignore_participants.filter((s) => typeof s === 'string') : [],
    hostName: typeof data.host_display_name === 'string' ? data.host_display_name : null,
    teamName: typeof data.team_name === 'string' && data.team_name.trim() ? data.team_name.trim() : null,
    keywords: Array.isArray(data.keywords) ? data.keywords.filter((k) => typeof k === 'string' && k.trim()) : [],
  };
}

/**
 * Person for a Telemost display name, or null. Longest alias match wins; a tie between two
 * different people is ambiguous and returns null.
 */
export function matchPerson(name, people) {
  const tokens = new Set(nameTokens(name));
  if (!tokens.size) return null;
  let best = null;
  let bestLen = 0;
  let tie = false;
  for (const p of people) {
    if (!p || p.exclude) continue;
    const aliases = [p.display, ...(Array.isArray(p.aliases) ? p.aliases : [])].filter((a) => typeof a === 'string');
    for (const alias of aliases) {
      const at = nameTokens(alias);
      // every alias token must be a whole word of the name; single-word aliases («Игнат») are
      // allowed only when people.json lists them explicitly (a display name alone never splits)
      if (!at.length || !at.every((t) => tokens.has(t))) continue;
      if (at.length > bestLen) {
        best = p;
        bestLen = at.length;
        tie = false;
      } else if (at.length === bestLen && best && best.id !== p.id) {
        tie = true;
      }
    }
  }
  return tie ? null : best;
}

/**
 * @param {object} opts
 * @param {{people: object[], firstAlways: string|null, ignore: string[], hostName: string|null}} opts.roster
 * @param {object} [opts.settings]  times.soft_deadline / hard_deadline for the context deadline
 * @param {'monday_focus'|'daily_plans'} [opts.dayMode]
 * @param {() => number} [opts.now]  wall clock ms (default clock.now(), i.e. the simulated clock)
 * @param {string} [opts.hostName]  our own display name (settings.display_name)
 */
export function createState({ roster, settings = {}, dayMode = 'daily_plans', now, hostName } = {}) {
  const people = roster?.people ?? [];
  const firstAlways = roster?.firstAlways ?? null;
  const ignore = new Set([...(roster?.ignore ?? []), roster?.hostName, hostName].filter(Boolean).map(normalizeName));
  const byId = new Map(people.map((p) => [p.id, p]));
  const order = new Map(people.map((p, i) => [p.id, i]));
  const nowMs = now ?? (() => clockNow().getTime());

  const participants = new Map(); // id -> record
  let guestSeq = 0;
  const guestIds = new Map(); // normalized name -> guest id
  let phase = 'waiting';
  let current = null; // presumed speaker (id) — who was given the word
  let plan = { next: null, then: [] };
  let roundStartedAt = null;
  let silentSince = null;

  const times = settings.times ?? {};

  function personFor(name) {
    return matchPerson(name, people);
  }

  function idForName(name) {
    const norm = normalizeName(name);
    if (!norm || ignore.has(norm)) return null;
    const p = personFor(name);
    if (p) return p.id;
    let gid = guestIds.get(norm);
    if (!gid) {
      gid = `guest_${++guestSeq}`;
      guestIds.set(norm, gid);
    }
    return gid;
  }

  function ensure(id, name) {
    let rec = participants.get(id);
    if (!rec) {
      const person = byId.get(id) ?? null;
      rec = {
        id,
        name: person?.display ?? name,
        telemost_name: name,
        known: Boolean(person),
        present: false,
        joined: null,
        left: null,
        status: 'absent',
        spoke_at: null,
        turns: 0,
        muted: null,
        dom_speaking: false,
        track_id: '',
        tiles: 0,
      };
      participants.set(id, rec);
    }
    return rec;
  }

  /**
   * Apply a tile list from telemost.getParticipants / installObservers.
   * @returns {{joined: string[], left: string[], changed: boolean}}
   */
  function applyParticipants(list, { t } = {}) {
    const at = t ?? nowMs();
    const seen = new Map(); // id -> merged tile info
    for (const tile of Array.isArray(list) ? list : []) {
      if (!tile || !tile.name || tile.isSelf) continue;
      const id = idForName(tile.name);
      if (!id) continue;
      const prev = seen.get(id);
      const info = {
        name: tile.name,
        muted: tile.muted ?? null,
        speaking: Boolean(tile.speaking),
        track_id: tile.trackId || '',
        visible: tile.visible !== false,
        tiles: 1,
      };
      if (!prev) seen.set(id, info);
      else {
        // ghost dedupe: prefer the tile that has a track / is visible; OR the speaking flag
        const better = (!prev.track_id && info.track_id) || (!prev.visible && info.visible);
        const merged = better ? { ...info } : { ...prev };
        merged.speaking = prev.speaking || info.speaking;
        merged.tiles = prev.tiles + 1;
        seen.set(id, merged);
      }
    }
    const joined = [];
    const left = [];
    for (const [id, info] of seen) {
      const rec = ensure(id, info.name);
      if (!rec.present) {
        rec.present = true;
        rec.joined = at;
        rec.left = null;
        if (rec.status === 'absent') rec.status = 'pending';
        joined.push(id);
      }
      rec.telemost_name = info.name;
      rec.muted = info.muted;
      rec.dom_speaking = info.speaking;
      rec.track_id = info.track_id;
      rec.tiles = info.tiles;
    }
    for (const rec of participants.values()) {
      if (rec.present && !seen.has(rec.id)) {
        rec.present = false;
        rec.left = at;
        rec.dom_speaking = false;
        rec.tiles = 0;
        if (rec.status === 'pending' || rec.status === 'speaking' || rec.status === 'skipped') rec.status = 'absent';
        left.push(rec.id);
      }
    }
    for (const id of left) {
      planRemove(id);
      if (current === id) current = null;
    }
    joined.sort(cmpOrder);
    left.sort(cmpOrder);
    return { joined, left, changed: joined.length > 0 || left.length > 0 };
  }

  /** Ids of participants currently in the call (known people first in roster order, guests last). */
  function presentIds() {
    return [...participants.values()].filter((r) => r.present).map((r) => r.id).sort(cmpOrder);
  }

  function cmpOrder(a, b) {
    const ia = order.has(a) ? order.get(a) : 10_000 + Number(String(a).replace(/\D/g, '') || 0);
    const ib = order.has(b) ? order.get(b) : 10_000 + Number(String(b).replace(/\D/g, '') || 0);
    return ia - ib;
  }

  /** Present participants who have not spoken yet (pending or skipped), roster order, lead first. */
  function pendingIds({ includeSkipped = true, includeGuests = false } = {}) {
    const ids = presentIds().filter((id) => {
      const r = participants.get(id);
      if (!r || id === current) return false;
      if (!includeGuests && !r.known) return false;
      return r.status === 'pending' || (includeSkipped && r.status === 'skipped');
    });
    if (firstAlways && ids.includes(firstAlways)) return [firstAlways, ...ids.filter((id) => id !== firstAlways)];
    return ids;
  }

  /** Default speaking order: pending known people in roster order, then skipped, then guests. */
  function defaultOrder() {
    const pending = pendingIds({ includeSkipped: false });
    const skipped = presentIds().filter((id) => participants.get(id)?.status === 'skipped' && id !== current);
    const guests = presentIds().filter((id) => {
      const r = participants.get(id);
      return r && !r.known && r.status === 'pending' && id !== current;
    });
    return [...pending, ...skipped, ...guests];
  }

  /** Replace the plan (ids that are not present are dropped). */
  function setPlan(p) {
    const ok = (id) => id && participants.get(id)?.present && id !== current && participants.get(id).status !== 'spoke';
    const next = ok(p?.next) ? p.next : null;
    const seen = new Set(next ? [next] : []);
    const then = [];
    for (const id of Array.isArray(p?.then) ? p.then : []) {
      if (!ok(id) || seen.has(id)) continue;
      seen.add(id);
      then.push(id);
    }
    plan = { next, then };
    return plan;
  }

  /** Fill plan from the default order when it is empty. */
  function ensurePlan() {
    if (plan.next) return plan;
    const [next, ...then] = [...plan.then.length ? plan.then : defaultOrder()];
    return setPlan({ next: next ?? null, then: then.length ? then : defaultOrder().filter((id) => id !== next) });
  }

  /** Put `id` at the front of the plan (Orlov joined late) or at the end (late joiner). */
  function planInsert(id, { front = false } = {}) {
    if (!participants.get(id)?.present) return plan;
    const rest = [plan.next, ...plan.then].filter((x) => x && x !== id);
    if (front) return setPlan({ next: id, then: rest });
    return setPlan({ next: rest[0] ?? null, then: [...rest.slice(1), id] });
  }

  /** Drop `id` from the plan; the queue shifts up (then[0] becomes next). */
  function planRemove(id) {
    const rest = [plan.next, ...plan.then].filter((x) => x && x !== id);
    plan = { next: rest[0] ?? null, then: rest.slice(1) };
    return plan;
  }

  /** Hand the floor to `id`: status speaking, removed from the plan; previous speaker (if any) marked spoke. */
  function giveWord(id, { t } = {}) {
    if (current && current !== id) finishTurn({ t });
    const rec = ensure(id, id);
    rec.status = 'speaking';
    rec.given_at = t ?? nowMs();
    rec.turns++;
    current = id;
    planRemove(id);
    if (roundStartedAt === null) roundStartedAt = rec.given_at;
    return rec;
  }

  /** The current speaker is done. */
  function finishTurn({ t, status = 'spoke' } = {}) {
    if (!current) return null;
    const rec = participants.get(current);
    if (rec) {
      rec.status = status;
      if (status === 'spoke') rec.spoke_at = t ?? nowMs();
    }
    const id = current;
    current = null;
    return id;
  }

  function setStatus(id, status) {
    const rec = participants.get(id);
    if (rec) rec.status = status;
    return rec;
  }

  function setPhase(p) {
    if (!PHASES.includes(p)) throw new Error(`bad phase ${p}`);
    phase = p;
    if (p === 'silent' && silentSince === null) silentSince = nowMs();
    return phase;
  }

  function get(id) {
    return participants.get(id) ?? null;
  }

  /** Vocative for clips: first name (+ surname when a namesake is present and people.json asks for it). */
  function vocative(id) {
    const person = byId.get(id);
    if (!person) {
      const rec = participants.get(id);
      const first = nameTokens(rec?.telemost_name ?? '')[0] ?? '';
      return first ? first[0].toUpperCase() + first.slice(1) : 'коллега';
    }
    const first = person.vocative || person.spoken || String(person.display).split(/\s+/)[0];
    if (person.disambiguate_with_surname && person.surname_spoken) {
      const myFirst = normalizeName(String(person.display).split(/\s+/)[0]);
      const namesake = [...participants.values()].some((r) => r.present && r.id !== id && r.known && normalizeName(String(byId.get(r.id)?.display ?? '').split(/\s+/)[0]) === myFirst);
      if (namesake) return `${first} ${person.surname_spoken}`;
    }
    return first;
  }

  function displayName(id) {
    return byId.get(id)?.display ?? participants.get(id)?.telemost_name ?? id;
  }

  /** Brain-context snapshot (context.js fills the rest). */
  function snapshot(extra = {}) {
    const list = [...participants.values()].sort((a, b) => cmpOrder(a.id, b.id)).map((r) => ({
      id: r.id,
      name: r.name,
      present: r.present,
      joined: r.joined,
      status: r.status === 'skipped' ? 'pending' : r.status,
    }));
    return {
      now: new Date(nowMs()),
      day_mode: dayMode,
      phase: phase === 'left' ? 'closing' : phase,
      deadline: { soft: times.soft_deadline ?? null, hard: times.hard_deadline ?? null },
      lead_present: firstAlways ? Boolean(participants.get(firstAlways)?.present) : null,
      participants: list,
      plan: { next: plan.next, then: [...plan.then] },
      ...extra,
    };
  }

  /** Human summary for logs. */
  function summary() {
    return {
      phase,
      current,
      plan: { next: plan.next, then: [...plan.then] },
      present: presentIds(),
      statuses: Object.fromEntries([...participants.values()].map((r) => [r.id, r.status])),
      lead_present: firstAlways ? Boolean(participants.get(firstAlways)?.present) : null,
    };
  }

  return {
    people,
    firstAlways,
    get dayMode() {
      return dayMode;
    },
    get phase() {
      return phase;
    },
    get current() {
      return current;
    },
    get plan() {
      return { next: plan.next, then: [...plan.then] };
    },
    get roundStartedAt() {
      return roundStartedAt;
    },
    get silentSince() {
      return silentSince;
    },
    timeAt: (key) => (times[key] ? todayAt(times[key], new Date(nowMs())).getTime() : null),
    isLead: (id) => Boolean(firstAlways) && id === firstAlways,
    leadPresent: () => (firstAlways ? Boolean(participants.get(firstAlways)?.present) : false),
    idForName,
    personFor,
    applyParticipants,
    presentIds,
    pendingIds,
    defaultOrder,
    setPlan,
    ensurePlan,
    planInsert,
    planRemove,
    giveWord,
    finishTurn,
    setStatus,
    setPhase,
    get,
    all: () => [...participants.values()],
    vocative,
    displayName,
    snapshot,
    summary,
  };
}
