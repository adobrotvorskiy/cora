#!/usr/bin/env node
// Render the pre-recorded clip set (phrases.json x people.json) into cache/ (WP4, PLAN §4 A).
//
//   node tools/render_clips.js --dry-run                 # texts + counts + estimate, no network
//   node tools/render_clips.js --core                    # core keys for everyone in people.json
//   node tools/render_clips.js --present "orlov_y,tkach_t" --keys "handoff,check_done"
//
// Options: --present ids (default: whole roster), --core | --keys k1,start_* (default: all keys),
// --no-surnames (skip «Имя Фамилия» forms), --concurrency 2, --max-usd 3 (refuse bigger estimates),
// --accept-mismatch (cache clips whose transcript differs from the text), --verbose.
// Offline check of the whole flow: --mock (synthetic tones, cache in _internal/mock_cache unless
// --cache-dir), --mock-fail-after N (call N+1 fails like an account without credits).
// --rerender-cut deletes cached clips of the plan whose audio stops mid-sound and renders them again.
// Already cached clips are never re-rendered. A credits/auth error stops the run at once (exit 3),
// nothing is retried in a loop. Keys stay inside the process (src/env.js); logs go to
// logs/render_clips_YYYY-MM-DD.jsonl, a summary to _internal/render_clips_last.json.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ClipStore,
  createSyntheticMouth,
  describeRenderError,
  edgeSilenceMs,
  fatalMessage,
  identityFromMouth,
  identityFromSettings,
  openRenderVoice,
} from '../src/audio/clips.js';
import { loadSettings } from '../src/config.js';
import { APP_ROOT, redactSecrets } from '../src/env.js';
import { openLog } from '../src/log.js';

const USAGE = `usage: node tools/render_clips.js [--dry-run] [--core | --keys k1,k2*] [--present id1,id2]
                                  [--no-surnames] [--concurrency 2] [--max-usd 3] [--accept-mismatch] [--verbose]
                                  [--mock [--mock-fail-after N]] [--cache-dir dir] [--rerender-cut]`;

const { values: args } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    core: { type: 'boolean', default: false },
    keys: { type: 'string' },
    present: { type: 'string' },
    'no-surnames': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '2' },
    'max-usd': { type: 'string', default: '3' },
    'accept-mismatch': { type: 'boolean', default: false },
    mock: { type: 'boolean', default: false },
    'mock-fail-after': { type: 'string' },
    'cache-dir': { type: 'string' },
    'rerender-cut': { type: 'boolean', default: false },
    verbose: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
const usd = (x) => `$${x.toFixed(x < 0.1 ? 4 : 2)}`;

