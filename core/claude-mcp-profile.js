'use strict';

/**
 * Claude CLI 的 MCP 加载档位 —— 对标 Codex 那套 `mcp_servers.X.enabled=false`。
 *
 * 背景：Codex 有 none/lean/browser/wireless/full 五档（session-manager.js 的
 * buildCodexMcpIsolationArgs），普通 Codex 会话现在默认 none。
 * Claude 这边一直是**全量继承** —— 每开一个 Claude 会话，~/.claude.json 里
 * 那七个 MCP server（playwright / gemini-cli / codex-cli / deepseek / qwen /
 * glm / wireless-sim）全部拉起来，每个都是一个常驻子进程。开三四个会话就很可观。
 *
 * Claude CLI 没有"逐个禁用"的开关，但有 `--mcp-config <file> --strict-mcp-config`：
 * strict 表示"只认这个文件，忽略所有其它来源"。所以做法是把用户现有的 server 定义
 * 按档位过滤后原样写进一个临时 config，再让 CLI 只读它。用户的 ~/.claude.json
 * 一个字节都不动。
 *
 * **Claude 默认必须是 full**（= 改动前的行为）。Codex 的 None 是独立用户偏好；
 * 不能顺带改变 Claude，否则会让依赖 MCP 的会话突然少工具，属于静默降级。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// 2026-08-29 改默认：full → none。
// 起因是用户报「内存怎么这么高」。实测：Claude 默认 full 意味着每开一个会话都把
// ~/.claude.json 里 7 个 MCP server 全拉起来，其中 wireless-sim 一个就恒定提交 2.66 GB
// （实占只有 20–30 MB，全是启动时一次性提交、之后从没碰过）。当时机器上有 13 个
// Claude 会话 → 单是 wireless-sim 就吃掉 34.6 GB 提交内存，占系统总额度的三分之一。
// 用户明确要求：「只有我提到的时候才加载 wireless-sim，否则不应该加载」。
//
// none 与 Codex 端语义对齐：硬关，连「工作区在无线目录下自动放行」都不走。
const CLAUDE_MCP_PROFILES = new Set(['none', 'full', 'lean', 'browser', 'wireless']);
const DEFAULT_CLAUDE_MCP_PROFILE = 'none';

// 同一个能力在 Claude 和 Codex 的配置里叫法不一样（claude 是 wireless-sim，
// codex 历史上写的是 superwireless），两边都列上，谁在就放行谁。
const BROWSER_MCP_NAMES = ['playwright', 'claude-in-chrome', 'chrome-devtools', 'puppeteer', 'web_roundtable'];
const WIRELESS_MCP_NAMES = ['wireless-sim', 'superwireless'];

function normalizeClaudeMcpProfile(value) {
  const normalized = String(value || DEFAULT_CLAUDE_MCP_PROFILE).trim().toLowerCase();
  return CLAUDE_MCP_PROFILES.has(normalized) ? normalized : DEFAULT_CLAUDE_MCP_PROFILE;
}

function readJsonSafe(filePath, fsModule = fs) {
  try {
    const parsed = JSON.parse(fsModule.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Claude CLI 的 MCP 来源有两层：~/.claude.json 顶层 mcpServers（user scope）
 * 和 projects["<cwd>"].mcpServers（project scope）。project 覆盖 user。
 */
function listClaudeMcpServers({ homeDir, cwd, fsModule = fs } = {}) {
  const home = homeDir || os.homedir();
  const config = readJsonSafe(path.join(home, '.claude.json'), fsModule);
  if (!config) return {};
  const merged = {};
  if (config.mcpServers && typeof config.mcpServers === 'object') {
    Object.assign(merged, config.mcpServers);
  }
  if (cwd && config.projects && typeof config.projects === 'object') {
    // Claude CLI 用正斜杠存 project key，Windows 上传进来的是反斜杠。
    const wanted = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    for (const [key, project] of Object.entries(config.projects)) {
      const normalized = String(key).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      if (normalized !== wanted) continue;
      if (project && project.mcpServers && typeof project.mcpServers === 'object') {
        Object.assign(merged, project.mcpServers);
      }
    }
  }
  return merged;
}

function isPathInside(candidate, root) {
  if (!candidate || !root) return false;
  const c = path.resolve(String(candidate)).toLowerCase();
  const r = path.resolve(String(root)).toLowerCase();
  return c === r || c.startsWith(r + path.sep);
}

function isWirelessWorkspace(cwd) {
  return isPathInside(cwd, process.env.AI_HUB_WIRELESS_ROOT || '');
}

/**
 * 某档位下允许保留哪些 server 名。与 Codex 端保持同一套判定，
 * 包括"工作区在无线目录下就自动放行无线 MCP"这条。
 */
