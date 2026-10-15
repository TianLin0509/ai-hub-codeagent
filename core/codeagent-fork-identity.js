'use strict';

// A fork may announce the source identity before the CLI creates its child.
// Keep source lineage separate from the child writer identity; never recover by mtime.
const fs = require('node:fs');
const path = require('node:path');
const { sameWorkDir, transcriptBucketMatches } = require('./hook-cwd-match');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAIL_BYTES = 4 * 1024 * 1024;
const uuid = value => typeof value === 'string' && UUID.test(value.trim()) ? value.trim().toLowerCase() : null;
const fileIdentity = file => typeof file === 'string' && /\.jsonl$/i.test(file) ? uuid(path.basename(file).replace(/\.jsonl$/i, '')) : null;

function forkSourceIdentity(meta, { getSession, loadSessionFile } = {}) {
  if (!meta) return null;
  const fixed = uuid(meta.codeagentForkSourceSessionId);
  if (fixed) return fixed;
  if (!meta.branchSourceSessionId) return null;
  const liveId = uuid(getSession?.(meta.branchSourceSessionId)?.ccSessionId);
  return liveId || uuid(loadSessionFile?.(meta.branchSourceSessionId)?.ccSessionId);
}

function identityRejection({ ccSessionId, transcriptPath } = {}, forkSourceId) {
  const incoming = typeof ccSessionId === 'string' ? ccSessionId.trim().toLowerCase() : '';
  const source = uuid(forkSourceId), transcript = fileIdentity(transcriptPath);
  if (source && incoming === source) return 'fork-source-identity';
  if (source && transcript === source) return 'fork-source-transcript';
  if (incoming && transcript && incoming !== transcript) return 'transcript-identity-mismatch';
  return null;
}

