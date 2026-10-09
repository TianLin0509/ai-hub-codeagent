'use strict';

const pasteChips = require('./composer-paste-chips');
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 20 12-12 4 4L8 24Z" transform="translate(0 -3)"/><path d="m13 8 4 4M5 3v4M3 5h4M19 2v4M17 4h4M20 17v4M18 19h4"/></svg>';

function attachPromptPolish({ input, rail, before, ipcRenderer, getTarget, isActive, writeText }) {
  const doc = input.ownerDocument;
  const tools = doc.createElement('span'); tools.className = 'prompt-polish-tools';
  const makeButton = (label, className) => {
    const el = doc.createElement('button'); el.type = 'button'; el.className = className;
    el.title = label; el.setAttribute('aria-label', label); return el;
  };
  const button = makeButton('整理 Prompt · DeepSeek Flash', 'prompt-polish-button'); button.innerHTML = ICON;
  const undo = makeButton('撤销整理', 'prompt-polish-undo'); undo.textContent = '撤销'; undo.hidden = true;
  const status = doc.createElement('span'); status.className = 'prompt-polish-status'; status.setAttribute('role', 'status'); status.hidden = true;
  tools.append(status, undo, button); rail.insertBefore(tools, before);
  let request = null, previous = null, disposed = false, revision = 0, timer;
  const read = () => pasteChips.expandPasteMarkers(input.innerText || '');
  const targetId = () => getTarget()?.id;
  const active = id => !disposed && !!id && targetId() === id && input.isConnected && input.isContentEditable && isActive(id);
  const setStatus = message => { clearTimeout(timer); status.textContent = message; status.hidden = !message; status.title = message; };
  const notice = message => { setStatus(message); timer = setTimeout(() => setStatus(''), 6000); };
  const refresh = () => { undo.hidden = !previous || !active(previous.target) || read() !== previous.result; };
  const changed = () => { revision++; refresh(); };
  const observer = new MutationObserver(changed);
  observer.observe(input, { subtree: true, childList: true, characterData: true });
  input.addEventListener('input', changed);
  const write = text => {
    writeText(text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  };
  const idle = () => {
    button.innerHTML = ICON; button.title = '整理 Prompt · DeepSeek Flash';
    button.setAttribute('aria-label', button.title); button.setAttribute('aria-busy', 'false');
  };
  button.addEventListener('click', async event => {
    event.stopPropagation();
    if (request) {
      const old = request; request = null; idle(); notice('已取消，原稿保留');
      void ipcRenderer.invoke('prompt:polish-cancel', old.id).catch(() => {}); return;
    }
    const target = targetId();
    if (!active(target)) return;
    const text = read();
    if (!text.trim()) { notice('请先输入要整理的文字'); input.focus(); return; }
    // Flush pre-existing mutations before capturing the draft revision.
    if (observer.takeRecords().length) revision++;
    const current = { id: globalThis.crypto.randomUUID(), target, text, revision };
    request = current;
    button.textContent = '取消'; button.title = '取消整理'; button.setAttribute('aria-label', '取消整理'); button.setAttribute('aria-busy', 'true');
    setStatus('整理中…');
    try {
      const result = await ipcRenderer.invoke('prompt:polish', { id: current.id, text });
      if (request !== current || disposed) return;
      // Edits, sends, voice transcription and switching rooms all win over an
      // outstanding rewrite, including edit-then-restore to the same string.
      if (!active(target) || revision !== current.revision || read() !== text) {
        notice('草稿已变化，已保留当前输入'); return;
      }
      if (!result?.ok) { notice(result?.message || '整理失败，原稿已保留'); return; }
      if (typeof result.text !== 'string' || !result.text.trim()) { notice('整理未返回正文，原稿已保留'); return; }
      if (result.text === text) { notice('表达已清楚，保留原稿'); return; }
      previous = { target, original: text, result: result.text };
      write(result.text); refresh(); notice('已整理，请检查后发送');
    } catch { if (request === current && !disposed) notice('整理失败，原稿已保留'); }
    finally { if (request === current) { request = null; idle(); } }
  });
  undo.addEventListener('click', event => {
    event.stopPropagation();
    if (!previous || !active(previous.target) || read() !== previous.result) { refresh(); return; }
    const original = previous.original; previous = null;
    write(original); refresh(); notice('已恢复原稿');
  });
  return { dispose() {
    disposed = true; clearTimeout(timer); observer.disconnect(); input.removeEventListener('input', changed);
    if (request) void ipcRenderer.invoke('prompt:polish-cancel', request.id).catch(() => {});
    request = previous = null; tools.remove();
  } };
}

module.exports = { attachPromptPolish };
