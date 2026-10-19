'use strict';
// 「规则」页的数据层（2026-10-12）。Hub 里所有 Agent 默认带上的规则分两层：
//   通用规则：在服务器上统一发布，本地只读、可整体关闭。用户点「检查更新」才去拉，
//            拉到新版立即生效（之后每个会话的下一条消息带上新版）；随 Hub 内置第一版，离线也能用。
//   我的规则：本机有个人基础规则（~/.agents/USER_CONTEXT.md）时就是它，Hub 原本就把它写进
//            各 CLI 的规则文件（core/agent-user-context.js），这里只负责查看和编辑；
//            没有时是数据目录里的 hub-rules/mine.md，和通用规则一起随会话的第一条消息送达。
// 只拉一个 JSON 和一个 Markdown，不执行任何下载内容；正文校验 sha256 与大小后才落盘。
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

// 服务器地址是公开的（2026-10-12 确认公开版也从这里拉）；测试用 AI_HUB_RULES_BASE_URL 改到本机。
const DEFAULT_BASE_URL = 'https://me.lt-stockpartner.tech/hub-rules/';
const CHANNELS = new Set(['public', 'company']);
const OFFICIAL_LIMIT = 64 * 1024;
const MINE_LIMIT = 32 * 1024;
const KEEP_VERSIONS = 5;
const FETCH_TIMEOUT_MS = 10000;
// 有自己固定人设和回复格式的内部会话不带通用规则。
const SKIP_PURPOSES = new Set(['memory-dream', 'writing', 'hub-assistant', 'hub-photo-assistant', 'xresearch-research']);
// 会话场景（scene-<id>，core/session-scenes.js）的系统提示自成一套，也不带通用规则
const skipsHubRules = purpose => SKIP_PURPOSES.has(purpose) || /^scene-./.test(String(purpose || ''));
const PREAMBLE = label => `以下是 AI Hub 默认带上的规则（${label}，可在 Hub 左侧「规则」页查看或关闭），作为默认工作方式，不覆盖用户本次的明确要求和项目规则。`;
const BUILTIN = Object.freeze({ version: 1, notes: '第一版（随 Hub 内置）', publishedAt: '2026-10-12', file: path.join(__dirname, 'hub-rules-default.md') });

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

// 逐行对比（最长公共子序列）。规则文件只有几百行，O(n·m) 足够；超过上限就只报行数差。
function lineDiff(before, after) {
  const a = String(before || '').replace(/\r\n?/g, '\n').split('\n');
  const b = String(after || '').replace(/\r\n?/g, '\n').split('\n');
  if (a.length * b.length > 4e6) return { added: b.length, removed: a.length, rows: null };
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = []; let i = 0, j = 0, added = 0, removed = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { rows.push({ type: 'same', text: a[i] }); i++; j++; }
    else if (j < b.length && (i >= a.length || dp[i][j + 1] >= dp[i + 1][j])) { rows.push({ type: 'add', text: b[j++] }); added++; }
    else { rows.push({ type: 'del', text: a[i++] }); removed++; }
  }
  return { added, removed, rows };
}

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  try {
    // Electron 的 net.fetch 走系统代理（见 core/claude-model-discovery.js 的说明）；纯 Node 回落全局 fetch。
    const electron = require('electron');
    if (electron && electron.net && typeof electron.net.fetch === 'function') return (...args) => electron.net.fetch(...args);
  } catch (_) {}
  return globalThis.fetch;
}

