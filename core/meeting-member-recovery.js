'use strict';

// Repair the old process-exit deletion bug only for an existing, empty room.
// Require its complete roster backup, matching slot identities, one process
// manifest, and every exact native transcript. Never match names or create
// replacement conversations, and never revive a deleted or partially edited room.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { latestActivityTime } = require('./session-recency');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const baseKind = kind => String(kind || '').replace(/-resume$/, '');

function readManifests(dataDir, logger) {
  const dir = path.join(dataDir, 'diagnostics');
  if (!fs.existsSync(dir)) return [];
  const result = [];
  let names;
  try { names = fs.readdirSync(dir); }
  catch (error) { logger.warn('[meeting-recovery] cannot scan manifests:', error.message); return []; }
  for (const name of names) {
    if (!/^session-manifest-\d+\.json$/.test(name)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (record && Array.isArray(record.sessions) && Number.isFinite(record.writtenAt) && record.writtenAt > 0) result.push(record);
    } catch (error) { logger.warn('[meeting-recovery] unreadable manifest:', name, error.message); }
  }
  return result.sort((a, b) => b.writtenAt - a.writtenAt);
}

function resolveNative(member, slot, options = {}) {
  if (!UUID.test(member.nativeId || '')) throw Error('缺少有效的原生会话编号');
  const homeDir = options.homeDir || process.env.CLAUDE_HUB_HOME_DIR || os.homedir();
  const kind = baseKind(slot.kind);
  // 公司 Code Agent 的记录与 Claude 同格式，定位器也会搜它的配置目录。
  if (kind === 'claude' || kind === 'codeagent') {
    const locator = require('./claude-transcript-locator');
    const transcriptPath = locator.findTranscriptByCCSessionId(member.nativeId, homeDir);
    if (!transcriptPath) throw Error('找不到原 Claude 历史文件');
    const fd = fs.openSync(transcriptPath, 'r');
    let prefix;
    try { const buffer = Buffer.alloc(65536); prefix = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8'); }
    finally { fs.closeSync(fd); }
    const verified = prefix.split('\n').some(line => {
      try { return JSON.parse(line).sessionId === member.nativeId; } catch { return false; }
    });
    if (!verified) throw Error('Claude 历史文件身份无法核实');
    return { ccSessionId: member.nativeId, transcriptPath, cwd: locator.extractCwdFromTranscript(transcriptPath) };
  }
  if (kind === 'codex') {
    const parser = require('./codex-transcript-parser');
    const profiles = options.codexProfiles || require('./codex-global-account').currentConfig().codexSubscriptionProfiles;
    const found = new Map();
    for (const profile of profiles) {
      const home = require('./codex-usage-scope').expandHomePath(profile.home, homeDir)
        || path.join(homeDir, '.codex');
      const root = path.join(home, 'sessions');
      const file = parser.findCodexRolloutBySid(member.nativeId, root);
      if (!file) continue;
      const meta = parser.readCodexRolloutMeta(file);
      if (meta?.id !== member.nativeId) continue;
      found.set(path.resolve(file).toLowerCase(), { codexSid: member.nativeId, transcriptPath: file,
        codexSessionsRoot: root, codexProfile: profile.id, codexProfileLabel: profile.label, cwd: meta.cwd });
    }
    if (found.size !== 1) throw Error(found.size ? '存在多份 Codex 历史，需人工核对' : '找不到原 Codex 历史文件');
    return [...found.values()][0];
  }
  throw Error('此成员的原生历史需要人工核对');
}

function recoverEmptyMeetingMembers(state, backups, options = {}) {
  const logger = options.logger || console;
  const candidates = (state.meetings || []).filter(m => m.groupChat && Array.isArray(m.subSessions) && !m.subSessions.length);
  if (!candidates.length) return [];
  const byId = new Map((backups || []).filter(m => m && m.id).map(m => [m.id, m]));
  let manifests;
  const recovered = [];
  for (const meeting of candidates) {
    const backup = byId.get(meeting.id);
    if (!backup?.subSessions?.length || !Array.isArray(backup.slotSpecs)
        || backup.slotSpecs.length !== backup.subSessions.length || !Array.isArray(meeting.slotSpecs)
        || meeting.slotSpecs.length !== backup.slotSpecs.length) continue;
    if (new Set(backup.subSessions).size !== backup.subSessions.length) continue;
    if (meeting.slotSpecs.some((slot, i) => slot.memberId !== backup.slotSpecs[i].memberId || slot.kind !== backup.slotSpecs[i].kind)) continue;
    if (!backup.subSessions.every(id => UUID.test(id))) continue;
    manifests ||= options.manifests || readManifests(options.dataDir || require('./data-dir').getHubDataDir(), logger);
    const manifest = manifests.find(record => record.writtenAt >= (meeting.createdAt || 0)
      && backup.subSessions.every((id, i) => record.sessions.some(s => s && s.id === id && s.meetingId === meeting.id
        && baseKind(s.kind) === baseKind(backup.slotSpecs[i].kind))));
    if (!manifest) continue;
    try {
      const members = backup.subSessions.map((id, i) => {
        const existing = state.sessions.find(s => (s.hubId || s.id) === id);
        if (existing && existing.meetingId !== meeting.id) throw Error('成员已属于其他会话，未覆盖');
        const slot = backup.slotSpecs[i];
        const observed = manifest.sessions.find(s => s && s.id === id && s.meetingId === meeting.id);
        const identity = require('./session-capabilities').nativeSessionIdentity(existing);
        if (identity && identity.value !== observed.nativeId) throw Error('已有原生身份与备份不一致，未覆盖');
        const native = (options.resolveNative || resolveNative)(observed, slot, options);
        const value = { ...existing, hubId: id, kind: slot.kind, title: observed.title || slot.kind,
          meetingId: meeting.id, agentRuntime: 'pty', runtimeBackend: null, nativeRuntime: null,
          ...native, cwd: native.cwd || meeting.workspace, workspaceLabel: meeting.workspaceLabel,
          currentModel: slot.model ? { id: slot.model, displayName: slot.model } : existing?.currentModel,
          effort: slot.effort, fastMode: slot.fastMode, codexSpeedTier: slot.codexSpeedTier,
          mcpProfile: slot.mcpProfile, lastMessageTime: latestActivityTime(existing) || latestActivityTime(meeting),
          ...(meeting.orchestration?.sessionId === id ? { purpose: 'hub-orchestrator' } : {}),
          status: 'dormant', runStartedAt: null, suspendReason: 'recovered-member', updatedAt: Date.now() };
        if (options.canEditSession && !options.canEditSession(value)) throw Error('成员仍由其他 Hub 使用，未恢复');
        return value;
      });
      // All identities must verify before applying any part of the room repair.
      for (const member of members) {
        const index = state.sessions.findIndex(s => (s.hubId || s.id) === member.hubId);
        if (index < 0) state.sessions.push(member); else state.sessions[index] = member;
      }
      meeting.subSessions = backup.subSessions.slice();
      meeting.focusedSub = meeting.subSessions.includes(backup.focusedSub) ? backup.focusedSub : meeting.subSessions[0];
      meeting.updatedAt = Date.now();
      recovered.push({ meetingId: meeting.id, members });
      logger.info('[meeting-recovery] verified and restored members:', meeting.id, members.length);
    } catch (error) { logger.warn('[meeting-recovery] room left unchanged:', meeting.id, error.message); }
  }
  return recovered;
}
module.exports = { recoverEmptyMeetingMembers, resolveNative };
