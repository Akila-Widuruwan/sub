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

/** Fake Gemini fetch: echoes ids back with "SI:" prefix, records requests. */
function fakeGemini({ skipFirstCallIds = [], failWith = null } = {}) {
  const calls = [];
  let skipped = false;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const prompt = body.contents[0].parts[0].text;
    calls.push({ url, headers: init.headers, body, prompt });
    if (failWith && calls.length === 1) {
      return new Response(JSON.stringify({ error: { message: failWith.message } }), { status: failWith.status });
    }
    const toTranslate = JSON.parse(prompt.split('TRANSLATE')[1].split('\n').slice(1).join('\n'));
    const out = toTranslate
      .filter((e) => !(skipFirstCallIds.length && !skipped && e.id === skipFirstCallIds[0]))
      .map((e) => ({ id: e.id, text: 'SI:' + e.text }));
    if (skipFirstCallIds.length && !skipped) skipped = true;
    const payload = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(out) }] } }] };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  return { fetchImpl, calls };
}

test('translateEntries batches, keeps order and sends the key in a header', async () => {
  const entries = parseSrt(SAMPLE);
  const { fetchImpl, calls } = fakeGemini();
  const out = await translateEntries(entries, {
    apiKey: 'KEY123',
    model: 'gemini-2.5-flash',
    fetchImpl,
    batchSize: 2,
    baseUrl: 'https://example.test',
  });
  assert.deepEqual(out, ['SI:What are you doing?', 'SI:Line one\nline two', '']);
  // Entry 3 is empty, so only 2 batches of non-empty text are sent: [0,1] then none for [2].
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
  assert.equal(calls[0].headers['x-goog-api-key'], 'KEY123');
  assert.match(calls[0].prompt, /TRANSLATE/);
  assert.doesNotMatch(calls[0].prompt, /CONTEXT/);
});

test('second batch includes previous translations as context', async () => {
  const entries = parseSrt(SAMPLE.replace('3\n00:00:05,500 --> 00:00:06,000\n', '3\n00:00:05,500 --> 00:00:06,000\nThird\n'));
  const { fetchImpl, calls } = fakeGemini();
  const out = await translateEntries(entries, { apiKey: 'k', model: 'gemini-2.5-flash', fetchImpl, batchSize: 2, sleep: async () => {} });
  assert.equal(out[2], 'SI:Third');
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /CONTEXT/);
  assert.match(calls[1].prompt, /SI:What are you doing\?/);
});

test('a skipped subtitle triggers a retry and then succeeds', async () => {
  const entries = parseSrt(SAMPLE);
  const { fetchImpl, calls } = fakeGemini({ skipFirstCallIds: [1] });
  const out = await translateEntries(entries, { apiKey: 'k', model: 'gemini-2.5-flash', fetchImpl, sleep: async () => {} });
  assert.equal(out[1], 'SI:Line one\nline two');
  assert.equal(calls.length, 2);
});

test('an API key error is reported without retrying', async () => {
  const entries = parseSrt(SAMPLE);
  const { fetchImpl, calls } = fakeGemini({ failWith: { status: 403, message: 'API key not valid' } });
  await assert.rejects(
    translateEntries(entries, { apiKey: 'bad', model: 'gemini-2.5-flash', fetchImpl, sleep: async () => {} }),
    (err) => err instanceof GeminiError && /refused the API key/.test(err.message)
  );
  assert.equal(calls.length, 1);
});

test('server validates input and streams a full translation', async () => {
  // Mock Gemini server
  const mock = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      assert.equal(req.headers['x-goog-api-key'], 'TEST_KEY');
      const body = JSON.parse(data);
      const prompt = body.contents[0].parts[0].text;
      const items = JSON.parse(prompt.split('TRANSLATE')[1].split('\n').slice(1).join('\n'));
      const out = items.map((e) => ({ id: e.id, text: 'සිං ' + e.text }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(out) }] } }] }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${mock.address().port}`;

  const app = createServer();
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;

  try {
    let res = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: '', model: 'gemini-2.5-flash', srt: SAMPLE }),
    });
    assert.equal(res.status, 400);

    res = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'TEST_KEY', model: 'gemini-2.5-flash', srt: SAMPLE }),
    });
    assert.equal(res.status, 200);
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines[0].type, 'start');
    const result = lines.find((l) => l.type === 'result');
    assert.ok(result, 'expected a result event');
    assert.equal(
      result.srt,
      '1\n00:00:01,000 --> 00:00:03,000\nසිං What are you doing?\n\n2\n00:00:03,500 --> 00:00:05,000\nසිං Line one\nline two\n\n3\n00:00:05,500 --> 00:00:06,000\n\n'
    );

    res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Sinhala Anime Subtitle Translator/);
  } finally {
    app.close();
    mock.close();
    delete process.env.GEMINI_BASE_URL;
  }
});
