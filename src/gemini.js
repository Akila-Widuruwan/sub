'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
const SYSTEM_PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'system-prompt.txt');

const MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (recommended)' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (highest quality, slower)' },
  { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite (fastest)' },
];

const BATCH_SIZE = 40; // subtitle entries per request
const CONTEXT_SIZE = 8; // previously translated entries shown as context
const MAX_ROUNDS = 3; // rounds over the whole endpoint list, per batch
const MAX_KEYS = 20; // hard cap so a paste accident can't spin forever
const QUOTA_COOLDOWN_MS = 60 * 1000; // key hit a rate/quota limit: park it for a while
const TRANSIENT_COOLDOWN_MS = 3 * 1000; // network / 5xx: try another key first, come back soon
const RECOVERY_WAIT_MS = 5 * 1000; // only wait out short outages; a quota block ends the run
const KEY_CHECK_TIMEOUT_MS = 20 * 1000;

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      id: { type: 'INTEGER' },
      text: { type: 'STRING' },
    },
    required: ['id', 'text'],
    propertyOrdering: ['id', 'text'],
  },
};

// Anime dialogue contains fights, horror and profanity. Only block high-probability content.
const SAFETY_SETTINGS = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));

class GeminiError extends Error {
  /**
   * kind: 'http' (a status came back) | 'network' (request never landed) |
   *       'output' (Gemini answered but the batch was unusable)
   */
  constructor(message, { status, retryable = false, kind = 'http' } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.retryable = retryable;
    this.kind = kind;
  }
}

let systemPromptCache = null;
function getSystemPrompt() {
  if (systemPromptCache === null) {
    systemPromptCache = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf8').trim();
  }
  return systemPromptCache;
}

function isValidModelId(model) {
  return typeof model === 'string' && /^[a-z0-9][a-z0-9.\-]{0,63}$/i.test(model);
}

function friendlyHttpError(status, detail) {
  const d = detail ? ` Details: ${detail}` : '';
  switch (status) {
    case 400:
      return `Gemini rejected the request (400).${d}`;
    case 401:
    case 403:
      return `Gemini refused the API key (${status}). Check that the key is correct and has access to the Gemini API.${d}`;
    case 404:
      return `Model not found (404). Check the model name.${d}`;
    case 429:
      return `Gemini rate/quota limit reached (429). Wait a minute or use a key with more quota.${d}`;
    default:
      if (status >= 500) return `Gemini service error (${status}). Try again shortly.${d}`;
      return `Gemini request failed (${status}).${d}`;
  }
}

function isRetryableError(err) {
  return err instanceof GeminiError && err.retryable;
}

