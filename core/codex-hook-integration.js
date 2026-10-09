'use strict';

// PTY 模式下 Codex 的状态与卡片绑定靠 Codex 自己的 hook（0.153 起支持）。
//
// 这里只管 Hub 自己的那几条 hook：
//   1. 把 hook 脚本（私人版 session-hub-hook.py，社区版 .ps1，见 hook-runner.js）
//      复制到 <CODEX_HOME>/hub-scripts/，路径稳定；
//   2. 在 <CODEX_HOME>/hooks.json 里补齐缺的事件，已有的 session-hub-hook 条目原样保留；
//   3. 在 <CODEX_HOME>/config.toml 的 [hooks.state] 里为这些条目写 trusted_hash。
//
// 第 3 步等价于用户在 Codex /hooks 里点一次「信任」。Codex 只执行 hash 一致的
// hook，否则新条目会被静默跳过，状态就退化成只能看 rollout。hash 算法与 Codex
// 源码 hooks/src/engine/discovery.rs::hook_hash + config/src/fingerprint.rs 一致：
// {event_name, matcher?, hooks:[归一化后的 handler]} 转 JSON、键排序、紧凑序列化后 sha256。
// 只为命令里带 session-hub-hook 的条目写信任，绝不替用户信任别的 hook。
//
// hook 脚本在没有 CLAUDE_HUB_SESSION_ID 时立刻退出，所以用户自己在终端里跑的
// Codex 不受影响。

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const childProcess = require('child_process');
const { scanTomlStatements, tomlKey, simpleStringValue, samePath, isPrefix } = require('./toml-statements');
const { hookRunner, hookCommand } = require('./hook-runner');

const MARKER = 'session-hub-hook';
const TIMEOUT_SEC = 5;
// [Codex 事件名, trust key 里的事件标签, hook 脚本参数, 是否 async]
const HUB_CODEX_HOOKS = [
  ['SessionStart', 'session_start', 'session-start', false],
  ['UserPromptSubmit', 'user_prompt_submit', 'prompt', false],
  ['PreToolUse', 'pre_tool_use', 'tool-start', true],
  ['PostToolUse', 'post_tool_use', 'tool-complete', true],
  ['PermissionRequest', 'permission_request', 'permission-request', false],
  ['Stop', 'stop', 'stop', false],
];

function defaultCodexHome() {
  return path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.codex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

// Codex 对 command handler 的归一化：timeout 缺省 600、最小 1；async 总是序列化；
// commandWindows / statusMessage / matcher 为空时不进入 hash。
function codexHookTrustHash(eventLabel, matcher, handler) {
  const normalized = {
    type: 'command',
    command: String(handler.command),
    timeout: Math.max(1, Number.isInteger(handler.timeout) ? handler.timeout : 600),
    async: handler.async === true,
  };
  if (typeof handler.statusMessage === 'string') normalized.statusMessage = handler.statusMessage;
  const identity = { event_name: eventLabel, hooks: [normalized] };
  if (typeof matcher === 'string') identity.matcher = matcher;
  const json = JSON.stringify(canonical(identity));
  return 'sha256:' + crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}

function hookArg(command) {
  const match = /session-hub-hook(?:\.(?:py|ps1))?"?\s+([a-z-]+)\s*$/i.exec(String(command || ''));
  return match ? match[1] : null;
}

function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('hooks.json 不是对象');
  return parsed;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, text, 'utf8');
  fs.renameSync(temporary, file);
}

function copyHookScript(codexHome, sourceScript, runner) {
  const target = hubHookScriptPath(codexHome, runner);
  const source = fs.readFileSync(sourceScript);
  let current = null;
  try { current = fs.readFileSync(target); } catch {}
  if (!current || !current.equals(source)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, source);
    fs.renameSync(temporary, target);
  }
  return target;
}

function hubHookScriptPath(codexHome, runner = hookRunner()) {
  return path.join(codexHome, 'hub-scripts', runner.script);
}

