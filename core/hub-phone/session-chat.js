'use strict';
// 手机直接与 Hub 会话对话（App 2.1，2026-10-13 用户：「用手机时也能最轻松地做基本 vibe coding」）。
// 与只读的 session_cards 分开：这里的每种消息都是显式的写操作，逐条校验、逐条回执。
//  - session_turns_get：读卡片（与电脑卡片同一份原生落盘解析），可向前翻页
//  - session_watch：手机打开某个会话时订阅；Hub 只在内容或状态变化时推 session_live，约 2 秒一次，2.5 分钟不续订自动停
//  - session_send：文字 / 语音 / 附件直接发给该会话，走与电脑输入框同一条提交管线；会话忙或在等你时先排队，空闲后自动发
//  - session_stop：等同电脑上的停止（PTY 发一次 Esc，原生后端调用自己的中断）
//  - session_key：会话「在等你」（权限确认、选择题）时按键：数字、回车、Esc、上下
//  - session_cancel：取消还在排队的消息
// 群聊成员与助理自身只读；手机发出的每条消息与结果写进助理对话记录（「手机 → 会话名」）。
const crypto = require('node:crypto');

const TYPES = ['session_turns_get', 'session_send', 'session_stop', 'session_key', 'session_watch', 'session_cancel'];
const KEYS = { enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', tab: '\t', space: ' ', y: 'y', n: 'n',
  1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9' };
const NATIVE_BACKENDS = ['claude-stream-json', 'codex-app-server', 'acp'];
const WATCH_MS = 150000;        // 手机每 60 秒续订一次；断网或退出会话页后最多 2.5 分钟自动停推
const PUSH_GAP_MS = 2000;       // 云中继按 IP 限每分钟 180 次请求，推送节奏留足余量
const HOLD_MAX_MS = 2 * 3600000;
const STOP_THROTTLE_MS = 1500;  // 空闲时连按两次 Esc 会进 TUI 的「回退历史」，短时间内重复停止只发一次
const TEXT_MAX = 12000;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

function brief(value, max = 80) { const s = String(value || '').replace(/\s+/g, ' ').trim(); return s.length > max ? s.slice(0, max - 1) + '…' : s; }
function toolBrief(call) {
  const input = call && typeof call.input === 'object' && call.input ? call.input : {};
  const file = input.file_path || input.path || input.notebook_path || '';
  const what = input.description || input.command || (file ? String(file).split(/[\\/]/).slice(-2).join('/') : '') || input.pattern || input.url || input.query || input.prompt || '';
  return { name: String(call?.name || '工具').slice(0, 40), text: brief(what, 70), error: !!call?.isError };
}
function cardOf(turn, running) {
  const role = turn.role === 'user' ? 'user' : 'assistant';
  const full = String(turn.text || '');
  const calls = Array.isArray(turn.toolCalls) ? turn.toolCalls : [];
  return {
    id: String(turn.id || crypto.createHash('sha256').update(JSON.stringify([turn.ts, full.slice(0, 200)])).digest('hex')).slice(0, 160),
    role, text: full.length > TEXT_MAX ? full.slice(0, TEXT_MAX) : full, truncated: full.length > TEXT_MAX,
    timestamp: Number(turn.ts || turn.timestamp) || null,
    tools: role === 'assistant' ? { count: calls.length, recent: calls.slice(-3).map(toolBrief) } : null,
    ...(running ? { running: true } : {}),
  };
}
// 终端画面：PTY 原始输出交给无界面 xterm 回放，只取最后一屏的文字（在等你时用来看清题目和选项）。
async function renderRows({ text, cols, rows }) {
  if (typeof text !== 'string' || !text) return [];
  const { Terminal } = require('@xterm/headless');
  const term = new Terminal({ cols: Math.max(40, Math.min(300, cols || 120)), rows: Math.max(10, Math.min(80, rows || 30)), scrollback: 0, allowProposedApi: true });
  try {
    await new Promise(resolve => term.write(text.slice(-300000), resolve));
    const b = term.buffer.active, lines = [];
    for (let i = 0; i < term.rows; i++) lines.push(b.getLine(b.baseY + i)?.translateToString(true) || '');
    return lines;
  } finally { term.dispose(); }
}
async function renderScreen(raw) { return cleanRows(await renderRows(raw)); }
function cleanRows(lines) {
  {
    const cleaned = lines.map(l => l.replace(/^\s*[│┃|]\s?/, '').replace(/\s?[│┃|]\s*$/, '').replace(/\s+$/, ''))
      .filter(l => !/^[\s─━═╭╮╰╯┌┐└┘╴╶·.]*$/.test(l) || l === '');
    while (cleaned.length && !cleaned[0].trim()) cleaned.shift();
    while (cleaned.length && !cleaned.at(-1).trim()) cleaned.pop();
    return cleaned.slice(-18).map(l => l.slice(0, 160));
  }
}
function screenOptions(lines) {
  const out = [];
  for (const line of lines || []) {
    const m = /^\s*([❯›>▶→]?)\s*(\d)[.)、]\s+(.{1,80})$/.exec(line);
    if (m && !out.some(o => o.key === m[2])) out.push({ key: m[2], label: brief(m[3].replace(/\s{2,}.*$/, ''), 48), selected: !!m[1] });
  }
  return out.length >= 2 ? out.slice(0, 6) : [];
}

