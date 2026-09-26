#!/usr/bin/env node
// Name audition for Sergey (PLAN §4): «<Имя Фамилия>, всё?» with the current stress and the
// alternative, one WAV per person plus one combined WAV, in _internal/audition/.
//
//   node tools/audition_names.js              # people with stress_uncertain or surname_spoken_alt
//   node tools/audition_names.js --all        # every name in people.json (alternative where there is one)
//   node tools/audition_names.js --people "goryushko_s,boyko_s" --dry-run
//
// Per-person file NN_<id>.wav: A (current surname_spoken) … beep … B (surname_spoken_alt).
// all.wav: for each person two short beeps, then A, one beep, B. index.txt lists the order.
// If B sounds right: swap surname_spoken and surname_spoken_alt in config/people.json, then run
// tools/render_clips.js again (the texts change, so only the affected clips are rendered).
// Renders go through the clip cache (a re-run costs nothing). A credits/auth error stops at once.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ClipStore,
  SAMPLE_RATE,
  createSyntheticMouth,
  describeRenderError,
  fatalMessage,
  finalizeText,
  firstName,
  identityFromSettings,
  openRenderVoice,
  pcmToWav,
} from '../src/audio/clips.js';
import { loadPeople } from '../src/audio/realtime_ws.js';
import { loadSettings } from '../src/config.js';
import { APP_ROOT, redactSecrets } from '../src/env.js';
import { openLog } from '../src/log.js';

const { values: args } = parseArgs({
  options: {
    all: { type: 'boolean', default: false },
    people: { type: 'string' },
    out: { type: 'string', default: join(APP_ROOT, '_internal', 'audition') },
    'dry-run': { type: 'boolean', default: false },
    mock: { type: 'boolean', default: false }, // synthetic tones + scratch cache: checks the WAV assembly offline
    'cache-dir': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const PHRASE = (name) => `${name}, всё?`;

/** The audition list: [{n, person, items: [{label, surname, text}]}]. */
function auditionList(people, { all = false, ids = null } = {}) {
  const pick = people.filter((p) => !p.exclude && (ids ? ids.includes(p.id) : all || p.stress_uncertain || p.surname_spoken_alt));
  return pick.map((p, i) => {
    const first = firstName(p);
    const items = [{ label: 'A', what: 'current', surname: p.surname_spoken, text: PHRASE(`${first} ${p.surname_spoken}`) }];
    if (p.surname_spoken_alt) items.push({ label: 'B', what: 'alternative', surname: p.surname_spoken_alt, text: PHRASE(`${first} ${p.surname_spoken_alt}`) });
    return { n: i + 1, person: p, items };
  });
}

function silence(ms) {
  return Buffer.alloc(Math.round((ms * SAMPLE_RATE) / 1000) * 2);
}

/** Sine beep with 5 ms fades, -12 dBFS. */
function beep(ms = 120, hz = 1000) {
  const n = Math.round((ms * SAMPLE_RATE) / 1000);
  const fade = Math.round(0.005 * SAMPLE_RATE);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * 0.25 * 32767 * env), i * 2);
  }
  return buf;
}

