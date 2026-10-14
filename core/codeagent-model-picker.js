'use strict';
// 公司 CodeAgent 换模型：在它自己的 /model 菜单里替用户选中（2026-10-14 用户：「就是在 CLI 里输入 /model，
// 然后选择对应的模型」）。
//
// 为什么不用启动参数：公司真机三轮排查（2026-10-13）确认，交互模式下 --model / --settings / 环境变量 /
// 「/model <名字>」都不生效，启动画面写着 MiniMax、回答仍是 GLM；只有 -p 一问一答模式认 --model。
// 所以新建、恢复、会话中换模型都走同一条路：
//   1. 敲 /model 回车（走 sendToPty：等 CLI 就绪、斜杠命令不套 Hub 规则、以「菜单出现」为回执，不补回车）；
//   2. 读渲染后的屏幕，找到光标行和目标行，一次按一下方向键，每次都重新读屏确认光标真的动了；
//   3. 菜单上写着「s to use this session only」就按 s，只改这个会话；没有这个提示就按回车，
//      回车会把它存成以后新会话的默认模型，Hub 事后把配置里的 model 改回原值（只动这一个键）；
//   4. 菜单消失（最好还看到「Set model to …」）算切换完成；下一轮回答再由 codeagent-models 核对实际模型。
// 新会话的第一条消息要等这一步做完再发（waitForPick），否则第一轮还是默认模型。
const fs = require('node:fs');
const path = require('node:path');

const CURSOR_GLYPHS = '❯›▶>';
// 行首可能残留没擦干净的旧字符（「erva4. Sonnet」，2026-10-14 替身实录），所以「编号.」不要求在行首；
// 靠下面「编号连续」和「含模型名」两道筛选排除正文。
const NUMBERED_ROW = new RegExp(`(?:^|[^\\d.])([${CURSOR_GLYPHS}])?\\s*(\\d{1,2})\\.\\s+(\\S.*?)\\s*$`);
const BARE_CURSOR_ROW = new RegExp(`^(\\s*)([${CURSOR_GLYPHS}])\\s+(\\S.*?)\\s*$`);
const MODEL_WORDS = /\b(?:GLM|MiniMax|DeepSeek|Qwen|Kimi|Default|Auto|Opus|Sonnet|Haiku|Fable)\b|模型/i;
const SESSION_ONLY_KEY = /(?:^|[\s·|])([a-z])\s+to\s+use\s+(?:this|for this)\s+session\s+only/i;

const squash = value => String(value || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '');
// 行里第一段（两个以上空格或「·」之前）是模型名，后面是说明。
const rowLabel = text => String(text || '').split(/\s{2,}|\s+·\s+/)[0].replace(/\s*[✔✓]\s*$/, '').trim();

// 测试替身（真 Claude Code）的菜单里只有 Claude 的模型名：用 AI_HUB_CODEAGENT_PICKER_LABELS
// （JSON：{ "MiniMax-M2.7": "Haiku" }）把 Hub 的模型名对到菜单里的名字。真 CodeAgent 不需要。
function pickerLabelFor(modelId, env = process.env) {
  try {
    const map = JSON.parse(env.AI_HUB_CODEAGENT_PICKER_LABELS || '{}');
    const hit = Object.keys(map).find(key => key.toLowerCase() === String(modelId).toLowerCase());
    if (hit && typeof map[hit] === 'string' && map[hit].trim()) return map[hit].trim();
  } catch { /* 格式不对就当没配 */ }
  return String(modelId || '');
}