class SessionChat {
  constructor(channel) { this.c = channel; this.watches = new Map(); this.stopAt = new Map(); this.stopHints = new Map(); }
  get a() { return this.c.assistant; }
  get deps() { return this.a?.deps || {}; }
  available() { return typeof this.deps.readSessionTurns === 'function' && typeof this.deps.sendPrompt === 'function'; }
  // 有待处理的手机请求（含排队中、等结果入账）才进入处理；没有时不占用收发循环。
  pending() { return this.c.journal.state.inbox.some(r => TYPES.includes(r.type) && (['session-queued', 'session-held'].includes(r.state) || r.awaitResult && !r.resultLogged)); }
  active() { return this.watches.size > 0 || this.c.journal.state.inbox.some(r => r.state === 'session-held' || r.state === 'session-queued' || r.awaitResult && !r.resultLogged); }
  validate(m) {
    if (!TYPES.includes(m.type)) return;
    if (typeof m.sessionId !== 'string' || !ID_RE.test(m.sessionId)) throw Error('会话编号无效');
    if (m.type === 'session_turns_get' && m.before != null && (typeof m.before !== 'string' || m.before.length > 160)) throw Error('卡片请求无效');
    if (m.type === 'session_watch' && (typeof m.on !== 'boolean' || m.screen !== undefined && typeof m.screen !== 'boolean')) throw Error('订阅请求无效');
    if (m.type === 'session_key' && !Object.prototype.hasOwnProperty.call(KEYS, String(m.key))) throw Error('按键无效');
    if (m.type === 'session_cancel' && (typeof m.target !== 'string' || m.target.length > 100)) throw Error('取消请求无效');
    if (m.type === 'session_send') {
      const hasText = typeof m.text === 'string' && m.text.trim(), hasVoice = typeof m.pcm === 'string' && m.pcm;
      if (!hasText && !hasVoice && !m.attachment) throw Error('消息为空');
      if (m.text !== undefined && (typeof m.text !== 'string' || m.text.length > 50000)) throw Error('消息过长，请分几次发');
      if (hasVoice && m.pcm.length > Math.ceil(16000 * 2 * 120 / 3) * 4 + 4) throw Error('语音无效');
    }
  }
  // 收到时：订阅直接生效（不进收件箱）；其余进收件箱，由 process 按顺序处理并回执。
  watch(m) {
    if (!m.on) { this.watches.delete(m.sessionId); return; }
    const w = this.watches.get(m.sessionId) || { sig: null, last: 0 };
    this.watches.set(m.sessionId, { ...w, until: Date.now() + WATCH_MS, screen: !!m.screen, ...(w.screen !== !!m.screen ? { sig: null, last: 0 } : {}) });
    this.c.kick?.();
  }
  session(id) { return this.a.sessions().find(s => s.id === id) || null; }
  target(id, { write = false } = {}) {
    const s = this.session(id);
    if (!s) throw Error('会话已不在 Hub 里，请刷新会话列表');
    if (write && s.meetingId) throw Error('群聊成员在手机上只能查看；要发言请在电脑上的群聊里说');
    if (write && ['hub-assistant', 'hub-photo-assistant'].includes(s.purpose)) throw Error('助理请在「对话」页直接聊');
    return s;
  }
  state(id) {
    const s = this.session(id), live = this.deps.getSession?.(id);
    const hub = s?.hubState?.state || (s?.isOpen ? 'unknown' : 'closed');
    const busy = !!live && !!this.a.sessionBusy?.(id);
    // 「等你」分两种：回合还没结束、卡在选择题 / 权限确认上（waiting：给题目、终端画面和按键）；
    // 回合已结束、回答里在问你（needsReply：直接回一句就行，手机的话不排队）。
    const needs = !!live && (hub === 'wait' || live.needsUserInput === true || live.attentionState === 'needs-input');
    const waiting = needs && busy, needsReply = needs && !busy;
    const native = !!live && NATIVE_BACKENDS.includes(live.runtimeBackend);
    return {
      state: waiting ? 'wait' : busy ? 'run' : needsReply ? 'reply' : hub, label: waiting ? '等你' : busy ? '工作中' : needsReply ? '等你回复' : s?.hubState?.label || (s?.isOpen ? '就绪' : '未打开'),
      busy, waiting, needsReply, isOpen: !!live, waitingText: waiting ? brief(live.waitingText || '', 200) : '',
      canStop: busy, canKeys: !!live && !native, readonly: !!s?.meetingId,
      title: String(s?.title || s?.name || '未命名会话').slice(0, 120), kind: String(s?.kind || '').replace(/-resume$/, ''),
    };
  }
  async turns(id, { limit = 8, before = null } = {}) {
    const s = this.target(id);
    const want = Math.max(1, Math.min(20, limit));
    let parseLimit = before ? 60 : want, result, list, end;
    for (;;) {
      result = await this.deps.readSessionTurns(id, { limit: parseLimit, fromTail: true, compactToolOutputs: true });
      list = (Array.isArray(result?.turns) ? result.turns : []).filter(t => ['user', 'assistant'].includes(t.role) && (String(t.text || '').trim() || t.toolCalls?.length));
      end = before == null ? list.length : list.findIndex(t => String(t.id) === before);
      if (end >= 0 || parseLimit >= 240 || list.length < parseLimit) break;
      parseLimit *= 2;
    }
    if (end < 0) throw Error('历史卡片发生变化，请刷新后继续');
    const start = Math.max(0, end - want), running = this.state(id).busy;
    const page = list.slice(start, end).map((t, i, arr) => cardOf(t, running && before == null && i === arr.length - 1 && t.role === 'assistant'));
    return { sessionId: id, title: String(s.title || s.name || '').slice(0, 120), turns: page, hasMore: start > 0 || list.length >= parseLimit,
      issue: result?.error || null, loadedAt: Date.now() };
  }
  async screen(id) {
    if (typeof this.deps.readTerminalScreen !== 'function') return null;
    try { const raw = await this.deps.readTerminalScreen(id); if (!raw) return null; const lines = await renderScreen(raw); return { lines, options: screenOptions(lines) }; }
    catch (e) { return { lines: [], options: [], issue: '终端画面暂时读不到：' + e.message }; }
  }
  // 手机按了停止之后的真实状态。Claude 在回答还没开始时被 Esc 打断，会把那句话退回输入框，
  // 也不写中断记录，Hub 因此一直显示「运行中」（电脑上的停止键同样如此）。这里看终端画面：
  // 没有运行标志、底栏已回到输入状态，就按「已停止」处理；那句退回的话留在输入框会和下一句粘在一起，
  // 只在它确实是刚才那句时用 Ctrl+C 清掉（输入框有字时 Ctrl+C 只清空，不退出）。
  async liveState(id) {
    const st = this.state(id), hint = this.stopHints.get(id);
    if (!hint) return st;
    if (!st.busy || Date.now() - hint.at > 30 * 60000) { this.stopHints.delete(id); return st; }
    if (!st.canKeys || typeof this.deps.readTerminalScreen !== 'function') return st;
    try {
      const { classifyTerminalRuntime } = require('../terminal-runtime-state');
      const read = async () => renderRows(await this.deps.readTerminalScreen(id) || {});
      let rows = await read(), verdict = classifyTerminalRuntime(st.kind, rows);
      if (verdict.state === 'running' || verdict.state === 'waiting') return st;
      if (verdict.state !== 'idle' && !hint.cleared) {
        const inputAt = rows.findLastIndex(l => /^\s*[›❯>]\s*\S/.test(l)), draft = inputAt >= 0 ? rows[inputAt].replace(/^\s*[›❯>]\s*/, '').trim() : '';
        const last = (await this.turns(id, { limit: 2 })).turns.filter(t => t.role === 'user').at(-1)?.text?.trim() || '';
        const footer = rows.slice(inputAt + 1).some(l => /mode on|bypass permissions|shift\+tab|for shortcuts|Context \d+%/i.test(l));
        if (draft && footer && last && last.startsWith(draft.slice(0, 20))) {
          hint.cleared = true; this.deps.sessionKeys(id, '\x03');
          await new Promise(r => setTimeout(r, 400)); rows = await read(); verdict = classifyTerminalRuntime(st.kind, rows);
        }
      }
      if (verdict.state !== 'idle') return st;
      return { ...st, state: 'idle', label: '已停止', busy: false, waiting: false, canStop: false, stopped: true };
    } catch { return st; }
  }
  rows() { return this.c.journal.state.inbox.filter(r => TYPES.includes(r.type)); }
  queuedFor(id) { return this.rows().filter(r => r.sessionId === id && r.type === 'session_send' && ['session-queued', 'session-held'].includes(r.state)).map(r => ({ requestId: r.id, text: brief(r.text || (r.pcm ? '语音（识别中）' : '附件'), 60), state: r.state === 'session-held' ? 'held' : 'queued' })); }
  reply(row, state, text, extra = {}) { this.c.emit('session-status-' + row.id + '-' + state, { type: 'status', requestId: row.id, state, text, sessionId: row.sessionId, ...extra }); }
  done(row, state = 'done', patch = {}) { this.c.journal.change(() => { row.state = state; Object.assign(row, patch); delete row.pcm; }); }
  refresh(id) { const w = this.watches.get(id); if (w) { w.sig = null; w.last = 0; } }
  async process() {
    if (!this.available()) {
      for (const row of this.rows().filter(r => r.state === 'session-queued')) { this.done(row, 'rejected', { issue: '电脑 Hub 未支持' }); this.reply(row, 'rejected', '电脑 Hub 需重启到新版后才能直接对话。'); }
      return;
    }
    for (const row of this.rows().filter(r => r.state === 'session-queued' && r.type !== 'session_send')) {
      try {
        if (row.type === 'session_turns_get') {
          const body = await this.turns(row.sessionId, { before: row.before || null, limit: 8 });
          this.c.emit('session-turns-' + row.id, { type: 'session_turns', requestId: row.id, ...body, append: !!row.before });
          this.done(row);
        } else if (row.type === 'session_stop') {
          this.target(row.sessionId, { write: true });
          const st = this.state(row.sessionId);
          if (!st.canStop) { this.done(row); this.reply(row, 'done', '会话已经停下了。'); continue; }
          const last = this.stopAt.get(row.sessionId) || 0;
          if (Date.now() - last >= STOP_THROTTLE_MS) { this.stopAt.set(row.sessionId, Date.now()); await this.deps.interruptSession(row.sessionId); this.stopHints.set(row.sessionId, { at: Date.now() }); }
          this.done(row); this.reply(row, 'done', '已发送停止。'); this.refresh(row.sessionId);
          this.c.log({ id: row.id, role: 'user', input: 'text', text: '手机 → 「' + st.title + '」：停止' });
        } else if (row.type === 'session_key') {
          this.target(row.sessionId, { write: true });
          const st = this.state(row.sessionId);
          if (!st.canKeys) throw Error('这个会话不是终端会话，按键请在电脑上操作');
          if (!st.busy && !st.waiting) throw Error('会话现在没有在等你，按键未发送');
          this.deps.sessionKeys(row.sessionId, KEYS[String(row.key)]);
          this.done(row); this.reply(row, 'done', '已按下 ' + ({ enter: '回车', esc: 'Esc', up: '↑', down: '↓', tab: 'Tab', space: '空格' }[row.key] || row.key) + '。'); this.refresh(row.sessionId);
        } else if (row.type === 'session_cancel') {
          const target = this.rows().find(r => r.id === row.target && r.type === 'session_send' && ['session-queued', 'session-held'].includes(r.state));
          if (target) { this.done(target, 'rejected', { issue: '手机上已取消' }); this.reply(target, 'cancelled', '已取消，这条没有发给会话。'); }
          this.done(row); this.refresh(row.sessionId);
        }
      } catch (e) { this.done(row, 'rejected', { issue: e.message }); this.reply(row, 'rejected', e.message); }
    }
    for (const row of this.rows().filter(r => r.type === 'session_send' && ['session-queued', 'session-held'].includes(r.state))) await this.send(row);
    await this.logResults();
  }
  async send(row) {
    try {
      const s = this.target(row.sessionId, { write: true });
      if (row.pcm && !String(row.text || '').trim()) {
        const heard = String(await this.c.transcribe(row.pcm)).trim();
        if (!heard) throw Error('没有听清，请再说一次');
        this.c.journal.change(() => { row.text = heard; row.inputMode = 'voice'; delete row.pcm; });
        this.c.emit('transcript-' + row.id, { type: 'transcript', requestId: row.id, text: heard, auto: true, sessionId: row.sessionId });
      }
      const text = String(row.text || '').trim();
      if (!text) throw Error('消息为空');
      if (!row.logged) { this.c.log({ id: row.id, role: 'user', input: row.inputMode === 'voice' ? 'voice' : 'text', text: '手机 → 「' + String(s.title || s.name || '会话') + '」：' + text }); this.c.journal.change(() => { row.logged = true; }); }
      if (!this.deps.getSession?.(row.sessionId)) {
        // 会话在电脑上关着：按原生身份恢复后再发（与助理派工同一规则），身份对不上就不发。
        const meta = this.deps.getSessionMetadata?.(row.sessionId);
        const { nativeId } = require('../hub-assistant/live-history');
        if (!meta || !nativeId(meta) || !this.deps.resumeSession) throw Error('会话未打开且缺少原生身份，请在电脑上打开后再发');
        await this.deps.resumeSession(row.sessionId);
        const opened = this.deps.getSession?.(row.sessionId);
        if (!opened || nativeId(opened) !== nativeId(meta)) throw Error('会话恢复后身份未确认，消息未发送');
      }
      const st = await this.liveState(row.sessionId);
      if (st.busy || st.waiting) {
        if (Date.now() - (row.t?.received || Date.now()) > HOLD_MAX_MS) throw Error('排队超过 2 小时，会话一直没空下来，这条没有发送');
        if (row.state !== 'session-held') { this.c.journal.change(() => { row.state = 'session-held'; }); this.reply(row, 'held', st.waiting ? '会话在等你处理，处理完后自动发送。' : '会话正在工作，答完后自动发送。'); this.refresh(row.sessionId); }
        return;
      }
      this.c.journal.change(() => { row.state = 'session-sending'; row.t = { ...row.t, dispatch: Date.now() }; });
      const wire = require('../hub-assistant/delegated-prompt').encodeDelegatedPrompt(text, this.deps.getSession?.(row.sessionId)?.kind);
      this.stopHints.delete(row.sessionId);
      const r = await this.deps.sendPrompt(row.sessionId, wire, row.id);
      const confirmed = r?.ok === true && r?.receipt?.status === 'confirmed' && !r.notSent && !r.contentMismatch;
      if (confirmed) { this.done(row, 'done', { awaitResult: true, sentAt: Date.now() }); this.reply(row, 'received', '已发给「' + st.title + '」。'); }
      else if (r?.notSent) { this.done(row, 'rejected', { issue: r.message || r.error || '未发送' }); this.reply(row, 'rejected', (r.message || r.error || '会话没有接收') + '。这条没有发送，可以再发一次。'); }
      else { this.done(row, 'unknown', { issue: r?.message || r?.error || '送达未确认', awaitResult: true, sentAt: Date.now() }); this.reply(row, 'unknown', '是否送达尚未确认，请看卡片；不会自动重发。'); }
      this.refresh(row.sessionId);
    } catch (e) {
      const sending = row.state === 'session-sending';
      this.done(row, sending ? 'unknown' : 'rejected', { issue: e.message });
      this.reply(row, sending ? 'unknown' : 'rejected', sending ? '提交中断：' + e.message + '。请看卡片确认，不会自动重发。' : e.message);
    }
  }
  // 手机发出的消息跑完后，把会话最后一张回答记进助理对话记录（电脑助理页也看得到手机都干了什么）。
  async logResults() {
    for (const row of this.rows().filter(r => r.type === 'session_send' && r.awaitResult && !r.resultLogged)) {
      if (Date.now() - (row.sentAt || 0) > HOLD_MAX_MS) { this.c.journal.change(() => { row.resultLogged = true; }); continue; }
      if (Date.now() - (row.sentAt || 0) < 3000 || (await this.liveState(row.sessionId)).busy) continue;
      try {
        const { turns, title } = await this.turns(row.sessionId, { limit: 2 });
        const answer = turns.filter(t => t.role === 'assistant').at(-1);
        this.c.log({ id: row.id + ':result', role: 'assistant', lane: 'session', by: title || '会话', text: answer?.text || '（会话已停下，没有新的文字回答）' });
      } catch (e) { this.c.log({ id: row.id + ':result', role: 'system', text: '手机发出的消息结果暂时读不到：' + e.message }); }
      this.c.journal.change(() => { row.resultLogged = true; });
    }
  }
  // 订阅中的会话：内容或状态有变化才推，至少隔 2 秒；在等你时附终端最后一屏和可点的选项。
  async push() {
    if (!this.available()) return;
    const now = Date.now();
    for (const [id, w] of [...this.watches]) {
      if (now > w.until) { this.watches.delete(id); continue; }
      if (now - w.last < PUSH_GAP_MS) continue;
      w.last = now;
      try {
        const state = await this.liveState(id);
        const body = await this.turns(id, { limit: 3 });
        const screen = state.isOpen && (state.waiting || w.screen) && state.canKeys ? await this.screen(id) : null;
        const queued = this.queuedFor(id);
        const sig = JSON.stringify([state, body.turns.map(t => [t.id, t.text.length, t.tools?.count, t.running]), screen, queued]);
        if (sig === w.sig) continue;
        w.sig = sig;
        this.c.emit('session-live-' + crypto.randomUUID(), { type: 'session_live', sessionId: id, state, turns: body.turns, hasMore: body.hasMore, screen, queued, at: now });
      } catch (e) {
        const sig = 'error:' + e.message; if (sig === w.sig) continue; w.sig = sig;
        this.c.emit('session-live-' + crypto.randomUUID(), { type: 'session_live', sessionId: id, error: e.message, at: now });
      }
    }
  }
  // Hub 重启时还在提交中的手机消息：不知道是否送达，标成待核对，不自动重发。
  recover() {
    const stuck = this.rows().filter(r => r.state === 'session-sending');
    if (!stuck.length) return;
    this.c.journal.change(() => { for (const r of stuck) { r.state = 'unknown'; r.issue = 'Hub 重启打断了提交，是否送达请看卡片；不自动重发'; } });
  }
}
module.exports = { SessionChat, SESSION_TYPES: TYPES, renderScreen, renderRows, screenOptions, cardOf };
