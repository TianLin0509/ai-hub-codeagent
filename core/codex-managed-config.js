'use strict';

// Hub 自己生成的 Codex home（DeepSeek、API 模式）每次启动都要按当前设置重写
// config.toml。以前是整份覆盖，Codex 自己写下的东西一起被抹掉：用户在 /hooks
// 审核页点的信任（[hooks.state.*]）、[tui] 等，下次启动又得重新审核。
//
// 这里只接管 Hub 生成文本里出现过的顶层键（根上的键和表头的第一段，例如
// model、notice、windows、model_providers、projects），旧文件里其余顶层键下的
// 表和键值原文保留，接在 Hub 内容之后。写盘前做语义比对：新文件必须能解析，
// 且等于「Hub 内容 + 保留下来的旧内容」；任何一步失败都退回只写 Hub 内容
// （即以前的行为），保证 config.toml 不会被写坏。

const fs = require('fs');
const path = require('path');
const { scanTomlStatements } = require('./toml-statements');

function deepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function topKeyOf(statement) {
  return statement.path[0];
}

/**
 * @param {string} oldText 现有 config.toml 原文（不存在时传空串）
 * @param {string} hubText Hub 本次生成的完整内容
 * @param {{parse?: (text: string) => object}} opts parse 用于写盘前语义比对
 * @returns {{text: string, preserved: string[], warning: string|null}}
 */
function mergeHubManagedCodexConfig(oldText, hubText, { parse = null } = {}) {
  const base = { text: hubText, preserved: [], warning: null };
  const old = String(oldText || '');
  if (!old.trim()) return base;
  let hubScan, oldScan;
  try { hubScan = scanTomlStatements(hubText); }
  catch (error) { return { ...base, warning: `Hub 生成的 config.toml 无法识别：${error.message}` }; }
  try { oldScan = scanTomlStatements(old); }
  catch (error) { return { ...base, warning: `现有 config.toml 无法识别，按 Hub 默认重写：${error.message}` }; }

  const owned = new Set(hubScan.statements.map(topKeyOf));
  const oldLines = old.split(/\r?\n/);
  const rootKeep = [];
  const tableKeep = [];
  const statements = oldScan.statements;
  const firstTableAt = statements.findIndex(s => s.kind !== 'kv');
  const rootStatements = firstTableAt < 0 ? statements : statements.slice(0, firstTableAt);
  for (const s of rootStatements) {
    if (owned.has(topKeyOf(s))) continue;
    rootKeep.push(...oldLines.slice(s.startLine, s.endLine + 1));
  }
  if (firstTableAt >= 0) {
    // 每个表头连同它到下一个表头之前的全部行（键值、注释、空行）作为一个整体去留。
    const headers = statements.map((s, i) => ({ s, i })).filter(({ s }) => s.kind !== 'kv');
    headers.forEach(({ s }, n) => {
      if (owned.has(topKeyOf(s))) return;
      const next = headers[n + 1];
      const end = next ? next.s.startLine : oldLines.length;
      const block = oldLines.slice(s.startLine, end);
      while (block.length && !block[block.length - 1].trim()) block.pop();
      if (tableKeep.length) tableKeep.push('');
      tableKeep.push(...block);
    });
  }
  if (!rootKeep.length && !tableKeep.length) return base;

  const preserved = [...new Set(statements.filter(s => !owned.has(topKeyOf(s))).map(topKeyOf))];
  const hubLines = String(hubText).replace(/\r?\n$/, '').split(/\r?\n/);
  const hubFirstTable = hubScan.statements.find(s => s.kind !== 'kv');
  const insertAt = hubFirstTable ? hubFirstTable.startLine : hubLines.length;
  const head = hubLines.slice(0, insertAt);
  while (head.length && !head[head.length - 1].trim()) head.pop();
  const tail = hubLines.slice(insertAt);
  const out = [...head, ...rootKeep];
  if (tail.length) out.push('', ...tail);
  if (tableKeep.length) {
    while (out.length && !out[out.length - 1].trim()) out.pop();
    out.push('', ...tableKeep);
  }
  const text = out.join('\n') + '\n';

  if (parse) {
    try {
      const oldDoc = parse(old);
      const hubDoc = parse(hubText);
      const newDoc = parse(text);
      const expected = { ...hubDoc };
      for (const key of Object.keys(oldDoc)) if (!owned.has(key)) expected[key] = oldDoc[key];
      if (!deepEqual(newDoc, expected)) throw new Error('合并后的语义与预期不一致');
    } catch (error) {
      return { ...base, warning: `保留 config.toml 原有设置失败，按 Hub 默认重写：${error.message}` };
    }
  }
  return { text, preserved, warning: null };
}

function defaultParse() {
  const { parseTomlWithPython, parseTomlStructural } = require('./codex-hook-integration');
  return require('./hook-runner').hookRunner().name === 'python' ? parseTomlWithPython : parseTomlStructural;
}

/**
 * 写 Hub 管理的 config.toml：保留非 Hub 顶层键，内容不变时不写盘。
 * opts.parseToml 可注入解析器（测试用）；opts.logger 接收降级提示。
 */
function writeHubManagedCodexConfig(configPath, hubText, opts = {}) {
  let oldText = '';
  try { oldText = fs.readFileSync(configPath, 'utf8').replace(/^﻿/, ''); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = mergeHubManagedCodexConfig(oldText, hubText, { parse: opts.parseToml || defaultParse() });
  if (result.warning) (opts.logger || console).warn?.(`[codex-config] ${configPath}: ${result.warning}`);
  if (oldText !== result.text) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, result.text, 'utf8');
  }
  return result;
}

module.exports = { mergeHubManagedCodexConfig, writeHubManagedCodexConfig };