function unresolved(reason, cause) {
  return Object.assign(new Error('这条分支尚未找到可核实的独立会话记录。现有对话已保留，未启动原会话；请核对分支的原生历史后再恢复。'),
    { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED', reason, ...(cause ? { cause } : {}) });
}

function verifyExactChild(file, expectedId, cwd, fsModule = fs) {
  if (!file || !path.isAbsolute(file) || !expectedId || fileIdentity(file) !== expectedId) throw unresolved('child-path-missing');
  if (!cwd || !transcriptBucketMatches(file, cwd)) throw unresolved('child-transcript-directory-mismatch');
  let fd, primaryError;
  try {
    fd = fsModule.openSync(file, 'r');
    const before = fsModule.fstatSync(fd);
    if (!before.isFile() || !before.size) throw unresolved('child-transcript-empty');
    const start = Math.max(0, before.size - TAIL_BYTES), buffer = Buffer.alloc(before.size - start);
    let read = 0;
    while (read < buffer.length) {
      const count = fsModule.readSync(fd, buffer, read, buffer.length - read, start + read);
      if (!count) throw unresolved('child-transcript-changed');
      read += count;
    }
    const after = fsModule.fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw unresolved('child-transcript-changed');
    const boundary = start ? buffer.indexOf(10) : -1;
    if (start && boundary < 0) throw unresolved('child-evidence-outside-tail');
    const text = buffer.subarray(start ? boundary + 1 : 0).toString('utf8').replace(/^\uFEFF/, '');
    let last = null;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch (cause) { throw unresolved('child-transcript-incomplete', cause); }
      if (!row || !['user', 'assistant'].includes(row.type) || row.isSidechain || row.agentId || row.agent_id) continue;
      if (!row.message || !uuid(row.sessionId)) throw unresolved('child-native-identity-unproven');
      last = row;
    }
    if (!last || uuid(last.sessionId) !== expectedId) throw unresolved('child-native-identity-unproven');
    if (!last.cwd || !sameWorkDir(last.cwd, cwd)) throw unresolved('child-native-cwd-mismatch');
  } catch (error) {
    primaryError = error.code === 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' ? error : unresolved('child-transcript-unreadable', error);
    throw primaryError;
  } finally {
    if (fd !== undefined) {
      try { fsModule.closeSync(fd); }
      catch (error) { if (primaryError) primaryError.closeError = error; else throw error; }
    }
  }
}

function exactNativeHistory(sessionId, cwd, deps, reason) {
  const env = deps.env || process.env;
  try {
    const config = require('./codeagent-config').resolveCodeAgentConfig(env);
    const file = require('./claude-native-history').findNativeClaudeHistory(sessionId,
      { cwd, env: { ...env, CLAUDE_CONFIG_DIR: config.configDir } });
    if (!file) throw unresolved(reason);
    const stat = (deps.fsModule || fs).statSync(file);
    if (!stat.isFile() || !stat.size) throw unresolved(reason);
    return file;
  } catch (error) {
    if (error.code === 'CODEAGENT_FORK_IDENTITY_UNRESOLVED') throw error;
    throw unresolved(reason, error);
  }
}

function recoverCodeAgentFork(meta, deps = {}) {
  const unchanged = { meta, forkCCSessionId: null, repaired: false, sourceId: null };
  if (!/^codeagent(?:-resume)?$/.test(String(meta?.kind || ''))) return unchanged;
  const sourceId = forkSourceIdentity(meta, deps);
  if (!sourceId) {
    if (meta.branchSourceSessionId && identityRejection(meta, null)) throw unresolved('fork-source-unavailable');
    return unchanged;
  }
  const next = { ...meta, codeagentForkSourceSessionId: sourceId };
  const current = uuid(meta.ccSessionId), candidate = fileIdentity(meta.transcriptPath);
  if (current && current !== sourceId) {
    const rejection = identityRejection(meta, sourceId);
    if (rejection) throw unresolved(rejection);
    // A bound child must also remain resumable. Resolve by its exact native id
    // so an old archived path does not turn a valid child into a false failure.
    next.transcriptPath = exactNativeHistory(current, meta.cwd, deps, 'child-native-history-unavailable');
    return { ...unchanged, meta: next, sourceId };
  }
  if (candidate && candidate !== sourceId) {
    verifyExactChild(meta.transcriptPath, candidate, meta.cwd, deps.fsModule);
    // A proven file outside the CLI's current history root cannot be resumed by
    // id. Keep the retained record instead of letting the launcher start fresh.
    exactNativeHistory(candidate, meta.cwd, deps, 'child-native-history-unavailable');
    return { meta: { ...next, ccSessionId: candidate, codeagentIdentityPending: false }, forkCCSessionId: null, repaired: true, sourceId };
  }
  // A fresh pending fork has never owned a child. Re-run the original fork so it
  // inherits the same context. A used/ambiguous branch must keep its data for review.
  // Persisted records normally use epoch numbers; older/imported records can
  // use ISO dates. Any non-empty unknown timestamp is also insufficient proof
  // that a branch has never run.
  const used = ['runStartedAt', 'lastRunStartedAt', 'lastCompletedAt'].some(key => {
    const value = meta[key];
    return typeof value === 'string' ? !!value.trim() && value.trim() !== '0' : !!value;
  }) || ['lastPrompt', 'lastOutputPreview'].some(key => typeof meta[key] === 'string' && !!meta[key].trim());
  if (!meta.ccSessionId && !meta.transcriptPath && uuid(meta.codeagentForkSourceSessionId) && !used) {
    // The launcher treats a missing fork history as a fresh session. That is
    // acceptable for a first empty-source fork, but never for reopening a saved
    // pending branch: it would silently discard the requested source context.
    const sourcePath = exactNativeHistory(sourceId, meta.cwd, deps, 'fork-source-history-unavailable');
    verifyExactChild(sourcePath, sourceId, meta.cwd, deps.fsModule);
    return { meta: { ...next, ccSessionId: null, transcriptPath: null, codeagentIdentityPending: true }, forkCCSessionId: sourceId, repaired: false, sourceId };
  }
  throw unresolved('independent-child-unavailable');
}

module.exports = { forkSourceIdentity, identityRejection, recoverCodeAgentFork };
