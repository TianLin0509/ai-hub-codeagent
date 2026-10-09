'use strict';
// Kimi Code 把会话按 cwd 分域，而且**会校验**：从另一个目录 `kimi --session <id>`
// 直接拒绝启动并退出——
//   Session "session_xxx" was created under a different directory.
//   error: failed to start shell
// Hub 的归档流程（关 CLI → 移目录 → --session 重连）因此对 Kimi 是致命的：
// PTY spawn 本身成功，Hub 以为一切正常，用户拿到的是一个已经死掉的终端，上下文全丢。
//
// 目录键 = kimi 内部 encodeWorkDirKey：`wd_<slug(basename)>_<sha256(正斜杠绝对路径) 前 12 位 hex>`。
// 注意 basename 不是原样使用，要先过 slugifyWorkDirName（见下）——中文/大写/空格/超长
// 目录名都会得到和直觉不同的 slug。2026-07-28 用真实 kimi.exe 在隔离 KIMI_CODE_HOME
// 里实测验证（与 kimi 二进制内嵌源码逐字节一致）：
//   C:/Workspace/_scratch/hub-kimi-slug-test/AI-HUB路径重构排查-LongNameTest
//     → wd_ai-hub--longnametest_c6a3d5e233e0
//   …/Very-Long Project Name With Spaces And MANY Uppercase Letters 2026
//     → wd_very-long-project-name-with-spaces-and-m_32b105079b26
// kimi 自己的注释（migration-legacy/workdir-bucket.ts）：picker 纯按
// readdir(encodeWorkDirKey(workDir)) 找会话，两边算法必须保持一致，否则迁移过的
// 会话在 picker 里直接隐身。
//
// workDir 一共记在四个地方，缺一不可：
//   1. <home>/sessions/<workspaceKey>/<sessionId>/          目录名本身
//   2. <home>/sessions/<workspaceKey>/<sessionId>/state.json  "workDir"
//      （以及 agents.*.homedir——kimi 官方迁移器同样会重写它，见 rewriteAgentHomedirs）
//   3. <home>/workspaces.json                                 "<key>": { root }
//      （workspaces.json 的 name 字段是原始 basename，不 slug——实测确认）
//   4. <home>/session_index.jsonl                             { sessionDir, workDir }

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultKimiHome(env = process.env) {
  return env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
}

// Kimi 内部一律用正斜杠记路径，哈希也基于该形式。
function toPosix(p) {
  return path.resolve(String(p || '')).replace(/\\/g, '/');
}

// --- 以下两个函数逐行移植自 kimi 二进制内嵌源码 ---
// agent-core-v2/src/_base/utils/workdir-slug.ts（kimi.exe build 2026-07-18）。
// 任何改动都必须先对照 kimi 实现，两边产出必须逐字节一致。
const MAX_WORKDIR_SLUG_LENGTH = 40;

