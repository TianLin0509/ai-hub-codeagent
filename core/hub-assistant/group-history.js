'use strict';
// Read-only, bounded adapter for file-answer group chats. A file's mtime is an
// observation of file change, never the time the underlying work was completed.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const answers = require('../group-answer-files');
const delivery = require('../delivery-workflow');
const SAFE = /^[a-zA-Z0-9_-]{1,255}$/;
const clamp = (value, fallback, max) => Math.max(1, Math.min(max, Number(value) || fallback));
const normalize = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

function readGroupHistory(options = {}) {
  const { dataDir, query = '', meetings = [] } = options;
  const until = Number.isFinite(options.until) ? options.until : Date.now();
  const since = Number.isFinite(options.since) ? options.since : 0;
  const maxChars = clamp(options.maxChars, 6000, 48000);
  const maxFiles = clamp(options.maxFiles, 30, 100);
  const maxBytes = clamp(options.maxFileBytes, 256 * 1024, 2 * 1024 * 1024);
  const maxGroups = clamp(options.maxGroups, 200, 500);
  const maxScanEntries = clamp(options.maxScanEntries, 2400, 10000);
  const result = { sources: [], selectedChars: 0, scannedEntries: 0, candidateFiles: 0,
    skipped: { legacy: 0, noSupportedFiles: 0, unsafe: 0, oversized: 0, invalid: 0, pinnedChanged: 0, userSkipped: 0 },
    truncated: false, available: false, timeBasis: 'file-mtime-observation',
    coverage: '群聊只读回答.md及交付文件；文件修改时间仅表示观测到文件变化，不证明任务在该时刻完成。旧协议聊天不回退 transcript；未枚举范围、无文件及未交内容不证明没有任务。' };
  if (!dataDir || !fs.existsSync(dataDir)) return result;
  const root = fs.realpathSync(dataDir), taskRoot = path.join(root, 'task-docs');
  function safe(file, isDir = false) {
    try {
      const rel = path.relative(root, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (isDir ? !stat.isDirectory() : !stat.isFile()) || normalize(fs.realpathSync(file)) !== normalize(file)) {
        result.skipped.unsafe++; return null;
      }
      return stat;
    } catch { return null; }
  }
  function directories(base, limit) {
    if (result.scannedEntries >= maxScanEntries) { result.truncated = true; return []; }
    if (!safe(base, true)) return [];
    const found = [];
    let directory;
    try {
      directory = fs.opendirSync(base);
      for (let item; (item = directory.readSync());) {
        if (++result.scannedEntries > maxScanEntries) { result.truncated = true; break; }
        if (!item.isDirectory() || item.isSymbolicLink()) { if (item.isSymbolicLink()) result.skipped.unsafe++; continue; }
        if (found.length >= limit) { result.truncated = true; break; }
        const file = path.join(base, item.name);
        if (safe(file, true)) found.push(item.name);
      }
    } catch { result.skipped.invalid++; } finally { directory?.closeSync(); }
    return found;
  }
  let metadataBytes = 0;
  function readJson(file) {
    if (++result.scannedEntries > maxScanEntries) { result.truncated = true; return null; }
    const stat = safe(file);
    if (!stat) return null;
    if (stat.size > 512 * 1024) { result.skipped.oversized++; return null; }
    if (metadataBytes + stat.size > 2 * 1024 * 1024) { result.truncated = true; return null; }
    metadataBytes += stat.size;
    try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { result.skipped.invalid++; return null; }
  }
  const candidates = [];
  function enqueue(entry, meta, run, step, accepted) {
    if (++result.scannedEntries > maxScanEntries) { result.truncated = true; return; }
    if (accepted?.outcome === 'skipped') { result.skipped.userSkipped++; return; }
    const present = {};
    for (const key of ['ready', 'rework', 'blocked', 'draft']) {
      if (!entry[key] || !fs.existsSync(entry[key])) continue;
      const stat = safe(entry[key]);
      if (!stat) return;
      if (stat.size > maxBytes) { result.skipped.oversized++; return; }
      present[key] = stat;
    }
    const finals = ['ready', 'rework', 'blocked'].filter(key => present[key]);
    if (finals.length > 1) { result.skipped.invalid++; return; }
    const key = finals[0] || (present.draft ? 'draft' : null);
    if (!key) return;
    const mtime = present[key].mtimeMs;
    if (mtime < since || mtime > until) return;
    result.candidateFiles++;
    candidates.push({ entry, key, meta, run, step, accepted, mtime });
  }
  const groups = directories(taskRoot, maxGroups);
  result.available = fs.existsSync(taskRoot);
  const meetingById = new Map((Array.isArray(meetings) ? meetings : []).map(m => [m.id, m]));
  for (const id of groups) {
    if (result.scannedEntries > maxScanEntries) break;
    if (!SAFE.test(id)) { result.skipped.unsafe++; continue; }
    const meeting = meetingById.get(id);
    if (meeting && !answers.enabled(meeting)) { result.skipped.legacy++; continue; }
    const meta = { groupId: id, title: String(meeting?.title || meeting?.name || `群聊 ${id}`).slice(0, 200) };
    const base = path.join(taskRoot, id), answerRoot = path.join(base, 'answers');
    const turns = directories(answerRoot, 300).filter(n => /^turn-\d+$/.test(n)).sort((a, b) => Number(b.slice(5)) - Number(a.slice(5)));
    if (turns.length > answers.RECENT_TURNS) result.truncated = true;
    for (const turn of turns.slice(0, answers.RECENT_TURNS)) {
      const turnNum = Number(turn.slice(5));
      for (const member of directories(path.join(answerRoot, turn), 32)) {
        if (!SAFE.test(member) || !Number.isSafeInteger(turnNum)) { result.skipped.unsafe++; continue; }
        const entry = answers.entryFor({ dataDir: root, meetingId: id, turnNum, memberId: member });
        enqueue(entry, { ...meta, memberId: member, turn: turnNum, sourceType: 'group-answer-file' });
      }
    }
    const dbase = delivery.directory(root, id);
    const current = readJson(path.join(dbase, 'run.json'));
    const runs = current ? [current] : [];
    for (const runId of directories(dbase, 16)) {
      if (!SAFE.test(runId) || runId === current?.id) continue;
      const archived = readJson(path.join(dbase, runId, '已结束运行.json'));
      if (archived?.id === runId) runs.push(archived);
    }
    if (!turns.length && !runs.length) result.skipped.noSupportedFiles++;
    for (const run of runs) {
      if (!SAFE.test(String(run.id)) || !Array.isArray(run.steps)) { result.skipped.invalid++; continue; }
      if (run.steps.length > 60) result.truncated = true;
      for (const step of run.steps.slice(-60)) {
        if (!Number.isSafeInteger(step.number) || step.number < 1 || !Array.isArray(step.members)) { result.skipped.invalid++; continue; }
        if (step.members.length > 32) result.truncated = true;
        for (const member of step.members.slice(0, 32)) {
          if (!SAFE.test(String(member))) { result.skipped.unsafe++; continue; }
          const entry = { kind: 'delivery', ...delivery.paths(dbase, run, step, member) };
          enqueue(entry, { ...meta, memberId: member, runId: run.id, step: step.number, sourceType: 'group-delivery-file' }, run, step, step.deliveries?.[member]);
        }
      }
    }
  }
  const terms = String(query).trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
  candidates.sort((a, b) => b.mtime - a.mtime);
  let filesRead = 0;
  for (const candidate of candidates) {
    if (filesRead >= maxFiles || result.selectedChars >= maxChars) { result.truncated = true; break; }
    const { entry, key, meta, run, step, accepted, mtime } = candidate;
    filesRead++;
    try {
      if (run && key !== 'draft') {
        const found = delivery.readDelivery(delivery.directory(root, meta.groupId), run, step, meta.memberId);
        if (accepted && (!found || found.hash !== accepted.hash || found.path !== accepted.path || found.outcome !== accepted.outcome)) { result.skipped.pinnedChanged++; continue; }
      } else if (accepted) { result.skipped.pinnedChanged++; continue; }
      const got = answers.read(entry);
      if (!got) continue;
      const after = safe(entry[key]);
      if (!after || after.mtimeMs !== mtime) { result.skipped.invalid++; continue; }
      const haystack = `${meta.title}\n${got.text}`.toLocaleLowerCase();
      if (terms.length && !terms.every(term => haystack.includes(term))) continue;
      const remaining = Math.min(3500, maxChars - result.selectedChars);
      const text = got.text.length <= remaining ? got.text : got.text.slice(0, remaining);
      const eventId = [meta.sourceType, meta.groupId, meta.runId || `turn-${meta.turn}`, meta.step || '', meta.memberId].join(':');
      const ref = 'E' + createHash('sha256').update(JSON.stringify([eventId, got.hash, got.state, got.outcome])).digest('hex').slice(0, 16);
      result.sources.push({ ref, sessionKey: `meeting:${meta.groupId}`, eventId, sessionId: null, provider: 'meeting', role: 'assistant',
        ...meta, text, originalChars: got.text.length, truncated: text.length < got.text.length,
        timestamp: null, observedAt: mtime, fileModifiedAt: mtime, readAt: Date.now(), timeBasis: result.timeBasis,
        path: entry[key], revisionHash: got.hash, deliveryState: got.state, outcome: got.outcome,
        accepted: !!accepted, verification: accepted ? 'accepted-delivery-version-matched; business acceptance follows workflow outcome' : 'file-content-only; not proof of task acceptance' });
      result.selectedChars += text.length;
      if (text.length < got.text.length) result.truncated = true;
    } catch { result.skipped.invalid++; }
  }
  result.filesRead = filesRead;
  return result;
}
module.exports = { readGroupHistory };
