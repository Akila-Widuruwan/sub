'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseSrt, buildSrt } = require('../src/srt');
const {
  translateEntries,
  validateBatchResult,
  GeminiError,
  parseModelJson,
  isValidModelId,
  parseKeys,
  maskKey,
  checkKeys,
  buildEndpoints,
} = require('../src/gemini');
const { createServer } = require('../server');

const SAMPLE = `1
00:00:01,000 --> 00:00:03,000
What are you doing?

2
00:00:03,500 --> 00:00:05,000
Line one
line two

3
00:00:05,500 --> 00:00:06,000
`;

const KEY_A = 'AIzaTEST_KEY_AAAA';
const KEY_B = 'AIzaTEST_KEY_BBBB';

test('parseSrt keeps numbers, timings and multi-line text', () => {
  const entries = parseSrt(SAMPLE);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], { index: '1', timing: '00:00:01,000 --> 00:00:03,000', text: 'What are you doing?' });
  assert.equal(entries[1].text, 'Line one\nline two');
  assert.equal(entries[2].text, '');
});

test('parseSrt handles CRLF and BOM', () => {
  const entries = parseSrt('\uFEFF1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n');
  assert.equal(entries[0].text, 'Hi');
});

test('parseSrt rejects non-SRT input', () => {
  assert.throws(() => parseSrt('hello world'), /Invalid SRT|No subtitle/);
  assert.throws(() => parseSrt('   '), /empty/);
});

test('buildSrt round-trips the structure', () => {
  const out = buildSrt(parseSrt(SAMPLE).map((e, i) => ({ ...e, text: 'X' + i })));
  assert.equal(
    out,
    '1\n00:00:01,000 --> 00:00:03,000\nX0\n\n2\n00:00:03,500 --> 00:00:05,000\nX1\n\n3\n00:00:05,500 --> 00:00:06,000\nX2\n'
  );
});

test('validateBatchResult requires every id exactly once', () => {
  assert.throws(() => validateBatchResult([{ id: 0, text: 'a' }], [0, 1]), GeminiError);
  assert.throws(() => validateBatchResult([{ id: 0, text: 'a' }, { id: 0, text: 'b' }], [0]), /duplicate/);
  const ok = validateBatchResult([{ id: 1, text: 'b' }, { id: 0, text: 'a' }], [0, 1]);
  assert.equal(ok.get(0), 'a');
});

test('parseModelJson tolerates a code fence and rejects non-arrays', () => {
  assert.deepEqual(parseModelJson('```json\n[{"id":0,"text":"x"}]\n```'), [{ id: 0, text: 'x' }]);
  assert.throws(() => parseModelJson('{"id":0}'), GeminiError);
});

test('isValidModelId blocks path tricks', () => {
  assert.equal(isValidModelId('gemini-2.5-flash'), true);
  assert.equal(isValidModelId('../evil'), false);
  assert.equal(isValidModelId(''), false);
});

/* ------------------------------------------------------------------ *
 * Key parsing / pooling
 * ------------------------------------------------------------------ */

test('parseKeys accepts arrays and newline or comma separated strings', () => {
  assert.deepEqual(parseKeys([KEY_A, ` ${KEY_B} `]), [KEY_A, KEY_B]);
  assert.deepEqual(parseKeys(`${KEY_A}\n${KEY_B}\n`), [KEY_A, KEY_B]);
  assert.deepEqual(parseKeys(`${KEY_A},${KEY_B}`), [KEY_A, KEY_B]);
  assert.deepEqual(parseKeys(`${KEY_A}\n${KEY_A}`), [KEY_A], 'duplicates collapse');
  assert.deepEqual(parseKeys('  '), []);
  assert.throws(() => parseKeys('two words here'), /doesn't look like an API key/);
});

test('maskKey never reveals more than the ends of a key', () => {
  assert.equal(maskKey(''), '');
  assert.equal(maskKey(KEY_A), 'AIza…AAAA');
  assert.equal(maskKey('short'), '•••••');
});

test('buildEndpoints rotates keys before falling back to another model', () => {
  const endpoints = buildEndpoints({
    keys: [KEY_A, KEY_B],
    model: 'gemini-2.5-pro',
    fallbackModels: ['gemini-2.5-flash'],
  });
  assert.deepEqual(
    endpoints.map((e) => `${e.keyIndex}:${e.model}`),
    ['0:gemini-2.5-pro', '1:gemini-2.5-pro', '0:gemini-2.5-flash', '1:gemini-2.5-flash']
  );
  // A model equal to the primary one is not added twice.
  const noDupes = buildEndpoints({ keys: [KEY_A], model: 'm1', fallbackModels: ['m1', 'm2'] });
  assert.deepEqual(noDupes.map((e) => e.model), ['m1', 'm2']);
});

/* ------------------------------------------------------------------ *
 * Fake Gemini endpoint: routes by key and model, records every call.
 * ------------------------------------------------------------------ */

function reply(spec) {
  if (spec instanceof Response) return spec;
  if (spec.status && spec.status !== 200) {
    return new Response(JSON.stringify({ error: { message: spec.message || 'error' } }), { status: spec.status });
  }
  const items = spec.items.map((e) => ({ id: e.id, text: (spec.prefix || 'SI:') + e.text }));
  return new Response(
    JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(items) }] } }] }),
    { status: 200 }
  );
}

