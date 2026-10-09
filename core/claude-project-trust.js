'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);
const _renameSleepCell = new Int32Array(new SharedArrayBuffer(4));

function renameWithRetrySync(source, target, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const retries = Number.isInteger(options.retries) ? Math.max(0, options.retries) : 80;
  const retryDelayMs = Number.isFinite(options.retryDelayMs) ? Math.max(0, options.retryDelayMs) : 15;
  const sleep = options.sleep || (ms => { if (ms > 0) Atomics.wait(_renameSleepCell, 0, 0, ms); });
  for (let attempt = 0; ; attempt += 1) {
    try {
      fsImpl.renameSync(source, target);
      return attempt;
    } catch (error) {
      if (!error || !TRANSIENT_RENAME_CODES.has(error.code) || attempt >= retries) throw error;
      sleep(retryDelayMs);
    }
  }
}

// 让 Claude Code 不再对 Hub 新建的工作区弹「Quick safety check」信任框。
//
// 2026-08-28 实测（Claude Code v2.1.251，node-pty 起真 CLI）：
//   * 空的临时目录不弹框；Hub 的 _scratch 工作区（git init + 播种的 AGENTS.md）
//     必弹 —— 用户报的「又不自动信任了」就是它。
//   * 往 ~/.claude.json 写 projects["<正斜杠 cwd>"].hasTrustDialogAccepted = true
//     之后，同一目录再起 CLI 直接进提示符，框完全不出现。
//
// 这是唯一无竞态的路径（PTY 探测那条只能在框已经画出来之后补救，且新版默认高亮
// 项是 "No, exit"）。代价是要碰共享的 ~/.claude.json，所以这里刻意写得很窄：
//   - 只补 projects[key].hasTrustDialogAccepted，不动 settings.json、不动
//     hasCompletedOnboarding / bypassPermissionsModeAccepted 等全局字段；
//   - 已经是 true 就直接返回，不产生写入；
//   - 解析不了就放弃，绝不用一份空对象覆盖用户配置；
//   - 文件不存在且用的是共享 home 配置时不凭空创建（那说明 CLI 还没初始化过）。

function toClaudeProjectKey(projectDir) {
  return path.resolve(projectDir || os.homedir()).replace(/\\/g, '/');
}

// stateFileName：同形态的 CLI 用别的状态文件名（公司 Code Agent 是 <configDir>/.cac.json）。
function claudeStatePathFor(configDir, stateFileName = '.claude.json') {
  return configDir
    ? path.join(configDir, stateFileName)
    : path.join(os.homedir(), '.claude.json');
}

function ensureClaudeProjectTrusted(projectDir, options = {}) {
  const {
    configDir = null,
    stateFileName = null,
    fsImpl = fs,
    logger = console,
    renameRetries,
    renameRetryDelayMs,
    renameSleep,
  } = options;
  const statePath = claudeStatePathFor(configDir, stateFileName || '.claude.json');
  const projectKey = toClaudeProjectKey(projectDir);

  try {
    let raw = null;
    try { raw = fsImpl.readFileSync(statePath, 'utf8'); } catch { raw = null; }
    // 别的 CLI 的状态文件不存在，说明它还没初始化过，同样不凭空创建。
    if (raw === null && (!configDir || stateFileName)) {
      return { ok: false, changed: false, reason: 'state-missing', statePath, projectKey };
    }

    let state = {};
    if (raw !== null) {
      try { state = JSON.parse(raw); } catch {
        // 半截 / 损坏的 .claude.json 交给 CLI 自己修，Hub 覆盖只会放大事故。
        return { ok: false, changed: false, reason: 'unparsable-state', statePath, projectKey };
      }
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return { ok: false, changed: false, reason: 'unexpected-state', statePath, projectKey };
    }
    if (!state.projects || typeof state.projects !== 'object' || Array.isArray(state.projects)) {
      state.projects = {};
    }

    // 同一个目录可能有两种写法：8.3 短名（C:/Users/L00807~1/…，TEMP 常是这种）和真实长名。
    // CLI 按哪种查不确定（2026-10-08 公司真机：Hub 写短名、CLI 查长名，信任框照弹），两种都写。
    const keys = [projectKey];
    try {
      const realKey = toClaudeProjectKey((fsImpl.realpathSync && fsImpl.realpathSync.native || fs.realpathSync.native)(projectDir));
      if (realKey && realKey !== projectKey) keys.push(realKey);
    } catch {}
    const isTrusted = key => state.projects[key] && typeof state.projects[key] === 'object' && state.projects[key].hasTrustDialogAccepted === true;
    if (keys.every(isTrusted)) {
      return { ok: true, changed: false, reason: 'already-trusted', statePath, projectKey };
    }

    for (const key of keys) {
      const existing = state.projects[key];
      state.projects[key] = {
        allowedTools: [],
        mcpContextUris: [],
        mcpServers: {},
        enabledMcpjsonServers: [],
        disabledMcpjsonServers: [],
        ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
        hasTrustDialogAccepted: true,
      };
    }

    // 原子写。~/.claude.json 有 600KB+，直接就地写会让并发启动的 claude CLI 读到
    // 半截 JSON；tmp + rename 至少保证读到的永远是完整的一版。
    const tmpPath = `${statePath}.hub-${process.pid}-${Date.now()}.tmp`;
    fsImpl.mkdirSync(path.dirname(statePath), { recursive: true });
    try {
      fsImpl.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8');
      renameWithRetrySync(tmpPath, statePath, {
        fsImpl,
        retries: renameRetries,
        retryDelayMs: renameRetryDelayMs,
        sleep: renameSleep,
      });
    } finally {
      try { if (fsImpl.existsSync(tmpPath)) fsImpl.unlinkSync(tmpPath); } catch {}
    }
    return { ok: true, changed: true, statePath, projectKey };
  } catch (err) {
    logger.warn?.('[hub] ensureClaudeProjectTrusted failed:', err && err.message);
    return { ok: false, changed: false, reason: (err && err.message) || 'unknown', statePath, projectKey };
  }
}

module.exports = {
  claudeStatePathFor,
  ensureClaudeProjectTrusted,
  renameWithRetrySync,
  toClaudeProjectKey,
};
