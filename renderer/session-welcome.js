'use strict';
const path = require('path');

function renderSessionWelcome(session, escapeHtml) {
  const kind = String(session?.kind || 'claude').replace(/-resume$/, '');
  const provider = kind==='deepseek-acp' ? 'deepseek' : ['claude', 'codex', 'gemini', 'kimi', 'deepseek','qwen','glm','codeagent'].includes(kind) ? kind : 'claude';
  const label = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', kimi: 'Kimi', deepseek: 'DeepSeek',qwen:'千问 · Qwen Code',glm:'智谱 · ZCode',codeagent:'CodeAgent' }[provider];
  const assistant = session?.purpose === 'hub-assistant';
  const mark = `<img src="${assistant ? 'assets/assistant/penguin.png' : `assets/ai-logos/${provider}.svg`}" alt="${assistant ? '企鹅助理' : label}" />`;
  const cwd = session?.cwd || '';
  const project = session?.workspaceLabel || path.basename(cwd) || '当前工作区';
  const actions = assistant ? [
    ['最近的进展', '看看最近有哪些变化', '请用白话汇报最近三小时最重要的变化，以及现在需要我处理什么。附上可核对的来源。', '<path d="M3 12h18M12 3v18"/>'],
    ['需要我处理', '先找到需要决定的事', '当前有哪些事情需要我决定、确认或补充？请依据实际工作记录回答。', '<path d="m5 12 4 4L19 6"/>'],
    ['下一步', '把决定交给原会话推进', '根据最近的工作进展，建议我接下来优先处理什么，并说明依据。', '<path d="M4 12h16m-6-6 6 6-6 6"/>'],
  ] : [
    ['梳理项目', '先了解结构，再决定下一步', '请先梳理当前项目的结构与主要入口，简要说明各部分的作用，先不要修改代码。', '<path d="M3 7h7l2 2h9v10H3Z"/><path d="M3 7V4h7l2 3"/>'],
    ['实现想法', '把目标变成可执行的改动', '我想在当前项目实现一个功能：', '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>'],
    ['排查问题', '从现象和证据开始定位', '请帮我排查这个问题，先确认原因再修改。现象是：', '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M10 7v4m0 2v.1"/>'],
  ];
  return `<section class="msg-overlay-placeholder session-welcome" aria-label="新会话欢迎页">
    <div class="session-welcome-mark">${mark}</div>
    <span class="session-welcome-eyebrow">${assistant ? '你的 AI Hub 工作伙伴' : `和 ${label} 一起开始`}</span>
    <h2>${assistant ? '用户，想先聊聊哪件事？' : '今天，想完成什么？'}</h2>
    <p class="session-welcome-intro">描述你的目标，或从下面选一个起点。</p>
    <div class="session-welcome-project" title="${escapeHtml(cwd)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 2h9v12H3Z"/></svg><span>${escapeHtml(project)}</span></div>
    <div class="session-welcome-actions">${actions.map(([title, detail, prompt, icon]) => `<button type="button" data-welcome-prompt="${escapeHtml(prompt)}" title="填入输入框，确认后再发送；已有草稿会保留"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><strong>${title}</strong><small>${detail}</small></button>`).join('')}</div>
    <p class="session-welcome-hint">消息、文件或一个还没成形的想法，都可以从这里开始。</p>
  </section>`;
}
module.exports = { renderSessionWelcome };