function fakeGemini(behaviour) {
  const calls = [];
  let skipped = false;
  const fetchImpl = async (url, init) => {
    const key = init.headers['x-goog-api-key'];
    const model = decodeURIComponent(String(url).split('/models/')[1].split(':')[0]);
    const body = JSON.parse(init.body);
    const prompt = body.contents[0].parts[0].text;
    const items = JSON.parse(prompt.split('TRANSLATE')[1].split('\n').slice(1).join('\n'));
    calls.push({ key, model, url, headers: init.headers, body, prompt, items });
    if (typeof behaviour === 'function') {
      const spec = Object.assign({ items }, behaviour({ key, model, items, call: calls.length }));
      if (spec.skipIds && spec.skipIds.length && !skipped) {
        skipped = true;
        spec.items = items.filter((e) => e.id !== spec.skipIds[0]);
      }
      return reply(spec);
    }
    return reply({ items });
  };
  return { fetchImpl, calls };
}

const noSleep = async () => {};

test('translateEntries batches, keeps order and sends the key in a header', async () => {
  const entries = parseSrt(SAMPLE);
  const { fetchImpl, calls } = fakeGemini();
  const out = await translateEntries(entries, {
    apiKey: KEY_A,
    model: 'gemini-2.5-flash',
    fetchImpl,
    batchSize: 2,
    baseUrl: 'https://example.test',
  });
  assert.deepEqual(out, ['SI:What are you doing?', 'SI:Line one\nline two', '']);
  // Entry 3 is empty, so only 2 batches of non-empty text are sent: [0,1] then none for [2].
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(calls[0].headers['x-goog-api-key'], KEY_A);
  assert.match(calls[0].prompt, /TRANSLATE/);
  assert.doesNotMatch(calls[0].prompt, /CONTEXT/);
});

test('second batch includes previous translations as context', async () => {
  const entries = parseSrt(SAMPLE.replace('3\n00:00:05,500 --> 00:00:06,000\n', '3\n00:00:05,500 --> 00:00:06,000\nThird\n'));
  const { fetchImpl, calls } = fakeGemini();
  const out = await translateEntries(entries, { apiKey: KEY_A, model: 'gemini-2.5-flash', fetchImpl, batchSize: 2, sleep: noSleep });
  assert.equal(out[2], 'SI:Third');
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /CONTEXT/);
  assert.match(calls[1].prompt, /SI:What are you doing\?/);
});

test('a skipped subtitle triggers a retry and then succeeds', async () => {
  const entries = parseSrt(SAMPLE);
  const { fetchImpl, calls } = fakeGemini(() => ({ skipIds: [1] }));
  const out = await translateEntries(entries, { apiKey: KEY_A, model: 'gemini-2.5-flash', fetchImpl, sleep: noSleep });
  assert.equal(out[1], 'SI:Line one\nline two');
  assert.equal(calls.length, 2);
});

test('an API key error is reported without retrying', async () => {
  const entries = parseSrt(SAMPLE);
  const { fetchImpl, calls } = fakeGemini(() => ({ status: 403, message: 'API key not valid' }));
  await assert.rejects(
    translateEntries(entries, { apiKey: KEY_A, model: 'gemini-2.5-flash', fetchImpl, sleep: noSleep }),
    (err) => err instanceof GeminiError && /refused the API key|Every API key was rejected/.test(err.message)
  );
  assert.equal(calls.length, 1);
});

