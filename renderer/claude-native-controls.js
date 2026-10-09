'use strict';
const { isNativeNoticeDismissed, dismissNativeNotice } = require('./native-notice-dismissal');

function createClaudeNativeControls({ sessionId, ipcRenderer, onHistory, onRestoreDraft }) {
  const element = document.createElement('section');
  element.className = 'claude-native-controls codex-native-controls';
  element.hidden = true;
  element.setAttribute('aria-label', '原生会话操作');
  // Only for what needs the user: the same contract as the Codex panel, which
  // stays hidden unless there is an approval, a recovery step or an error.
  // Runtime status belongs to the composer and is not repeated here.
  const notice = document.createElement('div');
  notice.className = 'claude-native-notice';
  // Plan mode is a session-wide setting, so it gets the same banner and
  // "切回默认模式" button as the Codex panel instead of a bare /plan off.
  // Built and mounted only while plan mode is on: a hidden button here would
  // still be the panel's first button and swallow clicks meant for a form.
  let modeBox = null, modeReset = null;
  function mountModeBox(runtime) {
    if (!modeBox) {
      modeBox = document.createElement('div'); modeBox.className = 'codex-native-mode';
      const text = document.createElement('span'); text.textContent = '计划模式 · 只讨论不改文件；后续消息沿用此模式。';
      const modeError = document.createElement('div'); modeError.className = 'codex-native-error';
      modeReset = document.createElement('button'); modeReset.type = 'button'; modeReset.textContent = '切回默认模式';
      modeReset.addEventListener('click', async () => {
        modeReset.disabled = true; modeError.textContent = '';
        try {
          const result = await ipcRenderer.invoke('claude-native:set-permission-mode', { sessionId, mode: 'default' });
          if (!result?.ok) throw new Error(result?.error || '引擎未确认');
        } catch (failure) { modeError.textContent = failure.message; modeReset.disabled = false; }
      });
      modeBox.append(text, modeReset, modeError);
    }
    if (!modeBox.isConnected) element.insertBefore(modeBox, requests);
    modeReset.disabled = viewer || runtime.connection !== 'connected'
      || !['idle', 'completed', 'failed', 'interrupted'].includes(runtime.state);
  }
  const requests = document.createElement('div');
  const error = document.createElement('div'); error.className = 'claude-native-error';
  error.style.color = '#e88'; error.setAttribute('role', 'alert');
  const errorRow = document.createElement('div'); errorRow.className = 'native-dismissible-notice';
  const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = '忽略本次';
  dismiss.className = 'native-notice-dismiss';
  dismiss.title = '隐藏本次提示，保留实际状态；不会重发消息';
  errorRow.append(error, dismiss);
  let currentSession = null;
  dismiss.addEventListener('click', () => { dismissNativeNotice(currentSession, error.textContent); refreshVisibility(); });
  let displayedActionError = null;
  element.append(notice, requests, errorRow);
  const refreshVisibility = () => {
    errorRow.hidden = !error.textContent || isNativeNoticeDismissed(currentSession, error.textContent);
    element.hidden = !(notice.textContent || modeBox?.isConnected || requests.childElementCount
      || !errorRow.hidden);
  };
  let signature = '';
  let viewer = false;
  const forms = new Map();
  const pendingForms = new WeakSet();
  async function act(request, decision, button) {
    if(viewer)return;
    const form = button.closest('form');
    if (pendingForms.has(form)) return;
    pendingForms.add(form);
    form.querySelectorAll('button,input,textarea,select').forEach(control => { control.disabled = true; });
    error.textContent = '';
    try {
      const result = await ipcRenderer.invoke('claude-native:respond', { sessionId, requestId: request.id,
        epoch: request.epoch, submissionId: request.submissionId, decision });
      if (!result?.ok) throw new Error(result?.error || '操作未确认');
    } catch (failure) {
      error.textContent = failure.message; pendingForms.delete(form);
      form.querySelectorAll('button,input,textarea,select').forEach(control => { control.disabled = viewer; });
    }
    refreshVisibility();
  }
  function update(session) {
    if (session?.runtimeBackend !== 'claude-stream-json') { element.hidden = true; return; }
    currentSession = session;
    const runtime = session.nativeRuntime || {};
    viewer = require('../core/session-observer-policy').isSessionViewer(session);
    notice.textContent = runtime.configurationChange ? '正在更新设置，等待 Claude 确认'
      // 超时之后再说「等待 Claude 确认」就是在骗人：没有人还在等，需要的是核对。
      : runtime.cancellation?.status === 'unknown' ? '停止结果未确认，请核对上次任务；不会自动重发'
      : runtime.cancellation ? '正在停止，等待 Claude 确认'
      : runtime.connection === 'unstarted' ? '尚未开始，收到消息后启动。' : '';
    if (runtime.permissionMode === 'plan') mountModeBox(runtime);
    else if (modeBox?.isConnected) modeBox.remove();
    const recovering = runtime.state === 'unknown' || runtime.connection === 'disconnected';
    const actionError = recovering && session.nativeActionError === runtime.reason ? null : session.nativeActionError || null;
    if (actionError !== displayedActionError) {
      if (actionError) error.textContent = actionError;
      else if (error.textContent === displayedActionError) error.textContent = '';
      displayedActionError = actionError;
    }
    const activeRequests = runtime.cancellation?.status === 'pending' ? [] : runtime.requests || [];
    const next = JSON.stringify([runtime.epoch, viewer, activeRequests.map(item => [item.id,item.submissionId])]);
    if (next === signature) { refreshVisibility(); return; }
    signature = next;
    const children = [];
    for (const request of activeRequests) {
      const key = JSON.stringify([runtime.epoch, request.id, request.submissionId]);
      if (forms.has(key)) { children.push(forms.get(key)); continue; }
      const box = document.createElement('form'); box.dataset.requestId = request.id;
      box.className = 'codex-native-request';
      box.dataset.epoch = String(runtime.epoch);
      const title = document.createElement('strong');
      title.textContent = request.method === 'claude/requestUserInput' ? 'Claude 需要你回答' : '工具审批：' + request.params.toolName;
      box.append(title);
      const inputs = [];
      if (request.method === 'claude/requestUserInput') {
        for (const question of request.params.questions || []) {
          const label = document.createElement('label'); label.style.display = 'block';
          label.textContent = question.question;
          const input = document.createElement(question.isSecret ? 'input' : 'textarea'); input.required = true;
          if (question.isSecret) input.type = 'password';
          input.rows = 2; input.setAttribute('aria-label', question.question);
          input.disabled = viewer;
          label.append(input); box.append(label); inputs.push([question.question, input]);
          for (const option of question.options || []) {
            const choose = document.createElement('button'); choose.type = 'button';
            choose.textContent = option.label; choose.title = option.description || '';
            choose.addEventListener('click', () => {
              if (viewer || pendingForms.has(box)) return;
              if (question.multiSelect) {
                const values = input.value ? input.value.split(', ') : [];
                input.value = values.includes(option.label) ? values.filter(value=>value!==option.label).join(', ')
                  : [...values, option.label].join(', ');
              } else input.value = option.label;
              input.focus();
            });
            box.append(choose);
          }
        }
      } else {
        const detail = document.createElement('pre');
        detail.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:18vh;overflow:auto';
        detail.textContent = JSON.stringify(request.raw.input, null, 2); box.append(detail);
      }
      const allow = document.createElement('button'); allow.type = 'submit';
      allow.textContent = inputs.length ? '提交回答' : '允许本次';
      const deny = document.createElement('button'); deny.type = 'button'; deny.textContent = '拒绝';
      allow.disabled = viewer; deny.disabled = viewer;
      const actions = document.createElement('div'); actions.className = 'codex-native-actions';
      actions.append(allow, deny); box.append(actions);
      box.addEventListener('submit', event => {
        event.preventDefault();
        if (!box.reportValidity()) return;
        act(request, { behavior: 'allow', updatedInput: inputs.length
          ? { ...request.raw.input, answers: Object.fromEntries(inputs.map(([question, input]) => [question, input.value])) }
          : request.raw.input }, allow);
      });
      deny.addEventListener('click', () => act(request, { behavior: 'deny' }, deny));
      forms.set(key, box); children.push(box);
    }
    const focused = document.activeElement;
    const keep = new Set(children);
    for (const [key, form] of forms) if (!keep.has(form)) forms.delete(key);
    children.forEach((child,index) => {
      if (requests.children[index] !== child) requests.insertBefore(child,requests.children[index] || null);
      child.querySelectorAll('button,input,textarea,select').forEach(control => {
        control.disabled = viewer || pendingForms.has(child);
      });
    });
    while (requests.children.length > children.length) requests.lastElementChild.remove();
    if (focused && requests.contains(focused) && document.activeElement !== focused) focused.focus();
    refreshVisibility();
  }
  return { element, update };
}

module.exports = { createClaudeNativeControls };
