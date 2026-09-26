// Speaker attribution (WP6, PLAN.md §3 «Атрибуция»): who is talking right now and who said a
// transcript line. Signals, strongest first:
//   1. DOM active speaker (Telemost rootStroke_* marker, +0.4 s on / +0.7 s off, telemost.js)
//   2. the presumed speaker: whoever the host gave the word to (state.current)
//   3. per-track levels from the page adapter (levels[] of __host_audio) with a learned
//      track -> participant map (votes: DOM names exactly one speaker while exactly one track is loud)
// Confidence: high = DOM matches the presumed speaker (or DOM names one person); med = only the
// presumed speaker (DOM silent, energy present) or a track hint; low = energy but nobody
// identifiable; unknown = silence. With conf low the host never names the speaker.

// Per-track transcripts (yandex_cascade, one STT session per SFU slot): speakerForTrack() names the
// person on a slot for an utterance interval. Telemost reuses a slot for whoever the SFU forwards,
// so a slot is not a person: one DOM speaker in the interval decides; two or more (people talking
// over each other) are told apart by when THIS slot was loud versus the other slots; no DOM marker
// falls back to the slot's last owner. Two slots loud together for chorusMs -> onChorus().

const DEFAULTS = { energyDb: -50, energyHoldMs: 300, historyMax: 300, hintMinVotes: 3, loudKeepMs: 60_000, ownerTtlMs: 60_000, chorusMs: 600, chorusGapMs: 20_000 };

