'use strict';
// CodeAgent 配置目录默认模型（settings.json 的 model）的看护与留痕（2026-10-19 公司真机：Hub 重开、恢复个人号会话的同一秒，
// 个人目录 ~/.cac/settings.json 的 model 从刚改好的 GLM-5.2-WX-Auto 变回 deepseek-v4-flash-0731，随后两个会话报模型不存在）。
//
// 会改这份文件的只有三类：
//   1. CodeAgent 自己：/model 菜单按回车把选择存成默认模型（Hub 驱动菜单时事后改回，core/codeagent-model-picker.js guardDefaults）；
//      其他由 CodeAgent 内部触发的写入 Hub 看不到原因，只能看到结果；
//   2. Hub 的模型菜单驱动改回原值（来源 picker:<原因>）；
//   3. 经授权的远程维护 set-personal-model（来源 remote:set-personal-model，core/codeagent-personal-model.js）。
// 这里不自动改个人账号的配置，只做两件事：
//   - 每一次 model 变化记一行到 logs/codeagent-model.log：会话、账号代称、写前、写后、来源；Hub 自己写的按登记认来源，
//     认不出的记 external，并带上前后 20 秒内启动的 CodeAgent 会话（恢复的带 --resume），方便判断是谁写的；
//   - 最近一次变化落盘（logs/codeagent-settings-state.json），直查的个人号行据此报「settings 最近一次被改写的来源」。
const fs = require('fs');
const path = require('path');

const STATE_FILE = 'codeagent-settings-state.json';
const HUB_WRITE_WINDOW_MS = 15000;
const LAUNCH_WINDOW_MS = 20000;

function logsDir(dataDir) { return path.join(dataDir, 'logs'); }
function readModel(file, fsModule = fs) {
  try {
    const value = JSON.parse(fsModule.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return { exists: true, model: value && typeof value.model === 'string' ? value.model : '' };
  } catch (error) { return { exists: !(error && error.code === 'ENOENT'), model: '', unreadable: !(error && error.code === 'ENOENT') }; }
}
function sameDir(a, b) {
  const norm = d => require('./codeagent-model-picker').normalizeConfigDir(d).replace(/[\\/]+$/, '');
  const x = norm(a), y = norm(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// 会话属于哪个账号：号池号用固定代称（号 N），其余是个人。
function accountOf(session, dataDir) {
  const id = session && session.codeagentPoolAccount;
  if (!id) return { key: 'personal', alias: '个人' };
  let alias = '';
  try { alias = require('./codeagent-quota').aliasMap(dataDir).get(id) || ''; } catch { alias = ''; }
  return { key: id, alias: alias || '号池' };
}

// 会话的 CodeAgent 实际用的配置目录：启动时记下的那个；老会话没记时按账号推出来（号池号的目录 / 个人目录）。
function sessionConfigDir(session, { dataDir, env = process.env } = {}) {
  if (session && session.codeagentConfigDir) return String(session.codeagentConfigDir);
  if (session && session.codeagentPoolAccount && dataDir) {
    try { return require('./codeagent-pool').accountDir(dataDir, session.codeagentPoolAccount); } catch { return ''; }
  }
  try { return require('./codeagent-config').resolveCodeAgentConfig(env).configDir; } catch { return ''; }
}

// 账号的模型权限清单：个人账号优先用「获取模型权限」的探测文件，号池号用自己目录里的；authoritative=false 时调用方不拦。
function permittedModels(session, dir, { dataDir } = {}) {
  const pool = require('./codeagent-pool');
  try {
    const personal = !(session && session.codeagentPoolAccount);
    const known = pool.accountModels(dir, fs, personal && dataDir ? pool.personalModelsFile(dataDir) : null);
    return { models: (known.models || []).slice(), authoritative: !!known.authoritative };
  } catch { return { models: [], authoritative: false }; }
}

// ---------------------------------------------------------------- Hub 自己的写入登记
// Hub 改这份文件前登记一下（目录、写后的值、来源），看护发现变化时据此认出是 Hub 写的。
const hubWrites = [];
// logged=true：调用方自己会记这一行日志，看护看到时只更新「最近一次变化」，不重复记。
function noteHubWrite(dir, model, source, { now = Date.now(), logged = false, session = '' } = {}) {
  hubWrites.push({ dir, model: model == null ? '' : String(model), source: String(source || 'hub'), at: now, logged: !!logged, session });
  while (hubWrites.length > 50) hubWrites.shift();
}
function hubWriteFor(dir, model, now = Date.now()) {
  for (let i = hubWrites.length - 1; i >= 0; i -= 1) {
    const w = hubWrites[i];
    if (now - w.at > HUB_WRITE_WINDOW_MS) continue;
    if (w.model === String(model || '') && sameDir(w.dir, dir)) return w;
  }
  return null;
}

// 前后 LAUNCH_WINDOW_MS 内启动的 CodeAgent 会话（读 codeagent-model.log 里的 launch 行）。
function launchesNear(dataDir, at, { fsModule = fs } = {}) {
  let text = '';
  try {
    const file = path.join(logsDir(dataDir), 'codeagent-model.log');
    const stat = fsModule.statSync(file);
    const fd = fsModule.openSync(file, 'r');
    try {
      const size = Math.min(stat.size, 64 * 1024);
      const buffer = Buffer.alloc(size);
      fsModule.readSync(fd, buffer, 0, size, stat.size - size);
      text = buffer.toString('utf8');
    } finally { fsModule.closeSync(fd); }
  } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\S+) event=launch (.*)$/);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!Number.isFinite(t) || Math.abs(t - at) > LAUNCH_WINDOW_MS) continue;
    const field = name => ((m[2].match(new RegExp(`(?:^| )${name}=(\\S+)`)) || [])[1] || '');
    out.push(`${field('session') || '?'}${field('account') ? '@' + field('account') : ''}${field('resume') ? '(' + field('resume') + ')' : ''}${t > at ? '+' : '-'}${Math.round(Math.abs(t - at) / 1000)}s`);
  }
  return out.slice(-6);
}

