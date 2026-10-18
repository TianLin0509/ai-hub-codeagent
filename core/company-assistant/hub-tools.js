'use strict';
// 公司助理管 Hub 会话的工具（2026-10-18 用户定：手机上只和助理说话，由助理去管其他 CodeAgent 会话，不做指令集）。
// 思路同家里助理（core/hub-assistant 的 list_sessions / send_session / create_session / watch_session），按公司版简化：
//   - 只有公司助理会话本身能调：本机接口要口令，还按请求头里的会话编号核对身份（AssistantBridge）。
//   - 不碰特殊会话：助理自己、论坛摘要、替家里办事的会话（company-bridge，内容会带回家）、群聊成员。
//   - 发话、新建、按键、停止都直接执行（用户 10-18 选「直接执行，事后复述」）；发过话、新建的会话自动「盯着」，
//     做完或卡住时由 phone.js 推到手机群。
const fs = require('node:fs');
const path = require('node:path');
const { AssistantBridge } = require('../hub-assistant/bridge');

const SPECIAL = new Set(['company-assistant', 'company-forum', 'company-bridge', 'hub-assistant', 'hub-photo-assistant']);
const KEYS = { enter: '\r', esc: '\x1b', up: '\x1b[A', down: '\x1b[B', tab: '\t', space: ' ', y: 'y', n: 'n',
  1: '1', 2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9' };
const LABELS = { stuck: '卡住了，在等你确认或选择', running: '运行中', reply: '答完了，在等你回复', idle: '空闲', closed: '没打开（发话时自动恢复）' };
const TEXT_MAX = 20000;
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
const baseKind = k => String(k || '').replace(/-resume$/, '');

class HubTools {
  constructor(assistant, deps = {}) {
    this.a = assistant; this.deps = deps;
    this.endpointFile = path.join(assistant.dir, 'tools-endpoint.json');
    this.bridge = new AssistantBridge(request => this.invoke(request), { identityHeader: 'x-hub-company-assistant-session' });
  }
  async start() {
    await this.bridge.start();
    fs.mkdirSync(path.dirname(this.endpointFile), { recursive: true });
    const tmp = this.endpointFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ url: this.bridge.url, token: this.bridge.secret }), { mode: 0o600 });
    fs.renameSync(tmp, this.endpointFile);
  }
  close() { this.bridge.close(); }
  // 挂给助理会话的 MCP（session-manager 的 extraMcpProvider 调用）。Hub 程序以 Node 方式运行 mcp.js（公司版脚本在 app.asar 里）。
  mcpEntry(sessionId) {
    return { name: 'hub_sessions', command: this.deps.nodeExecutable || process.execPath, args: [path.join(__dirname, 'mcp.js')],
      env: { ELECTRON_RUN_AS_NODE: '1', HUB_COMPANY_TOOLS_ENDPOINT: this.endpointFile, HUB_COMPANY_ASSISTANT_SESSION_ID: String(sessionId || '') } };
  }

  // ---- 会话状态（Hub 侧栏同一套事实：CLI hook 上报的运行与等待） ----
  row(s, open) {
    const id = s.id || s.hubId;
    const busy = open && (!!this.deps.isAgentTurnActive?.(id) || s.status === 'running');
    const needs = open && (s.needsUserInput === true || s.attentionState === 'needs-input');
    const state = !open ? 'closed' : needs && busy ? 'stuck' : busy ? 'running' : needs ? 'reply' : 'idle';
    return { id, title: String(s.title || s.name || '未命名会话').slice(0, 100), kind: baseKind(s.kind), cwd: s.cwd || '', open, state, label: LABELS[state],
      waitingText: state === 'stuck' ? short(s.waitingText || '', 300) : '', lastActiveAt: Number(s.lastOutputAt) || Number(s.updatedAt) || Number(s.createdAt) || null };
  }
  manageable(s) { return !!s && !!(s.id || s.hubId) && !SPECIAL.has(s.purpose) && !s.meetingId && (s.id || s.hubId) !== this.a.state().sessionId; }
  rows({ closed = 20 } = {}) {
    const live = (this.deps.getAllSessions?.() || []).filter(s => this.manageable(s)).map(s => this.row(s, true));
    const seen = new Set(live.map(r => r.id));
    const old = (this.deps.listKnownSessions?.() || []).filter(s => this.manageable(s) && !seen.has(s.id || s.hubId)).map(s => this.row(s, false))
      .sort((x, y) => (y.lastActiveAt || 0) - (x.lastActiveAt || 0)).slice(0, closed);
    return [...live, ...old];
  }
  find(id) {
    const r = this.rows({ closed: 200 }).find(x => x.id === String(id || ''));
    if (!r) throw new Error('找不到这个会话，或它是助理自己、论坛、家里联动、群聊成员这类不归助理管的会话。先用 list_sessions 查编号');
    return r;
  }
  lastFinal(id) { return this.a.lastFinal(id); }
  async screen(id) {
    if (typeof this.deps.readTerminalScreen !== 'function') return null;
    try {
      const raw = await this.deps.readTerminalScreen(id);
      if (!raw) return null;
      const { renderScreen } = require('../hub-phone/session-chat');
      return await renderScreen(raw);
    } catch { return null; }
  }

  // ---- 工具 ----
  async invoke({ name, arguments: args = {}, callerSessionId }) {
    const me = this.a.state().sessionId;
    if (!me || callerSessionId !== me) throw new Error('只有公司助理会话能用这些工具');
    if (name === 'list_sessions') {
      return { sessions: this.rows().map(r => ({ ...r, lastActiveAt: r.lastActiveAt ? new Date(r.lastActiveAt).toLocaleString('zh-CN', { hour12: false }) : null })),
        note: 'state：stuck=卡住等确认或选择（可用 press_keys 回答），running=运行中，reply=答完在等回复，idle=空闲，closed=没打开。' };
    }
    if (name === 'read_session') {
      const r = this.find(args.sessionId);
      const final = this.lastFinal(r.id);
      const max = Math.max(500, Math.min(12000, Number(args.maxChars) || 4000));
      const text = String(final?.text || '');
      return { ...r, lastAnswer: text ? (text.length > max ? text.slice(-max) : text) : null, lastAnswerTruncated: text.length > max,
        lastAnswerAt: final?.timestamp || final?.ts || null, screen: r.state === 'stuck' || args.screen ? await this.screen(r.id) : undefined };
    }
    if (name === 'send_session') {
      const r = this.find(args.sessionId), text = String(args.text || '').trim();
      if (!text || text.length > TEXT_MAX) throw new Error(`要发的话为空或超过 ${TEXT_MAX} 字`);
      if (r.state === 'running') throw new Error('这个会话正在运行，等它这一轮做完再发；需要的话先用 watch_session 盯着它');
      if (r.state === 'stuck') throw new Error('这个会话卡在确认或选择上，打字进不去：先用 read_session 看画面，再用 press_keys 回答');
      if (!r.open) {
        if (!this.deps.resumeSession) throw new Error('这个会话没打开，也没法自动恢复');
        await this.deps.resumeSession(r.id);
        if (!this.deps.getSession?.(r.id)) throw new Error('这个会话没能恢复，没有发出');
      }
      const baseline = this.lastFinal(r.id)?.id || null;
      const receipt = await this.deps.sendPrompt(r.id, text, require('node:crypto').randomUUID());
      if (!receipt || receipt.notSent || (receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck')) throw new Error(receipt?.error || '没有发进这个会话');
      this.a.phone?.watch(r.id, { baseline, title: r.title, why: 'send' });
      return { ok: true, sessionId: r.id, title: r.title, watched: true, note: '已发出。它做完或卡住时 Hub 会推到手机群，不用你轮询。' };
    }
    if (name === 'create_session') {
      const title = String(args.title || '').trim().slice(0, 60) || '助理派的任务', text = String(args.text || '').trim();
      if (!text || text.length > TEXT_MAX) throw new Error(`任务为空或超过 ${TEXT_MAX} 字`);
      const cwd = String(args.cwd || '').trim();
      if (cwd && !(this.deps.isDirectory || (p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }))(cwd)) throw new Error('工作目录不存在：' + cwd);
      const id = require('node:crypto').randomUUID();
      const created = await this.deps.createSession('codeagent', { id, title, ...(cwd ? { cwd } : {}), noInheritCursor: true });
      if (!created || created.id !== id) throw new Error('新会话没能打开');
      this.a.phone?.watch(id, { baseline: null, title, why: 'create' });
      const receipt = await this.deps.sendPrompt(id, text, require('node:crypto').randomUUID());
      if (!receipt || receipt.notSent || (receipt.ok === false && !receipt.unconfirmed && receipt.sendStatus !== 'stuck')) throw new Error('会话已建好，但任务没发进去：' + (receipt?.error || '原因不明'));
      return { ok: true, sessionId: id, title, cwd: created.cwd || cwd || null, watched: true, note: '已新建并交代任务。做完或卡住时 Hub 会推到手机群。' };
    }
    if (name === 'watch_session') {
      const r = this.find(args.sessionId);
      this.a.phone?.watch(r.id, { baseline: this.lastFinal(r.id)?.id || null, title: r.title, why: 'watch' });
      return { ok: true, sessionId: r.id, title: r.title, state: r.label, note: '盯上了：它下一次答完或卡住时推到手机群（24 小时内有效）。' };
    }
    if (name === 'press_keys') {
      const r = this.find(args.sessionId);
      const keys = (Array.isArray(args.keys) ? args.keys : [args.keys]).map(String).filter(Boolean).slice(0, 6);
      if (!keys.length || keys.some(k => !Object.prototype.hasOwnProperty.call(KEYS, k))) throw new Error('按键只能是 ' + Object.keys(KEYS).join(' / '));
      if (r.state !== 'stuck') throw new Error('这个会话现在没有卡在确认或选择上，按键没发');
      if (!this.deps.sessionKeys) throw new Error('这台 Hub 不支持远程按键');
      for (const k of keys) { this.deps.sessionKeys(r.id, KEYS[k]); await new Promise(res => setTimeout(res, 250)); }
      this.a.phone?.watch(r.id, { baseline: this.lastFinal(r.id)?.id || null, title: r.title, why: 'keys' });
      await new Promise(res => setTimeout(res, 1200));
      return { ok: true, sessionId: r.id, pressed: keys, screenAfter: await this.screen(r.id) };
    }
    if (name === 'stop_session') {
      const r = this.find(args.sessionId);
      if (!['running', 'stuck'].includes(r.state)) return { ok: true, sessionId: r.id, note: '它本来就没在运行' };
      if (!this.deps.interruptSession) throw new Error('这台 Hub 不支持远程停止');
      await this.deps.interruptSession(r.id);
      return { ok: true, sessionId: r.id, title: r.title, note: '已发送停止（和电脑上按停止键一样）。' };
    }
    throw new Error('未知工具：' + name);
  }
}

module.exports = { HubTools, KEYS, SPECIAL };