function createHubRulesStore(options = {}) {
  const env = options.env || process.env;
  const dataDir = options.dataDir;
  if (!dataDir) throw new Error('缺少 Hub 数据目录');
  const root = path.join(dataDir, 'hub-rules');
  const stateFile = path.join(root, 'state.json');
  const mineFile = path.join(root, 'mine.md');
  const channel = CHANNELS.has(options.channel) ? options.channel : 'public';
  const baseUrl = String(env.AI_HUB_RULES_BASE_URL || options.baseUrl || DEFAULT_BASE_URL).replace(/\/?$/, '/');
  const builtinFile = options.builtinFile || BUILTIN.file;
  const loadPersonal = options.loadPersonal || (() => require('./agent-user-context').loadUserContext(env, dataDir));
  const runSync = options.runSync || defaultRunSync;
  let checking = null;

  // 内置文件经 git 检出可能变成 CRLF；服务器统一存 LF、去 BOM。按同一口径算校验值，同一版才认得出来。
  function readBuiltin() {
    return fs.readFileSync(builtinFile, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  }
  function builtin() {
    const text = readBuiltin();
    return { version: BUILTIN.version, notes: BUILTIN.notes, publishedAt: BUILTIN.publishedAt, sha256: sha256(text), bytes: Buffer.byteLength(text), source: 'builtin' };
  }
  function readState() {
    const state = readJSON(stateFile, {});
    return { schema: 1, enabled: typeof state.enabled === 'boolean' ? state.enabled : null, active: state.active || null, previous: state.previous || null, lastCheck: state.lastCheck || null };
  }
  function saveState(state) { writeAtomic(stateFile, JSON.stringify(state, null, 2) + '\n'); }
  function versionFile(version) { return path.join(root, 'official', `v${version}.md`); }
  function textOf(record) {
    if (!record) return null;
    if (record.source === 'builtin') return readBuiltin();
    const text = fs.readFileSync(versionFile(record.version), 'utf8');
    if (sha256(text) !== record.sha256) throw new Error(`本地缓存的通用规则 v${record.version} 校验不一致，请重新检查更新`);
    return text;
  }
  // 内置版本比已下载的新（Hub 升级自带了新一版）时以内置为准；否则用已下载的版本。
  function effective(state) {
    const shipped = builtin();
    if (!state.active || state.active.version < shipped.version) return shipped;
    return state.active;
  }
  function personal() {
    try { return { context: loadPersonal(), error: null }; }
    catch (error) { return { context: null, error: error.message }; }
  }
  function enabledFor(state, hasPersonal) {
    // 默认开；本机已有个人基础规则时默认关，避免同类内容重复注入。用户一旦手动切换就以手动为准。
    return state.enabled === null ? !hasPersonal : state.enabled;
  }
  function readMine() {
    try { return fs.readFileSync(mineFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
  }

  function snapshot() {
    const state = readState();
    const { context, error } = personal();
    const active = effective(state);
    let text = null, textError = null;
    try { text = textOf(active); } catch (e) { textError = e.message; }
    let previousText = null;
    try { previousText = textOf(state.previous); } catch (_) {}
    const mine = context
      ? { mode: 'personal', path: context.source, text: context.content, sha: sha256(context.content), syncScript: syncScriptPath(context.home), error }
      : { mode: 'local', path: mineFile, text: readMine(), sha: sha256(readMine()), error };
    return {
      channel, url: `${baseUrl}${channel}/latest.json`,
      official: { ...active, text, textError, enabled: enabledFor(state, !!context), enabledIsDefault: state.enabled === null, previous: state.previous, previousText, lastCheck: state.lastCheck },
      mine,
    };
  }

  function setEnabled(on) {
    const state = readState();
    state.enabled = !!on;
    saveState(state);
    return snapshot();
  }

  async function fetchJSON(url, fetchImpl) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' });
    if (!response || !response.ok) throw new Error(`服务器返回 ${response ? response.status : '无响应'}`);
    return JSON.parse(await response.text());
  }
  async function fetchText(url, fetchImpl) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' });
    if (!response || !response.ok) throw new Error(`服务器返回 ${response ? response.status : '无响应'}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > OFFICIAL_LIMIT) throw new Error('服务器上的规则超过 64 KB，未采用');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return text;
  }
  function validLatest(latest) {
    if (!latest || latest.schema !== 1) throw new Error('服务器返回的版本信息格式不认识');
    if (latest.channel !== channel) throw new Error(`服务器返回的是「${latest.channel}」频道，不是本机的「${channel}」`);
    if (!Number.isInteger(latest.version) || latest.version < 1) throw new Error('服务器返回的版本号无效');
    if (!/^[a-f0-9]{64}$/.test(String(latest.sha256 || ''))) throw new Error('服务器返回的校验值无效');
    if (latest.md !== `v/${latest.version}.md`) throw new Error('服务器返回的正文地址不符合约定');
    if (!Number.isInteger(latest.bytes) || latest.bytes < 1 || latest.bytes > OFFICIAL_LIMIT) throw new Error('服务器上的规则大小不在允许范围');
    return latest;
  }

  async function checkUpdate() {
    if (checking) return checking;
    checking = (async () => {
      const state = readState();
      const current = effective(state);
      const at = new Date().toISOString();
      try {
        const fetchImpl = resolveFetch(options.fetchImpl);
        if (typeof fetchImpl !== 'function') throw new Error('运行环境不能联网');
        const latest = validLatest(await fetchJSON(`${baseUrl}${channel}/latest.json`, fetchImpl));
        if (latest.version < current.version || (latest.version === current.version && latest.sha256 === current.sha256)) {
          const message = latest.version < current.version ? `本机的 v${current.version} 比服务器上的 v${latest.version} 新，保持不变` : `已是最新：v${current.version}`;
          state.lastCheck = { at, ok: true, latestVersion: latest.version, message };
          saveState(state);
          return { updated: false, message: state.lastCheck.message, snapshot: snapshot() };
        }
        if (latest.version === current.version) throw new Error(`服务器上的 v${latest.version} 和本机同号但内容不同，未采用`);
        const text = await fetchText(`${baseUrl}${channel}/${latest.md}`, fetchImpl);
        if (Buffer.byteLength(text) !== latest.bytes || sha256(text) !== latest.sha256) throw new Error('下载的规则校验不一致（可能传输出错），未采用，可稍后再试');
        if (!text.trim()) throw new Error('服务器上的规则为空，未采用');
        writeAtomic(versionFile(latest.version), text);
        const record = { version: latest.version, notes: String(latest.notes || '').slice(0, 500), publishedAt: String(latest.published_at || ''), sha256: latest.sha256, bytes: latest.bytes, source: 'cloud', installedAt: at };
        const before = textOf(current);
        state.previous = current;
        state.active = record;
        state.lastCheck = { at, ok: true, latestVersion: latest.version, message: `已更新到 v${latest.version}` };
        saveState(state);
        pruneVersions(state);
        const diff = lineDiff(before, text);
        return { updated: true, from: current.version, to: latest.version, notes: record.notes, added: diff.added, removed: diff.removed, message: state.lastCheck.message, snapshot: snapshot() };
      } catch (error) {
        const reason = error && error.name === 'TimeoutError' ? '连接服务器超时（10 秒）' : (error && error.message) || String(error);
        state.lastCheck = { at, ok: false, message: `检查失败：${reason}；继续使用 v${current.version}` };
        saveState(state);
        return { updated: false, failed: true, message: state.lastCheck.message, snapshot: snapshot() };
      }
    })();
    try { return await checking; } finally { checking = null; }
  }

  function pruneVersions(state) {
    const keep = new Set([state.active, state.previous].filter(r => r && r.source === 'cloud').map(r => `v${r.version}.md`));
    const dir = path.join(root, 'official');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^v\d+\.md$/.test(f)) : [];
    files.sort((x, y) => Number(y.slice(1, -3)) - Number(x.slice(1, -3)));
    files.slice(KEEP_VERSIONS).filter(f => !keep.has(f)).forEach(f => fs.unlinkSync(path.join(dir, f)));
  }

  function rollback() {
    const state = readState();
    if (!state.previous) throw new Error('没有可以回到的上一版');
    const current = effective(state);
    textOf(state.previous);
    state.active = state.previous;
    state.previous = current;
    state.lastCheck = { at: new Date().toISOString(), ok: true, latestVersion: state.lastCheck?.latestVersion ?? null, message: `已回到 v${state.active.version}；再点「检查更新」会重新拉最新版` };
    saveState(state);
    return snapshot();
  }

  function saveMine({ text, baseSha }) {
    if (typeof text !== 'string') throw new Error('规则内容无效');
    const { context } = personal();
    if (context) {
      if (baseSha !== sha256(context.content)) throw new Error('规则文件在别处被改过，请先点「重新载入」再改');
      if (!text.trim()) throw new Error('个人基础规则不能为空');
      if (Buffer.byteLength(text) > 32768) throw new Error('个人基础规则超过 32 KB，请先精简');
      // 保持原文件的换行风格；改之前先备份一份。
      const normalized = text.replace(/\r\n?/g, '\n');
      const output = /\r\n/.test(context.content) ? normalized.replace(/\n/g, '\r\n') : normalized;
      const backup = path.join(context.home, '.agents', 'context-backups', 'hub', `USER_CONTEXT-${stamp()}.md`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.copyFileSync(context.source, backup);
      writeAtomic(context.source, output);
      const sync = runSync(context.home);
      return { backup, sync, snapshot: snapshot() };
    }
    const current = readMine();
    if (baseSha !== sha256(current)) throw new Error('规则文件在别处被改过，请先点「重新载入」再改');
    if (Buffer.byteLength(text) > MINE_LIMIT) throw new Error('我的规则超过 32 KB，请先精简');
    if (current) {
      const backup = path.join(root, 'backups', `mine-${stamp()}.md`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.writeFileSync(backup, current, 'utf8');
    }
    writeAtomic(mineFile, text);
    return { backup: null, sync: null, snapshot: snapshot() };
  }

  // 随第一条消息送达的内容。个人基础规则已由原机制写进各 CLI，这里不重复。
  function injection() {
    const state = readState();
    const { context } = personal();
    const parts = [];
    if (enabledFor(state, !!context)) {
      const active = effective(state);
      try { parts.push({ label: `通用规则 v${active.version}`, version: active.version, content: textOf(active).trim() }); }
      catch (_) { /* 缓存坏了就不送，规则页会提示重新检查更新 */ }
    }
    if (!context) {
      const mine = readMine().trim();
      if (mine) parts.push({ label: '我的规则', content: mine });
    }
    if (!parts.length) return null;
    const content = parts.map(p => `【${p.label}】\n${p.content}`).join('\n\n');
    return { content, label: parts.map(p => p.label).join(' + '), version: sha256(content) };
  }

  // Claude 启动时用 --append-system-prompt-file 读的文件。按内容命名、写后不改，
  // 多个会话同时启动也互不干扰；目录只留最近 20 份。
  // extra：某类会话额外带的一段（自动派活会话的规则，core/auto-dispatch-rules.js）。带了就按整份内容的校验值命名；
  // rules 可以为空（规则页全关时，这类会话仍带那一段）。
  function systemPromptFile(rules, { extra = null } = {}) {
    const dir = path.join(root, 'system');
    const parts = [];
    if (rules) parts.push(`${PREAMBLE(rules.label)}\n\n${rules.content}`);
    if (extra && extra.text) parts.push(String(extra.text).trim());
    if (!parts.length) throw new Error('没有要写进系统提示的内容');
    const body = parts.join('\n\n') + '\n';
    const key = extra && extra.text ? sha256(body) : rules.version;
    const file = path.join(dir, `rules-${key.slice(0, 16)}.md`);
    if (!fs.existsSync(file)) {
      writeAtomic(file, body);
      const files = fs.readdirSync(dir).filter(f => /^rules-[0-9a-f]{16}\.md$/.test(f))
        .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      files.slice(20).forEach(({ f }) => { try { fs.unlinkSync(path.join(dir, f)); } catch (_) {} });
    }
    return file;
  }
  // 「发送内容」面板读回某个会话启动时写进系统提示的那一版；文件被轮换清掉了就返回 null。
  function systemPromptText(version) {
    if (!/^[0-9a-f]{16,64}$/.test(String(version || ''))) return null;
    try { return fs.readFileSync(path.join(root, 'system', `rules-${String(version).slice(0, 16)}.md`), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function isSystemPromptFile(file) {
    if (!file) return false;
    const rel = path.relative(path.join(root, 'system'), path.resolve(String(file)));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  return { snapshot, setEnabled, checkUpdate, rollback, saveMine, injection, systemPromptFile, systemPromptText, isSystemPromptFile, channel, baseUrl, root };
}

function syncScriptPath(home) {
  const file = path.join(home, '.agents', 'sync-user-context.py');
  return fs.existsSync(file) ? file : null;
}
// 有同步脚本（作者本机）就跑一次，把新规则复制到各 CLI 的规则文件；没有就交给 Hub 下次启动会话时写入。
function defaultRunSync(home) {
  const script = syncScriptPath(home);
  if (!script) return { ran: false, ok: true, message: '已保存；下次新开会话时 Hub 会写进各 CLI' };
  const { spawnSync } = require('node:child_process');
  const result = spawnSync('python', [script, '--apply'], { cwd: path.dirname(script), encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim().split(/\r?\n/).slice(-6).join('\n');
  if (result.error) return { ran: true, ok: false, message: `同步脚本没能运行：${result.error.message}` };
  return { ran: true, ok: result.status === 0, message: result.status === 0 ? '已保存并同步到各 CLI' : `已保存，但同步脚本报错（退出码 ${result.status}）`, output };
}

module.exports = { createHubRulesStore, lineDiff, SKIP_PURPOSES, skipsHubRules, PREAMBLE, DEFAULT_BASE_URL, OFFICIAL_LIMIT, MINE_LIMIT, sha256 };
