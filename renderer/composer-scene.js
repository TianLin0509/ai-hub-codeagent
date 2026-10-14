'use strict';
// 输入框的「场景」按钮（2026-10-13）：选这个会话用哪个场景的提示词（场景库见 core/session-scenes.js）。
//   - 还没开聊的会话：直接换成新场景（新开一个同设置的会话，草稿带过去，空会话收起）
//   - 已有对话的会话：Claude 接续时换不掉开头的系统提示（2026-10-13 实测 6/6 次），所以新开一个该场景的会话，
//     输入框自动放好对原会话的引用；原会话保留
const scenes = require('../core/session-scenes');
const { isFreshSession } = require('../core/session-history-state');

let cache = null;
let cacheAt = 0;
async function loadScenes(ipcRenderer, force = false) {
  if (!force && cache && Date.now() - cacheAt < 30000) return cache;
  try {
    const r = await ipcRenderer.invoke('session-scenes:snapshot');
    if (r && r.ok) { cache = r.data; cacheAt = Date.now(); }
  } catch (_) { /* 拿不到就不显示按钮 */ }
  return cache;
}

function eligible(session) {
  if (!session || session.meetingId || session.hiddenFromSidebar) return false;
  if (session.purpose && !scenes.isScenePurpose(session.purpose)) return false;
  return scenes.supportsScenes(String(session.kind || ''), session);
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/**
 * @param onSwitch  async (sceneId, { fresh }) => void：真正去新开会话（renderer.js 负责）
 */
function mountComposerSceneChip({ composer, tuningControls, before, sessionId, getSession, ipcRenderer, onSwitch }) {
  const doc = composer.ownerDocument;
  const chip = doc.createElement('button');
  chip.type = 'button';
  chip.className = 'composer-chip composer-scene';
  chip.hidden = true;
  chip.setAttribute('aria-expanded', 'false');
  chip.title = '场景：按任务换一套提示词（编程、技术讨论、投研……）';
  const menu = doc.createElement('div');
  menu.className = 'composer-scene-popover';
  menu.hidden = true;
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', '选择场景');
  composer.append(menu);
  if (before && before.parentNode === tuningControls) tuningControls.insertBefore(chip, before);
  else tuningControls.append(chip);

  let pending = null;
  let busy = false;
  const current = () => scenes.sceneIdOf(getSession()?.purpose);
  const labelOf = (data, id) => data?.scenes?.find(s => s.id === id)?.label || (id === scenes.DEFAULT_SCENE ? '编程开发' : id);

  async function refresh(force) {
    const data = await loadScenes(ipcRenderer, force);
    const session = getSession();
    const show = !!(data && data.scenes && data.scenes.length > 1 && eligible(session));
    chip.hidden = !show;
    if (show) chip.textContent = '场景 · ' + labelOf(data, current());
    return data;
  }

  function paint(data) {
    const session = getSession();
    const fresh = isFreshSession(session, { allowMissingTranscript: true });
    const cur = current();
    if (pending) {
      const target = data.scenes.find(s => s.id === pending);
      menu.innerHTML = `<div class="cs-confirm"><div class="cs-title">换到「${esc(target?.label || pending)}」</div>`
        + '<p>这个会话已经聊过。AI 接续旧会话时会沿用开头那份提示词，中途换不掉，所以会新开一个「'
        + esc(target?.label || pending) + '」会话，输入框里自动放好对这段聊天的引用；原会话保留在左侧。</p>'
        + `<div class="cs-actions"><button type="button" class="cs-cancel">取消</button><button type="button" class="cs-go" data-go="${esc(pending)}">新开「${esc(target?.label || pending)}」会话并引用</button></div></div>`;
      return;
    }
    menu.innerHTML = '<div class="cs-head">这个会话的场景</div>' + data.scenes.map(s => {
      const kb = s.knowledgeInfo ? `<span class="cs-kb">知识库 ${s.knowledgeInfo.entries} 条</span>` : '';
      return `<button type="button" class="cs-item${s.id === cur ? ' on' : ''}" data-scene="${esc(s.id)}" role="menuitemradio" aria-checked="${s.id === cur}">`
        + `<span class="cs-check">${s.id === cur ? '✓' : ''}</span><span class="cs-main"><span class="cs-label">${esc(s.label)}${kb}</span>`
        + `<span class="cs-desc">${esc(s.desc)}</span></span></button>`;
    }).join('') + `<div class="cs-note">${fresh ? '还没开聊：选了直接生效。' : '已经聊过：换场景会新开一个会话并引用这段聊天，原会话保留。'}在左侧「规则 → 场景」里看每个场景带了什么。</div>`;
  }

  const close = () => { menu.hidden = true; pending = null; chip.setAttribute('aria-expanded', 'false'); };
  chip.addEventListener('click', async () => {
    if (!menu.hidden) { close(); return; }
    const data = await refresh(true);
    if (!data || chip.hidden) return;
    pending = null;
    paint(data);
    menu.hidden = false;
    chip.setAttribute('aria-expanded', 'true');
  });
  menu.addEventListener('click', async e => {
    if (busy) return;
    if (e.target.closest('.cs-cancel')) { pending = null; paint(cache); return; }
    const go = e.target.closest('[data-go]');
    const item = e.target.closest('[data-scene]');
    const target = go ? go.getAttribute('data-go') : item ? item.getAttribute('data-scene') : null;
    if (!target) return;
    if (target === current()) { close(); return; }
    const fresh = isFreshSession(getSession(), { allowMissingTranscript: true });
    if (!go && !fresh) { pending = target; paint(cache); return; }
    busy = true;
    chip.disabled = true;
    try { await onSwitch(target, { fresh }); close(); }
    finally { busy = false; chip.disabled = false; }
  });
  const outside = e => { if (!menu.hidden && !menu.contains(e.target) && !chip.contains(e.target)) close(); };
  const key = e => { if (!menu.hidden && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); chip.focus(); } };
  doc.addEventListener('pointerdown', outside, true);
  composer.addEventListener('keydown', key);
  void refresh(false);
  return {
    refresh: () => refresh(false),
    dispose() { doc.removeEventListener('pointerdown', outside, true); composer.removeEventListener('keydown', key); },
  };
}

module.exports = { mountComposerSceneChip, loadScenes, eligible };
