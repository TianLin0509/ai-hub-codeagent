/**
 * read-last-assistant.js
 *
 * Read the most recent `assistant` turn from a Claude Code transcript JSONL.
 * Symmetric to main.js's readLastUserMessage — uses the same tail-only
 * reverse-read approach (64KB chunks) to avoid loading 10MB+ session files
 * into memory on every call. Reuses S1's parseAssistantContent so we don't
 * reimplement the content-block flatten logic.
 *
 * Returns null on any failure (file missing, parse error, no assistant entry)
 * — caller should treat absence as non-fatal.
 *
 * Coexists with `core/transcript-tap.js:readLastAssistantMessageFromClaudeTranscript`
 * which returns only `string` text (used by 4 internal hooks for the
 * turn-complete event payload). This module returns the structured object
 * needed by spec 2's card view rendering. Dedup planned for spec 4+ (wrap
 * the legacy string function around this one and call `.text`).
 */

const fs = require('node:fs');
const { parseAssistantContent } = require('./claude-transcript-parser');

/**
 * @param {string} transcriptPath
 * @returns {Promise<{
 *   text: string,
 *   thinking: string|null,
 *   toolCalls: Array,
 *   model?: string,
 *   stopReason?: string,
 *   usage?: object,
 *   ts: number|null,
 *   id?: string
 * } | null>}
 */
async function readLastAssistantMessage(transcriptPath) {
  const CHUNK = 65536;
  let fh;
  try {
    fh = await fs.promises.open(transcriptPath, 'r');
    const { size } = await fh.stat();
    let pos = size;
    let tail = '';
    while (pos > 0) {
      const readLen = Math.min(CHUNK, pos);
      pos -= readLen;
      const buf = Buffer.alloc(readLen);
      await fh.read(buf, 0, readLen, pos);
      tail = buf.toString('utf-8') + tail;
      const lines = tail.split('\n');
      // First fragment may be an incomplete line — keep it for the next pass
      // by prepending it back to `tail`, except when we've reached file start.
      const firstFragment = pos === 0 ? null : lines.shift();
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || entry.type !== 'assistant') continue;
        const msg = entry.message;
        if (!msg || typeof msg !== 'object') continue;
        const parsed = parseAssistantContent(msg.content);
        const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
        return {
          text: parsed.text,
          thinking: parsed.thinking,
          toolCalls: parsed.toolCalls,
          model: typeof msg.model === 'string' ? msg.model : undefined,
          stopReason: typeof msg.stop_reason === 'string' ? msg.stop_reason : undefined,
          usage: (msg.usage && typeof msg.usage === 'object') ? msg.usage : undefined,
          ts: Number.isFinite(ts) ? ts : null,
          id: entry.uuid,
        };
      }
      tail = firstFragment == null ? '' : firstFragment;
    }
  } catch {
    // swallowed — non-fatal
  } finally {
    if (fh) { try { await fh.close(); } catch {} }
  }
  return null;
}

module.exports = { readLastAssistantMessage };