// 在一份 hooks.json 内容上补齐 Hub 的事件，原有条目（包括别处已部署的
// session-hub-hook 同名事件）原样保留、不重复。纯函数：个人规则同步
// （agent-user-context）写 hooks.json 时也用它，两边的期望内容才会一致。
function mergeHubCodexHooks(hooksFile, targetScript, runner = hookRunner()) {
  const next = hooksFile && typeof hooksFile === 'object' && !Array.isArray(hooksFile)
    ? JSON.parse(JSON.stringify(hooksFile)) : {};
  if (!next.hooks || typeof next.hooks !== 'object' || Array.isArray(next.hooks)) next.hooks = {};
  const hooks = next.hooks;
  let changed = false;
  for (const [eventName, , arg, asyncHook] of HUB_CODEX_HOOKS) {
    if (!Array.isArray(hooks[eventName])) hooks[eventName] = [];
    const present = hooks[eventName].some(group => Array.isArray(group && group.hooks)
      && group.hooks.some(handler => String(handler && handler.command || '').includes(MARKER)
        && hookArg(handler.command) === arg));
    if (present) continue;
    hooks[eventName].push({ hooks: [{ type: 'command', command: hookCommand(runner, targetScript, arg),
      timeout: TIMEOUT_SEC, ...(asyncHook ? { async: true } : {}) }] });
    changed = true;
  }
  return { changed, hooksFile: next };
}

// 只增改 Hub 自己的 [hooks.state.<key>] 表里的 trusted_hash，其余文本逐字保留。
//
// 表和键按 TOML 语义识别：'单引号'、"双引号"（含转义）、点号两侧空白、行尾注释
// 都是同一个表。Hub 只改两种形状：独立的 [hooks.state.<key>] 表，或者完全没有
// 这个条目（在文末追加）。条目若以点号键或内联表的形式写在别处，就不动它，
// 记进 skipped —— 猜着改最容易写出重复定义。扫描不了的文本整体不改。
function upsertTrustedHashes(configText, entries) {
  const text = String(configText || '');
  let scan;
  try { scan = scanTomlStatements(text); }
  catch (error) { return { changed: false, text, skipped: entries.map(e => e.key), error: `config.toml 无法识别：${error.message}` }; }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  const edits = [];
  const appended = [];
  const skipped = [];
  for (const { key, hash } of entries) {
    const target = ['hooks', 'state', key];
    const wanted = `trusted_hash = "${hash}"`;
    const tableAt = scan.statements.findIndex(s => s.kind === 'table' && samePath(s.path, target));
    if (tableAt >= 0) {
      const own = [];
      for (let i = tableAt + 1; i < scan.statements.length && scan.statements[i].kind === 'kv'; i += 1) own.push(scan.statements[i]);
      const hashStmt = own.find(s => samePath(s.key, ['trusted_hash']));
      if (!hashStmt) edits.push({ at: scan.statements[tableAt].endLine + 1, remove: 0, insert: [wanted] });
      else if (simpleStringValue(hashStmt.valueText) !== hash) {
        const line = lines[hashStmt.startLine];
        const indent = /^[ \t]*/.exec(line)[0];
        let tail = '';
        if (hashStmt.startLine === hashStmt.endLine) {
          const at = line.indexOf(hashStmt.valueText, line.indexOf('='));
          tail = line.slice(at + hashStmt.valueText.length); // 保留行尾注释
        }
        edits.push({ at: hashStmt.startLine, remove: hashStmt.endLine - hashStmt.startLine + 1, insert: [indent + wanted + tail] });
      }
      // 用户显式禁用过的条目尊重用户：保留 enabled = false，不替他打开。
      continue;
    }
    // 条目（或它的上级）以别的形状存在：点号键、内联表、数组表。不改，交给语义校验之外的人工处理。
    const elsewhere = scan.statements.some(s => (s.kind === 'kv' && (isPrefix(target, s.path) || isPrefix(s.path, target)))
      || (s.kind !== 'kv' && s.kind !== 'table' && (isPrefix(target, s.path) || isPrefix(s.path, target)))
      || (s.kind === 'table' && isPrefix(target, s.path)));
    if (elsewhere) { skipped.push(key); continue; }
    appended.push('', `[hooks.state.${tomlKey(key)}]`, wanted);
  }
  if (!edits.length && !appended.length) return { changed: false, text, skipped };
  for (const edit of edits.sort((a, b) => b.at - a.at)) lines.splice(edit.at, edit.remove, ...edit.insert);
  let next = lines.join(eol);
  if (appended.length) {
    if (next.length && !next.endsWith(eol)) next += eol;
    next += appended.join(eol) + eol;
  }
  return { changed: true, text: next, skipped };
}

