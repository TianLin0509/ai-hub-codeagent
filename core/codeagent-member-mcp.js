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
  // 「原生候选」：CodeAgent 自己可能照常加载的位置——号的配置目录 .cac.json 顶层、用户目录 ~/.cac.json 顶层（2026-10-21 v3.0.2 真机：
  // 1.2615 不认 strict，~/.cac.json 里登记的 9 个服务各起了 2 份）。只记名字，是否真会自己加载由学习记录决定（见下）。
  const native = [];
  for (const f of files) {
    if (!f.data || !NATIVE_LABELS.has(f.label) || !f.data.mcpServers || typeof f.data.mcpServers !== 'object') continue;
    for (const [name, cfg] of Object.entries(f.data.mcpServers)) if (validServer(cfg) && !native.includes(name)) native.push(name);
  }
  return { servers, sources, native };
}

// ---------------------------------------------------------------- 自学习去重（2026-10-21，v3.0.2 回归修复）
// 本机 CodeAgent 会不会自己照常加载原生候选里的服务，不同版本不一样（1.2615 不认 strict 会加载；有的版本认 strict 不加载），
// 猜错一边就是「丢插件」或「每个服务起两份」。所以不猜：通道会话启动约 75 秒后看一眼它进程树里 serve 底下的 MCP 进程，
// 同一服务起了 ≥2 份 → 记下「这个版本、这个号会自己加载它」；之后生成配置时，记录里有且名字仍在原生候选里的就不再写进来。
// 记录在 Hub 数据目录 codeagent-native-mcp.json，按 CodeAgent 版本 + 号的配置目录分开；版本变了按新版本重新学；
// 跳过的服务如果在之后的会话里一份都没起（这版其实不自己加载了），从记录里去掉，下一个会话照写。只记，不结束任何进程。
const NATIVE_LABELS = new Set(['号的配置目录', '用户目录 .cac.json']);
const NATIVE_FILE = 'codeagent-native-mcp.json';

