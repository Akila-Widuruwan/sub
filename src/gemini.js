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
const MAX_ATTEMPTS = 3; // attempts per batch (transient errors / bad output)

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
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
    this.retryable = retryable;
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

/**
 * Call the Gemini generateContent endpoint once and return the parsed JSON
 * array produced by the model.
 */
async function callGemini({ apiKey, model, systemPrompt, userPrompt, baseUrl, fetchImpl }) {
  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
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
    });
  } catch (err) {
    throw new GeminiError(`Could not reach Gemini: ${err.message}`, { retryable: true });
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
    throw new GeminiError(`Gemini blocked this batch (${data.promptFeedback.blockReason}).`);
  }

  const candidate = data?.candidates?.[0];
  if (!candidate) throw new GeminiError('Gemini returned no candidates.', { retryable: true });
  if (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
    throw new GeminiError(`Gemini stopped early (${candidate.finishReason}).`, { retryable: true });
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
    throw new GeminiError(`Model output was not valid JSON (${err.message}).`, { retryable: true });
  }
}

/** Check that the model returned exactly one translation per requested id. */
function validateBatchResult(result, expectedIds) {
  const byId = new Map();
  for (const item of result) {
    if (!item || typeof item !== 'object') throw new GeminiError('Model returned a malformed item.', { retryable: true });
    const id = Number(item.id);
    if (!Number.isInteger(id)) throw new GeminiError('Model returned a non-integer id.', { retryable: true });
    if (typeof item.text !== 'string') throw new GeminiError(`Model returned no text for id ${id}.`, { retryable: true });
    if (byId.has(id)) throw new GeminiError(`Model returned duplicate id ${id}.`, { retryable: true });
    byId.set(id, item.text);
  }
  const missing = expectedIds.filter((id) => !byId.has(id));
  if (missing.length) {
    throw new GeminiError(`Model skipped ${missing.length} subtitle(s) (e.g. id ${missing[0]}).`, { retryable: true });
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

/**
 * Translate parsed SRT entries with Gemini, in order, in batches.
 * Returns an array of translated text strings, aligned with `entries`.
 */
async function translateEntries(entries, options) {
  const { apiKey, model, baseUrl, fetchImpl, onProgress, batchSize = BATCH_SIZE, sleep = defaultSleep } = options;
  if (!apiKey) throw new GeminiError('A Gemini API key is required.');
  if (!isValidModelId(model)) throw new GeminiError('Invalid model name.');

  const systemPrompt = getSystemPrompt();
  const translations = new Array(entries.length);
  const total = entries.length;

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

      let byId = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !byId; attempt++) {
        try {
          const result = await callGemini({ apiKey, model, systemPrompt, userPrompt, baseUrl, fetchImpl });
          byId = validateBatchResult(result, expectedIds);
        } catch (err) {
          lastErr = err;
          const retryable = err instanceof GeminiError ? err.retryable : false;
          if (!retryable || attempt === MAX_ATTEMPTS) break;
          await sleep(1000 * 2 ** (attempt - 1));
        }
      }
      if (!byId) {
        throw lastErr instanceof GeminiError
          ? lastErr
          : new GeminiError(`Translation failed: ${lastErr?.message || 'unknown error'}`);
      }
      for (const b of batch) translations[b.id] = byId.get(b.id).trim();
    }

    for (let k = 0; k < slice.length; k++) {
      if (translations[start + k] === undefined) translations[start + k] = slice[k].text;
    }

    if (onProgress) onProgress(Math.min(start + slice.length, total), total);
  }

  return translations;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  MODELS,
  BATCH_SIZE,
  GeminiError,
  translateEntries,
  validateBatchResult,
  buildUserPrompt,
  parseModelJson,
  isValidModelId,
  getSystemPrompt,
  DEFAULT_BASE_URL,
};