// 解析屏幕上的模型菜单。认不出返回 null。
// rows: [{ line, cursor, number|null, text, label }]，cursor 是光标所在行的下标。
function parsePicker(lines) {
  const screen = Array.isArray(lines) ? lines : String(lines || '').split(/\r?\n/);
  let rows = [];
  screen.forEach((line, index) => {
    const m = line.match(NUMBERED_ROW);
    if (m) rows.push({ line: index, cursor: !!m[1], number: Number(m[2]), text: m[3], label: rowLabel(m[3]) });
  });
  // 编号要连续，排除正文里碰巧以「1. 」开头的几行。
  if (rows.length >= 2) {
    const runs = [];
    for (const row of rows) {
      const last = runs[runs.length - 1];
      if (last && row.number === last[last.length - 1].number + 1 && row.line - last[last.length - 1].line <= 3) last.push(row);
      else runs.push([row]);
    }
    // 屏幕镜像里可能还留着菜单的旧画面（TUI 重绘没擦干净）：取最靠下、也就是最新的那一份。
    rows = runs.filter(run => run.length >= 2 && run.some(r => r.cursor)).pop() || [];
  } else rows = [];
  // 没有编号的菜单：以光标行为准，向上下收集同一缩进、光标列为空白的相邻行。
  if (rows.length < 2) {
    rows = [];
    const isCursorRow = line => BARE_CURSOR_ROW.test(line) && !/^\s*[❯›▶>]\s*\//.test(line) && MODEL_WORDS.test(line);
    let at = -1;
    for (let i = screen.length - 1; i >= 0; i -= 1) if (isCursorRow(screen[i])) { at = i; break; }
    if (at >= 0) {
      const [, indent] = screen[at].match(BARE_CURSOR_ROW);
      const col = indent.length;
      const sibling = line => line.length > col + 2 && line.slice(0, col + 1).trim() === '' && line[col + 2] !== ' ' && line.trim();
      let top = at, bottom = at;
      while (top - 1 >= 0 && sibling(screen[top - 1])) top -= 1;
      while (bottom + 1 < screen.length && sibling(screen[bottom + 1])) bottom += 1;
      for (let i = top; i <= bottom; i += 1) {
        const text = i === at ? screen[i].match(BARE_CURSOR_ROW)[3] : screen[i].trim();
        rows.push({ line: i, cursor: i === at, number: null, text, label: rowLabel(text) });
      }
    }
  }
  if (rows.length < 2 || !rows.some(row => MODEL_WORDS.test(row.text))) return null;
  const cursor = rows.findIndex(row => row.cursor);
  if (cursor < 0) return null;
  const footer = screen.slice(rows[rows.length - 1].line + 1).join('\n');
  const sessionKey = (footer.match(SESSION_ONLY_KEY) || [])[1] || null;
  return { rows, cursor, sessionKey };
}

// 目标在哪一行：模型名完全相同优先，其次以它开头，最后整行包含。
function findTarget(picker, label) {
  const want = squash(label);
  if (!picker || !want) return -1;
  const exact = picker.rows.findIndex(row => squash(row.label) === want);
  if (exact >= 0) return exact;
  const prefix = picker.rows.findIndex(row => squash(row.label).startsWith(want));
  if (prefix >= 0) return prefix;
  return picker.rows.findIndex(row => squash(row.text).includes(want));
}

function confirmationSeen(lines, label) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || ''));
  const want = squash(label);
  return text.split(/\r?\n/).some(line => /set model to|model set to|switched to|已切换|切换到|模型已/i.test(line) && squash(line).includes(want));
}

// ---------------------------------------------------------------- 会话屏幕镜像
// 与 codex-fast-command 同一做法：用会话缓冲快照重建一个终端模拟器，再接上之后的输出。
async function openSessionScreen(manager, sid) {
  const { Terminal } = require('@xterm/headless');
  const queued = [];
  let terminal = null, replayed = false, disposed = false, chain = Promise.resolve();
  const write = text => new Promise(resolve => terminal.write(text, resolve));
  const listener = event => {
    if (event.sessionId !== sid || disposed) return;
    if (!replayed) queued.push(event);
    else chain = chain.then(() => write(event.data));
  };
  manager.on('output', listener);
  try {
    const snapshot = await manager.getSessionBufferSnapshot(sid);
    // windowsPty 与会话自己的快照终端一致（core/terminal-snapshot.js）：不按 ConPTY 解释换行和光标移动，
    // 重绘会错一行，光标看起来就「没动」（2026-10-14 替身实测）。
    terminal = new Terminal({ cols: snapshot.baseCols || snapshot.cols || 120, rows: snapshot.baseRows || snapshot.rows || 30, scrollback: 200, allowProposedApi: true,
      ...(process.platform === 'win32' ? { windowsPty: { backend: 'conpty', buildNumber: parseInt(require('node:os').release().split('.').pop(), 10) || 0 } } : {}) });
    await write(snapshot.text || '');
    for (const operation of snapshot.operations || []) {
      if (operation.type === 'resize') terminal.resize(operation.cols, operation.rows);
      else if (operation.type === 'write') await write(operation.data);
    }
    for (const event of queued) if (!event.seq || event.seq > snapshot.seq) await write(event.data);
    replayed = true;
  } catch (error) {
    disposed = true; manager.removeListener('output', listener); try { terminal && terminal.dispose(); } catch {}
    throw error;
  }
  return {
    async lines() {
      await chain;
      const buffer = terminal.buffer.active, out = [];
      for (let i = buffer.baseY; i < buffer.baseY + terminal.rows; i += 1) out.push(buffer.getLine(i)?.translateToString(true) || '');
      return out;
    },
    dispose() { disposed = true; manager.removeListener('output', listener); chain.finally(() => { try { terminal.dispose(); } catch {} }); },
  };
}

