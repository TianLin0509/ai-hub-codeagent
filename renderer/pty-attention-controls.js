'use strict';

// PTY 跑的 Claude / Codex 在等人操作（工具授权、提问、选项）时，卡片视图里
// 给出一条提示和「到终端处理」按钮。
//
// 第一版刻意不在卡片上直接作答：答案必须由 CLI 自己的界面接收。Hub 往 TUI 里
// 模拟方向键 / 回车去替用户选，就是回到「盲发按键」的老路，选错了还没有回执。
// 提示内容来自 hook（PermissionRequest、AskUserQuestion 的 PreToolUse、
// Notification）或终端画面识别，只是把「卡在哪」告诉用户。

const { RUNTIME_WAITING } = require('../core/session-runtime-truth.js');

function createPtyAttentionControls({ onOpenTerminal } = {}) {
  const element = document.createElement('section');
  element.className = 'pty-attention-controls codex-native-controls';
  element.hidden = true;
  element.setAttribute('aria-label', '终端等待操作');
  const title = document.createElement('strong');
  title.textContent = '终端在等你操作';
  const header = document.createElement('div');
  header.className = 'pty-attention-header';
  const detail = document.createElement('div');
  detail.className = 'pty-attention-detail';
  detail.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:18vh;overflow:auto;margin:6px 0';
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = '到终端处理';
  open.title = '切到终端视图，在 CLI 原生界面里回答或授权';
  open.addEventListener('click', () => { if (typeof onOpenTerminal === 'function') onOpenTerminal(); });
  const collapse = document.createElement('button');
  collapse.type = 'button';
  collapse.className = 'pty-attention-collapse';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'pty-attention-close';
  close.textContent = '×';
  close.title = '关闭此提示，不会取消终端正在等待的操作';
  close.setAttribute('aria-label', '关闭提示');
  let currentKey = null;
  let dismissed = false;
  let collapsed = false;
  function paint() {
    detail.hidden = collapsed;
    collapse.textContent = collapsed ? '展开' : '折叠';
    collapse.title = collapsed ? '展开提示详情' : '折叠提示详情';
    collapse.setAttribute('aria-expanded', String(!collapsed));
  }
  collapse.addEventListener('click', () => { collapsed = !collapsed; paint(); });
  close.addEventListener('click', () => { dismissed = true; element.hidden = true; });
  header.append(title, open, collapse, close);
  element.append(header, detail);
  paint();

  function update(session, runtime) {
    const waiting = !!session && session.agentRuntime === 'pty' && !session.runtimeBackend
      && runtime && runtime.state === RUNTIME_WAITING;
    if (!waiting) {
      element.hidden = true;
      currentKey = null;
      dismissed = false;
      return;
    }
    const text = String(runtime.detail || '').trim() || '需要授权或回答问题';
    // Repeated status heartbeats must not undo a user's dismissal. A new
    // question/turn, or leaving and re-entering waiting, can notify again.
    const key = JSON.stringify([session.id || session.hubId, runtime.turnId, runtime.reason, text]);
    if (key !== currentKey) {
      currentKey = key;
      dismissed = false;
      collapsed = false;
      paint();
    }
    element.hidden = dismissed;
    if (detail.textContent !== text) detail.textContent = text;
  }

  return { element, update };
}

module.exports = { createPtyAttentionControls };
