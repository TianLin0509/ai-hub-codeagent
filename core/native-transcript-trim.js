'use strict';

// Tool output is almost all of what a native journal stores and almost none of
// what it shows. Cards render at most 2048 characters of a result (see
// core/acp-tool-preview.js) and fetch the rest on demand through
// `claude-native:tool-result`. One production journal measured 62.3 MB of
// tool_result inside 65 MB of frame bodies (2026-09-19) — kept only so that the
// on-demand read could still be served after a restart.
//
// The provider's own transcript already holds every one of those bytes and is
// never deleted by Hub, so the journal keeps a preview-sized head and the
// reader falls back to the provider transcript for the remainder. Live sessions
// are untouched: the in-memory frames still carry the full result, and trimming
// never mutates a caller's frame — an untrimmed frame is returned by identity so
// that the journal's delta comparison keeps its fast path.
const KEEP_CHARS = 4096;
const OMITTED_IMAGE = '[图片正文未进 Hub 记录，见原生记录]';

// The backstage panel renders these frames verbatim (core/claude-backstage.js),
// so a trimmed body has to say so where it is read. The notice sits past the
// preview budget, which keeps card previews byte-identical, and it travels with
// the value instead of relying on every future reader to check hubTrimmed.
const trimNotice = bytes => `\n\n［以上是 Hub 保留的开头 ${KEEP_CHARS} 字；全文共 ${bytes} 字，在该会话的原生记录中，展开工具详情即可读取］`;

function textLength(value) {
  if (typeof value === 'string') return value.length;
  if (value == null) return 0;
  try { return JSON.stringify(value).length; } catch { return 0; }
}

// The notice quotes this number to the user, so it counts the body a reader
// would have seen rather than the JSON envelope around it.
function contentLength(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return textLength(content);
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') total += block.text.length;
    else if (typeof block.source?.data === 'string') total += block.source.data.length;
    else total += textLength(block);
  }
  return total;
}

function trimBlockList(blocks, bytes) {
  let budget = KEEP_CHARS;
  let changed = false;
  let lastTextAt = -1;
  const trimmed = blocks.map((block, index) => {
    if (!block || typeof block !== 'object') return block;
    if (block.type === 'image' && block.source && typeof block.source.data === 'string') {
      changed = true;
      return { ...block, source: { ...block.source, data: '' }, hubOmitted: OMITTED_IMAGE };
    }
    if (typeof block.text !== 'string') return block;
    lastTextAt = index;
    if (block.text.length <= budget) { budget -= block.text.length; return block; }
    changed = true;
    const head = block.text.slice(0, Math.max(0, budget));
    budget = 0;
    return { ...block, text: head };
  });
  if (!changed) return blocks;
  // Blocks are trimmed, never dropped, so the notice rides on the last text
  // block rather than changing how many blocks a reader sees.
  if (lastTextAt >= 0) trimmed[lastTextAt] = { ...trimmed[lastTextAt], text: trimmed[lastTextAt].text + trimNotice(bytes) };
  return trimmed;
}

// Only the two shapes Claude actually emits are trimmed: a plain string, or a
// list of content blocks. Anything else is left alone rather than reshaped into
// something a reader would have to special-case.
function trimToolResultContent(content, bytes) {
  if (typeof content === 'string') {
    return content.length > KEEP_CHARS ? content.slice(0, KEEP_CHARS) + trimNotice(bytes) : content;
  }
  if (Array.isArray(content)) return trimBlockList(content, bytes);
  return content;
}

function trimBlock(block) {
  if (!block || block.type !== 'tool_result' || block.hubTrimmed) return block;
  const bytes = contentLength(block.content);
  if (bytes <= KEEP_CHARS) return block;
  const content = trimToolResultContent(block.content, bytes);
  if (content === block.content) return block;
  return { ...block, content, hubTrimmed: { bytes, kept: KEEP_CHARS } };
}

// Claude's wire frames repeat the tool output a second time at frame level.
// Measured on the same journal: `tool_use_result` alone was 36.11 MB and
// `wire_tool_inputs` 0.49 MB, and neither field is read anywhere in Hub — cards,
// search, activities and the on-demand tool reader all go through
// message.content. They are reduced to a marked head rather than dropped so a
// stored frame still says what used to be there.
const PASSTHROUGH_FIELDS = ['tool_use_result', 'wire_tool_inputs'];

function trimPassthrough(value) {
  const bytes = textLength(value);
  if (bytes <= KEEP_CHARS) return value;
  const head = typeof value === 'string' ? value.slice(0, KEEP_CHARS)
    : JSON.stringify(value).slice(0, KEEP_CHARS);
  return { hubTrimmed: { bytes, kept: KEEP_CHARS }, head };
}

function trimFrame(frame) {
  if (!frame || typeof frame !== 'object') return frame;
  let next = frame;
  const blocks = frame.message && frame.message.content;
  if (Array.isArray(blocks)) {
    let changed = false;
    const trimmedBlocks = blocks.map(block => {
      const trimmed = trimBlock(block);
      if (trimmed !== block) changed = true;
      return trimmed;
    });
    if (changed) next = { ...next, message: { ...frame.message, content: trimmedBlocks } };
  }
  for (const field of PASSTHROUGH_FIELDS) {
    const value = next[field];
    if (value == null || value.hubTrimmed) continue;
    const trimmed = trimPassthrough(value);
    if (trimmed !== value) next = { ...next, [field]: trimmed };
  }
  return next;
}

function trimFramesForJournal(frames) {
  if (!Array.isArray(frames)) return frames;
  let changed = false;
  const next = frames.map(frame => {
    const trimmed = trimFrame(frame);
    if (trimmed !== frame) changed = true;
    return trimmed;
  });
  return changed ? next : frames;
}

// The journal is handed whole records; only the transcript inside them is large.
function trimRecordForJournal(data) {
  if (!data || typeof data !== 'object') return data;
  let next = data;
  for (const field of ['transcriptMessages', 'transcriptAppend']) {
    const frames = next[field];
    if (!Array.isArray(frames)) continue;
    const trimmed = trimFramesForJournal(frames);
    if (trimmed !== frames) next = { ...next, [field]: trimmed };
  }
  return next;
}

module.exports = { KEEP_CHARS, OMITTED_IMAGE, trimFramesForJournal, trimRecordForJournal };