/* ------------------------------------------------------------------ *
 * Multi-key / model failover
 * ------------------------------------------------------------------ */

const THREE_LINES = `1
00:00:01,000 --> 00:00:02,000
One

2
00:00:02,000 --> 00:00:03,000
Two

3
00:00:03,000 --> 00:00:04,000
Three
`;

test('a rate-limited key falls over to the next key', async () => {
  const entries = parseSrt(THREE_LINES);
  const { fetchImpl, calls } = fakeGemini(({ key }) => (key === KEY_A ? { status: 429, message: 'quota' } : {}));
  const out = await translateEntries(entries, {
    keys: [KEY_A, KEY_B],
    model: 'gemini-2.5-flash',
    fetchImpl,
    sleep: noSleep,
  });
  assert.deepEqual(out, ['SI:One', 'SI:Two', 'SI:Three']);
  assert.deepEqual(calls.map((c) => c.key), [KEY_A, KEY_B]);
});

test('a rejected key is dropped for the rest of the run', async () => {
  const entries = parseSrt(THREE_LINES);
  const { fetchImpl, calls } = fakeGemini(({ key }) => (key === KEY_A ? { status: 403, message: 'API key not valid' } : {}));
  const out = await translateEntries(entries, {
    keys: [KEY_A, KEY_B],
    model: 'gemini-2.5-flash',
    fetchImpl,
    batchSize: 1,
    sleep: noSleep,
  });
  assert.deepEqual(out, ['SI:One', 'SI:Two', 'SI:Three']);
  // Key A is tried once, marked dead, and never touched again: 1 + 3 batches.
  assert.equal(calls.filter((c) => c.key === KEY_A).length, 1);
  assert.equal(calls.filter((c) => c.key === KEY_B).length, 3);
});

test('a key that fails mid-episode is replaced and the episode still finishes', async () => {
  const entries = parseSrt(THREE_LINES);
  const { fetchImpl, calls } = fakeGemini(({ key, call }) =>
    key === KEY_A && call > 1 ? { status: 500, message: 'backend exploded' } : {}
  );
  const stats = {};
  const out = await translateEntries(entries, {
    keys: [KEY_A, KEY_B],
    model: 'gemini-2.5-flash',
    fetchImpl,
    batchSize: 1,
    sleep: noSleep,
    stats,
  });
  assert.deepEqual(out, ['SI:One', 'SI:Two', 'SI:Three']);
  assert.equal(calls.filter((c) => c.key === KEY_B).length, 2);
  assert.deepEqual(stats.used.map((u) => u.keyIndex), [0, 1]);
});

test('all keys failing on a model falls back to the next model', async () => {
  const entries = parseSrt(THREE_LINES);
  const { fetchImpl, calls } = fakeGemini(({ model }) =>
    model === 'gemini-2.5-pro' ? { status: 404, message: 'model not found' } : { prefix: 'FLASH:' }
  );
  const out = await translateEntries(entries, {
    keys: [KEY_A, KEY_B],
    model: 'gemini-2.5-pro',
    fallbackModels: ['gemini-2.5-flash'],
    fetchImpl,
    sleep: noSleep,
  });
  assert.deepEqual(out, ['FLASH:One', 'FLASH:Two', 'FLASH:Three']);
  // A 404 kills the model for every key at once, then the fallback model takes over.
  assert.equal(calls.filter((c) => c.model === 'gemini-2.5-pro').length, 1);
  assert.equal(calls.filter((c) => c.model === 'gemini-2.5-flash').length, 1);
  assert.deepEqual(calls.map((c) => c.model), ['gemini-2.5-pro', 'gemini-2.5-flash']);
});

test('every key/model failing reports a combined error', async () => {
  const entries = parseSrt(THREE_LINES);
  const { fetchImpl, calls } = fakeGemini(() => ({ status: 429, message: 'quota' }));
  await assert.rejects(
    translateEntries(entries, {
      keys: [KEY_A, KEY_B],
      model: 'gemini-2.5-flash',
      fallbackModels: ['gemini-2.5-pro'],
      fetchImpl,
      sleep: noSleep,
    }),
    (err) => err instanceof GeminiError && /out of quota or rate limited/.test(err.message)
  );
  assert.equal(calls.length, 2, 'each key is tried once per model before giving up');
});

