'use strict';

// Parse and build SRT text. Timestamps and numbers are kept exactly as they
// appear in the input; only the dialogue text is ever replaced.

function normalizeNewlines(text) {
  return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/**
 * Parse SRT text into an array of { index, timing, text }.
 * `index` is the original subtitle number string (kept verbatim).
 * Throws if the file does not look like SRT.
 */
function parseSrt(input) {
  const src = normalizeNewlines(input).trim();
  if (!src) throw new Error('SRT file is empty.');

  const blocks = src.split(/\n\s*\n/);
  const entries = [];
  const timingRe = /^(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}).*$/;

  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i, arr) => !(i === 0 && l.trim() === ''));
    if (lines.length === 0) continue;

    let i = 0;
    // Index line is optional in some files; tolerate it either way.
    let index = null;
    if (!timingRe.test(lines[0].trim()) && /^\s*\d+\s*$/.test(lines[0])) {
      index = lines[0].trim();
      i = 1;
    }
    const timingLine = (lines[i] || '').trim();
    const m = timingRe.exec(timingLine);
    if (!m) {
      throw new Error(`Invalid SRT block near: "${block.slice(0, 60).replace(/\n/g, ' | ')}"`);
    }
    const text = lines.slice(i + 1).join('\n');
    entries.push({
      index: index ?? String(entries.length + 1),
      timing: `${m[1]} --> ${m[2]}`,
      text,
    });
  }

  if (entries.length === 0) throw new Error('No subtitle entries found in SRT file.');
  return entries;
}

/** Build SRT text from entries [{ index, timing, text }]. */
function buildSrt(entries) {
  return (
    entries
      .map((e) => `${e.index}\n${e.timing}\n${e.text}`)
      .join('\n\n') + '\n'
  );
}

module.exports = { parseSrt, buildSrt };
