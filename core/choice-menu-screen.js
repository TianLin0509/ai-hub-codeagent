'use strict';
// 从会话屏幕被动认出「停在选择菜单上等人选」（2026-10-19，自动派活会话不出选择题的兜底，见 core/auto-dispatch-rules.js）。
// 只读终端缓冲（经无界面 xterm 回放成最后一屏，core/hub-phone/session-chat.js renderRows），从不发按键、不替它选。
//
// 依据 Claude Code 公开的选择菜单样式（AskUserQuestion 提问、权限确认等共用）：
//   - 编号选项一行一个，从 1 开始连续编号：「1. 红」「2. 蓝」（选项下方可能有一行缩进的说明）；
//   - 当前高亮的那一项行首带光标符号（❯），整组里只有一项带；
//   - 菜单在屏幕最下方，底下是按键提示（「Enter to select · ↑/↓ to navigate · Esc to cancel」一类），
//     或者选项上方是一句以问号结尾的题目。
// 普通输出里的编号列表没有光标符号；空闲时屏幕底部是输入框，不在这些规则里。
// 公司 CodeAgent 的真实样本还没有（2026-10-19），规则可在 <数据目录>/company-bridge/choice-menu-rules.json 里改（见 loadRules）。
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_RULES = Object.freeze({
  enabled: true,
  // 高亮选项行首的光标符号
  cursor: '❯›▶►→',
  // 菜单底部的按键提示（正则源码，不区分大小写）
  footer: 'Enter to (?:select|confirm|submit|choose)|Esc to (?:cancel|exit|go back)|↑\\s*/\\s*↓|arrow keys|to navigate|按\\s*(?:Enter|回车)|回车(?:确认|选择)',
  // 工具权限确认（不是提问）：题目或选项像这样就归为 permission（正则源码，不区分大小写）。
  // 依据替身真实样本（tests/fixtures/choice-menu/claude-code-2.1-permission-bash.json，Claude Code 2.1.303）：题目「Do you want to proceed?」，
  // 选项「Yes / Yes, and always allow access to … / Yes, and switch to auto mode … / No」；旧版是「Yes, and don't ask again / No, and tell Claude …」。
  permission: '^Do you want to\\b|\\bAllow\\b.*\\?|是否允许|允许.*吗|don.t ask again|tell Claude what to do differently|^Yes, (?:allow|and )|^(?:Yes|No)$',
  // 菜单要落在屏幕最后这么多行（非空行）里
  bottomRows: 16,
  minOptions: 2,
});
const RULES_FILE = 'choice-menu-rules.json';

const BORDER = /^[\s─━═╭╮╰╯┌┐└┘╴╶·.\-_=]*$/;
const stripBox = line => String(line || '').replace(/^\s*[│┃|]\s?/, '').replace(/\s?[│┃|]\s*$/, '').replace(/\s+$/, '');
const escapeClass = s => String(s).replace(/[\\\]^-]/g, '\\$&');

function compile(rules) {
  const cursor = String(rules.cursor || DEFAULT_RULES.cursor);
  return {
    option: new RegExp(`^\\s*([${escapeClass(cursor)}])?\\s*(\\d{1,2})[.)]\\s+(\\S.*)$`),
    footer: new RegExp(rules.footer || DEFAULT_RULES.footer, 'i'),
    permission: new RegExp(rules.permission || DEFAULT_RULES.permission, 'i'),
    bottomRows: Math.max(4, Math.min(60, Number(rules.bottomRows) || DEFAULT_RULES.bottomRows)),
    minOptions: Math.max(2, Math.min(9, Number(rules.minOptions) || DEFAULT_RULES.minOptions)),
  };
}

