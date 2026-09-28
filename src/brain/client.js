// Brain client: one LLM call per decision (PLAN.md §2 «Контракты», §3, §5).
//
// Provider (PLAN §2.7): the env variable named by settings.keys.openrouter is present ->
// OpenRouter with settings.brain.openrouter_model; else settings.keys.openai -> OpenAI with
// settings.brain.openai_fallback_model; else a clear error. Key NAMES always come from
// settings.keys; the shared OPENROUTER_API_KEY is refused even if settings point to it.
// If OpenRouter fails permanently (unknown model id, auth, no credits) and the OpenAI key is
// present, the session fails over to OpenAI once (brain.failover in the log).
//
// One decision: system prompt (byte-stable, so the provider caches it) + context JSON ->
// structured output (json_schema strict; a 400 about it degrades to json_object, then to
// plain) -> parseActionText + validate -> one repair round-trip carrying the validator
// errors -> still invalid: {"action":"wait","why":"invalid_brain_output"}.
// Transport: SSE streaming (TTFT = first content token), settings.brain.timeout_ms per
// attempt, 1 retry on timeout / 5xx / 429 / network errors. A 400 about an unsupported
// parameter (temperature, reasoning_effort, stream, response_format, ...) adapts the request
// and the adaptation is kept for the session.
//
// Rate limit and coalescing: at most one request in flight and one pending.
//  - decide() while a request is pending: the new call replaces it (newest input wins, the
//    trigger with the highest priority is kept); the replaced caller resolves 'superseded'.
//  - decide() with a higher priority than the in-flight request (barge_in, question_to_host):
//    the in-flight request is aborted (its caller resolves 'superseded') and the new one
//    starts at once, ignoring min_interval_ms.
//  - otherwise the pending call starts when the in-flight one ends and min_interval_ms has
//    passed since the previous start.
// Pass a function instead of a context object to build the context only when the request
// actually starts: decide(() => buildContext(state.snapshot()), {trigger}).
// opts.onText({action, to, text}) fires once per attempt as soon as the streamed output has a
// complete `action` and `text` that pass validation (text already normalized), while the model is
// still writing `plan`: the host starts synthesizing the line early. The decision itself still
// comes only from the full, validated output.
// decide() never rejects: every caller gets a result whose action is safe to apply
// (a 'wait' for any status but 'ok').

import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { dayMode as clockDayMode } from '../clock.js';
import { selectBrainProvider } from '../config.js';
import { hasKey, requireKey } from '../env.js';
import { ACTION_SCHEMA_NAME, TEXT_LIMITS, actionJsonSchema, actionKeys, completedFields, parseActionText, validate, waitAction } from './actions.js';
import { estimateTokens } from './context.js';
import { buildSystemPrompt, humanModelName, loadBrainAssets } from './prompt.js';

/** Yandex AI Studio brain (yandex_cascade): best of the 26.09 bench on the real prompt (5/5 sensible, p50 1.2 s). */
export const DEFAULT_YANDEX_MODEL = 'aliceai-llm-flash/latest';
export const ENDPOINTS = Object.freeze({
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  yandex: 'https://ai.api.cloud.yandex.net/v1/chat/completions',
  // Gemini API (a Google AI Studio key), its OpenAI-compatible endpoint: used by the agent (agent.provider "google")
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
});
/** Env names the host must never use: the shared OpenRouter key belongs to other tools. */
export const FORBIDDEN_KEY_NAMES = Object.freeze(['OPENROUTER_API_KEY']);
/** Triggers that pre-empt an in-flight request. */
export const HIGH_PRIORITY_TRIGGERS = Object.freeze(['barge_in', 'question_to_host']);
/** USD per 1M tokens [input, cached input, output], used when the provider reports no cost. */
export const PRICES_USD_PER_MTOK = Object.freeze({
  'gpt-5-mini': [0.25, 0.025, 2.0],
  'gpt-5-nano': [0.05, 0.005, 0.4],
  'gpt-5.4-mini': [0.75, 0.075, 4.5],
  'gpt-5.4-nano': [0.2, 0.02, 1.25],
});

const DEFAULTS = Object.freeze({
  timeout_ms: 4000,
  min_interval_ms: 1500,
  retries: 1,
  retry_backoff_ms: 250,
  max_output_tokens: 1200,
  stream: true,
  log_context: true,
  failover: true,
});
const MAX_ADAPTATIONS = 4;
const PERMANENT_ERRORS = new Set(['model_unavailable', 'auth', 'payment']);
const RETRY_AFTER_CAP_MS = 2000;
const WARMUP_CONTEXT = Object.freeze({
  now: '09:58:00', day_mode: null, phase: 'waiting', deadline: { soft: null, hard: null }, lead_present: false,
  participants: [], speaker: null, host: { speaking: false, silent_mode: false, last_utterance: null, last_interrupted: false },
  plan: { next: null, then: [] }, recent_events: [], transcript_window: [], trigger: 'plan_refresh',
});

