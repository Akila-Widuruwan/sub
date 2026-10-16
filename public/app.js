(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const KEYS_STORAGE = 'gemini_api_keys';
  const OLD_KEY_STORAGE = 'gemini_api_key';

  const apiKeysInput = $('api-keys');
  const rememberKey = $('remember-key');
  const toggleKeyBtn = $('toggle-key');
  const checkKeysBtn = $('check-keys-btn');
  const keyInfo = $('key-info');
  const keyStatusList = $('key-status-list');
  const modelSelect = $('model');
  const fallbackWrap = $('fallback-models');
  const srtFile = $('srt-file');
  const srtInput = $('srt-input');
  const srtInfo = $('srt-info');
  const translateBtn = $('translate-btn');
  const cancelBtn = $('cancel-btn');
  const progressWrap = $('progress-wrap');
  const progressBar = $('progress-bar');
  const progressText = $('progress-text');
  const failoverLog = $('failover-log');
  const patientMode = $('patient-mode');
  const statusEl = $('status');
  const errorReport = $('error-report');
  const outputSection = $('output-section');
  const srtOutput = $('srt-output');
  const downloadBtn = $('download-btn');
  const copyBtn = $('copy-btn');
  const customModelWrap = $('custom-model-wrap');
  const customModelInput = $('custom-model');
  const previewSection = $('preview-section');
  const previewList = $('preview-list');
  const previewInfo = $('preview-info');
  const previewAll = $('preview-all');
  const CUSTOM = '__custom__';
  const PREVIEW_LIMIT = 40;
  let lastSourceSrt = '';

  let abortController = null;
  let resultSrt = '';
  let sourceName = 'episode';

  // ---- API keys (optional remember) ----
  function getKeys() {
    return apiKeysInput.value
      .split('\n')
      .map((k) => k.trim())
      .filter(Boolean);
  }

  function setKeys(list) {
    apiKeysInput.value = list.join('\n');
    updateKeyInfo();
  }

  function updateKeyInfo() {
    const n = getKeys().length;
    keyInfo.textContent = n === 0
      ? ''
      : n === 1
        ? '1 key — no backup if it fails'
        : `${n} keys — automatic failover enabled`;
  }

  function loadStoredKeys() {
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem(KEYS_STORAGE) || 'null');
    } catch (_) {
      stored = null;
    }
    if (!Array.isArray(stored) || !stored.length) {
      const legacy = localStorage.getItem(OLD_KEY_STORAGE); // migrate the old single key
      stored = legacy ? [legacy] : [];
    }
    if (stored.length) {
      setKeys(stored);
      rememberKey.checked = true;
    }
  }

  rememberKey.addEventListener('change', () => {
    if (rememberKey.checked && getKeys().length) {
      localStorage.setItem(KEYS_STORAGE, JSON.stringify(getKeys()));
    } else if (!rememberKey.checked) {
      localStorage.removeItem(KEYS_STORAGE);
      localStorage.removeItem(OLD_KEY_STORAGE);
    }
  });
  apiKeysInput.addEventListener('input', () => {
    updateKeyInfo();
    if (rememberKey.checked) localStorage.setItem(KEYS_STORAGE, JSON.stringify(getKeys()));
  });
  toggleKeyBtn.addEventListener('click', () => {
    const show = apiKeysInput.classList.contains('masked');
    apiKeysInput.classList.toggle('masked', !show);
    toggleKeyBtn.textContent = show ? 'Hide' : 'Show';
  });

  // ---- Key health check ----
  function renderKeyStatus(results) {
    keyStatusList.innerHTML = '';
    keyStatusList.hidden = !results.length;
    for (const r of results) {
      const row = document.createElement('div');
      row.className = 'key-row ' + (r.ok ? 'ok' : 'bad');

      const name = document.createElement('span');
      name.className = 'key-name';
      name.textContent = `${r.label} · ${r.masked}`;

      const state = document.createElement('span');
      state.className = 'key-state';
      state.textContent = r.ok ? '✓ working' : `✗ ${r.status ? 'error ' + r.status : 'unreachable'}`;

      const detail = document.createElement('span');
      detail.className = 'key-detail';
      detail.textContent = r.ok
        ? r.models.length
          ? `${r.models.length} models available (e.g. ${r.models.slice(0, 3).join(', ')})`
          : 'Key accepted.'
        : r.message;

      row.append(name, state, detail);
      keyStatusList.appendChild(row);
    }
  }

  async function checkKeys() {
    const keys = getKeys();
    if (!keys.length) return setStatus('Add at least one API key first.', 'error');
    checkKeysBtn.disabled = true;
    setStatus('Checking keys…', '');
    try {
      const res = await fetch('/api/keys/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
      renderKeyStatus(data.results);
      const ok = data.results.filter((r) => r.ok).length;
      setStatus(
        `${ok} of ${data.results.length} key${data.results.length === 1 ? '' : 's'} working.` +
          (ok && ok < data.results.length ? ' The working ones will be used first.' : ''),
        ok ? 'ok' : 'error'
      );
    } catch (err) {
      setStatus(err.message || 'Could not check the keys.', 'error');
    } finally {
      checkKeysBtn.disabled = false;
    }
  }

  checkKeysBtn.addEventListener('click', checkKeys);

  // ---- Models ----
  async function loadModels() {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      modelSelect.innerHTML = '';
      fallbackWrap.innerHTML = '';
      for (const m of data.models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);

        const label = document.createElement('label');
        label.className = 'check';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'fallback-box';
        box.value = m.id;
        label.appendChild(box);
        label.appendChild(document.createTextNode(' ' + m.label));
        fallbackWrap.appendChild(label);
      }
    } catch (_) {
      modelSelect.innerHTML = '<option value="gemini-2.5-flash">Gemini 2.5 Flash</option>';
      fallbackWrap.innerHTML = '';
    }
    const other = document.createElement('option');
    other.value = CUSTOM;
    other.textContent = 'Other (enter model ID)…';
    modelSelect.appendChild(other);
    modelSelect.addEventListener('change', updateCustomVisibility);
    updateCustomVisibility();
  }

  function updateCustomVisibility() {
    customModelWrap.hidden = modelSelect.value !== CUSTOM;
  }

  function selectedModel() {
    if (modelSelect.value === CUSTOM) return customModelInput.value.trim();
    return modelSelect.value;
  }

  function selectedFallbacks() {
    const model = selectedModel();
    return [...fallbackWrap.querySelectorAll('.fallback-box')]
      .filter((b) => b.checked)
      .map((b) => b.value)
      .filter((m) => m !== model);
  }

  // ---- SRT input ----
  function countEntries(text) {
    const m = text.replace(/\r/g, '').match(/-->/g);
    return m ? m.length : 0;
  }

  function updateSrtInfo() {
    const n = countEntries(srtInput.value);
    srtInfo.textContent = n ? `${n} subtitle entries detected` : '';
  }

  srtFile.addEventListener('change', async () => {
    const file = srtFile.files[0];
    if (!file) return;
    sourceName = file.name.replace(/\.srt$/i, '') || 'episode';
    srtInput.value = await file.text();
    updateSrtInfo();
    setStatus(`Loaded ${file.name}`, 'ok');
  });
  srtInput.addEventListener('input', updateSrtInfo);

  // ---- Helpers ----
  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setBusy(busy) {
    translateBtn.disabled = busy;
    cancelBtn.disabled = !busy;
    checkKeysBtn.disabled = busy;
    progressWrap.hidden = !busy;
    if (busy) {
      progressBar.style.width = '0%';
      progressText.textContent = 'Starting…';
      failoverLog.innerHTML = '';
      failoverLog.hidden = true;
      errorReport.innerHTML = '';
      errorReport.hidden = true;
    }
  }

  function showResult(srt) {
    resultSrt = srt;
    srtOutput.value = srt;
    outputSection.hidden = false;
    renderPreview();
    outputSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function endpointLabel(endpoint) {
    if (!endpoint) return '';
    const key = endpoint.keyIndex === null || endpoint.keyIndex === undefined
      ? ''
      : `Key ${endpoint.keyIndex + 1}`;
    return [key, endpoint.model].filter(Boolean).join(' · ');
  }

  function logFailover(evt) {
    failoverLog.hidden = false;
    const row = document.createElement('div');
    row.className = 'failover-row';
    const where = document.createElement('span');
    where.className = 'failover-where';
    where.textContent = `${endpointLabel(evt.endpoint)} failed`;
    const why = document.createElement('span');
    why.className = 'failover-why';
    const wait = evt.retryDelayMs ? ` (Gemini says retry in ${formatWait(evt.retryDelayMs)})` : '';
    why.textContent = evt.remaining > 0
      ? `${evt.reason}${wait} — switching, ${evt.remaining} option${evt.remaining === 1 ? '' : 's'} left.`
      : `${evt.reason}${wait} — no options left, retrying.`;
    row.append(where, why);
    failoverLog.appendChild(row);
    while (failoverLog.childElementCount > 6) failoverLog.removeChild(failoverLog.firstChild);
    failoverLog.scrollTop = failoverLog.scrollHeight;
  }

  function formatWait(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ${sec % 60}s`;
    const h = Math.floor(min / 60);
    return `${h}h ${min % 60}m`;
  }

  function renderErrorReport(evt) {
    const failures = Array.isArray(evt.failures) ? evt.failures : [];
    errorReport.innerHTML = '';
    errorReport.hidden = !failures.length;
    if (!failures.length) return;

    const title = document.createElement('p');
    title.className = 'error-report-title';
    title.textContent = `What each option said (${failures.length}):`;
    errorReport.appendChild(title);

    for (const f of failures) {
      const row = document.createElement('div');
      row.className = 'error-row';
      const who = document.createElement('span');
      who.className = 'error-who';
      who.textContent = f.label || 'option';
      const what = document.createElement('span');
      what.className = 'error-what';
      what.textContent = f.message + (f.retryDelayMs ? ` (retry in ${formatWait(f.retryDelayMs)})` : '');
      row.append(who, what);
      errorReport.appendChild(row);
    }

    if (evt.hint) {
      const hint = document.createElement('p');
      hint.className = 'error-hint';
      hint.textContent = evt.hint;
      errorReport.appendChild(hint);
    }
  }

  // ---- Preview (client-side SRT parse, original vs translated) ----
  function parseSrtClient(text) {
    const blocks = text.replace(/\r/g, '').replace(/^\uFEFF/, '').trim().split(/\n\s*\n/);
    const out = [];
    for (const block of blocks) {
      const lines = block.split('\n');
      const t = lines.findIndex((l) => l.includes('-->'));
      if (t < 0) continue;
      out.push({ timing: lines[t].trim(), text: lines.slice(t + 1).join('\n') });
    }
    return out;
  }

  function renderPreview() {
    const src = parseSrtClient(lastSourceSrt);
    const dst = parseSrtClient(resultSrt);
    if (!dst.length) {
      previewSection.hidden = true;
      return;
    }
    previewSection.hidden = false;
    previewInfo.textContent = `${dst.length} subtitles`;
    previewList.innerHTML = '';

    const limit = previewAll.checked ? dst.length : Math.min(dst.length, PREVIEW_LIMIT);
    for (let i = 0; i < limit; i++) {
      const row = document.createElement('div');
      row.className = 'preview-row';

      const meta = document.createElement('div');
      meta.className = 'preview-meta';
      meta.textContent = `${i + 1} · ${dst[i].timing}`;

      const orig = document.createElement('div');
      orig.className = 'preview-orig';
      orig.textContent = src[i] ? src[i].text : '';

      const si = document.createElement('div');
      si.className = 'preview-si';
      si.textContent = dst[i].text;

      row.append(meta, orig, si);
      previewList.appendChild(row);
    }
    if (limit < dst.length) {
      const more = document.createElement('p');
      more.className = 'hint';
      more.textContent = `Showing first ${limit}. Tick "Show all" to see the rest.`;
      previewList.appendChild(more);
    }
  }

  previewAll.addEventListener('change', renderPreview);

  // ---- Translate (streams NDJSON progress from the server) ----
  async function translate() {
    const keys = getKeys();
    const srt = srtInput.value;

    if (!keys.length) return setStatus('Please enter at least one Gemini API key.', 'error');
    if (!srt.trim()) return setStatus('Please upload or paste an SRT file.', 'error');
    if (countEntries(srt) === 0) return setStatus('This does not look like an SRT file (no "-->" timing lines found).', 'error');
    const model = selectedModel();
    if (!model) return setStatus('Please enter the custom model ID.', 'error');

    if (rememberKey.checked) localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys));

    lastSourceSrt = srt;
    setBusy(true);
    setStatus('Translating… keep this tab open.', '');
    abortController = new AbortController();

    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys, model, fallbackModels: selectedFallbacks(), patient: patientMode.checked, srt }),
        signal: abortController.signal,
      });

      if (!res.ok) {
        let msg = `Request failed (${res.status}).`;
        try { msg = (await res.json()).error || msg; } catch (_) { /* not JSON */ }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      const handle = (line) => {
        if (!line.trim()) return;
        const evt = JSON.parse(line);
        if (evt.type === 'start') {
          progressText.textContent = `0 / ${evt.total} subtitles`;
        } else if (evt.type === 'progress') {
          const pct = Math.round((evt.done / evt.total) * 100);
          const who = endpointLabel(evt.endpoint);
          progressBar.style.width = pct + '%';
          progressText.textContent = `${evt.done} / ${evt.total} subtitles (${pct}%)` + (who ? ` · ${who}` : '');
        } else if (evt.type === 'failover') {
          logFailover(evt);
        } else if (evt.type === 'waiting') {
          progressText.textContent = `Waiting ${Math.round(evt.ms / 1000)}s — ${evt.reason}. Still holding your place…`;
        } else if (evt.type === 'result') {
          finished = true;
          errorReport.hidden = true;
          showResult(evt.srt);
          const used = Array.isArray(evt.used) ? evt.used : [];
          const models = [...new Set(used.map((u) => u.model).filter(Boolean))];
          const keyCount = new Set(used.map((u) => u.keyIndex)).size;
          let extra = '';
          if (used.length) {
            extra = ` via ${models.join(', ')}`;
            if (keyCount > 1) extra += ` (${keyCount} keys used)`;
          }
          setStatus(`Done — ${evt.count} subtitles translated${extra}.`, 'ok');
        } else if (evt.type === 'error') {
          finished = true;
          setStatus(evt.message, 'error');
          renderErrorReport(evt);
        }
      };

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          handle(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 1);
        }
      }
      handle(buffer);
      if (!finished) setStatus('The connection ended before translation finished.', 'error');
    } catch (err) {
      if (err.name === 'AbortError') setStatus('Translation cancelled.', 'error');
      else setStatus(err.message || 'Translation failed.', 'error');
    } finally {
      abortController = null;
      setBusy(false);
    }
  }

  translateBtn.addEventListener('click', translate);
  cancelBtn.addEventListener('click', () => abortController && abortController.abort());

  downloadBtn.addEventListener('click', () => {
    if (!resultSrt) return;
    const blob = new Blob([resultSrt], { type: 'application/x-subrip;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sourceName}.si.srt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  copyBtn.addEventListener('click', async () => {
    if (!resultSrt) return;
    try {
      await navigator.clipboard.writeText(resultSrt);
      setStatus('Copied to clipboard.', 'ok');
    } catch (_) {
      srtOutput.select();
      setStatus('Press Ctrl+C to copy the selected text.', '');
    }
  });

  loadStoredKeys();
  loadModels();
})();