// 读覆盖规则：文件不存在用默认；写错了也用默认，并把原因带回（直查、日志用）。
function loadRules(dataDir) {
  const file = dataDir ? path.join(dataDir, 'company-bridge', RULES_FILE) : null;
  if (!file) return { rules: { ...DEFAULT_RULES }, file: null, error: null };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { return { rules: { ...DEFAULT_RULES }, file, error: error.code === 'ENOENT' ? null : error.message }; }
  try {
    const o = JSON.parse(raw.replace(/^﻿/, ''));
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('应当是一个 JSON 对象');
    const rules = { ...DEFAULT_RULES };
    if (typeof o.enabled === 'boolean') rules.enabled = o.enabled;
    if (typeof o.cursor === 'string' && o.cursor.trim()) rules.cursor = o.cursor.trim().slice(0, 20);
    if (typeof o.footer === 'string' && o.footer.trim()) { new RegExp(o.footer, 'i'); rules.footer = o.footer.slice(0, 500); }
    if (typeof o.permission === 'string' && o.permission.trim()) { new RegExp(o.permission, 'i'); rules.permission = o.permission.slice(0, 500); }
    if (Number.isInteger(o.bottomRows)) rules.bottomRows = o.bottomRows;
    if (Number.isInteger(o.minOptions)) rules.minOptions = o.minOptions;
    return { rules, file, error: null };
  } catch (error) { return { rules: { ...DEFAULT_RULES }, file, error: '规则文件写错了，按默认规则识别：' + error.message }; }
}

// rows：最后一屏的文字行。认出时返回 { kind, question, options: [{ key, label, selected }], footer }，否则 null。
// kind：question（AskUserQuestion 一类提问）或 permission（工具权限确认，通道按等待权限处理，不当选择题）。
function detectChoiceMenu(rows, rules = DEFAULT_RULES) {
  if (rules && rules.enabled === false) return null;
  const c = compile(rules || DEFAULT_RULES);
  const lines = (Array.isArray(rows) ? rows : []).map(stripBox);
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end -= 1;
  // 最后 bottomRows 个非空行的起点
  let start = end, seen = 0;
  while (start > 0 && seen < c.bottomRows) { start -= 1; if (lines[start].trim()) seen += 1; }
  const parsed = [];
  for (let i = start; i < end; i++) {
    const m = c.option.exec(lines[i]);
    if (m) parsed.push({ i, key: Number(m[2]), label: m[3].replace(/\s{2,}.*$/, '').trim(), selected: !!m[1] });
  }
  // 取最后一组从 1 起连续编号的选项
  let group = null;
  for (let k = 0; k < parsed.length; k++) {
    if (parsed[k].key !== 1) continue;
    const g = [parsed[k]];
    for (let n = k + 1; n < parsed.length && parsed[n].key === g.length + 1; n++) g.push(parsed[n]);
    if (g.length >= c.minOptions) group = g;
  }
  if (!group) return null;
  if (group.filter(o => o.selected).length !== 1) return null;
  const first = group[0].i, last = group[group.length - 1].i;
  // 菜单下面不能再有输入框（空闲时靠左的「❯ 」提示行）。远离左边的孤立光标符号是回放宽度和终端不一致时的残影，不算
  for (let i = last + 1; i < end; i++) if (/^\s{0,3}[❯>]\s*$/.test(lines[i])) return null;
  const footerLine = lines.slice(last + 1, end).find(l => c.footer.test(l)) || '';
  // 题目：选项上方最近的几行里，优先取以问号结尾的那行
  let question = '', fallback = '';
  for (let i = first - 1, n = 0; i >= 0 && n < 6; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    if (BORDER.test(l)) { if (question || fallback) break; continue; }
    n += 1;
    if (/[?？]\s*$/.test(l)) { question = l; break; }
    if (!fallback) fallback = l;
  }
  if (!footerLine && !question) return null;
  const q = question || fallback;
  // 权限确认和提问分开：AskUserQuestion 的选项末尾总有「Type something」一类自由输入项，权限确认没有
  const freeText = group.some(o => /^(?:Type something|Chat about this|Other)\b/i.test(o.label));
  const kind = !freeText && (c.permission.test(q) || group.some(o => c.permission.test(o.label))) ? 'permission' : 'question';
  return { kind, question: q, options: group.map(o => ({ key: String(o.key), label: o.label.slice(0, 120), selected: o.selected })), footer: footerLine.trim() };
}

module.exports = { DEFAULT_RULES, RULES_FILE, loadRules, detectChoiceMenu };