// 用 Python 标准库 tomllib 读出整份配置的语义（hook 本身就靠 python 运行）。
function parseTomlWithPython(text) {
  const result = childProcess.spawnSync('python', ['-c',
    'import sys,json,tomllib;print(json.dumps(tomllib.loads(sys.stdin.read()),default=str,sort_keys=True))'], {
    input: text, encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  if (result.error) throw new Error(`无法运行 python 校验 config.toml：${result.error.message}`);
  if (result.status !== 0) throw new Error(String(result.stderr || '').trim().split(/\r?\n/).pop() || `python 退出码 ${result.status}`);
  return JSON.parse(result.stdout);
}

// 没有 Python 时的结构级解析（社区版）：用 toml-statements 扫描器把每条键值落到
// 对应路径，值保留原文（简单字符串取内容）。它不求值，但足以判断「除 Hub 的
// trusted_hash 之外，其余表、键和值的原文都没变」，这正是 verifyTrustEdit 要守的。
function parseTomlStructural(text) {
  const { statements } = scanTomlStatements(text);
  const root = {};
  const descend = (node, keys) => {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(node, key)) node[key] = {};
      node = node[key];
      if (Array.isArray(node)) node = node[node.length - 1];
      if (!node || typeof node !== 'object') throw new Error(`键 ${keys.join('.')} 与已有的值冲突`);
    }
    return node;
  };
  let current = root;
  for (const statement of statements) {
    if (statement.kind === 'table') { current = descend(root, statement.path); continue; }
    if (statement.kind === 'array-table') {
      const parent = descend(root, statement.path.slice(0, -1));
      const last = statement.path[statement.path.length - 1];
      if (!Array.isArray(parent[last])) parent[last] = [];
      parent[last].push({});
      current = parent[last][parent[last].length - 1];
      continue;
    }
    const holder = descend(current, statement.key.slice(0, -1));
    const simple = simpleStringValue(statement.valueText);
    holder[statement.key[statement.key.length - 1]] = simple !== null ? simple : `\u0000toml:${statement.valueText.trim()}`;
  }
  return root;
}

// 源码运行时脚本就在仓库 scripts/；打包后 scripts 作为 extraResources 放在
// resources/scripts（Claude 一侧的部署也从这里取），不在 app.asar 里。
function defaultHookSource(runner) {
  const inAsar = /[\\/]app\.asar[\\/]/.test(__dirname);
  if (inAsar && process.resourcesPath) return path.join(process.resourcesPath, 'scripts', runner.script);
  return path.join(__dirname, '..', 'scripts', runner.script);
}