function resolveAllowedMcpNames(profile, { cwd, extraAllowed = [] } = {}) {
  const normalized = normalizeClaudeMcpProfile(profile);
  // none 是硬关：extraAllowed 和「无线工作区自动放行」都不生效，与 Codex 端一致。
  // 否则默认档一落到无线目录下就又把 wireless-sim 拉起来，等于默认没关。
  if (normalized === 'none') return new Set();
  const allowed = new Set(extraAllowed.filter(Boolean));
  if (normalized === 'browser') BROWSER_MCP_NAMES.forEach(name => allowed.add(name));
  if (normalized === 'wireless' || isWirelessWorkspace(cwd)) WIRELESS_MCP_NAMES.forEach(name => allowed.add(name));
  return allowed;
}

function filterMcpServers(servers, allowed) {
  const out = {};
  for (const [name, definition] of Object.entries(servers || {})) {
    if (allowed.has(name)) out[name] = definition;
  }
  return out;
}

function claudeMcpProfileDir(hubDataDir) {
  return path.join(hubDataDir, 'mcp-profiles');
}

/**
 * 生成本次启动用的 config 文件。按内容命名（档位 + 放行的 server 名），
 * 同档位的会话复用同一个文件，不会每开一个会话就攒一个垃圾文件。
 */
function writeClaudeMcpProfileConfig({ hubDataDir, profile, servers, fsModule = fs }) {
  const dir = claudeMcpProfileDir(hubDataDir);
  fsModule.mkdirSync(dir, { recursive: true });
  const names = Object.keys(servers).sort();
  const suffix = names.length ? names.join('-').replace(/[^A-Za-z0-9_-]/g, '_') : 'none';
  const filePath = path.join(dir, `claude-mcp-${normalizeClaudeMcpProfile(profile)}-${suffix}.json`);
  fsModule.writeFileSync(filePath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, 'utf8');
  return filePath;
}

/**
 * 拼给 Claude CLI 的 flag。full 档返回空串（完全维持改动前的行为）。
 *
 * @returns {{ args: string, profile: string, keptServers: string[], configPath: string|null }}
 */
function buildClaudeMcpProfileArgs({
  mcpProfile,
  cwd,
  hubDataDir,
  homeDir,
  extraAllowed = [],
  fsModule = fs,
  logger = console,
} = {}) {
  const profile = normalizeClaudeMcpProfile(mcpProfile);
  const empty = { args: '', profile, keptServers: [], configPath: null };
  if (!hubDataDir) return empty;

  try {
    // none 压根不需要读用户配置：直接写一份空 mcpServers。少读一个文件就少一处
    // 会抛异常的地方 —— 而 none 是默认档，它的失败回退方向是「全量加载」，代价最大。
    const servers = profile === 'none' ? {} : listClaudeMcpServers({ homeDir, cwd, fsModule });
    const allowed = resolveAllowedMcpNames(profile, { cwd, extraAllowed });
    const kept = profile === 'full' ? {} : filterMcpServers(servers, allowed);
    if (require('./web-roundtable/integration').enabled(profile)) {
      const { name, ...server } = require('./web-roundtable/integration').entry(hubDataDir);
      kept[name] = server;
    }
    const configPath = writeClaudeMcpProfileConfig({ hubDataDir, profile, servers: kept, fsModule });
    return {
      // --strict-mcp-config 是关键：只给 --mcp-config 而不加 strict 的话，
      // CLI 会把这个文件和用户全局配置**合并**，等于什么都没省。
      args: ` --mcp-config "${configPath.replace(/\\/g, '\\\\')}"${profile === 'full' ? '' : ' --strict-mcp-config'}`,
      profile,
      keptServers: Object.keys(kept).sort(),
      configPath,
    };
  } catch (error) {
    // 生成失败只能退回全量继承（没有别的杠杆）。对 none 这个默认档来说，这等于
    // 悄悄把 7 个 MCP 全拉回来、多吃几个 GB，所以日志要说清后果，别只写一句失败。
    logger.warn?.(profile === 'none'
      ? `[claude-mcp] 默认档 none 生成失败，本次会话将回退到全量加载 MCP（内存会显著上升）：${error.message}`
      : `[claude-mcp] 档位 ${profile} 生成失败，回退全量继承：${error.message}`);
    return empty;
  }
}

module.exports = {
  BROWSER_MCP_NAMES,
  CLAUDE_MCP_PROFILES,
  DEFAULT_CLAUDE_MCP_PROFILE,
  WIRELESS_MCP_NAMES,
  buildClaudeMcpProfileArgs,
  claudeMcpProfileDir,
  filterMcpServers,
  isWirelessWorkspace,
  listClaudeMcpServers,
  normalizeClaudeMcpProfile,
  resolveAllowedMcpNames,
  writeClaudeMcpProfileConfig,
};