async function main() {
  if (args.help) {
    console.log('usage: node tools/audition_names.js [--all] [--people id1,id2] [--out dir] [--dry-run]');
    return 0;
  }
  const settings = loadSettings();
  const ids = args.people ? args.people.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const list = auditionList(loadPeople(), { all: args.all, ids });
  if (!list.length) {
    console.log('nobody to audition (no stress_uncertain / surname_spoken_alt in people.json)');
    return 0;
  }
  for (const { n, person, items } of list) console.log(`${String(n).padStart(2)}. ${person.display} (${person.id}): ${items.map((it) => `${it.label} «${it.text}»`).join('  ')}`);
  if (args['dry-run']) return 0;

  const log = openLog({ name: 'audition_names' });
  const cacheDir = args['cache-dir'] ?? (args.mock ? join(APP_ROOT, '_internal', 'mock_cache') : undefined);
  let voice;
  try {
    voice = args.mock
      ? { mouth: createSyntheticMouth({ instructions: identityFromSettings(settings).instructions }), kind: 'mock', close: async () => {} }
      : await openRenderVoice({ settings, log });
  } catch (err) {
    const fatal = describeRenderError(err);
    fatal.message = redactSecrets(fatal.message);
    console.error(fatalMessage(fatal, identityFromSettings(settings)) || `cannot open the voice: ${fatal.message}`);
    log.close();
    return 3;
  }
  try {
    const store = new ClipStore({ settings, mouth: voice.mouth, log, cacheDir });
    const entries = list.flatMap(({ person, items }) => items.map((it) => ({ text: it.text, key: 'audition', person: person.id, variant: it.label === 'A' ? 0 : 1 })));
    // normal verbatim policy: «Имя Фамилия, всё?» is also the check_done surname clip (same cache key),
    // so a garbled render must not be cached; stress marks are ignored by the transcript check anyway
    const stats = await store.ensure(entries);
    if (stats.fatal) {
      console.error(fatalMessage(stats.fatal, store.identity, { requests: stats.attempts }));
      return 3;
    }
    mkdirSync(args.out, { recursive: true });
    const combined = [];
    const index = [
      `Name audition ${new Date().toISOString().slice(0, 16)} — ${store.identity.provider} / ${store.identity.model} / ${store.identity.voice}`,
      'Each item: A = current stress (people.json surname_spoken), beep, B = alternative (surname_spoken_alt).',
      'all.wav: two beeps = next person. If B is right, swap the two fields in config/people.json and re-run tools/render_clips.js.',
      '',
    ];
    const files = [];
    for (const { n, person, items } of list) {
      const parts = [];
      const got = items.map((it) => ({ ...it, clip: store.getByHash(store.hash(it.text)) }));
      got.forEach((it, i) => {
        if (i > 0) parts.push(silence(500), beep(), silence(300));
        parts.push(it.clip ? it.clip.pcm : beep(600, 300)); // a low buzz marks a failed render
      });
      const pcm = Buffer.concat(parts);
      const name = `${String(n).padStart(2, '0')}_${person.id}.wav`;
      writeFileSync(join(args.out, name), pcmToWav(pcm));
      files.push(name);
      combined.push(beep(80), silence(80), beep(80), silence(400), pcm, silence(900));
      index.push(`${String(n).padStart(2)}. ${person.display} (${person.id}) — ${name}`);
      for (const it of got) {
        const err = it.clip ? null : stats.errors.find((e) => e.text === finalizeText(it.text));
        const why = err ? ` (${err.code}${err.transcript ? `: said «${err.transcript}»` : ''})` : '';
        index.push(`      ${it.label} ${it.what.padEnd(11)} ${it.surname}${it.clip ? `   ${(it.clip.duration_ms / 1000).toFixed(1)} s${it.clip.meta?.cut ? '   (ends abruptly)' : ''}` : `   RENDER FAILED${why} — re-run the tool`}`);
      }
    }
    writeFileSync(join(args.out, 'all.wav'), pcmToWav(Buffer.concat(combined)));
    writeFileSync(join(args.out, 'index.txt'), `${index.join('\n')}\n`);
    console.log(`\nrendered ${stats.rendered}, cached ${stats.cached}, failed ${stats.failed}, transcript mismatch ${stats.mismatched}; cost ${stats.cost_usd.toFixed(4)} USD (${stats.cost_source})`);
    console.log(`files: ${args.out}\\{${files.join(', ')}, all.wav, index.txt}`);
    return stats.failed || stats.mismatched ? 1 : 0;
  } finally {
    await voice?.close?.();
    log.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`audition_names: ${redactSecrets(err?.stack ?? String(err))}`);
    process.exitCode = 1;
  });
