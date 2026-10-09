'use strict';

// Card history only shows a bounded preview of each tool result: the card DOM
// holds at most 50,000 characters (renderer/turn-card-renderer.js) and the
// rest is read on demand through `resultRef`. A Claude transcript read from
// disk still carried every byte of every result to the window — screenshots as
// base64 included. Measured on the live Hub (2026-10-08): nine recent turns of
// one session were 12.7 MB, 12.0 MB of it image data the card never displays;
// a click serialised that twice (worker → main → window) and the parse cache
// (32 MB budget) evicted everything else to hold it.
//
// This keeps what a card can show and points at the transcript for the rest:
//   - image blocks keep their type and media type, the data is dropped;
//   - a result longer than COMPACT_OVER keeps the first DISPLAY_KEEP characters
//     (exactly what the card renders) plus a short tail, so the verification
//     summary that tests print last is still seen by turn-presentation.
// The provider transcript is never modified; `resultRef` reads it back whole.
const DISPLAY_KEEP = 50000;
const TAIL_KEEP = 4000;
const COMPACT_OVER = 60000;
const REF_SOURCE = 'claude-transcript-file';

const omittedImage = chars => `［图片约 ${Math.max(1, Math.round(chars * 3 / 4 / 1024))} KB，卡片不加载原图数据；点「查看全文」读取原始输出］`;
const omittedMiddle = chars => `\n\n［中间省略 ${chars} 字；点「查看全文」读取完整输出］\n\n`;

function stripImages(blocks) {
  let changed = false;
  const next = blocks.map(block => {
    if (!block || block.type !== 'image' || typeof block.source?.data !== 'string' || !block.source.data) return block;
    changed = true;
    return { ...block, source: { ...block.source, data: '' }, hubOmitted: omittedImage(block.source.data.length) };
  });
  return changed ? next : blocks;
}

function headAndTail(text) {
  if (text.length <= COMPACT_OVER) return text;
  return text.slice(0, DISPLAY_KEEP) + omittedMiddle(text.length - DISPLAY_KEEP - TAIL_KEEP) + text.slice(-TAIL_KEEP);
}

// Returns the compacted value, or the same value when nothing needs to change.
function compactToolOutput(value) {
  if (typeof value === 'string') return headAndTail(value);
  if (!value || typeof value !== 'object') return value;
  const stripped = Array.isArray(value) ? stripImages(value) : value;
  // Only measure when it could matter: a stripped list of short blocks is the
  // common case and stays an array, exactly as before.
  let json;
  try { json = JSON.stringify(stripped, null, 2); } catch { return stripped; }
  if (json.length <= COMPACT_OVER) return stripped;
  // The card renders a non-string result as this same pretty JSON, so the
  // head it shows is unchanged; only the part past the preview is deferred.
  return headAndTail(json);
}

function compactTurnsToolOutputs(turns, { transcriptPath } = {}) {
  if (!Array.isArray(turns) || !transcriptPath) return turns;
  let changedAny = false;
  const next = turns.map(turn => {
    if (!turn || !Array.isArray(turn.toolCalls) || !turn.toolCalls.length) return turn;
    let changed = false;
    const toolCalls = turn.toolCalls.map(tool => {
      if (!tool || tool.resultRef || tool.output == null || !tool.id) return tool;
      const output = compactToolOutput(tool.output);
      if (output === tool.output) return tool;
      changed = true;
      return { ...tool, output, resultTruncated: true,
        resultRef: { source: REF_SOURCE, transcriptPath, itemId: tool.id } };
    });
    if (!changed) return turn;
    changedAny = true;
    return { ...turn, toolCalls };
  });
  return changedAny ? next : turns;
}

module.exports = { COMPACT_OVER, DISPLAY_KEEP, REF_SOURCE, TAIL_KEEP, compactToolOutput, compactTurnsToolOutputs };