// ---------------------------------------------------------------- 默认模型保护
function readModelKey(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return { exists: true, model: value && typeof value.model === 'string' ? value.model : undefined };
  } catch (error) { return { exists: !(error && error.code === 'ENOENT'), model: undefined, unreadable: !(error && error.code === 'ENOENT') }; }
}
function snapshotDefaults(configDir) {
  return ['settings.json', 'settings.local.json'].map(name => ({ file: path.join(configDir, name), ...readModelKey(path.join(configDir, name)) }));
}
// 只把这次被菜单改掉的 model 键改回去，其余内容原样保留。
function restoreDefaults(snapshot) {
  const restored = [];
  for (const before of snapshot) {
    if (!before.exists || before.unreadable) continue;
    let raw;
    try { raw = fs.readFileSync(before.file, 'utf8'); } catch { continue; }
    let value;
    try { value = JSON.parse(raw.replace(/^﻿/, '')); } catch { continue; }
    const now = value && typeof value.model === 'string' ? value.model : undefined;
    if (now === before.model) continue;
    if (before.model === undefined) delete value.model; else value.model = before.model;
    const temp = `${before.file}.hub-model-${process.pid}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.renameSync(temp, before.file); restored.push(path.basename(before.file)); }
    finally { try { fs.unlinkSync(temp); } catch {} }
  }
  return restored;
}

// ---------------------------------------------------------------- 选择
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(screen, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lines = [];
  while (Date.now() < deadline) {
    lines = await screen.lines();
    const value = predicate(lines);
    if (value) return { value, lines };
    await sleep(80);
  }
  return { value: null, lines };
}

// 选中之后 CLI 打印的「Set model to <模型>」：从原始输出里找，不依赖屏幕重绘。界面框架用光标移动代替空格，
// 去掉控制序列后单词会粘在一起，所以压成小写字母数字再比。返回回显里模型名开头的一段（已压缩），没有返回 null。
// 会话里已经聊过时，选中后还会弹「Switch model? … ❯ 1. Yes, switch to X / 2. No, go back」（提醒换模型后历史要重读）。
// 用户点了换模型就是要换：移到「Yes」回车（同 Claude 的处理，core/cli-model-command.js）。
async function waitForEcho(manager, sid, mark, timeoutMs, screen) {
  const { stripAnsi } = require('./ansi-utils.js');
  const { parseClaudeModelSwitchConfirmation } = require('./cli-model-command');
  const deadline = Date.now() + timeoutMs;
  let answered = false;
  while (Date.now() < deadline) {
    const fresh = squash(stripAnsi(String(manager.getSessionOutputSince(sid, mark) || '')));
    const at = fresh.lastIndexOf('setmodelto');
    if (at >= 0 && fresh.length - at > 'setmodelto'.length + 2) return fresh.slice(at + 'setmodelto'.length, at + 'setmodelto'.length + 40);
    if (!answered && screen) {
      const dialog = parseClaudeModelSwitchConfirmation((await screen.lines()).join('\n'));
      if (dialog) {
        answered = true;
        const moves = dialog.number - dialog.cursor;
        for (let i = 0; i < Math.abs(moves); i += 1) { manager.writeToSession(sid, moves > 0 ? '\x1b[B' : '\x1b[A'); await sleep(150); }
        await sleep(200);
        manager.writeToSession(sid, '\r');
      }
    }
    await sleep(100);
  }
  return null;
}

// 在已经打开的会话里选模型。返回 { ok, mode: 'session'|'default', confirmed, restored, message }。
async function pickModel({ manager, sid, kind, modelId, configDir, sendToPty, screenTimeoutMs = 8000, env = process.env }) {
  const label = pickerLabelFor(modelId, env);
  const screen = await openSessionScreen(manager, sid);
  let opened = false;
  // 失败时把当时的画面带回去，写进数据目录方便排查（公司电脑上的菜单长相我们看不到）。
  const fail = async message => ({ ok: false, message, screen: await screen.lines().catch(() => []) });
  try {
    const sent = await sendToPty(sid, '/model', kind, { codeagentModelPick: true });
    if (!sent || sent.ok === false || sent.notSent) return { ok: false, message: (sent && sent.message) || 'CodeAgent 没有接收 /model 命令' };
    const first = await waitFor(screen, parsePicker, screenTimeoutMs);
    if (!first.value) return fail('CodeAgent 的模型菜单没有出现，或画面认不出来' );
    opened = true;
    let picker = first.value;
    const target = findTarget(picker, label);
    if (target < 0) return fail(`模型菜单里没有 ${modelId}（菜单里有：${picker.rows.map(row => row.label).join('、')}）` );
    // 方向键按第一帧算好的格数逐个按。这类界面只重画变化的几行，镜像和真实终端稍有出入，后面几帧就会读乱
    // （2026-10-14 替身实测：光标其实已经移到目标，镜像里还停在原处）；所以不逐帧核对，最终以 CLI 自己的回显为准。
    const steps = target - picker.cursor;
    for (let i = 0; i < Math.abs(steps); i += 1) {
      manager.writeToSession(sid, steps > 0 ? '\x1b[B' : '\x1b[A');
      await sleep(150);
    }
    await sleep(300);
    const restoreSnapshot = configDir ? snapshotDefaults(configDir) : [];
    const mode = picker.sessionKey ? 'session' : 'default';
    const mark = typeof manager.getSessionOutputMark === 'function' ? manager.getSessionOutputMark(sid) : null;
    manager.writeToSession(sid, picker.sessionKey || '\r');
    opened = false;
    const echo = mark == null ? null : await waitForEcho(manager, sid, mark, screenTimeoutMs, screen);
    // CLI 可能在回显之后才把默认模型写进配置：稍等再改回，过一会儿再核一次。
    let restored = [];
    if (mode === 'default') {
      await sleep(600);
      restored = restoreDefaults(restoreSnapshot);
      await sleep(1500);
      restored = [...new Set([...restored, ...restoreDefaults(restoreSnapshot)])];
    }
    // 回显可能用菜单上的显示名（例如「Sonnet 5.5」），也可能用模型名：两种都算对。
    const echoMatches = echo && [label, picker.rows[target].label].some(name => squash(name) && echo.startsWith(squash(name)));
    if (echo && !echoMatches) {
      return { ...(await fail(`CodeAgent 回显选中的不是 ${modelId}（回显：${echo.slice(0, 30)}）`)), restored };
    }
    if (!echo) {
      // 没有「Set model to」这句回显（CodeAgent 的措辞可能不同）：至少菜单要关掉。
      const closed = await waitFor(screen, lines => !parsePicker(lines), 3000);
      if (!closed.value) return { ...(await fail('选中后没有看到切换回显，菜单也没有关闭')), restored };
    }
    return { ok: true, mode, confirmed: !!echo, restored };
  } finally {
    // 只关自己打开的菜单；用户的输入和正在进行的回答不碰。
    if (opened) {
      try { manager.writeToSession(sid, '\x1b'); } catch {}
      // 紧跟在 Esc 后面到达的字符会被终端当成 Alt+键，排队等着的第一条消息就被吞了、输入框里什么也没有
      // （2026-10-14 替身实录：菜单里没有要选的模型 → Esc → 第一条消息没发出去）。等菜单关掉、再留一拍才放行。
      await waitFor(screen, lines => !parsePicker(lines), 3000).catch(() => {});
      await sleep(400);
    }
    screen.dispose();
  }
}

// ---------------------------------------------------------------- 排队与第一条消息的闸门
const pending = new Map(); // sid → Promise
let queue = Promise.resolve();
// 同一时间只做一次：回车方式会改写共用的默认模型，几个会话并发选会互相覆盖快照。
function schedulePick(sid, task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  const tracked = run.finally(() => { if (pending.get(sid) === tracked) pending.delete(sid); });
  pending.set(sid, tracked);
  tracked.catch(() => {});
  return tracked;
}
async function waitForPick(sid, timeoutMs = 150000) {
  const task = pending.get(sid);
  if (!task) return;
  // 兜底上限：选模型卡住也不能让消息永远发不出去。做完就清掉计时器。
  let timer = null;
  const limit = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); });
  try { await Promise.race([task.catch(() => {}), limit]); }
  finally { clearTimeout(timer); }
}
function isPicking(sid) { return pending.has(sid); }

module.exports = {
  parsePicker,
  findTarget,
  confirmationSeen,
  pickerLabelFor,
  snapshotDefaults,
  restoreDefaults,
  openSessionScreen,
  pickModel,
  schedulePick,
  waitForPick,
  isPicking,
};
