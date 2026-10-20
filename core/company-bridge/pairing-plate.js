'use strict';
// 配对号牌（2026-10-20）：家里和公司两侧 Hub 用同一个号牌标出「这条公司会话对接的是家里哪个会话、家里用的哪家模型」，
// 一眼看出谁对接谁。格式：Q21 · 家「会话名前 10 字 #短码」· 模型。
// 短码取家里 Hub 会话编号的前 4 位字母数字（小写）：同一会话永远同一个短码，看到短码能回查到原会话；
// 家里同时开着的会话通常几十个，4 位十六进制有 65536 种，撞上的概率很低，撞了也有会话名区分。
// 两侧都会用到（公司版导出带这个文件），只放纯函数。
const NAME_CHARS = 10;

const clean = s => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/[「」【】]/g, '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => Array.from(clean(s)).slice(0, n).join('').trim();

function shortCode(sessionId) {
  return String(sessionId || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4);
}

// 家里实际模型的显示名：先看模型编号（第三方模型跑在 Claude Code / Codex CLI 里时，种类名说明不了是谁在答），再看会话种类。
const MODEL_FAMILIES = [
  [/deepseek/, 'DeepSeek'], [/glm|zhipu|智谱/, 'GLM'], [/kimi|moonshot/, 'Kimi'], [/qwen|通义/, 'Qwen'],
  [/minimax/, 'MiniMax'], [/gemini/, 'Gemini'],
];
const KIND_FAMILIES = [
  ...MODEL_FAMILIES,
  [/codex|gpt/, 'Codex'], [/claude|opus|sonnet|haiku/, 'Claude'], [/codeagent/, 'CodeAgent'],
];
function modelLabel(kind, model) {
  const m = String(model || '').toLowerCase();
  for (const [re, label] of MODEL_FAMILIES) if (re.test(m)) return label;
  const k = String(kind || '').toLowerCase().replace(/-resume$/, '');
  for (const [re, label] of KIND_FAMILIES) if (re.test(k)) return label;
  if (/claude|opus|sonnet|haiku/.test(m)) return 'Claude';
  if (/gpt|codex/.test(m)) return 'Codex';
  return k.replace(/[^a-z0-9]/g, '').slice(0, 12) || '';
}

// 「Q-1020-21」→ Q21；别的格式原样（截短）。
function threadShort(id) {
  const m = /^Q-(\d{4})-(\d+)$/.exec(String(id || ''));
  return m ? 'Q' + Number(m[2]) : clip(id, 12);
}

// 家里会话那一半：「会话名前 10 字 #短码」（短码缺了就只写名字）。
function homeLabel({ title, code } = {}) {
  const name = clip(title, NAME_CHARS) || '未命名';
  return code ? `${name} #${code}` : name;
}

function plate({ thread, title, code, model } = {}) {
  return `${threadShort(thread)} · 家「${homeLabel({ title, code })}」· ${model || '未知模型'}`;
}

// 换号重做的第几次：新字段 redoCount 优先（prevSessions 只留最近 5 个，次数多了会少算）。
function redoNumber(t = {}) {
  const n = Number(t.redoCount) || (Array.isArray(t.prevSessions) ? t.prevSessions.length : 0);
  return n > 0 ? n + 1 : 0;
}

// 公司会话名：家里带了短码（新版家里）用号牌；老版家里没带，退回旧名「1020-Q21-codex」；
// 换号重做的新会话一律加「· 重做 N」，不再出现两个同名会话。
function companySessionTitle(t = {}) {
  const from = t.from && typeof t.from === 'object' ? t.from : {};
  const redo = redoNumber(t);
  const suffix = redo ? ` · 重做 ${redo}` : '';
  const m = /^Q-(\d{4})-(\d+)$/.exec(String(t.id || ''));
  if (m && from.code) return plate({ thread: t.id, title: from.title, code: clean(from.code).slice(0, 8), model: clip(from.model, 16) || modelLabel(from.kind) }) + suffix;
  if (!m) return '特战 · ' + clip(t.title, 26) + suffix;
  const kind = String(from.kind || '').toLowerCase();
  const agent = /codex/.test(kind) ? 'codex' : /deepseek/.test(kind) ? 'deepseek' : /claude/.test(kind) ? 'claude' : kind.replace(/[^a-z0-9]/g, '').slice(0, 12) || 'home';
  return `${m[1]}-Q${Number(m[2])}-${agent}${suffix}`;
}

// ---- 界面上的几句（两侧渲染层共用）----
const lastMetaOf = t => [...((t && t.rounds) || [])].reverse().find(r => r && r.meta)?.meta || null;
// 公司一端：「家里 会话名 #短码 · DeepSeek」。老版本家里没带短码时返回空串（界面退回旧写法）。
function homePairText(from) {
  if (!from || typeof from !== 'object' || !from.code) return '';
  const model = clip(from.model, 16) || modelLabel(from.kind);
  return `家里 ${homeLabel({ title: from.title, code: clean(from.code).slice(0, 8) })}${model ? ' · ' + model : ''}`;
}
// 公司一端：「本会话由 号 1 · GLM-5 作答」。pairing 来自 status 里的 t.pairing，缺了用最近一轮回执的 meta。
function answeredByText(t) {
  const p = (t && t.pairing) || {}, meta = lastMetaOf(t) || {};
  const alias = p.accountAlias || meta.accountAlias || '';
  const model = p.model || meta.actualModel || meta.model || '';
  if (!alias && !model) return '';
  return `本会话由 ${[alias, model].filter(Boolean).join(' · ')} 作答`;
}
// 家里一端：「→ 公司 号 1 · GLM-5 · 会话 Q21 · 家「…」· Codex」。公司回传的优先，老公司不回传用 ask 时推算的会话名。
function companyPairText(t, { withPlate = true } = {}) {
  if (!t) return '';
  const c = t.company || {}, meta = lastMetaOf(t) || {};
  const alias = c.accountAlias || meta.accountAlias || '';
  const model = c.model || meta.actualModel || meta.model || '';
  const name = withPlate ? (c.sessionTitle || t.companyPlate || t.plate || '') : '';
  const parts = [alias, model, name ? '会话 ' + name : ''].filter(Boolean);
  return parts.length ? '→ 公司 ' + parts.join(' · ') : '';
}

// 号牌认法（侧栏「特战」筛选等用）：新号牌、旧名都算，带不带「· 重做 N」都算。
const PLATE_TITLE_RE = /^Q\d+ · 家「[^」]*」· /;
const LEGACY_TITLE_RE = /^\d{4}-Q\d+-[a-z0-9]+(?: · 重做 \d+)?$/;
const isPlateTitle = title => PLATE_TITLE_RE.test(String(title || '').trim()) || LEGACY_TITLE_RE.test(String(title || '').trim());

module.exports = { NAME_CHARS, shortCode, modelLabel, threadShort, homeLabel, plate, redoNumber, companySessionTitle, isPlateTitle, PLATE_TITLE_RE, LEGACY_TITLE_RE,
  homePairText, answeredByText, companyPairText };
