'use strict';
// 卡片上「发送内容」按钮打开的面板：这条消息发出去时请求里依次有哪几块，每块可展开看原文。
// 数据由 core/prompt-composition.js 组装；规则文件与系统提示规则经主进程 prompt-composition 读取。

const GROUP_STYLE = {
  system: { cls: 'pc-c-system', legend: '系统提示' },
  startup: { cls: 'pc-c-startup', legend: '规则与记忆' },
  attached: { cls: 'pc-c-attached', legend: '本条附带' },
  user: { cls: 'pc-c-user', legend: '你的正文' },
};

function fmtTokens(n) {
  if (n == null) return '';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function partSize(p) {
  if (p.unavailable && p.text == null) return '拿不到原文';
  return `${p.chars.toLocaleString('zh-CN')} 字 · ≈${fmtTokens(p.tokens)} tokens`;
}

function renderComposition(model, { escapeHtml }) {
  // 体量条按四类上色：附带块和用户正文同属「这条消息」，但要分开看。
  const buckets = { system: 0, startup: 0, attached: 0, user: 0 };
  for (const g of model.groups) for (const p of g.parts) {
    const key = g.id === 'message' ? (p.id === 'user' ? 'user' : 'attached') : g.id;
    buckets[key] += p.tokens || 0;
  }
  const total = Object.values(buckets).reduce((a, b) => a + b, 0) || 1;
  const bar = Object.entries(buckets).filter(([, n]) => n > 0)
    .map(([k, n]) => `<i class="${GROUP_STYLE[k].cls}" style="width:${Math.max(0.8, n / total * 100).toFixed(2)}%"></i>`).join('');
  // CLI 内置的系统提示词和工具定义其实不小，只是读不到；图例上写明，别让「≈0」误导。
  const legend = Object.entries(buckets)
    .map(([k, n]) => `<span><i class="pc-sq ${GROUP_STYLE[k].cls}"></i>${GROUP_STYLE[k].legend} ≈${fmtTokens(n)}${k === 'system' ? ' ＋ CLI 内置（未知）' : ''}</span>`).join('');

  const groups = model.groups.map(g => {
    const parts = g.parts.map(p => `
      <details class="pc-part${p.unavailable ? ' pc-unavailable' : ''}" data-part-id="${escapeHtml(p.id)}">
        <summary><span class="pc-title">${escapeHtml(p.title)}</span><span class="pc-size">${escapeHtml(partSize(p))}</span></summary>
        ${p.path ? `<div class="pc-path">${escapeHtml(p.path)}</div>` : ''}
        ${p.note ? `<div class="pc-note">${escapeHtml(p.note)}</div>` : ''}
        ${p.text != null ? `<pre>${escapeHtml(p.text || '（空）')}</pre>` : ''}
      </details>`).join('');
    return `<section class="pc-group" data-group="${escapeHtml(g.id)}">
      <h4>${escapeHtml(g.title)}<span class="pc-size">≈${fmtTokens(g.tokens)} tokens</span></h4>
      ${g.note ? `<p class="pc-note">${escapeHtml(g.note)}</p>` : ''}
      ${parts || '<p class="pc-note">（无）</p>'}
    </section>`;
  }).join('');

  return `<div class="pc-summary">合计约 ${fmtTokens(model.tokens)} tokens（粗估，不含拿不到原文的 CLI 内置部分）</div>
    <div class="pc-bar">${bar}</div>
    <div class="pc-legend">${legend}</div>
    ${groups}`;
}

async function openPromptComposition({ turn, sessionId, doc = document, ipc, escapeHtml }) {
  const { buildComposition } = require('../core/prompt-composition');
  const modal = doc.createElement('dialog');
  modal.className = 'card-detail-dialog prompt-composition-dialog';
  modal.innerHTML = '<div class="card-detail-dialog-head"><strong>发送内容 · 这条消息的组成</strong>'
    + '<button type="button" aria-label="关闭发送内容">关闭</button></div><div class="pc-body"><p class="pc-note">正在读取…</p></div>';
  modal.querySelector('.card-detail-dialog-head button').addEventListener('click', () => modal.close());
  modal.addEventListener('close', () => modal.remove(), { once: true });
  doc.body.appendChild(modal);
  modal.showModal();
  let data = null, error = null;
  try {
    const res = await ipc.invoke('prompt-composition', { sessionId });
    if (res && res.ok) data = res.data; else error = (res && res.error) || '读取失败';
  } catch (e) { error = e && e.message ? e.message : String(e); }
  const model = buildComposition({ turn, kind: data?.kind, systemRules: data?.systemRules,
    assembly: data?.assembly, assemblyError: error || data?.assemblyError });
  const body = modal.querySelector('.pc-body');
  if (body) body.innerHTML = renderComposition(model, { escapeHtml });
  return modal;
}

module.exports = { openPromptComposition, renderComposition };