test('failover events are reported per failed endpoint', async () => {
  const entries = parseSrt(THREE_LINES);
  const { fetchImpl } = fakeGemini(({ key }) => (key === KEY_A ? { status: 429, message: 'quota' } : {}));
  const events = [];
  await translateEntries(entries, {
    keys: [KEY_A, KEY_B],
    model: 'gemini-2.5-flash',
    fetchImpl,
    sleep: noSleep,
    onEvent: (e) => events.push(e),
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'failover');
  assert.deepEqual(events[0].endpoint, { keyIndex: 0, model: 'gemini-2.5-flash', label: 'Key 1 · gemini-2.5-flash' });
  assert.match(events[0].reason, /quota|429/);
  assert.equal(events[0].remaining, 1);
});

test('translateEntries rejects an empty key list and a bad model', async () => {
  await assert.rejects(
    translateEntries(parseSrt(THREE_LINES), { keys: [], model: 'gemini-2.5-flash' }),
    (err) => err instanceof GeminiError && /at least one Gemini API key/i.test(err.message)
  );
  await assert.rejects(
    translateEntries(parseSrt(THREE_LINES), { keys: [KEY_A], model: '../etc/passwd' }),
    (err) => err instanceof GeminiError && /Invalid model name/.test(err.message)
  );
});

/* ------------------------------------------------------------------ *
 * Key health check
 * ------------------------------------------------------------------ */

test('checkKeys reports per-key status without throwing', async () => {
  const mock = http.createServer((req, res) => {
    const key = new URL(req.url, 'http://x').searchParams.get('key');
    res.setHeader('Content-Type', 'application/json');
    if (key === KEY_B) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: { message: 'API key not valid' } }));
      return;
    }
    res.writeHead(200);
    res.end(
      JSON.stringify({
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        ],
      })
    );
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  try {
    const results = await checkKeys([KEY_A, KEY_B], { baseUrl: `http://127.0.0.1:${mock.address().port}` });
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.deepEqual(results[0].models, ['gemini-2.5-flash', 'gemini-2.5-pro']);
    assert.equal(results[1].ok, false);
    assert.equal(results[1].status, 403);
    assert.match(results[1].message, /refused the API key/);
    assert.equal(results[1].masked, 'AIza…BBBB');
  } finally {
    mock.close();
  }
});

/* ------------------------------------------------------------------ *
 * HTTP server
 * ------------------------------------------------------------------ */

/** Mock Gemini: generateContent (POST) + models list (GET). */
function startMockGemini({ failKeys = [] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/v1beta/models') {
        const key = url.searchParams.get('key') || req.headers['x-goog-api-key'];
        requests.push({ kind: 'models', key });
        res.setHeader('Content-Type', 'application/json');
        if (failKeys.includes(key)) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: { message: 'API key not valid' } }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }));
        return;
      }
      const key = req.headers['x-goog-api-key'];
      const body = JSON.parse(data);
      const prompt = body.contents[0].parts[0].text;
      const items = JSON.parse(prompt.split('TRANSLATE')[1].split('\n').slice(1).join('\n'));
      requests.push({ kind: 'generate', key, model: url.pathname.split('/models/')[1].split(':')[0] });
      res.setHeader('Content-Type', 'application/json');
      if (failKeys.includes(key)) {
        res.writeHead(429);
        res.end(JSON.stringify({ error: { message: 'Quota exceeded for this key' } }));
        return;
      }
      res.writeHead(200);
      res.end(
        JSON.stringify({
          candidates: [
            { finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(items.map((e) => ({ id: e.id, text: 'සිං ' + e.text }))) }] } },
          ],
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('server validates input and streams a full translation', async () => {
  const mock = await startMockGemini();
  process.env.GEMINI_BASE_URL = mock.baseUrl;

  const app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;

  try {
    let res = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [], model: 'gemini-2.5-flash', srt: SAMPLE }),
    });
    assert.equal(res.status, 400);

    res = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [KEY_A], model: 'gemini-2.5-flash', srt: SAMPLE }),
    });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'start');
    assert.equal(lines[0].keys, 1);
    const result = lines.find((l) => l.type === 'result');
    assert.ok(result, 'expected a result event');
    assert.equal(
      result.srt,
      '1\n00:00:01,000 --> 00:00:03,000\nසිං What are you doing?\n\n2\n00:00:03,500 --> 00:00:05,000\nසිං Line one\nline two\n\n3\n00:00:05,500 --> 00:00:06,000\n\n'
    );
    assert.deepEqual(result.used, [{ keyIndex: 0, model: 'gemini-2.5-flash', batches: 1 }]);

    res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Sinhala Anime Subtitle Translator/);
  } finally {
    app.close();
    mock.server.close();
    delete process.env.GEMINI_BASE_URL;
  }
});

