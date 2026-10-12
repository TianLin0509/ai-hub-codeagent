'use strict';

const fs = require('node:fs');
const { parentPort, threadId, workerData } = require('node:worker_threads');
const { parseClaudeTranscriptToTurns } = require('./claude-transcript-parser.js');
const { parseClaudeTranscriptToNativeTurns } = require('./claude-disk-transcript.js');
const { parseCodexRolloutToTurns } = require('./codex-transcript-parser.js');
const { parseKimiWireToTurns } = require('./kimi-transcript-parser.js');

const {TranscriptResultCache}=require('./transcript-result-cache');
const { compactTurnsToolOutputs } = require('./transcript-tool-compact.js');
const cache = new TranscriptResultCache(workerData?.cacheOptions);

function parserForKind(kind) {
  if (kind === 'claude') return parseClaudeTranscriptToTurns;
  if (kind === 'claude-native') return parseClaudeTranscriptToNativeTurns;
  if (kind === 'codex') return parseCodexRolloutToTurns;
  if (kind === 'kimi') return parseKimiWireToTurns;
  if (kind === 'gemini') return require('./gemini-transcript-parser').parseGeminiTranscriptToTurns;
  throw new Error(`Unsupported transcript parser kind: ${kind}`);
}

// The agy parser also reads transcript_full.jsonl and the Hub completion receipt
// written at Stop. Without them in the key, a cached turn stays "in progress".
function antigravitySiblingSignature(kind, transcriptPath) {
  if (kind !== 'gemini') return '';
  const match = /[\\/]antigravity-cli[\\/]brain[\\/]([^\\/]+)[\\/]/i.exec(transcriptPath);
  if (!match) return '';
  const agy = require('./antigravity-config.js');
  const sig = file => { try { const st = fs.statSync(file); return `${st.size}:${st.mtimeMs}`; } catch { return 'missing'; } };
  return '|' + sig(require('node:path').join(require('node:path').dirname(transcriptPath), 'transcript_full.jsonl'))
    + '|' + (agy.UUID.test(match[1]) ? sig(agy.receiptsFile(match[1])) : 'none');
}

function parseTask(message) {
  const { id, kind, transcriptPath, opts = {} } = message || {};
  if (!id || !transcriptPath) throw new Error('Invalid transcript worker request');
  const stat = fs.statSync(transcriptPath);
  const signature = `${stat.size}:${stat.mtimeMs}` + antigravitySiblingSignature(kind, transcriptPath);
  const key = `${kind}\0${transcriptPath}`;
  const cached = cache.get(key,signature,opts);
  if (cached) {
    return {
      id,
      turns: cached,
      meta: { cacheHit: true, fileSize: stat.size, parseMs: 0, workerThreadId: threadId },
    };
  }

  const startedAt = Date.now();
  const turns = parserForKind(kind)(transcriptPath, opts);
  // Compacted here, before caching and before postMessage, so neither the
  // cache budget nor the main thread ever holds the full tool output.
  const normalizedTurns = Array.isArray(turns)
    ? (opts.compactToolOutputs ? compactTurnsToolOutputs(turns, { transcriptPath }) : turns)
    : [];
  cache.set(key,kind,signature,opts,normalizedTurns);
  return {
    id,
    turns: normalizedTurns,
    meta: {
      cacheHit: false,
      fileSize: stat.size,
      parseMs: Date.now() - startedAt,
      workerThreadId: threadId,
    },
  };
}

parentPort.on('message', (message) => {
  try {
    parentPort.postMessage(parseTask(message));
  } catch (error) {
    parentPort.postMessage({
      id: message && message.id,
      error: error && error.message ? error.message : String(error),
    });
  }
});
