'use strict';

// 存储根的唯一来源（2026-10-07，C: 盘满后新增 D: 盘）。
//
// 用户决定：新工作与产物落在 D:，C: 上的存量数据继续按完整路径可用。
// 这一轮的教训是**不要用 junction 把 C: 目录接到 D:**——Hub 的路径检查、realpath 比对、
// 文件管理器都会主动拒绝链接，于是改成 D: 上的真实目录，用环境变量告诉 Hub：
//   AI_HUB_WORKSPACE_ROOT          当前平铺工作根（新会话、默认路径都落这里）
//   AI_HUB_LEGACY_WORKSPACE_ROOTS  旧工作根，按 path.delimiter（Windows 为 ;）分隔；
//                                  存量会话的 cwd 仍在这些根里，必须像当前根一样被认出来
//   AI_HUB_ARTIFACTS_ROOT          跨项目产物根；未设置时沿用 ~/AI-Artifacts
// 所有调用方都从这里取，别再各自写 'C:/Work' / homedir()+'AI-Artifacts'。

const os = require('os');
const path = require('path');

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function pathKey(value) {
  const resolved = path.resolve(String(value)).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const raw = clean(item);
    if (!raw) continue;
    const resolved = path.resolve(raw);
    const key = pathKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

// 当前工作根。env 未设置时返回调用方各自的 fallback（workspace-service 有自己的
// 隔离 / ~/Workspaces 逻辑，手机与助理沿用 'C:/Work'），保持未配置时的旧行为。
function workspaceRoot({ env = process.env, fallback = null } = {}) {
  const override = clean(env && env.AI_HUB_WORKSPACE_ROOT);
  if (override) return path.resolve(override);
  return fallback ? path.resolve(fallback) : null;
}

function legacyWorkspaceRoots({ env = process.env, current } = {}) {
  const raw = clean(env && env.AI_HUB_LEGACY_WORKSPACE_ROOTS);
  if (!raw) return [];
  const currentRoot = current === undefined ? workspaceRoot({ env }) : current;
  const currentKey = currentRoot ? pathKey(currentRoot) : null;
  return dedupe(raw.split(path.delimiter)).filter(root => pathKey(root) !== currentKey);
}

function artifactsRoot({ env = process.env, home = os.homedir() } = {}) {
  const override = clean(env && env.AI_HUB_ARTIFACTS_ROOT);
  return override ? path.resolve(override) : path.join(home, 'AI-Artifacts');
}

// 旧产物位置：只用于读取/对外提供存量文件，不再往里写（桌面目录尤其如此）。
function legacyArtifactsRoots({ home = os.homedir() } = {}) {
  return [path.join(home, 'AI-Artifacts'), path.join(home, 'Desktop', 'claude-artifacts')];
}

// 读取 / 对外提供文件时信任的根（手机发图、口播资料等）。
function trustedFileRoots({ dataDir, env = process.env, home = os.homedir(), workspaceFallback = 'C:/Work' } = {}) {
  const current = workspaceRoot({ env, fallback: workspaceFallback });
  return dedupe([
    dataDir,
    current,
    ...legacyWorkspaceRoots({ env, current }),
    artifactsRoot({ env, home }),
    ...legacyArtifactsRoots({ home }),
  ]);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function dateStamp(date = new Date()) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

module.exports = {
  workspaceRoot,
  legacyWorkspaceRoots,
  artifactsRoot,
  legacyArtifactsRoots,
  trustedFileRoots,
  dateStamp,
  pathKey,
};