// ---------------------------------------------------------------- 落盘的最近一次变化
function readState(dataDir, fsModule = fs) {
  try { const v = JSON.parse(fsModule.readFileSync(path.join(logsDir(dataDir), STATE_FILE), 'utf8')); return v && typeof v === 'object' ? v : null; }
  catch { return null; }
}
function writeState(dataDir, state, fsModule = fs) {
  try {
    fsModule.mkdirSync(logsDir(dataDir), { recursive: true });
    const file = path.join(logsDir(dataDir), STATE_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fsModule.writeFileSync(tmp, JSON.stringify({ schema: 1, ...state }, null, 2) + '\n', 'utf8');
    try { fsModule.renameSync(tmp, file); } catch { fsModule.renameSync(tmp, file); }
  } catch { /* 记不下不影响 Hub */ }
}
// 直查用：{ at, model, before, source, session, launches }（没记录返回 null）。
function lastChange(dataDir, fsModule = fs) {
  const s = readState(dataDir, fsModule);
  return s && s.lastChange ? s.lastChange : null;
}

// 记一行默认模型变化（写前、写后、来源），并更新最近一次变化。
function recordChange(dataDir, { account = '个人', session = '', before = '', after = '', source = 'external', at = Date.now(), mtime = null, launches = [], extra = {} } = {}, { persist = true, log = true } = {}) {
  const models = require('./codeagent-models');
  if (log) models.appendModelLog(dataDir, { event: 'default-model', account, session: session || undefined, before: before || '(空)', after: after || '(空)', source,
    ...(mtime ? { mtime: new Date(mtime).toISOString() } : {}), ...(launches.length ? { near: launches.join(',') } : {}), ...extra });
  if (persist) {
    const state = readState(dataDir) || {};
    writeState(dataDir, { ...state, model: after, lastChange: { at: new Date(at).toISOString(), ...(mtime ? { mtime: new Date(mtime).toISOString() } : {}), account, before, after, source, ...(session ? { session } : {}), ...(launches.length ? { launches } : {}) } });
  }
}

// ---------------------------------------------------------------- 看护个人账号的 settings.json
// 轮询文件的修改时间（fs.watchFile，默认 3 秒一次，不占事件循环）；Hub 启动时先和上次记下的值比一次（Hub 没在跑时被改的也能看到）。
function watchPersonal({ dataDir, dir, intervalMs = 3000, fsModule = fs, now = () => Date.now() } = {}) {
  if (!dataDir || !dir) return { stop() {}, check() {} };
  const file = path.join(dir, 'settings.json');
  let known = readModel(file, fsModule);
  const state = readState(dataDir, fsModule);
  if (state && typeof state.model === 'string' && known.exists && !known.unreadable && state.model !== known.model) {
    let mtime = null; try { mtime = fsModule.statSync(file).mtimeMs; } catch { mtime = null; }
    recordChange(dataDir, { before: state.model, after: known.model, source: 'external-while-hub-not-watching', mtime, at: now() });
  } else if (!state || typeof state.model !== 'string') {
    writeState(dataDir, { ...(state || {}), model: known.model });
  }
  const check = () => {
    const current = readModel(file, fsModule);
    if (current.unreadable || current.model === known.model) return;
    let mtime = null; try { mtime = fsModule.statSync(file).mtimeMs; } catch { mtime = null; }
    const at = now();
    const hub = hubWriteFor(dir, current.model, at);
    recordChange(dataDir, { before: known.model, after: current.model, source: hub ? hub.source : 'external', mtime, at, session: hub ? hub.session : '',
      launches: hub ? [] : launchesNear(dataDir, mtime || at, { fsModule }) }, { log: !(hub && hub.logged) });
    known = current;
  };
  const listener = () => { try { check(); } catch { /* 看护失败不影响 Hub */ } };
  try { fsModule.watchFile(file, { interval: intervalMs, persistent: false }, listener); } catch { /* 不支持就只在启动时比一次 */ }
  return { stop() { try { fsModule.unwatchFile(file, listener); } catch {} }, check };
}

module.exports = { accountOf, sessionConfigDir, permittedModels, noteHubWrite, hubWriteFor, launchesNear, recordChange, lastChange, readState, watchPersonal, sameDir, STATE_FILE };
