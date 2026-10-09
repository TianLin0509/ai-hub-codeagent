'use strict';

// PTY Claude 的 /clear、/compact 不触发 UserPromptSubmit，提交闭环要靠各自的确认信号收尾。
// 这里决定「一个信号确认哪一条提交」（第 5 轮 R7：一次确认曾把两条同类提交都标成成功）。
//
// 真机取证（2026-09-26，Claude Code 2.1.283，tests/probe-claude-session-hooks.js --compact）：
//   /compact keep alpha notes →
//     PreCompact { trigger:'manual', custom_instructions:'keep alpha notes', prompt_id:P }
//     SessionStart { source:'compact', prompt_id:P }            ← 同一个执行周期，同一个 prompt_id
//   /clear → SessionEnd { reason:'clear', prompt_id:Q } → SessionStart { source:'clear' }
//
// 规则：
//   · 按会话、按命令排队，先提交的在前（CLI 也按这个顺序执行排队的命令）。
//   · 一个执行周期只确认一条：同一 prompt_id 的第二个信号不再确认任何提交。
//   · /compact 的确认带参数时，只确认参数相同的那条；对不上就不确认（保留未知）。
//   · 自动压缩（trigger=auto）不是用户命令，不确认任何提交。
//   · 只有周期结束信号（SessionStart source=compact）而没有开始信号：证据不足，不确认。
//   · 没有周期标识和参数的旧式信号：只确认最早的一条，绝不一次确认多条。

const MAX_SEEN_CYCLES = 64;

const normalizeArgs = value => String(value == null ? '' : value).trim().replace(/\s+/g, ' ');

function parseLocalCommand(text) {
  const match = /^\/(clear|compact)(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  return match ? { command: match[1].toLowerCase(), args: normalizeArgs(match[2]) } : null;
}

class LocalCommandAcks {
  constructor() {
    this.queues = new Map();      // `${sessionId}\n${command}` -> [ticket]，按提交顺序
    this.seenCycles = new Map();  // sessionId -> [cycleId]，最近处理过的执行周期
    this.nextSeq = 1;
  }

  _queue(sessionId, command) {
    const key = `${sessionId}\n${command}`;
    if (!this.queues.has(key)) this.queues.set(key, []);
    return this.queues.get(key);
  }

  register(sessionId, command, args = '') {
    const queue = this._queue(sessionId, command);
    let confirmed = false, onLate = null;
    const ticket = {
      seq: this.nextSeq++, sessionId, command, args: normalizeArgs(args),
      get confirmed() { return confirmed; },
      _confirm: () => {
        if (confirmed) return;
        confirmed = true;
        const index = queue.indexOf(ticket);
        if (index >= 0) queue.splice(index, 1);
        if (onLate) { const cb = onLate; onLate = null; cb(); }
      },
      async wait(timeoutMs = Number(process.env.CLAUDE_HUB_LOCAL_COMMAND_ACK_MS) || 15000) {
        const deadline = Date.now() + timeoutMs;
        while (!confirmed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 60));
        return confirmed ? { ok: true } : { ok: false, message: command === 'clear'
          ? '未收到 Claude /clear 后的新会话身份，请检查终端'
          : '未收到 Claude /compact 开始压缩的确认，请检查终端' };
      },
      onConfirm(cb) { if (confirmed) cb(); else onLate = cb; },
      dispose() {
        onLate = null;
        const index = queue.indexOf(ticket);
        if (index >= 0) queue.splice(index, 1);
      },
    };
    queue.push(ticket);
    return ticket;
  }

  _cycleSeen(sessionId, cycleId) {
    if (!cycleId) return false;
    const seen = this.seenCycles.get(sessionId) || [];
    if (seen.includes(cycleId)) return true;
    seen.push(cycleId);
    if (seen.length > MAX_SEEN_CYCLES) seen.shift();
    this.seenCycles.set(sessionId, seen);
    return false;
  }

  /**
   * 一个确认信号。返回被确认的那张票，或 null（不确认任何提交）。
   * @param {{command:string, phase?:'start'|'end', cycleId?:string, args?:string|null, trigger?:string}} signal
   */
  signal(sessionId, { command, phase = 'start', cycleId = null, args = null, trigger = null } = {}) {
    if (!sessionId || !command) return null;
    if (trigger === 'auto') { this._cycleSeen(sessionId, cycleId); return null; }
    // 同一周期的第二个信号（PreCompact 之后的 SessionStart compact）不再确认任何提交。
    if (this._cycleSeen(sessionId, cycleId)) return null;
    if (phase === 'end') return null; // 只有结束、没有开始：证据不足，保留未知
    const queue = this._queue(sessionId, command);
    const pending = queue.filter(ticket => !ticket.confirmed);
    const wanted = args == null ? null : normalizeArgs(args);
    const ticket = wanted == null ? pending[0] : pending.find(t => t.args === wanted);
    if (!ticket) return null;
    ticket._confirm();
    return ticket;
  }

  pending(sessionId, command) {
    return this._queue(sessionId, command).filter(t => !t.confirmed).map(t => ({ seq: t.seq, args: t.args }));
  }
}

// 每个 sessionManager 一份，只订阅一次事件；main.js 负责按取证结果 emit：
//   claude-local-command-ack  { sessionId, command:'compact', phase, cycleId, args, trigger }
//   claude-identity-switched  { sessionId, source, cycleId }   （source=clear 才确认 /clear）
const registries = new WeakMap();
function localCommandAcksFor(manager) {
  if (registries.has(manager)) return registries.get(manager);
  const acks = new LocalCommandAcks();
  const trace = (event, ticket) => {
    if (!ticket) return;
    console.log(`[local-command-ack] ${String(event.sessionId).slice(0, 8)} /${ticket.command}`
      + `${ticket.args ? ' "' + ticket.args.slice(0, 60) + '"' : ''} #${ticket.seq} confirmed by cycle ${event.cycleId || '-'}`);
  };
  manager.on('claude-local-command-ack', event => {
    if (!event || !event.sessionId) return;
    trace(event, acks.signal(event.sessionId, { command: event.command || 'compact', phase: event.phase || 'start',
      cycleId: event.cycleId || null, args: event.args === undefined ? null : event.args, trigger: event.trigger || null }));
  });
  manager.on('claude-identity-switched', event => {
    if (!event || !event.sessionId) return;
    if (event.source && event.source !== 'clear') return; // /resume、重启不是 /clear
    trace(event, acks.signal(event.sessionId, { command: 'clear', cycleId: event.cycleId || null }));
  });
  registries.set(manager, acks);
  return acks;
}

module.exports = { LocalCommandAcks, localCommandAcksFor, parseLocalCommand, normalizeArgs };