async function main() {
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const settings = loadSettings();
  const keys = args.core ? 'core' : args.keys ? args.keys.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const present = args.present ? args.present.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const planOpts = { keys, present, surnames: !args['no-surnames'] };

  // dry run: identity from settings, no network
  let voice = null;
  let log = null;
  let store;
  const cacheDir = args['cache-dir'] ?? (args.mock ? join(APP_ROOT, '_internal', 'mock_cache') : undefined);
  if (args.mock) {
    const failAfter = args['mock-fail-after'] != null ? Number(args['mock-fail-after']) : null;
    const mouth = createSyntheticMouth({ instructions: identityFromSettings(settings).instructions, failAfter });
    voice = { mouth, kind: `mock${failAfter != null ? `, fails after ${failAfter}` : ''}`, close: async () => {} };
    log = openLog({ name: 'render_clips' });
    store = new ClipStore({ settings, mouth, log, cacheDir });
  } else if (args['dry-run']) {
    store = new ClipStore({ settings, identity: await dryRunIdentity(settings), cacheDir });
  } else {
    log = openLog({ name: 'render_clips', verbose: false });
    try {
      voice = await openRenderVoice({ settings, log });
    } catch (err) {
      const fatal = describeRenderError(err);
      fatal.message = redactSecrets(fatal.message);
      console.error(fatalMessage(fatal, identityFromSettings(settings)) || `cannot open the voice: ${fatal.message}`);
      log.close();
      return 3;
    }
    store = new ClipStore({ settings, mouth: voice.mouth, log, cacheDir });
  }

  const id = store.identity;
  const plan = store.plan(planOpts);
  if (args['rerender-cut'] && !args['dry-run']) {
    // cached clips whose audio stops mid-sound (truncated renders): delete, so they render again below
    for (const e of plan) {
      const file = join(store.dir, `${e.hash}.pcm`);
      let pcm;
      try {
        pcm = readFileSync(file);
      } catch {
        continue;
      }
      if (!edgeSilenceMs(pcm).cut) continue;
      for (const f of [file, file.replace(/\.pcm$/, '.json')]) {
        try {
          unlinkSync(f);
        } catch {
          // already gone
        }
      }
      console.log(`re-render (cut ending): «${e.text}»`);
    }
  }
  const sum = store.summarize(plan);
  const unknown = present ? present.filter((p) => !store.people.some((x) => x.id === p)) : [];
  console.log(`voice      ${id.provider} / ${id.model} / ${id.voice}${voice ? ` (${voice.kind})` : ' (dry run, not connected)'}`);
  const firstLine = id.instructions.split('\n')[0];
  const instrSha = createHash('sha1').update(id.instructions, 'utf8').digest('hex').slice(0, 12);
  console.log(`instr.     ${firstLine.slice(0, 90)}${firstLine.length > 90 ? '…' : ''} [${id.instructions.length} chars, sha1 ${instrSha}]`);
  console.log(`cache      ${store.dir}`);
  console.log(`people     ${present ? present.length - unknown.length : store.people.length}${unknown.length ? ` (unknown ids: ${unknown.join(', ')})` : ''}; keys: ${keys ? (keys === 'core' ? 'core' : keys.join(',')) : 'all'}; surnames: ${planOpts.surnames ? 'yes' : 'no'}`);
  console.log('');
  const width = Math.max(...Object.keys(sum.by_key).map((k) => k.length), 3);
  console.log(`${'key'.padEnd(width)}  clips  cached`);
  for (const [key, k] of Object.entries(sum.by_key)) console.log(`${key.padEnd(width)}  ${String(k.total).padStart(5)}  ${String(k.cached).padStart(6)}`);
  console.log('');
  console.log(`clips ${sum.total}: cached ${sum.cached} (${sec(sum.cached_audio_ms)}), to render ${sum.missing} (est. ${sec(sum.est_missing_audio_ms)} ≈ ${usd(sum.est_cost_usd)} at $${store.pricing.usd_per_m_audio_tokens}/1M audio tokens, ${store.pricing.audio_tokens_per_s} tok/s)`);

  if (args['dry-run']) {
    console.log('');
    let lastKey = null;
    for (const e of plan) {
      if (e.key !== lastKey) console.log(`\n[${e.key}]`);
      lastKey = e.key;
      console.log(`  ${e.cached ? '✓' : '·'} ${e.text}${e.person ? `   (${e.person}${e.surname ? ', +surname' : ''})` : ''}`);
    }
    return 0;
  }

  try {
    if (!sum.missing) {
      console.log('nothing to render: 100% cache hit');
      return 0;
    }
    const maxUsd = Number(args['max-usd']);
    if (Number.isFinite(maxUsd) && sum.est_cost_usd > maxUsd) {
      console.error(`estimate ${usd(sum.est_cost_usd)} > --max-usd ${usd(maxUsd)}: render --core first or raise --max-usd`);
      return 2;
    }
    console.log(`rendering ${sum.missing} clip(s), ${args.concurrency} at a time…`);
    const t0 = Date.now();
    const stats = await store.ensure(plan, {
      concurrency: Math.max(1, Number(args.concurrency) || 2),
      keepMismatch: args['accept-mismatch'],
      onProgress: ({ done, total, entry, status, audio_ms: ms, error }) => {
        const tag = `[${String(done).padStart(String(total).length)}/${total}]`;
        const who = `${entry.key}${entry.person ? ` ${entry.person}` : ''} #${entry.variant ?? 0}${entry.surname ? ' +surname' : ''}`;
        if (status === 'rendered') {
          if (args.verbose || done % 20 === 0 || done === total) console.log(`${tag} ok    ${who}  ${sec(ms)}${args.verbose ? `  «${entry.text}»` : ''}`);
        } else if (status !== 'skipped') {
          console.log(`${tag} ${status.toUpperCase().padEnd(5)} ${who}: ${error?.code ?? ''} ${redactSecrets(error?.message ?? '')}`);
        }
      },
    });

    // leading/trailing silence of the whole set (the handoff latency budget cares about the lead)
    const edges = [];
    for (const e of plan) {
      try {
        edges.push(edgeSilenceMs(readFileSync(join(store.dir, `${e.hash}.pcm`))));
      } catch {
        // not rendered
      }
    }
    const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
    const leads = edges.map((x) => x.lead_ms).sort((a, b) => a - b);

    console.log('');
    console.log(`rendered ${stats.rendered}, cached before ${stats.cached}, failed ${stats.failed}, verbatim mismatch ${stats.mismatched}, skipped ${stats.skipped} (requests ${stats.attempts}, ${sec(Date.now() - t0)})`);
    console.log(`audio: rendered ${sec(stats.rendered_audio_ms)}; whole set on disk ${edges.length}/${plan.length} clips, ${sec(stats.audio_ms)}`);
    console.log(`cost: ${usd(stats.cost_usd)} (${stats.cost_source}); estimate was ${usd(sum.est_cost_usd)}; usage: ${stats.usage.responses} responses, in ${stats.usage.input_tokens} tok, out ${stats.usage.output_tokens} tok (audio ${stats.usage.audio_out_tokens})`);
    if (edges.length) console.log(`silence: lead avg ${avg(leads)} ms (p90 ${leads[Math.floor(leads.length * 0.9)] ?? 0} ms), tail avg ${avg(edges.map((x) => x.tail_ms))} ms; clips ending mid-sound: ${edges.filter((x) => x.cut).length}${edges.some((x) => x.cut) ? ' (--rerender-cut renders them again)' : ''}`);
    for (const w of stats.warnings.slice(0, 20)) console.log(`  ${w.code} ${w.key ?? ''} ${w.person ?? ''}: «${w.text}» (kept after one retry)`);
    for (const e of stats.errors.slice(0, 20)) console.log(`  ${e.status} ${e.key ?? ''} ${e.person ?? ''}: ${e.code} ${redactSecrets(e.message ?? '')}${e.transcript ? ` — said «${e.transcript}»` : ''}`);
    if (stats.errors.length > 20) console.log(`  … ${stats.errors.length - 20} more in the log`);
    if (stats.fatal) console.error(`\n${fatalMessage(stats.fatal, id, { requests: stats.attempts })}`);

    writeReport({ identity: { ...id, instructions: undefined, instructions_chars: id.instructions.length }, plan: sum, stats: { ...stats, errors: stats.errors.slice(0, 200) }, edges: { lead_avg_ms: avg(leads), tail_avg_ms: avg(edges.map((x) => x.tail_ms)) } });
    if (stats.fatal) return 3;
    return stats.failed || stats.mismatched ? 1 : 0;
  } finally {
    await voice?.close?.();
    log?.close();
  }
}

/** Identity for --dry-run: the real mouth from voice.js, built but never connected (no network). */
async function dryRunIdentity(settings) {
  try {
    const { createVoice } = await import('../src/audio/voice.js');
    const v = createVoice({ settings });
    try {
      return identityFromMouth(v.mouth) ?? identityFromSettings(settings);
    } finally {
      await v.close?.();
    }
  } catch {
    return identityFromSettings(settings); // no voice.js or no key: settings are the source
  }
}

function writeReport(data) {
  try {
    const dir = join(APP_ROOT, '_internal');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'render_clips_last.json'), `${JSON.stringify({ finished: new Date().toISOString(), ...data }, null, 2)}\n`);
  } catch {
    // not fatal
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(`render_clips: ${redactSecrets(err?.stack ?? String(err))}`);
    process.exitCode = 1;
  });
