'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { parseSrt, buildSrt } = require('./src/srt');
const {
  translateEntries,
  MODELS,
  GeminiError,
  isValidModelId,
  parseKeys,
  checkKeys,
} = require('./src/gemini');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readJson(req) {
  return readBody(req).then((text) => JSON.parse(text));
}

/** Accepts an array or a newline/comma separated string; returns trimmed strings. */
function toStringList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v == null ? '' : v).trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);
  return [];
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

async function handleTranslate(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status === 413 ? err.message : 'Invalid JSON body.' });
  }

  let keys = toStringList(payload.keys !== undefined && payload.keys !== null ? payload.keys : payload.apiKey);
  const model = typeof payload.model === 'string' ? payload.model.trim() : '';
  const fallbackModels = toStringList(payload.fallbackModels).filter((m) => m !== model);
  const patient = payload.patient === true;
  const srt = typeof payload.srt === 'string' ? payload.srt : '';

  if (!keys.length) return sendJson(res, 400, { error: 'Please enter at least one Gemini API key.' });
  try {
    keys = parseKeys(keys); // trims, drops duplicates and rejects obvious paste mistakes
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
  if (!isValidModelId(model)) return sendJson(res, 400, { error: 'Please choose a valid Gemini model.' });
  if (fallbackModels.some((m) => !isValidModelId(m))) {
    return sendJson(res, 400, { error: 'Please choose valid Gemini fallback models.' });
  }

  let entries;
  try {
    entries = parseSrt(srt);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  // Stream NDJSON so the browser can show progress for long episodes.
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  });
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  send({ type: 'start', total: entries.length, keys: keys.length, model, fallbackModels });

  const stats = {};
  try {
    const sourceEntries = entries.map((e) => ({ ...e }));
    const translations = await translateEntries(sourceEntries, {
      keys,
      model,
      fallbackModels,
      patient,
      baseUrl: process.env.GEMINI_BASE_URL || undefined,
      onProgress: (done, total, endpoint) => send({ type: 'progress', done, total, endpoint }),
      onEvent: (evt) => send(evt),
      stats,
    });
    const output = entries.map((e, i) => ({ ...e, text: translations[i] }));
    send({ type: 'result', srt: buildSrt(output), count: output.length, used: stats.used || [] });
  } catch (err) {
    if (err instanceof GeminiError) {
      send({ type: 'error', message: err.message, hint: err.hint || null, failures: err.failures || [] });
    } else {
      console.error('Unexpected translation error:', err);
      send({ type: 'error', message: 'Unexpected server error while translating.' });
    }
  }
  res.end();
}

async function handleKeyCheck(req, res) {
  let payload;
  try {
    payload = await readJson(req);
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.status === 413 ? err.message : 'Invalid JSON body.' });
  }

  let keys = toStringList(payload.keys !== undefined && payload.keys !== null ? payload.keys : payload.apiKey);
  if (!keys.length) return sendJson(res, 400, { error: 'Please enter at least one Gemini API key.' });
  try {
    keys = parseKeys(keys);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  try {
    const results = await checkKeys(keys, { baseUrl: process.env.GEMINI_BASE_URL || undefined });
    sendJson(res, 200, { results });
  } catch (err) {
    const message = err instanceof GeminiError ? err.message : 'Could not check the keys.';
    sendJson(res, err instanceof GeminiError ? 400 : 502, { error: message });
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url.startsWith('/api/models')) {
        return sendJson(res, 200, { models: MODELS });
      }
      if (req.method === 'POST' && req.url === '/api/keys/check') {
        return await handleKeyCheck(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/translate') {
        return await handleTranslate(req, res);
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        return serveStatic(req, res);
      }
      res.writeHead(405).end('Method not allowed');
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Server error.' });
      else res.end();
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`Sinhala SRT translator running on http://0.0.0.0:${port}`);
  });
}

module.exports = { createServer };