export class BrainError extends Error {
  /** kind: timeout | network | server | rate_limit | auth | payment | model_unavailable | bad_request | stream | context | superseded | aborted */
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'BrainError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

/**
 * Which provider, model and key NAME to use. Throws a readable Error when nothing usable is set.
 * @param {object} settings  needs settings.keys and settings.brain
 * @param {{env?: object, provider?: 'openrouter'|'openai', model?: string}} [opts]  provider/model force a choice (bench)
 * @returns {{provider: 'openrouter'|'openai', model: string, keyName: string, url: string}}
 */
export function resolveProvider(settings, { env = process.env, provider, model } = {}) {
  const keys = settings?.keys ?? {};
  const brain = settings?.brain ?? {};
  for (const role of ['openrouter', 'openai']) {
    if (FORBIDDEN_KEY_NAMES.includes(keys[role])) {
      throw new Error(`brain: settings.keys.${role} names the shared ${keys[role]}; the standup host must use its own key`);
    }
  }
  const has = (name) => typeof name === 'string' && name !== '' && hasKey(name, env);
  let sel;
  if (provider) {
    if (!Object.hasOwn(ENDPOINTS, provider)) throw new Error(`brain: unknown provider "${provider}" (expected ${Object.keys(ENDPOINTS).join('|')})`);
    const keyName = keys[provider];
    if (!has(keyName)) throw new Error(`brain: provider ${provider} requested but ${keyName ?? `settings.keys.${provider}`} is absent`);
    sel = { provider, keyName, model: model ?? defaultModel(provider, brain) };
    if (provider === 'yandex') {
      const folder = settings.yandex?.folder;
      if (!folder) throw new Error('brain: settings.yandex.folder is required for the yandex provider (cloud folder id)');
      sel = { ...sel, model: model ?? `gpt://${folder}/${brain.yandex_model ?? DEFAULT_YANDEX_MODEL}` };
    }
  } else {
    sel = selectBrainProvider({ keys, brain }, { has });
    if (sel.provider === 'none') {
      throw new Error(
        `brain: no LLM key. Set ${keys.openrouter ?? 'settings.keys.openrouter'} (OpenRouter) or ${keys.openai ?? 'settings.keys.openai'} (OpenAI fallback); the shared OPENROUTER_API_KEY is never used`,
      );
    }
    if (model) sel = { ...sel, model };
  }
  if (sel.provider === 'yandex' && typeof sel.model === 'string' && !sel.model.startsWith('gpt://')) {
    const folder = settings.yandex?.folder;
    if (!folder) throw new Error('brain: settings.yandex.folder is required for the yandex provider (cloud folder id)');
    sel = { ...sel, model: `gpt://${folder}/${sel.model}` };
  }
  if (!sel.model) throw new Error(`brain: no model for ${sel.provider}; set settings.brain.${sel.provider === 'openrouter' ? 'openrouter_model' : 'openai_fallback_model'}`);
  return { provider: sel.provider, model: sel.model, keyName: sel.keyName, url: ENDPOINTS[sel.provider] };
}

/** 1 = pre-empts (barge_in, question_to_host or priority 'high'), 0 = normal. */
export function priorityOf(priority, trigger) {
  if (typeof priority === 'number' && Number.isFinite(priority)) return priority;
  if (priority === 'high') return 1;
  if (priority === 'normal' || priority === 'low') return 0;
  return HIGH_PRIORITY_TRIGGERS.includes(trigger) ? 1 : 0;
}

/**
 * Request features to try first for a model; adapt() narrows them on 400s.
 * settings.brain overrides: reasoning_effort (OpenAI), openrouter_reasoning (object or null),
 * temperature, response_format ('json_schema'|'json_object'|'none'), stream.
 */
export function initialCaps(provider, model, brain = {}) {
  const vendor = provider === 'openrouter' ? model.split('/')[0] : 'openai';
  const bare = provider === 'openrouter' ? model.slice(model.indexOf('/') + 1) : model;
  return {
    stream: brain.stream !== false,
    streamOptions: provider === 'openai',
    format: ['json_schema', 'json_object', 'none'].includes(brain.response_format) ? brain.response_format : 'json_schema',
    tokensParam: provider === 'openai' ? 'max_completion_tokens' : 'max_tokens',
    temperature: typeof brain.temperature === 'number' ? brain.temperature : null,
    effort: provider === 'openai' ? (brain.reasoning_effort === undefined ? defaultEffort(bare) : brain.reasoning_effort) : null,
    orReasoning: provider === 'openrouter' ? openRouterReasoning(vendor, brain) : null,
    cacheKey: provider === 'openai',
    // Explicit cache breakpoint on the system prompt. OpenRouter spreads Gemini over several
    // upstream endpoints, so implicit caching rarely hits: measured 0 cached tokens without it,
    // ~88% cached (4x cheaper) with it. Anthropic caches only with a breakpoint.
    cacheControl: provider === 'openrouter' && (typeof brain.cache_control === 'boolean' ? brain.cache_control : vendor === 'anthropic' || vendor === 'google'),
    // OpenRouter routing: price-first by default; latency-first measured ~0.2 s faster TTFT.
    route: provider === 'openrouter' ? (brain.openrouter_provider === undefined ? { sort: 'latency' } : brain.openrouter_provider) : null,
    usageInclude: provider === 'openrouter',
  };
}

function defaultModel(provider, brain) {
  if (provider === 'google') return brain.google_model;
  return provider === 'openrouter' ? brain.openrouter_model : brain.openai_fallback_model;
}

// gpt-5 / -mini / -nano accept 'minimal'; gpt-5.1+ go down to 'none'. adapt() fixes a wrong guess.
function defaultEffort(bare) {
  if (/^gpt-5\.\d/.test(bare)) return 'none';
  if (/^gpt-5(-|$)/.test(bare)) return 'minimal';
  if (/^o\d/.test(bare)) return 'low';
  return null;
}

function openRouterReasoning(vendor, brain) {
  if (brain.openrouter_reasoning === null) return null;
  if (brain.openrouter_reasoning && typeof brain.openrouter_reasoning === 'object') return { ...brain.openrouter_reasoning };
  if (vendor === 'anthropic') return null; // extended thinking is off unless requested
  return { effort: 'minimal' };
}

/** Cost in USD from token usage when the provider does not report it; null for unknown models. */
export function estimateCost(model, usage) {
  const price = PRICES_USD_PER_MTOK[String(model).replace(/^openai\//, '')];
  if (!price || !usage) return null;
  const cached = usage.cached_tokens ?? 0;
  const fresh = Math.max(0, (usage.prompt_tokens ?? 0) - cached);
  return (fresh * price[0] + cached * price[1] + (usage.completion_tokens ?? 0) * price[2]) / 1e6;
}

/**
 * @param {object} opts
 * @param {object} opts.settings  loadSettings() result (keys, brain)
 * @param {{event: Function}} [opts.log]  openLog() handle
 * @param {object} [opts.env]  where key values are looked up (default process.env + repo .env files)
 * @param {Function} [opts.fetch]  fetch implementation (tests)
 * @param {'openrouter'|'openai'} [opts.provider]  force a provider (bench); disables failover
 * @param {string} [opts.model]  force a model
 * @param {string} [opts.systemPrompt]  use this prompt instead of building one from config/
 * @param {string} [opts.configDir]  where playbook.md / persona.md / people.json live
 * @param {'monday_focus'|'daily_plans'} [opts.dayMode]  default: clock.dayMode() ('off' -> daily_plans)
 * @param {() => number} [opts.clock]  monotonic ms (default performance.now)
 * @returns {{decide: (context: object|Function, opts?: {signal?: AbortSignal, priority?: 'high'|'normal'|number, trigger?: string, onText?: Function}) => Promise<object>,
 *   warmup: (context?: object) => Promise<object>, close: () => void, stats: () => object,
 *   readonly provider: string, readonly model: string, readonly systemPrompt: string}}
 */
export function createBrain({
  settings,
  log = null,
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  provider: forcedProvider,
  model: forcedModel,
  systemPrompt = null,
  configDir,
  dayMode,
  clock = () => performance.now(),
} = {}) {
  if (!settings?.brain || !settings?.keys) throw new Error('brain: settings.brain and settings.keys are required');
  if (typeof fetchImpl !== 'function') throw new Error('brain: no fetch implementation');
  const cfg = { ...DEFAULTS, ...settings.brain };
  const limits = { maxChars: cfg.max_text_chars ?? TEXT_LIMITS.maxChars, maxSentences: cfg.max_text_sentences ?? TEXT_LIMITS.maxSentences };
  const emit = (type, fields) => {
    try {
      log?.event?.(type, fields);
    } catch {
      // logging must never break a decision
    }
  };

  const primary = resolveProvider(settings, { env, provider: forcedProvider, model: forcedModel });
  const fallback =
    !forcedProvider && cfg.failover && primary.provider === 'openrouter' && settings.keys.openai && hasKey(settings.keys.openai, env) && cfg.openai_fallback_model
      ? { provider: 'openai', model: cfg.openai_fallback_model, keyName: settings.keys.openai, url: ENDPOINTS.openai }
      : null;

  const assets = systemPrompt == null ? loadBrainAssets(configDir ? { configDir } : {}) : null;
  const effectiveDayMode = dayMode ?? defaultDayMode();
  const voiceVendorHuman = settings.voice?.provider === 'yandex_cascade' ? 'Яндекс SpeechKit' : 'OpenAI';
  // main.js sets settings.times only with --start; without it the meeting has no clock (on demand)
  const scheduled = Boolean(settings.times);
  const whyLast = cfg.why_last === true;
  const schema = actionJsonSchema({ whyLast });
  const promptFor = (model) =>
    systemPrompt ?? buildSystemPrompt({ ...assets, dayMode: effectiveDayMode, brainModelHuman: humanModelName(model), voiceVendorHuman, scheduled, whyLast });

  let active = primary;
  let apiKey = requireKey(active.keyName, env);
  let caps = initialCaps(active.provider, active.model, cfg);
  let prompt = promptFor(active.model);
  let promptHash = sha1(prompt);

  const stats = {
    calls: 0, requests: 0, ok: 0, invalid: 0, errors: 0, superseded: 0, aborted: 0, repaired: 0, failovers: 0,
    prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0, cost_usd: 0,
  };
  for (const w of assets?.warnings ?? []) emit('brain.warn', { message: w });
  emit('brain.init', {
    provider: active.provider,
    model: active.model,
    key: active.keyName,
    fallback: fallback ? `${fallback.provider}/${fallback.model}` : null,
    day_mode: effectiveDayMode,
    schedule: scheduled ? 'scheduled' : 'on_demand',
    ...(whyLast ? { why_last: true } : {}),
    prompt_sha1: promptHash,
    prompt_chars: prompt.length,
    prompt_tokens_est: estimateTokens(prompt),
    assets: assets
      ? { playbook: Boolean(assets.playbook), persona: Boolean(assets.personaBlock), people: assets.people?.length ?? 0 }
      : 'given',
    timeout_ms: cfg.timeout_ms,
    min_interval_ms: cfg.min_interval_ms,
  });

  // ------------------------------------------------------------ scheduling

  let seq = 0;
  let inflight = null;
  let pending = null;
  let pendingTimer = null;
  let lastStartAt = -Infinity;
  let closed = false;

  function decide(input, opts = {}) {
    const trigger = opts.trigger ?? (input && typeof input === 'object' ? (input.trigger ?? null) : null);
    const priority = priorityOf(opts.priority, trigger);
    return new Promise((resolve) => {
      const caller = { resolve, settled: false, trigger, calledAt: clock(), cleanup: null, onText: typeof opts.onText === 'function' ? opts.onText : null };
      stats.calls++;
      if (closed) return settle(caller, stub('aborted', 'brain_closed', caller));
      const signal = opts.signal;
      if (signal) {
        if (signal.aborted) return settle(caller, stub('aborted', 'aborted', caller));
        const onAbort = () => cancelCaller(caller);
        signal.addEventListener('abort', onAbort, { once: true });
        caller.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      if (inflight && priority > inflight.priority) {
        const victim = inflight;
        inflight = null;
        supersede(victim, `preempted by ${trigger ?? 'a higher-priority call'}`);
        victim.controller.abort(new BrainError('superseded', 'preempted by a higher-priority decision'));
        if (pending) {
          supersede(pending, 'dropped by a pre-empting call');
          pending = null;
        }
        clearPendingTimer();
        startJob(newJob(input, trigger, priority, caller));
        return;
      }
      if (pending) {
        supersede(pending, `coalesced into a newer ${trigger ?? 'call'}`);
        pending.merged.push(pending.trigger);
        pending.caller = caller;
        pending.input = input;
        if (priority >= pending.priority) {
          pending.priority = priority;
          pending.trigger = trigger;
        }
        schedule();
        return;
      }
      pending = newJob(input, trigger, priority, caller);
      schedule();
    });
  }

  function newJob(input, trigger, priority, caller) {
    return { id: ++seq, input, trigger, priority, caller, controller: new AbortController(), merged: [] };
  }

  function schedule() {
    clearPendingTimer();
    if (!pending || inflight || closed) return;
    const wait = pending.priority > 0 ? 0 : lastStartAt + cfg.min_interval_ms - clock();
    if (wait <= 0) {
      const job = pending;
      pending = null;
      startJob(job);
      return;
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      schedule();
    }, Math.ceil(wait));
  }

  function clearPendingTimer() {
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = null;
  }

  function startJob(job) {
    inflight = job;
    lastStartAt = clock();
    stats.requests++;
    runJob(job)
      .then(
        (result) => settle(job.caller, result),
        (e) => {
          const kind = e instanceof BrainError && (e.kind === 'superseded' || e.kind === 'aborted') ? e.kind : 'error';
          settle(job.caller, kind === 'error' ? stub('error', `brain_error:${e?.kind ?? 'internal'}`, job.caller) : stub(kind, kind, job.caller));
        },
      )
      .finally(() => {
        if (inflight === job) inflight = null;
        schedule();
      });
  }

  function settle(caller, result) {
    if (caller.settled) return;
    caller.settled = true;
    caller.cleanup?.();
    caller.resolve(result);
  }

  function supersede(job, reason) {
    if (job.caller.settled) return;
    stats.superseded++;
    emit('brain.superseded', { job: job.id, trigger: job.trigger, reason });
    settle(job.caller, stub('superseded', 'superseded', job.caller));
  }

  function cancelCaller(caller) {
    if (caller.settled) return;
    if (pending?.caller === caller) {
      pending = null;
      clearPendingTimer();
    } else if (inflight?.caller === caller) {
      inflight.controller.abort(new BrainError('aborted', 'caller aborted'));
    }
    stats.aborted++;
    settle(caller, stub('aborted', 'aborted', caller));
  }

  function stub(status, why, caller) {
    return {
      status, action: waitAction(why), latency_ms: 0, ttft_ms: null, queue_ms: Math.round(clock() - caller.calledAt),
      usage: emptyUsage(), provider: active.provider, model: active.model, attempts: 0, repaired: false,
      trigger: caller.trigger ?? null, job: null, warnings: [], errors: [],
    };
  }

  // ------------------------------------------------------------ one decision

  async function runJob(job) {
    const t0 = clock();
    const queueMs = Math.round(t0 - job.caller.calledAt);
    let context;
    try {
      context = typeof job.input === 'function' ? await job.input() : job.input;
      if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('context must be an object (or a function returning one)');
    } catch (e) {
      return finish(job, t0, queueMs, { status: 'error', action: waitAction('brain_error:context'), error: new BrainError('context', e.message) });
    }
    if (job.controller.signal.aborted) throw job.controller.signal.reason;
    if (job.trigger != null && context.trigger !== job.trigger) context = { ...context, trigger: job.trigger };
    const participants = Array.isArray(context.participants) ? context.participants : [];
    const userMessage = { role: 'user', content: JSON.stringify(context) };
    emit('brain.request', {
      job: job.id,
      trigger: job.trigger,
      priority: job.priority,
      ...(job.merged.length ? { merged: job.merged } : {}),
      queue_ms: queueMs,
      provider: active.provider,
      model: active.model,
      ...(cfg.log_context ? { context } : { context_chars: userMessage.content.length }),
    });

    const base = () => [systemMessage(), userMessage];
    let messages = base();
    const usage = emptyUsage();
    let attempts = 0;
    let retries = 0;
    let adaptations = 0;
    let repairTried = false;
    let lengthHit = false;
    let ttft = null;
    let textMs = null;
    let last = null;
    for (;;) {
      attempts++;
      let r;
      try {
        r = await requestOnce(messages, job.controller.signal, lengthHit ? 2 : 1, earlyText(job, participants, (ms) => (textMs ??= Math.round(ms - t0))));
      } catch (e) {
        if (job.controller.signal.aborted) throw job.controller.signal.reason;
        const err = e instanceof BrainError ? e : new BrainError('network', String(e?.message ?? e), { retryable: true });
        emit('brain.error', { job: job.id, attempt: attempts, kind: err.kind, status: err.status ?? null, code: err.code ?? null, message: err.message, provider: active.provider, model: active.model });
        if (err.kind === 'bad_request' && adaptations < MAX_ADAPTATIONS) {
          const change = adapt(caps, err);
          if (change) {
            adaptations++;
            emit('brain.adapt', { job: job.id, model: active.model, change });
            messages = repairTried ? messages : base();
            continue;
          }
        }
        if (PERMANENT_ERRORS.has(err.kind) && failover(err)) {
          messages = base();
          repairTried = false;
          continue;
        }
        if (err.retryable && retries < cfg.retries) {
          retries++;
          const wait = err.retryAfterMs != null ? Math.min(err.retryAfterMs, RETRY_AFTER_CAP_MS) : cfg.retry_backoff_ms;
          try {
            await delay(wait, undefined, { signal: job.controller.signal });
          } catch {
            throw job.controller.signal.reason;
          }
          continue;
        }
        return finish(job, t0, queueMs, { status: 'error', action: waitAction(`brain_error:${err.kind}`), error: err, usage, attempts, ttft, textMs, last });
      }
      addUsage(usage, r.usage);
      ttft = r.ttft_ms;
      last = r;
      lengthHit = r.finish_reason === 'length';
      const parsed = !r.content && r.refusal ? { ok: false, error: `model refused: ${clip(r.refusal, 160)}` } : parseActionText(r.content);
      const verdict = parsed.ok
        ? validate(parsed.value, { participants, context, limits })
        : { ok: false, errors: [parsed.error + (lengthHit ? ' (output cut by the token limit)' : '')], warnings: [] };
      if (verdict.ok) {
        return finish(job, t0, queueMs, { status: 'ok', action: verdict.action, warnings: verdict.warnings, usage, attempts, ttft, textMs, repaired: repairTried, last });
      }
      emit('brain.invalid', { job: job.id, attempt: attempts, errors: verdict.errors, raw: clip(r.content, 600), finish_reason: r.finish_reason });
      if (!repairTried) {
        repairTried = true;
        messages = [...base(), { role: 'assistant', content: r.content || '(пустой ответ)' }, { role: 'user', content: repairPrompt(verdict.errors, whyLast) }];
        continue;
      }
      return finish(job, t0, queueMs, { status: 'invalid', action: waitAction('invalid_brain_output'), errors: verdict.errors, usage, attempts, ttft, textMs, last });
    }
  }

  /**
   * Stream hook for one attempt: once `action` and `text` are complete and valid, hand the
   * normalized line to the caller's onText (at most once per attempt). null when nobody listens.
   */
  function earlyText(job, participants, onReady) {
    const onText = job.caller.onText;
    if (!onText) return null;
    let fired = false;
    return (content) => {
      if (fired || job.caller.settled || !content.includes('"text"')) return;
      try {
        const f = completedFields(content);
        if (!('text' in f) || !('action' in f)) return;
        fired = true;
        if (typeof f.text !== 'string' || !f.text.trim()) return;
        const v = validate({ why: typeof f.why === 'string' ? f.why : '', action: f.action, to: f.to ?? null, text: f.text, plan: null }, { participants, limits });
        if (!v.ok || !v.action.text) return;
        onReady(clock());
        onText({ action: v.action.action, to: v.action.to, text: v.action.text, trigger: job.trigger ?? null, job: job.id });
      } catch {
        // an early hint must never break the decision itself
      }
    };
  }

  function systemMessage() {
    return caps.cacheControl
      ? { role: 'system', content: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] }
      : { role: 'system', content: prompt };
  }

  function failover(err) {
    if (!fallback || active === fallback) return false;
    emit('brain.failover', { from: `${active.provider}/${active.model}`, to: `${fallback.provider}/${fallback.model}`, reason: err.kind, message: err.message });
    stats.failovers++;
    active = fallback;
    apiKey = requireKey(active.keyName, env);
    caps = initialCaps(active.provider, active.model, cfg);
    prompt = promptFor(active.model);
    promptHash = sha1(prompt);
    return true;
  }

  function finish(job, t0, queueMs, p) {
    const usage = p.usage ?? emptyUsage();
    if (usage.cost_usd == null) usage.cost_usd = estimateCost(active.model, usage);
    const result = {
      status: p.status,
      action: p.action,
      latency_ms: Math.round(clock() - t0),
      ttft_ms: p.ttft == null ? null : Math.round(p.ttft),
      text_ms: p.textMs ?? null,
      queue_ms: queueMs,
      usage,
      provider: active.provider,
      model: active.model,
      response_provider: p.last?.response_provider ?? null,
      attempts: p.attempts ?? 0,
      repaired: Boolean(p.repaired),
      trigger: job.trigger ?? null,
      job: job.id,
      warnings: p.warnings ?? [],
      errors: p.errors ?? [],
      ...(p.error ? { error: { kind: p.error.kind, status: p.error.status ?? null, message: p.error.message } } : {}),
    };
    stats[p.status === 'ok' ? 'ok' : p.status === 'invalid' ? 'invalid' : 'errors']++;
    if (p.status === 'ok' && result.repaired) stats.repaired++;
    stats.prompt_tokens += usage.prompt_tokens;
    stats.cached_tokens += usage.cached_tokens;
    stats.completion_tokens += usage.completion_tokens;
    stats.cost_usd += usage.cost_usd ?? 0;
    emit('brain.action', {
      job: job.id,
      trigger: result.trigger,
      status: result.status,
      action: result.action,
      latency_ms: result.latency_ms,
      ttft_ms: result.ttft_ms,
      text_ms: result.text_ms,
      queue_ms: queueMs,
      attempts: result.attempts,
      repaired: result.repaired,
      usage,
      provider: result.provider,
      model: result.model,
      response_model: p.last?.response_model ?? null,
      response_provider: p.last?.response_provider ?? null,
      request_id: p.last?.request_id ?? null,
      server_ms: p.last?.server_ms ?? null,
      prompt_sha1: promptHash,
      ...(result.warnings.length ? { warnings: result.warnings } : {}),
      ...(result.errors.length ? { errors: result.errors } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    return result;
  }

  // ------------------------------------------------------------ transport

  function buildBody(messages, tokenFactor) {
    const body = { model: active.model, messages };
    if (caps.format === 'json_schema') {
      body.response_format = { type: 'json_schema', json_schema: { name: ACTION_SCHEMA_NAME, strict: true, schema } };
    } else if (caps.format === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    body[caps.tokensParam] = cfg.max_output_tokens * tokenFactor;
    if (caps.temperature !== null) body.temperature = caps.temperature;
    if (caps.effort) body.reasoning_effort = caps.effort;
    if (caps.orReasoning) body.reasoning = { ...caps.orReasoning, exclude: true };
    if (caps.stream) {
      body.stream = true;
      if (caps.streamOptions) body.stream_options = { include_usage: true };
    }
    if (caps.usageInclude) body.usage = { include: true };
    if (caps.cacheKey) body.prompt_cache_key = `standup-brain-${promptHash.slice(0, 16)}`;
    if (cfg.service_tier && active.provider === 'openai') body.service_tier = cfg.service_tier;
    if (caps.route) body.provider = caps.route;
    return body;
  }

  async function requestOnce(messages, jobSignal, tokenFactor, onContent = null) {
    const body = buildBody(messages, tokenFactor);
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new BrainError('timeout', `no complete answer within ${cfg.timeout_ms} ms`, { retryable: true })),
      cfg.timeout_ms,
    );
    const signal = AbortSignal.any([timeout.signal, jobSignal]);
    // Races every await against the abort, so a fetch that ignores its signal still times out.
    let rejectAborted;
    const aborted = new Promise((_, reject) => {
      rejectAborted = reject;
    });
    aborted.catch(() => {});
    const onAbort = () => rejectAborted(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    const started = clock();
    try {
      let res;
      try {
        res = await Promise.race([
          fetchImpl(active.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal,
          }),
          aborted,
        ]);
      } catch (e) {
        if (signal.aborted) throw signal.reason;
        throw new BrainError('network', `fetch failed: ${e?.cause?.code ?? e?.message ?? e}`, { retryable: true });
      }
      if (!res.ok) throw await httpError(res);
      const streamed = body.stream && /event-stream/i.test(res.headers.get('content-type') ?? '');
      const out = streamed ? await readStream(res, started, aborted, onContent) : await readJson(res, started, aborted);
      out.request_id ??= res.headers.get('x-request-id');
      out.server_ms = Number(res.headers.get('openai-processing-ms')) || null;
      return out;
    } catch (e) {
      if (signal.aborted) throw signal.reason ?? e;
      throw e;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async function readStream(res, started, aborted, onContent = null) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let refusal = '';
    let ttft = null;
    let usage = null;
    let finishReason = null;
    let responseModel = null;
    let responseProvider = null;
    let requestId = null;
    let ended = false;
    try {
      for (;;) {
        const { value, done } = await Promise.race([reader.read(), aborted]);
        if (done) {
          ended = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue; // comments (": OPENROUTER PROCESSING"), event:, id:, blank lines
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue; // keep reading to EOF so the connection can be reused
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }
          if (chunk.error) {
            const status = Number(chunk.error.code) || null;
            throw new BrainError('stream', `stream error: ${clip(chunk.error.message ?? JSON.stringify(chunk.error), 300)}`, {
              status,
              retryable: status === null || status >= 500 || status === 429,
            });
          }
          if (chunk.model) responseModel = chunk.model;
          if (chunk.provider) responseProvider = chunk.provider; // OpenRouter: which upstream served it
          if (chunk.id && !requestId) requestId = chunk.id;
          if (chunk.usage) usage = chunk.usage;
          for (const choice of chunk.choices ?? []) {
            const delta = choice.delta ?? {};
            if (typeof delta.content === 'string' && delta.content) {
              if (ttft === null) ttft = clock() - started;
              content += delta.content;
              onContent?.(content);
            }
            if (typeof delta.refusal === 'string') refusal += delta.refusal;
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }
        }
      }
    } finally {
      if (!ended) reader.cancel().catch(() => {});
    }
    return {
      content, refusal, ttft_ms: ttft, usage: normalizeUsage(usage), finish_reason: finishReason,
      response_model: responseModel, response_provider: responseProvider, request_id: requestId,
    };
  }

  async function readJson(res, started, aborted) {
    const data = await Promise.race([res.json(), aborted]);
    const choice = data?.choices?.[0] ?? {};
    return {
      content: typeof choice.message?.content === 'string' ? choice.message.content : '',
      refusal: typeof choice.message?.refusal === 'string' ? choice.message.refusal : '',
      ttft_ms: null,
      usage: normalizeUsage(data?.usage),
      finish_reason: choice.finish_reason ?? null,
      response_model: data?.model ?? null,
      response_provider: data?.provider ?? null,
      request_id: data?.id ?? null,
    };
  }

  // ------------------------------------------------------------ public API

  function warmup(context = WARMUP_CONTEXT) {
    return decide(context, { trigger: context.trigger ?? 'plan_refresh', priority: 'normal' });
  }

  function close() {
    if (closed) return;
    closed = true;
    clearPendingTimer();
    if (pending) {
      settle(pending.caller, stub('aborted', 'brain_closed', pending.caller));
      pending = null;
    }
    if (inflight) {
      inflight.controller.abort(new BrainError('aborted', 'brain closed'));
      settle(inflight.caller, stub('aborted', 'brain_closed', inflight.caller));
    }
  }

  return {
    decide,
    warmup,
    close,
    stats: () => ({ ...stats }),
    get provider() {
      return active.provider;
    },
    get model() {
      return active.model;
    },
    get keyName() {
      return active.keyName;
    },
    get systemPrompt() {
      return prompt;
    },
    get caps() {
      return { ...caps };
    },
  };
}

/**
 * Narrow the request after a 400 that names an unsupported parameter.
 * @returns {string|null} what changed, or null if the error is not about a known parameter
 */
export function adapt(caps, err) {
  const param = String(err.param ?? '');
  const text = `${param} ${err.message ?? ''} ${err.raw ?? ''}`;
  const about = (re) => re.test(text);
  if (caps.temperature !== null && about(/temperature/i)) {
    caps.temperature = null;
    return 'temperature: dropped';
  }
  if (caps.effort && about(/reasoning/i)) {
    const from = caps.effort;
    const offered = [...text.matchAll(/'(none|minimal|low|medium|high|xhigh)'/g)].map((m) => m[1]).filter((v) => v !== from);
    caps.effort = ['none', 'minimal', 'low'].find((v) => offered.includes(v)) ?? null;
    return `reasoning_effort: ${from} -> ${caps.effort ?? 'dropped'}`;
  }
  if (caps.orReasoning && about(/reasoning|thinking/i)) {
    caps.orReasoning = null;
    return 'reasoning: dropped';
  }
  if (caps.streamOptions && about(/stream_options/i)) {
    caps.streamOptions = false;
    return 'stream_options: dropped';
  }
  if (caps.stream && about(/\bstream/i)) {
    caps.stream = false;
    caps.streamOptions = false;
    return 'stream: off';
  }
  if (about(/max_completion_tokens|max_tokens/i)) {
    const from = caps.tokensParam;
    caps.tokensParam = from === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
    return `${from} -> ${caps.tokensParam}`;
  }
  if (caps.format !== 'none' && about(/response_format|json_schema|structured|schema/i)) {
    const from = caps.format;
    caps.format = from === 'json_schema' ? 'json_object' : 'none';
    return `response_format: ${from} -> ${caps.format}`;
  }
  if (caps.cacheKey && about(/prompt_cache_key/i)) {
    caps.cacheKey = false;
    return 'prompt_cache_key: dropped';
  }
  if (caps.cacheControl && about(/cache_control/i)) {
    caps.cacheControl = false;
    return 'cache_control: dropped';
  }
  // OpenRouter: "No endpoints found that support the requested parameters" names none of them.
  if (about(/no endpoints found/i)) {
    if (caps.format === 'json_schema') {
      caps.format = 'json_object';
      return 'response_format: json_schema -> json_object (no endpoint)';
    }
    if (caps.orReasoning) {
      caps.orReasoning = null;
      return 'reasoning: dropped (no endpoint)';
    }
    if (caps.format === 'json_object') {
      caps.format = 'none';
      return 'response_format: json_object -> none (no endpoint)';
    }
  }
  return null;
}

async function httpError(res) {
  let bodyText = '';
  try {
    bodyText = await res.text();
  } catch {
    // body unreadable: the status is enough
  }
  let err = {};
  try {
    const parsed = JSON.parse(bodyText);
    err = parsed?.error ?? parsed ?? {};
  } catch {
    // not JSON
  }
  const message = String((typeof err === 'string' ? err : err.message) || bodyText || res.statusText || `HTTP ${res.status}`).slice(0, 400);
  const code = typeof err === 'object' ? err.code : undefined;
  const param = typeof err === 'object' ? err.param : undefined;
  const raw = typeof err?.metadata?.raw === 'string' ? err.metadata.raw.slice(0, 400) : undefined;
  const s = res.status;
  let kind;
  if (s === 401 || s === 403) kind = 'auth';
  else if (s === 402 || code === 'insufficient_quota' || /no credits|insufficient (?:quota|credits|balance)|exceeded your current quota/i.test(message)) kind = 'payment';
  else if (s === 404 && /support|parameter/i.test(message)) kind = 'bad_request';
  else if (s === 404 || code === 'model_not_found' || /not a valid model|model .*does not exist|no endpoints found matching/i.test(message)) kind = 'model_unavailable';
  else if (s === 408) kind = 'timeout';
  else if (s === 429) kind = 'rate_limit';
  else if (s >= 500) kind = 'server';
  else kind = 'bad_request';
  return new BrainError(kind, `HTTP ${s}: ${message}`, {
    status: s,
    code,
    param,
    raw,
    retryable: kind === 'timeout' || kind === 'rate_limit' || kind === 'server',
    retryAfterMs: retryAfter(res.headers),
  });
}

function retryAfter(headers) {
  const ms = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const s = Number(headers.get('retry-after'));
  return Number.isFinite(s) && s > 0 ? s * 1000 : null;
}

function repairPrompt(errors, whyLast = false) {
  const keys = actionKeys({ whyLast }).map((k) => `"${k}"`).join(',');
  return `Ответ не прошёл проверку: ${errors.join('; ')}. Верни исправленный ответ: ровно один JSON-объект {${keys}} по контракту, без пояснений.`;
}

function normalizeUsage(u) {
  if (!u) return null;
  return {
    prompt_tokens: u.prompt_tokens ?? u.input_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? u.output_tokens ?? 0,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? u.input_tokens_details?.cached_tokens ?? 0,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens ?? 0,
    cost_usd: typeof u.cost === 'number' ? u.cost : null,
  };
}

function emptyUsage() {
  return { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, reasoning_tokens: 0, cost_usd: null };
}

function addUsage(total, u) {
  if (!u) return;
  total.prompt_tokens += u.prompt_tokens;
  total.completion_tokens += u.completion_tokens;
  total.cached_tokens += u.cached_tokens;
  total.reasoning_tokens += u.reasoning_tokens;
  if (u.cost_usd != null) total.cost_usd = (total.cost_usd ?? 0) + u.cost_usd;
}

function defaultDayMode() {
  const mode = clockDayMode();
  return mode === 'off' ? 'daily_plans' : mode;
}

function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