export function createAttribution({ state, log, now = Date.now, onChorus = null, ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };
  let presumed = null;
  let presumedSince = null;
  let domIds = []; // ids currently marked speaking in the DOM
  let domSince = null;
  const history = []; // {id, from, to|null}
  const hints = new Map(); // track_id -> Map(id -> votes)
  let lastEnergyAt = null;
  let loudTracks = []; // track ids above threshold in the last chunk
  let lastLevelsAt = null;
  const loudLog = []; // {t, tracks: [track ids loud in that chunk]}, chunk end times, last loudKeepMs
  const owners = new Map(); // track_id -> {id, at}: who a slot's last confident utterance belonged to
  let chorusSince = null;
  let lastChorusAt = -Infinity;

  const emit = (type, fields) => {
    try {
      log?.event?.(type, fields);
    } catch {
      // never
    }
  };

  function setPresumed(id, { t } = {}) {
    if (id === presumed) return;
    presumed = id ?? null;
    presumedSince = presumed ? (t ?? now()) : null;
  }

  /** DOM speaker names (telemost tile names) -> ids; keeps a history of intervals. */
  function onDomSpeakers(names, { t } = {}) {
    const at = t ?? now();
    const ids = [];
    for (const name of Array.isArray(names) ? names : []) {
      const id = state?.idForName ? state.idForName(name) : name;
      if (id && !ids.includes(id)) ids.push(id);
    }
    for (const h of history) if (h.to === null && !ids.includes(h.id)) h.to = at;
    for (const id of ids) {
      if (!history.some((h) => h.id === id && h.to === null)) {
        history.push({ id, from: at, to: null });
        if (history.length > o.historyMax) history.splice(0, history.length - o.historyMax);
      }
    }
    domIds = ids;
    domSince = ids.length ? (domSince ?? at) : null;
    if (!ids.length) domSince = null;
    learn(at);
    return ids;
  }

  /** Per-track levels from the page adapter: [{track_id, slot, frames:[dBFS, dBFS]}], mix = [dBFS, dBFS]. */
  function onLevels(levels, mix, { t } = {}) {
    const at = t ?? now();
    lastLevelsAt = at;
    loudTracks = (Array.isArray(levels) ? levels : [])
      .filter((l) => l && Array.isArray(l.frames) && Math.max(...l.frames) >= o.energyDb)
      .map((l) => l.track_id);
    const mixLoud = Array.isArray(mix) && mix.length && Math.max(...mix) >= o.energyDb;
    if (loudTracks.length || mixLoud) lastEnergyAt = at;
    loudLog.push({ t: at, tracks: loudTracks.filter((id) => id !== 'overflow') });
    while (loudLog.length && at - loudLog[0].t > o.loudKeepMs) loudLog.shift();
    watchChorus(at);
    learn(at);
  }

  function watchChorus(at) {
    const n = loudLog.at(-1)?.tracks.length ?? 0;
    if (n < 2) {
      chorusSince = null;
      return;
    }
    chorusSince ??= at;
    if (at - chorusSince < o.chorusMs || at - lastChorusAt < o.chorusGapMs) return;
    lastChorusAt = at;
    const ids = domIds.length >= 2 ? [...domIds] : [...new Set(loudLog.at(-1).tracks.map((tr) => owners.get(tr)?.id).filter(Boolean))];
    emit('attr.chorus', { tracks: loudLog.at(-1).tracks, ids, dom: [...domIds] });
    try {
      onChorus?.({ t: at, ids, tracks: loudLog.at(-1).tracks });
    } catch {
      // a listener must not break attribution
    }
  }

  function domMsIn(id, from, to) {
    let ms = 0;
    for (const h of history) {
      if (h.id !== id) continue;
      const ov = Math.min(h.to ?? to, to) - Math.max(h.from, from);
      if (ov > 0) ms += ov;
    }
    return ms;
  }

  /** ms during which `id` was DOM-speaking while `pred(loud tracks)` held (per 100 ms chunk). */
  function jointMs(id, from, to, pred) {
    let ms = 0;
    for (const c of loudLog) {
      if (c.t < from || c.t - 100 > to || !pred(c.tracks)) continue;
      if (domMsIn(id, c.t - 100 - 500, c.t + 800) > 0) ms += 100; // DOM lags ~0.4 s, hangs ~0.7 s
    }
    return ms;
  }

  /**
   * Who said an utterance recognized on one track between t_start and t_end (wall ms).
   * @returns {{id: string|null, conf: 'high'|'med'|'low', via: string, alt?: string[]}}
   */
  function speakerForTrack({ track_id, t_start, t_end, t } = {}) {
    const end = t_end ?? t ?? now();
    const start = t_start ?? end - 3000;
    const from = start - 500;
    const to = end + 800;
    const cands = [];
    for (const h of history) {
      const ov = Math.min(h.to ?? to, to) - Math.max(h.from, from);
      if (ov > 0 && !cands.includes(h.id)) cands.push(h.id);
    }
    const owner = owners.get(track_id);
    const ownerId = owner && end - owner.at <= o.ownerTtlMs ? owner.id : null;
    const remember = (id) => owners.set(track_id, { id, at: end });
    if (cands.length === 1) {
      remember(cands[0]);
      return { id: cands[0], conf: 'high', via: 'dom' };
    }
    if (cands.length > 1) {
      // talking over each other: the candidate whose DOM marker lines up with THIS slot being loud
      const here = (tracks) => tracks.includes(track_id);
      const elsewhere = (tracks) => tracks.length > 0 && !tracks.includes(track_id);
      const scored = cands
        .map((id) => ({ id, score: jointMs(id, from, to, here) - jointMs(id, from, to, elsewhere) + (id === ownerId ? 150 : 0) }))
        .sort((a, b) => b.score - a.score);
      const [best, next] = scored;
      if (best.score > 0 && best.score - (next?.score ?? 0) >= 200) {
        remember(best.id);
        return { id: best.id, conf: 'med', via: 'dom_levels', alt: cands.filter((c) => c !== best.id) };
      }
      if (ownerId && cands.includes(ownerId)) return { id: ownerId, conf: 'med', via: 'owner', alt: cands.filter((c) => c !== ownerId) };
      if (presumed && cands.includes(presumed)) return { id: presumed, conf: 'med', via: 'presumed', alt: cands.filter((c) => c !== presumed) };
      return { id: best.id, conf: 'low', via: 'dom_ambiguous', alt: cands.filter((c) => c !== best.id) };
    }
    if (ownerId) return { id: ownerId, conf: 'med', via: 'owner' };
    const present = typeof state?.presentIds === 'function' ? state.presentIds() : [];
    if (present.length === 1) return { id: present[0], conf: 'med', via: 'only_one' };
    const hinted = hintFor(track_id);
    if (hinted) return { id: hinted, conf: 'med', via: 'hint' };
    if (presumed) return { id: presumed, conf: 'med', via: 'presumed' };
    return { id: null, conf: 'low', via: 'none' };
  }

  function learn(at) {
    if (domIds.length !== 1 || loudTracks.length !== 1) return;
    if (lastLevelsAt === null || at - lastLevelsAt > 500) return;
    const track = loudTracks[0];
    if (track === 'overflow') return;
    let votes = hints.get(track);
    if (!votes) hints.set(track, (votes = new Map()));
    const id = domIds[0];
    const n = (votes.get(id) ?? 0) + 1;
    votes.set(id, n);
    if (n === o.hintMinVotes) emit('attr.track_hint', { track_id: track, id, votes: n });
  }

  function hintFor(track) {
    const votes = hints.get(track);
    if (!votes) return null;
    let best = null;
    let bestN = 0;
    let total = 0;
    for (const [id, n] of votes) {
      total += n;
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    }
    return bestN >= o.hintMinVotes && bestN / total >= 0.6 ? best : null;
  }

  function energyActive(at) {
    return lastEnergyAt !== null && at - lastEnergyAt <= o.energyHoldMs;
  }

  /**
   * Who is speaking now.
   * @returns {{id: string|null, conf: 'high'|'med'|'low'|'unknown', speaking: boolean, dom: string[], interjection: boolean, since: number|null}}
   */
  function current({ t } = {}) {
    const at = t ?? now();
    const energy = energyActive(at);
    if (domIds.length) {
      if (presumed && domIds.includes(presumed)) return { id: presumed, conf: 'high', speaking: true, dom: [...domIds], interjection: false, since: presumedSince };
      const id = domIds[0];
      return { id, conf: domIds.length === 1 ? 'high' : 'med', speaking: true, dom: [...domIds], interjection: Boolean(presumed) && id !== presumed, since: domSince };
    }
    if (energy) {
      const hinted = loudTracks.length === 1 ? hintFor(loudTracks[0]) : null;
      if (hinted && (!presumed || hinted === presumed)) return { id: hinted, conf: 'med', speaking: true, dom: [], interjection: false, since: presumedSince };
      if (hinted && presumed && hinted !== presumed) return { id: hinted, conf: 'med', speaking: true, dom: [], interjection: true, since: null };
      if (presumed) return { id: presumed, conf: 'med', speaking: true, dom: [], interjection: false, since: presumedSince };
      return { id: null, conf: 'low', speaking: true, dom: [], interjection: false, since: null };
    }
    return { id: presumed, conf: presumed ? 'med' : 'unknown', speaking: false, dom: [], interjection: false, since: presumedSince };
  }

  /**
   * Who most likely said something spoken between t_start and t_end (wall ms): the DOM speaker
   * with the longest overlap, else the presumed speaker.
   * @returns {{id: string|null, conf: 'high'|'med'|'low'|'unknown'}}
   */
  function speakerFor({ t_start, t_end, t } = {}) {
    const end = t_end ?? t ?? now();
    const start = t_start ?? end - 3000;
    const overlap = new Map();
    for (const h of history) {
      const to = h.to ?? end;
      const ov = Math.min(to, end + 800) - Math.max(h.from - 500, start); // DOM lags ~0.4 s, hangs ~0.7 s
      if (ov > 0) overlap.set(h.id, (overlap.get(h.id) ?? 0) + ov);
    }
    let best = null;
    let bestOv = 0;
    for (const [id, ov] of overlap) {
      if (ov > bestOv) {
        best = id;
        bestOv = ov;
      }
    }
    if (best) return { id: best, conf: presumed === best || overlap.size === 1 ? 'high' : 'med' };
    if (presumed) return { id: presumed, conf: 'med' };
    return { id: null, conf: 'low' };
  }

  function reset() {
    domIds = [];
    domSince = null;
    loudTracks = [];
    lastEnergyAt = null;
  }

  return {
    setPresumed,
    onDomSpeakers,
    onLevels,
    current,
    speakerFor,
    speakerForTrack,
    hintFor,
    reset,
    get presumed() {
      return presumed;
    },
    get domIds() {
      return [...domIds];
    },
    hints: () => Object.fromEntries([...hints].map(([track, votes]) => [track, Object.fromEntries(votes)])),
  };
}