function defaultParseToml(runner) {
  return runner.name === 'python' ? parseTomlWithPython : parseTomlStructural;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// 写盘前的闸门：旧文本必须能解析；新文本除 Hub 条目的 trusted_hash 之外语义完全不变。
function verifyTrustEdit(before, after, entries, parse) {
  let oldDoc;
  try { oldDoc = parse(before); }
  catch (error) { throw new Error(`现有 config.toml 解析失败，不改动：${error.message}`); }
  let newDoc;
  try { newDoc = parse(after); }
  catch (error) { throw new Error(`改写后的 config.toml 解析失败，已放弃写入：${error.message}`); }
  const expected = JSON.parse(JSON.stringify(oldDoc));
  for (const { key, hash } of entries) {
    if (!expected.hooks || typeof expected.hooks !== 'object') expected.hooks = {};
    if (!expected.hooks.state || typeof expected.hooks.state !== 'object') expected.hooks.state = {};
    if (!expected.hooks.state[key] || typeof expected.hooks.state[key] !== 'object') expected.hooks.state[key] = {};
    expected.hooks.state[key].trusted_hash = hash;
  }
  if (!deepEqual(newDoc, expected)) throw new Error('改写后的 config.toml 语义与预期不一致，已放弃写入');
}

/**
 * 保证指定 CODEX_HOME 下 Hub 的 Codex hook 已部署且受信任。幂等；
 * 失败只返回 errors，由调用方显示降级，不抛出去拦住会话启动。
 */
function ensureCodexHookIntegration({ codexHome = null, sourceScript = null, logger = console, parseToml = null,
  runner = hookRunner() } = {}) {
  const home = path.resolve(codexHome || defaultCodexHome());
  const parse = parseToml || defaultParseToml(runner);
  const result = { codexHome: home, hooksChanged: false, trustChanged: false, trusted: [], untrusted: [], errors: [] };
  const script = sourceScript || defaultHookSource(runner);
  const hooksPath = path.join(home, 'hooks.json');
  const configPath = path.join(home, 'config.toml');
  try {
    const target = copyHookScript(home, script, runner);
    const merged = mergeHubCodexHooks(readJson(hooksPath), target, runner);
    const hooksFile = merged.hooksFile;
    const hooks = hooksFile.hooks;
    result.hooksChanged = merged.changed;
    if (result.hooksChanged) writeAtomic(hooksPath, JSON.stringify(hooksFile, null, 2) + '\n');

    const trust = [];
    for (const [eventName, label] of HUB_CODEX_HOOKS) {
      (hooks[eventName] || []).forEach((group, groupIndex) => {
        (group && Array.isArray(group.hooks) ? group.hooks : []).forEach((handler, handlerIndex) => {
          if (!handler || handler.type !== 'command' || !String(handler.command || '').includes(MARKER)) return;
          trust.push({ key: `${hooksPath}:${label}:${groupIndex}:${handlerIndex}`,
            hash: codexHookTrustHash(label, typeof group.matcher === 'string' ? group.matcher : undefined, handler) });
        });
      });
    }
    let configText = '';
    try { configText = fs.readFileSync(configPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const next = upsertTrustedHashes(configText, trust);
    if (next.error) throw new Error(next.error);
    result.untrusted = next.skipped || [];
    if (result.untrusted.length) {
      result.errors.push(`config.toml 里有 ${result.untrusted.length} 条 Hub hook 的信任记录写法无法安全改写，请在 Codex /hooks 中手动信任`);
    }
    if (next.changed) {
      verifyTrustEdit(configText, next.text, trust.filter(entry => !result.untrusted.includes(entry.key)), parse);
      writeAtomic(configPath, next.text);
      result.trustChanged = true;
    }
    result.trusted = trust.map(entry => entry.key).filter(key => !result.untrusted.includes(key));
    if (result.hooksChanged || result.trustChanged) logger.log?.(`[codex-hooks] Hub hook 已部署并信任：${home}`);
  } catch (error) {
    result.errors.push(error.message);
    logger.warn?.(`[codex-hooks] ${home}: ${error.message}`);
  }
  return result;
}

module.exports = {
  HUB_CODEX_HOOKS, codexHookTrustHash, upsertTrustedHashes, ensureCodexHookIntegration, hookArg,
  mergeHubCodexHooks, hubHookScriptPath,
  parseTomlWithPython, parseTomlStructural, verifyTrustEdit,
};
