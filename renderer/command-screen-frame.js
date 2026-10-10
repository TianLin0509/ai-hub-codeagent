'use strict';
// A never-opened member terminal can retain the previous inline picker above
// the current one. The real Codex 0.153.4 frame contained both highlighted rows:
// model 1 and reasoning 3. Only the latest panel may supply a cursor.
function groupInputTuningFrame(screen) {
  // Ultra uses » for the same native input. Normalize only its leading glyph
  // for the shared picker; retain draft text so its non-empty input guard holds.
  const lines = String(screen || '').split('\n')
    .map(line => line.replace(/^(\s*)»(?=\s|$)/, '$1›'));
  let panel = -1, prompt = -1, changed = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^(?:Select Model and Effort|Select Reasoning Level\b|Advanced Reasoning\b)/i.test(line)) panel = i;
    if (/^›(?:\s*$|\s+(?!\d+\.).*)/.test(line)) prompt = i;
    if (/^[•·]?\s*Model changed to\b/i.test(line)) changed = i;
  }
  if (panel < 0) return lines.join('\n');
  // An input prompt below a panel means the panel has closed. Retain the real
  // confirmation when present, but never offer the old menu to the next switch.
  const start = prompt > panel ? (changed > panel ? changed : prompt) : panel;
  return lines.slice(start).join('\n');
}

module.exports = { groupInputTuningFrame };