test('server accepts a newline separated key string and streams failover events', async () => {
  const mock = await startMockGemini({ failKeys: [KEY_A] });
  process.env.GEMINI_BASE_URL = mock.baseUrl;

  const app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;

  try {
    const res = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: `${KEY_A}\n${KEY_B}`, model: 'gemini-2.5-flash', srt: THREE_LINES }),
    });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    const events = lines.filter((l) => l.type === 'failover');
    assert.equal(events.length, 1, 'one failover notice for the dead key');
    assert.equal(events[0].endpoint.keyIndex, 0);
    const result = lines.find((l) => l.type === 'result');
    assert.ok(result, 'translation completed on the backup key');
    assert.deepEqual(result.used, [{ keyIndex: 1, model: 'gemini-2.5-flash', batches: 1 }]);
    assert.deepEqual(
      mock.requests.filter((r) => r.kind === 'generate').map((r) => r.key),
      [KEY_A, KEY_B]
    );
  } finally {
    app.close();
    mock.server.close();
    delete process.env.GEMINI_BASE_URL;
  }
});

test('server rejects a malformed key before streaming', async () => {
  const app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try {
    const res = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: ['nope nope'], model: 'gemini-2.5-flash', srt: SAMPLE }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /doesn't look like an API key/);
  } finally {
    app.close();
  }
});

test('a long episode survives a key dying mid-run', async () => {
  const lines = [];
  for (let i = 1; i <= 100; i++) {
    lines.push(`${i}\n00:0${Math.floor(i / 60)}:${String(i % 60).padStart(2, '0')},000 --> 00:0${Math.floor(i / 60)}:${String((i % 60) + 1).padStart(2, '0')},000\nLine ${i}\n`);
  }
  const entries = parseSrt(lines.join('\n'));
  assert.equal(entries.length, 100);

  const { fetchImpl, calls } = fakeGemini(({ key, call }) =>
    key === KEY_A && call > 2 ? { status: 500, message: 'backend exploded' } : {}
  );
  const progress = [];
  const stats = {};
  const out = await translateEntries(entries, {
    keys: [KEY_A, KEY_B],
    model: 'gemini-2.5-flash',
    fallbackModels: ['gemini-2.5-pro'],
    fetchImpl,
    batchSize: 40,
    sleep: noSleep,
    stats,
    onProgress: (done, total, endpoint) => progress.push({ done, endpoint }),
  });

  assert.equal(out.length, 100);
  assert.equal(out[0], 'SI:Line 1');
  assert.equal(out[99], 'SI:Line 100');
  assert.deepEqual(stats.used.map((u) => u.keyIndex), [0, 1], 'started on key 1, finished on key 2');
  // 3 batches: two served by key 1 (keys rotate before models), the third by key 2.
  assert.deepEqual(calls.map((c) => `${c.key === KEY_A ? 'A' : 'B'}:${c.model}`), [
    'A:gemini-2.5-flash',
    'A:gemini-2.5-flash',
    'A:gemini-2.5-flash',
    'B:gemini-2.5-flash',
  ]);
  assert.match(progress.at(-1).endpoint.label, /Key 2/);
});

test('server checks keys over /api/keys/check', async () => {
  const mock = await startMockGemini({ failKeys: [KEY_B] });
  process.env.GEMINI_BASE_URL = mock.baseUrl;

  const app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;

  try {
    const res = await fetch(`${base}/api/keys/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [KEY_A, KEY_B] }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.results.map((r) => r.ok), [true, false]);
    assert.equal(data.results[1].status, 403);

    const bad = await fetch(`${base}/api/keys/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: [] }),
    });
    assert.equal(bad.status, 400);
  } finally {
    app.close();
    mock.server.close();
    delete process.env.GEMINI_BASE_URL;
  }
});
