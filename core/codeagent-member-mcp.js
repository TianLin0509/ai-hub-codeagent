'use strict';
// 通道会话带上成员自己注册的 MCP（2026-10-21 用户拍板：通道会话默认带上 read-KIA，与成员手动会话一致）。
//
// 为什么要 Hub 自己生成一份：通道会话（purpose=company-bridge）启动时带 --setting-sources user、MCP 档位 none
// （空的 --mcp-config + --strict-mcp-config，core/session-manager.js buildCodeAgentPtyLaunch），而且多半走号池号——
// 配置目录是 <Hub 数据目录>/codeagent-pool/accounts/<id>，号池同步不带 mcpServers（core/codeagent-pool.js SHARED_FILES）。
// 成员手动会话用的是个人账号的 ~/.cac.json、项目级 .mcp.json 或 local 作用域（.cac.json 的 projects[<目录>].mcpServers），
// 这些通道会话都可能读不到：同事电脑上通道会话没有 read-KIA、我们这台（9 个都注册在 ~/.cac.json 顶层、
// CodeAgent 1.2615 不认 strict）有，差异就在这里。
//
// 做法：每次启动通道会话时，从成员电脑上所有常见的注册位置只读地收集 mcpServers，合并成一份写到 Hub 数据目录，
// 经 --mcp-config 明确交给 CodeAgent。不改动成员的任何配置文件；认不认 --strict-mcp-config 的版本结果都一样。
// 同名以先找到的为准，优先级：号自己的 .cac.json（顶层 → 当前目录的 local）> 个人账号配置目录 > 用户目录 ~/.cac.json
// > 工作目录的 .mcp.json > 其他目录 local 作用域登记的（成员可能只在自己常用的目录下登记过）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_FILE = '.cac.json';
const MAX_SERVERS = 60;

function readJson(file, fsModule) {
  try { return JSON.parse(fsModule.readFileSync(file, 'utf8')); } catch { return null; }
}
function validServer(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return false;
  return (typeof cfg.command === 'string' && cfg.command.trim() !== '') || (typeof cfg.url === 'string' && /^https?:\/\//i.test(cfg.url));
}
const norm = p => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();

// 返回 { servers: { 名字: 配置 }, sources: { 名字: 来源说明 } }；读不到的位置跳过。
function collectMemberMcpServers({ cwd = '', accountDir = '', personalDir = '', homeDir = '', fsModule = fs } = {}) {
  const servers = {}, sources = {};
  const take = (map, label) => {
    if (!map || typeof map !== 'object') return;
    for (const [name, cfg] of Object.entries(map)) {
      if (Object.keys(servers).length >= MAX_SERVERS) return;
      if (!/^[\w.@-]{1,64}$/.test(name) || name in servers || !validServer(cfg)) continue;
      servers[name] = cfg; sources[name] = label;
    }
  };
  const files = [];
  const seen = new Set();
  const addFile = (file, label) => { if (!file) return; const k = norm(file); if (seen.has(k)) return; seen.add(k); files.push({ file, label, data: readJson(file, fsModule) }); };
  if (accountDir) addFile(path.join(accountDir, STATE_FILE), '号的配置目录');
  if (personalDir) addFile(path.join(personalDir, STATE_FILE), '个人账号配置目录');
  if (homeDir) addFile(path.join(homeDir, STATE_FILE), '用户目录 .cac.json');
  const here = norm(cwd);
  for (const f of files) {
    if (!f.data) continue;
    take(f.data.mcpServers, f.label);
    const projects = f.data.projects && typeof f.data.projects === 'object' ? f.data.projects : {};
    for (const [dir, p] of Object.entries(projects)) if (here && norm(dir) === here) take(p && p.mcpServers, f.label + '（本目录）');
  }
  if (cwd) { const project = readJson(path.join(cwd, '.mcp.json'), fsModule); take(project && project.mcpServers, '工作目录 .mcp.json'); }
  for (const f of files) {
    const projects = f.data && f.data.projects && typeof f.data.projects === 'object' ? f.data.projects : {};
    for (const [dir, p] of Object.entries(projects)) if (norm(dir) !== here) take(p && p.mcpServers, f.label + '（其他目录）');
  }
  return { servers, sources };
}

// 写成 --mcp-config 用的文件（内容不变就不重写）；没有可带的返回 null。
function writeMemberMcpConfig({ hubDataDir, fsModule = fs, ...where } = {}) {
  const { servers, sources } = collectMemberMcpServers({ ...where, fsModule });
  const names = Object.keys(servers);
  if (!names.length || !hubDataDir) return { file: null, names, sources };
  const body = JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
  const dir = path.join(hubDataDir, 'mcp-profiles');
  const file = path.join(dir, 'codeagent-member-mcp-' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 12) + '.json');
  try {
    fsModule.mkdirSync(dir, { recursive: true });
    let same = false; try { same = fsModule.readFileSync(file, 'utf8') === body; } catch { /* 还没有 */ }
    if (!same) { const tmp = file + '.' + process.pid + '.tmp'; fsModule.writeFileSync(tmp, body, 'utf8'); fsModule.renameSync(tmp, file); }
  } catch (error) { return { file: null, names, sources, error: error.message }; }
  return { file, names, sources };
}

module.exports = { collectMemberMcpServers, writeMemberMcpConfig };