function slugifyWorkDirName(name) {
  const slug = String(name == null ? '' : name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
  return slug === '' || slug === '.' || slug === '..' ? 'workspace' : slug;
}

function kimiWorkspaceKey(cwd) {
  const posix = toPosix(cwd);
  const digest = crypto.createHash('sha256').update(posix, 'utf8').digest('hex').slice(0, 12);
  const base = posix.split('/').pop() || posix;
  return `wd_${slugifyWorkDirName(base)}_${digest}`;
}

function readIndex(indexPath) {
  let raw = '';
  try { raw = fs.readFileSync(indexPath, 'utf8'); } catch { return []; }
  return raw.split(/\r?\n/).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function writeIndex(indexPath, entries) {
  const body = entries.map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(indexPath, body ? `${body}\n` : '', 'utf8');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// 移植自 kimi 官方迁移器的 rewriteAgentHomedirs/remapSessionPath：
// 只改写落在旧 sessionDir 之内的 homedir，指到外面的保持原样。
function remapAgentHomedirs(state, oldSessionDir, newSessionDir) {
  if (!state.agents || typeof state.agents !== 'object') return;
  for (const agentMeta of Object.values(state.agents)) {
    if (!agentMeta || typeof agentMeta !== 'object' || typeof agentMeta.homedir !== 'string') continue;
    const rel = path.relative(oldSessionDir, path.resolve(agentMeta.homedir));
    if (rel === '') agentMeta.homedir = newSessionDir;
    else if (!rel.startsWith('..') && !path.isAbsolute(rel)) agentMeta.homedir = path.join(newSessionDir, rel);
  }
}

// 按 sessionId 直查 session_index.jsonl（不迁移任何东西）。恢复流程用它对账：
// renderer 持久化的 cwd/kimiSessionDir 可能停留在归档前的旧路径。
function lookupKimiSession(sessionId, opts = {}) {
  const home = opts.homeDir || defaultKimiHome();
  const entry = readIndex(path.join(home, 'session_index.jsonl'))
    .find(e => e && e.sessionId === sessionId);
  if (!entry) return null;
  return { sessionDir: entry.sessionDir || null, workDir: entry.workDir || null };
}

// 把一个 Kimi 会话从旧 cwd 迁到新 cwd。幂等：已经在目标位置时直接返回 ok。
function migrateKimiSession(opts = {}) {
  const sessionId = String(opts.sessionId || '');
  const toCwd = opts.toCwd;
  if (!sessionId || !toCwd) return { ok: false, reason: 'sessionId and toCwd are required' };

  const home = opts.homeDir || defaultKimiHome();
  const indexPath = path.join(home, 'session_index.jsonl');
  const workspacesPath = path.join(home, 'workspaces.json');

  const entries = readIndex(indexPath);
  const entry = entries.find(e => e && e.sessionId === sessionId);
  if (!entry) return { ok: false, reason: `session ${sessionId} not found in session_index.jsonl` };

  const newKey = kimiWorkspaceKey(toCwd);
  const newWorkDir = toPosix(toCwd);
  const newSessionDir = path.join(home, 'sessions', newKey, sessionId);
  const oldSessionDir = entry.sessionDir ? path.resolve(entry.sessionDir) : null;

  if (oldSessionDir && path.resolve(newSessionDir) === oldSessionDir && entry.workDir === newWorkDir) {
    return { ok: true, alreadyCurrent: true, sessionDir: newSessionDir };
  }

  // 1. 目录搬迁（同盘 rename，跨盘/占用时回退到复制）
  if (oldSessionDir && fs.existsSync(oldSessionDir)) {
    fs.mkdirSync(path.dirname(newSessionDir), { recursive: true });
    if (fs.existsSync(newSessionDir)) return { ok: false, reason: `target session dir already exists: ${newSessionDir}` };
    try {
      fs.renameSync(oldSessionDir, newSessionDir);
    } catch (error) {
      if (!['EXDEV', 'EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      fs.cpSync(oldSessionDir, newSessionDir, { recursive: true });
      try {
        fs.rmSync(oldSessionDir, { recursive: true, force: true, maxRetries: 60, retryDelay: 50 });
      } catch (removeError) {
        // Do not publish a half-migration whose index points at the copy while
        // the original remains authoritative. Best-effort rollback keeps the
        // next user retry possible and surfaces the real Windows lock error.
        try { fs.rmSync(newSessionDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); } catch {}
        throw removeError;
      }
    }
  } else {
    fs.mkdirSync(newSessionDir, { recursive: true });
  }

  // 2. state.json 里的 workDir；agents.*.homedir 也记着旧 sessionDir，
  //    kimi 官方迁移器（rewriteAgentHomedirs）会一并重写，保持一致。
  const statePath = path.join(newSessionDir, 'state.json');
  const state = readJson(statePath, null);
  if (state && typeof state === 'object') {
    state.workDir = newWorkDir;
    if (oldSessionDir) remapAgentHomedirs(state, oldSessionDir, newSessionDir);
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  // 3. workspaces.json 注册新 workspace（保留旧条目，别的会话可能还指着它）
  const workspaces = readJson(workspacesPath, { version: 1, workspaces: {} });
  if (!workspaces.workspaces || typeof workspaces.workspaces !== 'object') workspaces.workspaces = {};
  const now = new Date().toISOString();
  const existing = workspaces.workspaces[newKey];
  workspaces.workspaces[newKey] = {
    root: newWorkDir,
    name: path.basename(newWorkDir),
    created_at: (existing && existing.created_at) || now,
    last_opened_at: now,
  };
  fs.mkdirSync(path.dirname(workspacesPath), { recursive: true });
  fs.writeFileSync(workspacesPath, JSON.stringify(workspaces, null, 2), 'utf8');

  // 4. session_index.jsonl——同一 sessionId 可能有多行（历史重复写入），全部更新，
  //    否则按行扫描的消费者（tap 绑定、workspaceRegistry 合并）可能读到旧的那行。
  for (const e of entries) {
    if (e && e.sessionId === sessionId) {
      e.sessionDir = toPosix(newSessionDir);
      e.workDir = newWorkDir;
    }
  }
  writeIndex(indexPath, entries);

  return {
    ok: true,
    sessionDir: newSessionDir,
    workspaceKey: newKey,
    from: oldSessionDir,
    workDir: newWorkDir,
  };
}

module.exports = {
  defaultKimiHome,
  kimiWorkspaceKey,
  lookupKimiSession,
  migrateKimiSession,
  slugifyWorkDirName,
  toPosix,
};