function readNativeStore(hubDataDir, fsModule = fs) {
  const d = hubDataDir ? readJson(path.join(hubDataDir, NATIVE_FILE), fsModule) : null;
  return {
    lastVersion: d && typeof d.lastVersion === 'string' ? d.lastVersion : '',
    records: d && d.records && typeof d.records === 'object' && !Array.isArray(d.records) ? d.records : {},
  };
}
function writeNativeStore(hubDataDir, store, fsModule = fs) {
  const file = path.join(hubDataDir, NATIVE_FILE);
  fsModule.mkdirSync(hubDataDir, { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fsModule.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fsModule.renameSync(tmp, file);
}
const recordKey = (version, accountDir) => `${String(version || '').trim()}|${norm(accountDir)}`;

// 这个号在这个版本下「会自己加载」的服务名；version 省略时用最近一次学到的版本。
function nativeLoaded({ hubDataDir, accountDir, version, fsModule = fs } = {}) {
  const store = readNativeStore(hubDataDir, fsModule);
  const v = String(version || store.lastVersion || '').trim();
  const rec = v && accountDir ? store.records[recordKey(v, accountDir)] : null;
  const names = rec && rec.names && typeof rec.names === 'object' ? rec.names : {};
  return { version: v, names: Object.keys(names), learnedAt: names };
}

// 写成 --mcp-config 用的文件（内容不变就不重写）；没有可带的返回 null。
// version：本机 CodeAgent 版本（省略时用最近一次学到的）；dedupe=false 关掉去重（只给单测和诊断用）。
function writeMemberMcpConfig({ hubDataDir, fsModule = fs, version, dedupe = true, ...where } = {}) {
  const collected = collectMemberMcpServers({ ...where, fsModule });
  const { sources } = collected;
  const servers = { ...collected.servers };
  const skipped = {};
  if (dedupe && hubDataDir && where.accountDir) {
    const known = nativeLoaded({ hubDataDir, accountDir: where.accountDir, version, fsModule }).names;
    for (const name of Object.keys(servers)) {
      if (known.includes(name) && collected.native.includes(name)) { skipped[name] = servers[name]; delete servers[name]; }
    }
  }
  const names = Object.keys(servers);
  const extra = { sources, skipped: Object.keys(skipped), skippedServers: skipped, servers };
  if (!names.length || !hubDataDir) return { file: null, names, ...extra };
  const body = JSON.stringify({ mcpServers: servers }, null, 2) + '\n';
  const dir = path.join(hubDataDir, 'mcp-profiles');
  const file = path.join(dir, 'codeagent-member-mcp-' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 12) + '.json');
  try {
    fsModule.mkdirSync(dir, { recursive: true });
    let same = false; try { same = fsModule.readFileSync(file, 'utf8') === body; } catch { /* 还没有 */ }
    if (!same) { const tmp = file + '.' + process.pid + '.tmp'; fsModule.writeFileSync(tmp, body, 'utf8'); fsModule.renameSync(tmp, file); }
  } catch (error) { return { file: null, names, ...extra, error: error.message }; }
  return { file, names, ...extra };
}

// ---- 从进程快照里数每个服务起了几份（纯函数）----
const lowSlash = s => String(s || '').replace(/\\/g, '/').replace(/"/g, '').toLowerCase().trim();
const baseName = s => lowSlash(s).split('/').pop().replace(/\.(exe|cmd|bat|ps1)$/, '');
const WRAPPERS = new Set(['cmd']);
const RUNNER_WORDS = new Set(['run', 'tool', 'exec', 'x', 'dlx']);
// 服务配置 → 匹配用的「执行程序名 + 第一个关键参数」（脚本路径或模块名）。认不出关键参数时用程序本身（全路径）。
function mcpMatchKey(cfg) {
  if (!cfg || typeof cfg.command !== 'string' || !cfg.command.trim()) return null;
  let tokens = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args.map(String) : [])];
  // cmd /c npx -y pkg 这种包装：剥掉 cmd 和它的开关，看里面真正跑的
  while (tokens.length > 1 && WRAPPERS.has(baseName(tokens[0]))) {
    tokens = tokens.slice(1);
    while (tokens.length && /^\/[a-z]$/i.test(tokens[0])) tokens = tokens.slice(1);
  }
  if (!tokens.length) return null;
  const runner = baseName(tokens[0]);
  const rest = tokens.slice(1);
  const m = rest.findIndex(a => a === '-m');
  let key = '';
  if (m >= 0 && rest[m + 1]) key = rest[m + 1];
  else key = rest.find(a => !a.startsWith('-') && !RUNNER_WORDS.has(a.toLowerCase())) || '';
  key = lowSlash(key);
  if (!key) key = lowSlash(tokens[0]);
  return runner && key ? { runner, key } : null;
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function cmdMatches(cmd, mk) {
  const c = ' ' + lowSlash(cmd) + ' ';
  if (!c.includes(mk.runner)) return false;
  // 关键参数两边要是边界（空白、斜杠或行首尾），避免 airview 误中 airview-ext
  return new RegExp('[\\s/=]' + escapeRe(mk.key.replace(/^\.\//, '')) + '(?=\\s|\\.(?:exe|cmd|bat)\\s)').test(c);
}
const isServe = p => /(^|\s)serve(\s|$)/i.test(String(p.cmd || '')) && /--config-dir|codeagent/i.test(String(p.cmd || ''));
// snapshot：core/process-inspector.js 的快照；rootPid：会话 PTY 根进程。
// 返回 { serveFound, counts: { 名字: 顶层实例数 } }。只看父进程是 serve 的那一层（uvx → uv → python 这种链只算一次）。
function countServerInstances(servers, snapshot, rootPid) {
  const list = (snapshot && snapshot.processes) || [];
  const byPid = snapshot && snapshot.byPid instanceof Map ? snapshot.byPid : new Map(list.map(p => [p.pid, p]));
  const children = snapshot && snapshot.childrenMap instanceof Map ? snapshot.childrenMap : require('./process-inspector').buildChildrenMap(list);
  const tree = require('./process-inspector').collectTree(Number(rootPid), children);
  const serves = [...tree].map(pid => byPid.get(pid)).filter(p => p && Number(p.pid) !== Number(rootPid) && isServe(p));
  const top = [];
  for (const s of serves) for (const kid of children.get(s.pid) || []) { const p = byPid.get(kid); if (p) top.push(p); }
  const counts = {};
  for (const [name, cfg] of Object.entries(servers || {})) {
    const mk = mcpMatchKey(cfg);
    counts[name] = mk ? top.filter(p => cmdMatches(p.cmd, mk)).length : 0;
  }
  return { serveFound: serves.length > 0, counts };
}

// 学习一次：written = 这次写进 member-mcp 的服务；skipped = 这次因记录跳过的。≥2 份的记下；跳过的 0 份的去掉。
// 返回 { learned, dropped, kept, serveFound, versionChanged, note }，note 是一行人话（写日志用）。
function learnNativeMcp({ hubDataDir, accountDir, version, written = {}, skipped = {}, snapshot, rootPid, now = Date.now(), fsModule = fs } = {}) {
  const v = String(version || '').trim();
  const out = { learned: [], dropped: [], kept: [], serveFound: false, versionChanged: false, note: '' };
  if (!hubDataDir || !accountDir || !v) { out.note = '没有版本号或号目录，不学'; return out; }
  const all = { ...written, ...skipped };
  const { serveFound, counts } = countServerInstances(all, snapshot, rootPid);
  out.serveFound = serveFound;
  if (!serveFound) { out.note = '会话进程树里没找到 CodeAgent 的 serve 进程，这次不学'; return out; }
  const store = readNativeStore(hubDataDir, fsModule);
  const previousVersion = store.lastVersion;
  out.versionChanged = !!previousVersion && previousVersion !== v;
  const key = recordKey(v, accountDir);
  const rec = store.records[key] && typeof store.records[key] === 'object' ? store.records[key] : { names: {} };
  const names = { ...(rec.names && typeof rec.names === 'object' ? rec.names : {}) };
  for (const name of Object.keys(written)) if (counts[name] >= 2 && !names[name]) { names[name] = now; out.learned.push(name); }
  for (const name of Object.keys(skipped)) {
    if (counts[name] >= 1) out.kept.push(name);
    else if (names[name]) { delete names[name]; out.dropped.push(name); }
  }
  const changed = out.learned.length || out.dropped.length || store.lastVersion !== v || !store.records[key];
  if (changed) {
    store.lastVersion = v;
    store.records[key] = { names, updatedAt: now };
    writeNativeStore(hubDataDir, store, fsModule);
  }
  const parts = [];
  if (out.versionChanged) parts.push(`CodeAgent 版本变了（${previousVersion} → ${v}），按新版本重新学`);
  if (out.learned.length) parts.push(`这些插件 CodeAgent 会自己加载、通道配置里又写了一份，各起了 2 份：${out.learned.join('、')}；下个通道会话起不再重复写`);
  if (out.dropped.length) parts.push(`这些插件上次记为会自己加载、这次却一份都没起：${out.dropped.join('、')}；已从记录去掉，下个会话照写`);
  if (!parts.length) parts.push(`没有重复（检查了 ${Object.keys(all).length} 个插件${out.kept.length ? `，其中 ${out.kept.length} 个由 CodeAgent 自己加载` : ''}）`);
  out.note = parts.join('；');
  return out;
}

// 诊断用：最近版本下各号「会自己加载的插件」。accountLabel(dir) 把号目录换成代称（不回路径）。
function describeNativeMcp(hubDataDir, accountLabel = () => '某个号', fsModule = fs) {
  const store = readNativeStore(hubDataDir, fsModule);
  const v = store.lastVersion;
  const out = [];
  for (const [key, rec] of Object.entries(store.records)) {
    const cut = key.indexOf('|');
    if (cut < 0 || key.slice(0, cut) !== v) continue;
    const names = rec && rec.names && typeof rec.names === 'object' ? rec.names : {};
    const list = Object.keys(names);
    if (!list.length) continue;
    const at = Math.max(...Object.values(names).map(Number).filter(Number.isFinite));
    out.push({ account: accountLabel(key.slice(cut + 1)), names: list, learnedAt: at || null,
      text: `会自己加载的插件：${list.join('、')}（学习于 ${at ? new Date(at).toLocaleString('zh-CN', { hour12: false }) : '未知时间'}）` });
  }
  return { version: v, accounts: out };
}

module.exports = { collectMemberMcpServers, writeMemberMcpConfig, nativeLoaded, readNativeStore, mcpMatchKey, countServerInstances, learnNativeMcp, describeNativeMcp, NATIVE_FILE };
