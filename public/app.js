(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const KEY_STORAGE = 'gemini_api_key';

  const apiKeyInput = $('api-key');
  const rememberKey = $('remember-key');
  const toggleKeyBtn = $('toggle-key');
  const modelSelect = $('model');
  const srtFile = $('srt-file');
  const srtInput = $('srt-input');
  const srtInfo = $('srt-info');
  const translateBtn = $('translate-btn');
  const cancelBtn = $('cancel-btn');
  const progressWrap = $('progress-wrap');
  const progressBar = $('progress-bar');
  const progressText = $('progress-text');
  const statusEl = $('status');
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

  // ---- API key (optional remember) ----
  const savedKey = localStorage.getItem(KEY_STORAGE);
  if (savedKey) {
    apiKeyInput.value = savedKey;
    rememberKey.checked = true;
  }
  rememberKey.addEventListener('change', () => {
    if (rememberKey.checked && apiKeyInput.value.trim()) {
      localStorage.setItem(KEY_STORAGE, apiKeyInput.value.trim());
    } else if (!rememberKey.checked) {
      localStorage.removeItem(KEY_STORAGE);
    }
  });
  apiKeyInput.addEventListener('input', () => {
    if (rememberKey.checked) localStorage.setItem(KEY_STORAGE, apiKeyInput.value.trim());
  });
  toggleKeyBtn.addEventListener('click', () => {
    const show = apiKeyInput.type === 'password';
    apiKeyInput.type = show ? 'text' : 'password';
    toggleKeyBtn.textContent = show ? 'Hide' : 'Show';
  });

  // ---- Models ----
  async function loadModels() {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      modelSelect.innerHTML = '';
      for (const m of data.models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.label;
        modelSelect.appendChild(opt);
      }
    } catch (_) {
      modelSelect.innerHTML = '<option value="gemini-2.5-flash">Gemini 2.5 Flash</option>';
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
    progressWrap.hidden = !busy;
    if (busy) {
      progressBar.style.width = '0%';
      progressText.textContent = 'Starting…';
    }
  }

  function showResult(srt) {
    resultSrt = srt;
    srtOutput.value = srt;
    outputSection.hidden = false;
    renderPreview();
    outputSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    const apiKey = apiKeyInput.value.trim();
    const srt = srtInput.value;

    if (!apiKey) return setStatus('Please enter your Gemini API key.', 'error');
    if (!srt.trim()) return setStatus('Please upload or paste an SRT file.', 'error');
    if (countEntries(srt) === 0) return setStatus('This does not look like an SRT file (no "-->" timing lines found).', 'error');
    const model = selectedModel();
    if (!model) return setStatus('Please enter the custom model ID.', 'error');

    if (rememberKey.checked) localStorage.setItem(KEY_STORAGE, apiKey);

    lastSourceSrt = srt;
    setBusy(true);
    setStatus('Translating… keep this tab open.', '');
    abortController = new AbortController();

    try {
      const res = await fetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, model, srt }),
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
          progressBar.style.width = pct + '%';
          progressText.textContent = `${evt.done} / ${evt.total} subtitles (${pct}%)`;
        } else if (evt.type === 'result') {
          finished = true;
          showResult(evt.srt);
          setStatus(`Done — ${evt.count} subtitles translated.`, 'ok');
        } else if (evt.type === 'error') {
          finished = true;
          setStatus(evt.message, 'error');
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

  loadModels();
})();