function maskKey(key) {
  const k = String(key == null ? '' : key);
  if (k.length <= 8) return '•'.repeat(k.length);
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

/**
 * Accepts an array of keys or a string containing keys separated by newlines
 * or commas; trims, drops blanks and duplicates, and sanity-checks each one.
 */
function parseKeys(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : [];
  const out = [];
  for (const item of raw) {
    const key = String(item == null ? '' : item).trim();
    if (!key) continue;
    if (!/^[\w\-.:]{8,300}$/.test(key)) {
      throw new GeminiError(
        `"${maskKey(key)}" doesn't look like an API key. Keys are one per line, with no spaces.`
      );
    }
    if (!out.includes(key)) out.push(key);
  }
  if (out.length > MAX_KEYS) {
    throw new GeminiError(`Too many API keys (${out.length}). The limit is ${MAX_KEYS}.`);
  }
  return out;
}

function resolveBaseUrl(baseUrl) {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Call the Gemini generateContent endpoint once and return the parsed JSON
 * array produced by the model.
 */
async function callGemini({ apiKey, model, systemPrompt, userPrompt, baseUrl, fetchImpl, signal }) {
  const url = `${resolveBaseUrl(baseUrl)}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.8,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
    },
    safetySettings: SAFETY_SETTINGS,
  };

  let res;
  try {
    res = await (fetchImpl || fetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new GeminiError(`Could not reach Gemini: ${err.message}`, { retryable: true, kind: 'network' });
  }

  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch (_) {
    data = null;
  }

  if (!res.ok) {
    const detail = data?.error?.message || '';
    const retryable = res.status === 429 || res.status >= 500;
    throw new GeminiError(friendlyHttpError(res.status, detail), { status: res.status, retryable });
  }

  if (data?.promptFeedback?.blockReason) {
    throw new GeminiError(`Gemini blocked this batch (${data.promptFeedback.blockReason}).`, { kind: 'output' });
  }

  const candidate = data?.candidates?.[0];
  if (!candidate) throw new GeminiError('Gemini returned no candidates.', { retryable: true, kind: 'output' });
  if (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
    throw new GeminiError(`Gemini stopped early (${candidate.finishReason}).`, { retryable: true, kind: 'output' });
  }

  const text = (candidate.content?.parts || []).map((p) => p.text || '').join('').trim();
  return parseModelJson(text);
}

function parseModelJson(text) {
  let s = text.trim();
  // Be tolerant if the model wraps JSON in a code fence despite the MIME type.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(s);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed;
  } catch (err) {
    throw new GeminiError(`Model output was not valid JSON (${err.message}).`, { retryable: true, kind: 'output' });
  }
}

/** Check that the model returned exactly one translation per requested id. */
function validateBatchResult(result, expectedIds) {
  const byId = new Map();
  for (const item of result) {
    if (!item || typeof item !== 'object') throw new GeminiError('Model returned a malformed item.', { retryable: true, kind: 'output' });
    const id = Number(item.id);
    if (!Number.isInteger(id)) throw new GeminiError('Model returned a non-integer id.', { retryable: true, kind: 'output' });
    if (typeof item.text !== 'string') throw new GeminiError(`Model returned no text for id ${id}.`, { retryable: true, kind: 'output' });
    if (byId.has(id)) throw new GeminiError(`Model returned duplicate id ${id}.`, { retryable: true, kind: 'output' });
    byId.set(id, item.text);
  }
  const missing = expectedIds.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new GeminiError(`Model skipped ${missing.length} subtitle(s) (e.g. id ${missing[0]}).`, { retryable: true, kind: 'output' });
  }
  return byId;
}

function buildUserPrompt(batch, context) {
  const lines = [];
  lines.push('You are translating one part of a single episode. The full SRT is split into consecutive parts.');
  lines.push('');
  if (context.length) {
    lines.push('CONTEXT — already translated lines just before this part (for continuity only; do NOT translate or return them):');
    lines.push(JSON.stringify(context, null, 0));
    lines.push('');
  }
  lines.push('TRANSLATE — return one item per entry below, with the same "id" and a Sinhala "text". Keep line breaks inside an entry only if the original has them:');
  lines.push(JSON.stringify(batch.map((e) => ({ id: e.id, text: e.text })), null, 0));
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * Endpoint pool: every (model × key) combination is one "endpoint".
 * A batch walks the pool in order until one endpoint answers; broken
 * keys and missing models are taken out of the pool for the whole run.
 * ------------------------------------------------------------------ */

function buildEndpoints({ keys, model, fallbackModels = [], baseUrl }) {
  const models = [model, ...fallbackModels.filter((m) => m && m !== model)];
  const endpoints = [];
  for (const m of models) {
    keys.forEach((key, keyIndex) => {
      endpoints.push({
        key,
        keyIndex,
        model: m,
        baseUrl,
        label: `Key ${keyIndex + 1} · ${m}`,
        disabled: false,
        disabledReason: null,
        cooldownUntil: 0,
        failures: 0,
      });
    });
  }
  return endpoints;
}

function describeEndpoint(endpoint) {
  if (!endpoint) return null;
  return { keyIndex: endpoint.keyIndex, model: endpoint.model, label: endpoint.label };
}

class EndpointPool {
  constructor(endpoints) {
    this.endpoints = endpoints;
    this.preferred = 0;
  }

  /** Next usable endpoint after `from`, wrapping around. -1 when none left. */
  findNext(from) {
    const n = this.endpoints.length;
    if (!n) return -1;
    const now = Date.now();
    for (let i = 1; i <= n; i++) {
      const index = (((from + i) % n) + n) % n;
      const ep = this.endpoints[index];
      if (!ep.disabled && ep.cooldownUntil <= now) return index;
    }
    return -1;
  }

  /**
   * Decide what a failure means for the pool:
   *  - a rejected key kills every endpoint using that key
   *  - a missing model kills every endpoint using that model
   *  - a quota hit parks the key briefly (another key can carry on)
   */
  recordFailure(endpoint, err) {
    const status = err instanceof GeminiError ? err.status : undefined;
    const kind = err instanceof GeminiError ? err.kind : 'unknown';
    endpoint.failures++;

    if (status === 401 || status === 403) {
      for (const ep of this.endpoints) {
        if (ep.key === endpoint.key) {
          ep.disabled = true;
          ep.disabledReason = 'key rejected';
        }
      }
      return 'fatal';
    }
    if (status === 404) {
      for (const ep of this.endpoints) {
        if (ep.model === endpoint.model) {
          ep.disabled = true;
          ep.disabledReason = 'model unavailable';
        }
      }
      return 'fatal';
    }
    if (status === 429) {
      const until = Date.now() + QUOTA_COOLDOWN_MS;
      for (const ep of this.endpoints) {
        if (ep.key === endpoint.key && ep.cooldownUntil < until) ep.cooldownUntil = until;
      }
      return 'cooldown';
    }
    // Gemini answered but the batch was unusable (bad JSON, skipped lines…):
    // the key is fine, so let the next round simply ask again.
    if (kind === 'output') return 'retryable';
    if (kind === 'network' || (status !== undefined && status >= 500)) {
      endpoint.cooldownUntil = Math.max(endpoint.cooldownUntil, Date.now() + TRANSIENT_COOLDOWN_MS);
      return 'retryable';
    }
    endpoint.disabled = true;
    endpoint.disabledReason = err.message;
    return 'fatal';
  }

  /** Milliseconds until the next parked endpoint becomes usable again. */
  earliestRecoveryMs() {
    let soonest = Infinity;
    const now = Date.now();
    for (const ep of this.endpoints) {
      if (ep.disabled) continue;
      if (ep.cooldownUntil > now) soonest = Math.min(soonest, ep.cooldownUntil);
    }
    return soonest === Infinity ? Infinity : soonest - now;
  }

  get available() {
    return this.endpoints.filter((ep) => !ep.disabled && ep.cooldownUntil <= Date.now()).length;
  }
}

function summarizeFailures(failures) {
  const seen = new Map();
  for (const f of failures) if (!seen.has(f.label)) seen.set(f.label, f.message);
  const lines = [...seen].map(([label, message]) => `${label}: ${message}`);
  const shown = lines.slice(0, 3).join(' | ');
  return lines.length > 3 ? `${shown} | (+${lines.length - 3} more)` : shown;
}

function buildExhaustedError(failures, pool) {
  if (!failures.length) {
    const dead = pool.endpoints
      .filter((ep) => ep.disabled)
      .slice(0, 3)
      .map((ep) => `${ep.label} (${ep.disabledReason || 'unavailable'})`);
    return new GeminiError(`No usable API key left. ${dead.join('; ')}`);
  }
  const summary = summarizeFailures(failures);
  const statuses = new Set(failures.map((f) => f.status));
  if (statuses.size === 1 && (statuses.has(401) || statuses.has(403))) {
    return new GeminiError(
      `Every API key was rejected (${[...statuses][0]}). Check that the keys are valid and have Gemini API access. ${summary}`
    );
  }
  if (statuses.size === 1 && statuses.has(429)) {
    return new GeminiError(
      `Every API key is out of quota or rate limited (429). Wait a while, or add another key. ${summary}`
    );
  }
  return new GeminiError(`Every API key failed on this batch. ${summary}`);
}

/**
 * Run one batch against the pool, failing over to the next endpoint on any
 * error. Returns the validated map plus the endpoint that answered.
 */
async function translateBatchWithFailover(pool, options) {
  const { systemPrompt, userPrompt, expectedIds, baseUrl, fetchImpl, sleep, onEvent, batchStart } = options;
  const failures = [];
  let sawRetryable = false;
  let cursor = pool.preferred;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    let index = pool.findNext(cursor - 1);
    if (index < 0) {
      // Nothing usable right now: wait only for a short outage, never for a quota block.
      if (!sawRetryable || round === MAX_ROUNDS) break;
      const wait = pool.earliestRecoveryMs();
      if (wait > RECOVERY_WAIT_MS) break;
      await sleep(Math.max(1000 * 2 ** (round - 1), wait));
      continue;
    }

    const firstIndex = index;
    for (;;) {
      const endpoint = pool.endpoints[index];
      try {
        const result = await callGemini({
          apiKey: endpoint.key,
          model: endpoint.model,
          baseUrl: endpoint.baseUrl || baseUrl,
          systemPrompt,
          userPrompt,
          fetchImpl,
        });
        const byId = validateBatchResult(result, expectedIds);
        pool.preferred = index; // stick with whatever is working
        return { byId, endpoint };
      } catch (err) {
        failures.push({
          label: endpoint.label,
          status: err instanceof GeminiError ? err.status : undefined,
          message: err.message,
        });
        if (isRetryableError(err)) sawRetryable = true;
        pool.recordFailure(endpoint, err);
        if (onEvent) {
          onEvent({
            type: 'failover',
            batchStart: batchStart + 1,
            endpoint: describeEndpoint(endpoint),
            reason: err.message,
            remaining: pool.available,
          });
        }
      }
      index = pool.findNext(index);
      if (index < 0 || index === firstIndex) break;
    }

    if (round === MAX_ROUNDS || !sawRetryable) break;
    const backoff = 1000 * 2 ** (round - 1);
    if (pool.findNext(pool.preferred - 1) < 0) {
      const wait = pool.earliestRecoveryMs();
      if (wait > RECOVERY_WAIT_MS) break; // e.g. every key is quota-blocked
      await sleep(Math.max(backoff, wait));
    } else {
      await sleep(backoff);
    }
    cursor = pool.preferred;
  }

  throw buildExhaustedError(failures, pool);
}

/**
 * Translate parsed SRT entries with Gemini, in order, in batches.
 *
 * `keys` (array or newline/comma separated string) holds one or more Gemini
 * API keys; if an endpoint fails the next key (and then the next fallback
 * model) is used automatically. Returns an array of translated text strings,
 * aligned with `entries`.
 */
async function translateEntries(entries, options) {
  const {
    apiKey,
    keys,
    model,
    fallbackModels = [],
    baseUrl,
    fetchImpl,
    onProgress,
    onEvent,
    stats,
    batchSize = BATCH_SIZE,
    sleep = defaultSleep,
  } = options || {};

  const keyList = parseKeys(keys === undefined || keys === null ? apiKey : keys);
  if (!keyList.length) throw new GeminiError('At least one Gemini API key is required.');
  if (!isValidModelId(model)) throw new GeminiError('Invalid model name.');
  const fallbacks = (Array.isArray(fallbackModels) ? fallbackModels : [fallbackModels]).filter(Boolean);
  for (const m of fallbacks) {
    if (!isValidModelId(m)) throw new GeminiError(`Invalid fallback model name: ${m}.`);
  }

  const pool = new EndpointPool(buildEndpoints({ keys: keyList, model, fallbackModels: fallbacks, baseUrl }));
  const systemPrompt = getSystemPrompt();
  const translations = new Array(entries.length);
  const total = entries.length;
  const batchesPerEndpoint = new Map();
  let active = null;

  for (let start = 0; start < total; start += batchSize) {
    const slice = entries.slice(start, start + batchSize);
    // Only send non-empty lines to the model; empty subtitles are kept as-is.
    const batch = [];
    slice.forEach((e, k) => {
      if (e.text.trim() !== '') batch.push({ id: start + k, text: e.text });
    });

    if (batch.length) {
      const context = [];
      for (let k = Math.max(0, start - CONTEXT_SIZE); k < start; k++) {
        if (translations[k] !== undefined && entries[k].text.trim() !== '') {
          context.push({ source: entries[k].text, sinhala: translations[k] });
        }
      }
      const userPrompt = buildUserPrompt(batch, context);
      const expectedIds = batch.map((b) => b.id);

      const outcome = await translateBatchWithFailover(pool, {
        systemPrompt,
        userPrompt,
        expectedIds,
        baseUrl,
        fetchImpl,
        sleep,
        onEvent,
        batchStart: start,
      });

      active = outcome.endpoint;
      batchesPerEndpoint.set(active.label, (batchesPerEndpoint.get(active.label) || 0) + 1);
      for (const b of batch) translations[b.id] = outcome.byId.get(b.id).trim();
    }

    for (let k = 0; k < slice.length; k++) {
      if (translations[start + k] === undefined) translations[start + k] = slice[k].text;
    }

    if (onProgress) onProgress(Math.min(start + slice.length, total), total, describeEndpoint(active));
  }

  if (stats) {
    stats.used = [...batchesPerEndpoint.entries()].map(([label, batches]) => {
      const endpoint = pool.endpoints.find((ep) => ep.label === label);
      return { keyIndex: endpoint ? endpoint.keyIndex : null, model: endpoint ? endpoint.model : null, batches };
    });
    stats.deadEndpoints = pool.endpoints
      .filter((ep) => ep.disabled)
      .map((ep) => ({ keyIndex: ep.keyIndex, model: ep.model, reason: ep.disabledReason }));
  }

  return translations;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lightweight health check for each key: lists the models the key can call.
 * Never throws for a single bad key — per-key results are returned instead.
 */
async function checkKeys(input, { baseUrl, fetchImpl, timeoutMs = KEY_CHECK_TIMEOUT_MS } = {}) {
  const keys = parseKeys(input);
  const base = resolveBaseUrl(baseUrl);

  return Promise.all(
    keys.map(async (key, index) => {
      const entry = { index, label: `Key ${index + 1}`, masked: maskKey(key), ok: false, status: null, message: '', models: [] };
      let res;
      let raw = '';
      try {
        res = await (fetchImpl || fetch)(
          `${base}/v1beta/models?key=${encodeURIComponent(key)}&pageSize=1000`,
          { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(timeoutMs) }
        );
        raw = await res.text();
      } catch (err) {
        entry.message = `Could not reach Gemini: ${err.message}`;
        return entry;
      }

      let data = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch (_) {
        data = null;
      }
      entry.status = res.status;

      if (!res.ok) {
        entry.message = friendlyHttpError(res.status, data?.error?.message || '');
        return entry;
      }

      entry.ok = true;
      entry.message = 'Working — Gemini accepted this key.';
      entry.models = (data?.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''))
        .sort();
      return entry;
    })
  );
}

module.exports = {
  MODELS,
  BATCH_SIZE,
  MAX_KEYS,
  GeminiError,
  translateEntries,
  validateBatchResult,
  buildUserPrompt,
  parseModelJson,
  isValidModelId,
  getSystemPrompt,
  DEFAULT_BASE_URL,
  // multi-key failover
  parseKeys,
  maskKey,
  checkKeys,
  buildEndpoints,
  EndpointPool,
};
