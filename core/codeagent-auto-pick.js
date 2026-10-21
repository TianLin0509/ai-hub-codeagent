'use strict';
// 自动会话（通道、公司助理、论坛）启动时的自动选模型：什么时候不开菜单、连续失败后熔断。
// 熔断（2026-10-21 同事公司 Hub 3.0.1：13 次自动选模型全失败，每次都耽误发问题）：
// 同一账号的自动会话连续 3 次在 /model 菜单里没选成，之后 4 小时这个号的自动会话不再开菜单，直接发问题；
// 任何一次在这个号上选成功就清零。记在数据目录里：Hub 一天重启好几次，内存里的计数会丢。
// 只管自动会话（通道、公司助理、论坛）的启动选型；用户在界面上明确换模型照常走菜单。
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'codeagent-pick-breaker.json';
const THRESHOLD = 3;
const OPEN_MS = 4 * 3600 * 1000;

const fileOf = dataDir => path.join(dataDir, FILE);
function read(dataDir, fsModule = fs) {
  if (!dataDir) return {};
  try {
    const value = JSON.parse(fsModule.readFileSync(fileOf(dataDir), 'utf8').replace(/^﻿/, ''));
    return value && typeof value === 'object' && value.accounts && typeof value.accounts === 'object' ? value.accounts : {};
  } catch { return {}; }
}
function write(dataDir, accounts, fsModule = fs) {
  if (!dataDir) return;
  const file = fileOf(dataDir), temp = `${file}.${process.pid}.tmp`;
  try {
    fsModule.mkdirSync(dataDir, { recursive: true });
    fsModule.writeFileSync(temp, JSON.stringify({ accounts }, null, 2) + '\n', 'utf8');
    fsModule.renameSync(temp, file);
  } catch { try { fsModule.unlinkSync(temp); } catch {} }
}
const keyOf = account => String(account || 'personal');

// 这个号此刻是否熔断中。返回 null 或 { failures, since, until, lastError }。
function openFor(dataDir, account, { now = Date.now(), fsModule = fs } = {}) {
  const entry = read(dataDir, fsModule)[keyOf(account)];
  if (!entry || !(Number(entry.until) > now)) return null;
  return { failures: Number(entry.failures) || 0, since: Number(entry.since) || null, until: Number(entry.until), lastError: String(entry.lastError || '') };
}

// 记一次自动选模型的结果。返回 { failures, opened, until }：opened 表示这一次刚好触发熔断。
function record(dataDir, account, ok, { error = '', now = Date.now(), fsModule = fs } = {}) {
  const accounts = read(dataDir, fsModule);
  const key = keyOf(account);
  if (ok) {
    if (accounts[key]) { delete accounts[key]; write(dataDir, accounts, fsModule); }
    return { failures: 0, opened: false, until: null };
  }
  const before = accounts[key] || {};
  // 熔断到期后重新计数：到期后的第一次失败从 1 开始，不会因为旧计数立刻再熔断。
  const expired = Number(before.until) > 0 && Number(before.until) <= now;
  const failures = (expired ? 0 : Number(before.failures) || 0) + 1;
  const opened = failures >= THRESHOLD && !(Number(before.until) > now);
  const until = opened ? now + OPEN_MS : (expired ? null : Number(before.until) || null);
  accounts[key] = { failures, lastAt: now, lastError: String(error || '').slice(0, 200),
    ...(until ? { until, since: opened ? now : Number(before.since) || now } : {}) };
  write(dataDir, accounts, fsModule);
  return { failures, opened, until };
}

// 诊断用：所有号的计数与熔断状态（到期的不算熔断中）。
function snapshot(dataDir, { now = Date.now(), fsModule = fs } = {}) {
  const out = {};
  for (const [key, entry] of Object.entries(read(dataDir, fsModule))) {
    const open = Number(entry.until) > now;
    out[key] = { failures: Number(entry.failures) || 0, open, ...(open ? { until: Number(entry.until) } : {}), lastError: String(entry.lastError || '').slice(0, 120) };
  }
  return out;
}

const eq = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// 自动会话启动时要不要开 /model 菜单。返回 null（照常选）或 { reason, note }（跳过、直接发问题）。
//   - breaker：这个号熔断中（连续 3 次没选成）；
//   - resume-same-model：休眠后恢复的会话，上一轮实际作答的就是目标模型（号池号）；
//   - account-default：家里没指定模型，号池号配置里写的默认模型就是目标模型。
// 个人账号只认熔断，不按配置跳过：公司真机 Q-1020-14 里个人号启动后被写回 deepseek（配置里写的不可信），
// 只有菜单选择确定管用（core/session-manager.js 自动会话选型处的注释）。
function skipReason({ dataDir, account, isPool, target, routeModel = '', freshLaunch, actualModel = '', writtenModel = '', now = Date.now(), fsModule = fs } = {}) {
  if (!target) return null;
  const open = openFor(dataDir, account, { now, fsModule });
  if (open) {
    return { reason: 'breaker', note: `这个号连续 ${open.failures} 次自动选模型没成功，${new Date(open.until).toLocaleString('zh-CN', { hour12: false })} 前不再自动选，直接发问题` };
  }
  if (!isPool) return null;
  if (!freshLaunch && eq(actualModel, target)) return { reason: 'resume-same-model', note: `恢复的会话上一轮就是 ${target} 作答，不再选模型` };
  if (freshLaunch && !routeModel && eq(writtenModel, target)) return { reason: 'account-default', note: `号的默认模型就是 ${target}，家里也没指定模型，不开模型菜单` };
  return null;
}

module.exports = { openFor, record, snapshot, skipReason, THRESHOLD, OPEN_MS, FILE };
