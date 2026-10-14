'use strict';
// core/session-scenes.js
//
// 会话场景（2026-10-13 用户提出并确认）：不是所有任务都该用编程助手的提示词。讨论无线、投研、写作、
// 带团队、生活琐事时，换一份为该场景写的系统提示。
//
// 场景库在 ~/.agents/scenes/*.md（每个场景一个文件，开头 frontmatter 写 id / label / desc 等），
// 知识库在 ~/.agents/knowledge/<名>/（INDEX.md + 主题正文），由场景的 knowledge 字段挂上。
// 「编程开发」是默认场景：什么都不换，和没有场景时完全一样。
//
// 非编程场景的启动方式照搬写作成员的干净启动（core/writing/member-opts.js）：
//   - 系统提示 = 场景提示词，其中插入「关于用户」（从个人规则的「身份与沟通」「用户说明书（摘要）」两节现截，
//     只维护一处），挂了知识库的再接上索引
//   - Claude：--system-prompt-file 换掉编程助手系统提示；关 CLAUDE.md、自动记忆、技能、浏览器说明，默认输出风格
//   - Codex：model_instructions_file 换掉基础指令；用写作成员那套干净配置目录（不带全局 AGENTS.md）
//   - 不带「规则」页的通用规则、不追加工作区规则
// 会话的场景记在 purpose 上（scene-<id>），新建、恢复、重启三条路径都按它重新拼启动参数。
//
// 中途换场景：Claude 接续旧会话时沿用会话开头记录下的系统提示快照（2026-10-13 实测 6/6 次），
// 换不掉；所以有对话的会话换场景 = 新开一个该场景的会话并引用原会话（renderer 负责）。

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const PREFIX = 'scene-';
const DEFAULT_SCENE = 'coding';
const CLAUDE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'];
const BASE_SECTIONS = [['身份与沟通', '身份与沟通'], ['用户说明书（摘要）', '用户说明书（摘要）']];
const MAX_PROMPT_BYTES = 48 * 1024;

const isScenePurpose = purpose => typeof purpose === 'string' && purpose.startsWith(PREFIX) && purpose.length > PREFIX.length;
const sceneIdOf = purpose => (isScenePurpose(purpose) ? purpose.slice(PREFIX.length) : DEFAULT_SCENE);
const scenePurpose = id => (!id || id === DEFAULT_SCENE ? null : PREFIX + id);
// 带自己整套提示词、不再叠加 Hub 通用规则与个人规则的会话
const isCleanPurpose = purpose => purpose === 'writing' || isScenePurpose(purpose);

function readText(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'); } catch { return ''; }
}

function homeOf(env = process.env, dataDir) {
  return require('./agent-user-context').contextHome(env, dataDir);
}
function scenesDir(env, dataDir) { const home = homeOf(env, dataDir); return home ? path.join(home, '.agents', 'scenes') : null; }
function knowledgeRoot(env, dataDir) { const home = homeOf(env, dataDir); return home ? path.join(home, '.agents', 'knowledge') : null; }

function parseScene(text, file) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(meta.id || '') || !meta.label) return null;
  return { ...meta, body: m[2].trim(), file };
}

// 知识库：INDEX.md 进系统提示（每轮都带），主题正文由 AI 按需读
function readKnowledge(name, env, dataDir) {
  const root = knowledgeRoot(env, dataDir);
  if (!name || !root || !/^[a-z0-9][a-z0-9_-]*$/i.test(name)) return null;
  const dir = path.join(root, name);
  const index = readText(path.join(dir, 'INDEX.md')).trim();
  if (!index) return null;
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'INDEX.md' && !f.startsWith('_') && !/说明\.md$/.test(f)); } catch {}
  let entries = 0;
  for (const f of files) entries += (readText(path.join(dir, f)).match(/^### /gm) || []).length;
  return { name, dir, index, files, entries, indexEntries: (index.match(/^- /gm) || []).length,
    indexBytes: Buffer.byteLength(index, 'utf8') };
}

function listScenes({ env = process.env, dataDir } = {}) {
  const dir = scenesDir(env, dataDir);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort(); } catch { files = []; }
  const scenes = [];
  for (const f of files) {
    const scene = parseScene(readText(path.join(dir, f)), path.join(dir, f));
    if (scene && !scenes.some(s => s.id === scene.id)) scenes.push(scene);
  }
  if (!scenes.length) return [];
  if (!scenes.some(s => s.id === DEFAULT_SCENE)) {
    scenes.unshift({ id: DEFAULT_SCENE, label: '编程开发', desc: '写代码、改 Hub、做工具和网页', body: '', file: null });
  }
  return scenes.map(s => ({ ...s, knowledgeInfo: s.knowledge ? readKnowledge(s.knowledge, env, dataDir) : null }));
}

function getScene(id, opts = {}) { return listScenes(opts).find(s => s.id === id) || null; }

// 「关于用户」：个人规则里两节的原文。缺了就不加，场景照常可用。
function baseSection(env, dataDir) {
  const ctx = require('./agent-user-context').loadUserContext(env, dataDir);
  if (!ctx) return '';
  const text = ctx.content.replace(/\r\n/g, '\n');
  const parts = [];
  for (const [title, heading] of BASE_SECTIONS) {
    const re = new RegExp('^## ' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*$([\\s\\S]*?)(?=^## |(?![\\s\\S]))', 'm');
    const m = re.exec(text);
    if (m && m[1].trim()) parts.push('### ' + heading + '\n\n' + m[1].trim());
  }
  return parts.length ? '## 关于用户\n\n' + parts.join('\n\n') : '';
}

function writingBody(scene) {
  let pack = '';
  // 单人会话没有群规则：去掉群聊交稿那一句，交稿格式用场景自己的「回复格式」
  pack = pack.split('\n').filter(line => !line.startsWith('- 交稿：')).join('\n').trim();
  const i = scene.body.indexOf('## 回复格式');
  const format = i >= 0 ? scene.body.slice(i) : '';
  return { pack, format };
}

/** 拼出某个场景实际发给 AI 的系统提示全文。编程场景返回空串。 */
function composeScenePrompt(scene, { env = process.env, dataDir } = {}) {
  if (!scene || scene.id === DEFAULT_SCENE) return '';
  const base = baseSection(env, dataDir);
  let text;
  if (scene.id === 'writing') {
    const { pack, format } = writingBody(scene);
    text = [pack || scene.body.split('\n## 回复格式')[0], base, format].filter(Boolean).join('\n\n');
  } else {
    const body = scene.body;
    const i = body.search(/^## 怎么/m);
    text = !base ? body : i >= 0 ? body.slice(0, i) + base + '\n\n' + body.slice(i) : body + '\n\n' + base;
  }
  const kb = scene.knowledgeInfo || (scene.knowledge ? readKnowledge(scene.knowledge, env, dataDir) : null);
  if (kb) {
    const index = kb.index.replace(/^# .*$/m, '## 知识库索引（' + scene.label + '）');
    text += '\n\n' + index + '\n\n正文目录：`' + kb.dir.replace(/\\/g, '/') + '`';
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_PROMPT_BYTES) throw new Error(`场景「${scene.label}」的系统提示有 ${Math.round(bytes / 1024)} KB，超过 ${MAX_PROMPT_BYTES / 1024} KB 上限，请精简场景提示词或知识库索引`);
  return text.trim() + '\n';
}

function writePromptFile(text, sceneId, dataDir) {
  const dir = path.join(dataDir, 'scene-prompts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sceneId}-${createHash('sha256').update(text).digest('hex').slice(0, 12)}.md`);
  if (readText(file) !== text) fs.writeFileSync(file, text, 'utf8');
  return file;
}

function isClaudeFamily(kind) {
  return /^(claude|deepseek-legacy|deepseek-claude)(?:$|-)/.test(String(kind || ''));
}
function isCodexFamily(kind, opts = {}) {
  const k = String(kind || '').replace(/-resume$/, '');
  return k === 'codex' || (k === 'deepseek' && !opts.deepseekLegacyClaude);
}
const supportsScenes = (kind, opts = {}) => isClaudeFamily(kind) || isCodexFamily(kind, opts);

/**
 * 按会话的场景改写启动参数。非场景会话原样返回。
 * 场景文件缺失或拼装失败：照常以编程场景启动，并在 sceneWarning 里写明原因（状态栏可见，不静默）。
 */
function applySceneLaunch(kind, opts = {}, { env = process.env, dataDir } = {}) {
  if (!isScenePurpose(opts.purpose)) return opts;
  const id = sceneIdOf(opts.purpose);
  if (!supportsScenes(kind, opts)) return { ...opts, sceneWarning: '这个 CLI 暂不支持场景，本次按编程开发启动' };
  let text = '';
  try {
    const scene = getScene(id, { env, dataDir });
    if (!scene) return { ...opts, sceneWarning: `找不到场景「${id}」（~/.agents/scenes），本次按编程开发启动` };
    text = composeScenePrompt(scene, { env, dataDir });
  } catch (error) {
    return { ...opts, sceneWarning: '场景提示词没拼好，本次按编程开发启动：' + error.message };
  }
  if (!text) return opts;
  const file = writePromptFile(text, id, dataDir);
  const next = { ...opts, mcpProfile: 'none' };
  delete next.codexMcpEntries;
  delete next.mcpConfigFile;
  delete next.appendSystemPromptFile;
  if (isClaudeFamily(kind)) {
    const home = homeOf(env, dataDir);
    const readable = home ? [path.join(home, '.agents'), path.join(home, '.claude', 'projects')] : [];
    next.extraEnv = { ...(opts.extraEnv || {}), CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' };
    next.claudeOutputStyle = 'default';
    next.disableSlashCommands = true;
    next.claudeNoChrome = true;
    next.claudeTools = [...CLAUDE_TOOLS];
    next.systemPromptFile = file;
    next.addDirs = [...new Set([...(Array.isArray(opts.addDirs) ? opts.addDirs : []), ...readable.filter(d => fs.existsSync(d))])];
  } else {
    next.codexInstructionFile = file;
  }
  next.scenePromptFile = file;
  return next;
}

// ---- 「规则 → 场景」页用：默认场景、保存场景提示词 ----

function settingsFile(dataDir) { return path.join(dataDir, 'session-scenes.json'); }
function getDefaultScene(dataDir) {
  try { const v = JSON.parse(readText(settingsFile(dataDir))).defaultScene; return typeof v === 'string' && v ? v : DEFAULT_SCENE; }
  catch { return DEFAULT_SCENE; }
}
function setDefaultScene(dataDir, id, opts = {}) {
  if (id !== DEFAULT_SCENE && !getScene(id, { ...opts, dataDir })) throw new Error('没有这个场景：' + id);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsFile(dataDir), JSON.stringify({ defaultScene: id }, null, 2), 'utf8');
  return id;
}

const sha = text => createHash('sha256').update(String(text)).digest('hex');
function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 保存场景提示词正文（frontmatter 不动）。改前的版本备份到 scenes/_history/，baseSha 不符说明文件被别处改过。 */
function saveSceneBody(id, body, { baseSha, env = process.env, dataDir } = {}) {
  const scene = getScene(id, { env, dataDir });
  if (!scene || !scene.file) throw new Error('这个场景没有对应的提示词文件，不能编辑');
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new Error('提示词不能为空');
  if (Buffer.byteLength(text, 'utf8') > 32 * 1024) throw new Error('场景提示词超过 32 KB，请精简');
  const raw = readText(scene.file);
  if (baseSha && sha(scene.body) !== baseSha) throw new Error('提示词文件在别处被改过，请刷新后再编辑');
  const front = /^---\n[\s\S]*?\n---\n?/.exec(raw)[0];
  const history = path.join(path.dirname(scene.file), '_history');
  fs.mkdirSync(history, { recursive: true });
  fs.writeFileSync(path.join(history, `${path.basename(scene.file, '.md')}-${stamp()}.md`), raw, 'utf8');
  fs.writeFileSync(scene.file, front + text + '\n', 'utf8');
  return getScene(id, { env, dataDir });
}

/** 给界面的场景列表：带上实际发送内容的大小和知识库摘要。 */
function scenesSnapshot({ env = process.env, dataDir } = {}) {
  const list = listScenes({ env, dataDir });
  return {
    dir: scenesDir(env, dataDir),
    defaultScene: getDefaultScene(dataDir),
    scenes: list.map(s => {
      let sent = '', error = null;
      try { sent = composeScenePrompt(s, { env, dataDir }); } catch (e) { error = e.message; }
      const kb = s.knowledgeInfo;
      return { id: s.id, label: s.label, desc: s.desc || '', base: s.base || '', engineering: s.engineering || '',
        outputStyle: s.output_style || '', tools: s.tools || '', skills: s.skills || '', knowledge: s.knowledge || '',
        file: s.file, body: s.body, bodySha: sha(s.body), sent, sentBytes: Buffer.byteLength(sent, 'utf8'), error,
        knowledgeInfo: kb ? { name: kb.name, dir: kb.dir, entries: kb.entries, indexEntries: kb.indexEntries,
          indexBytes: kb.indexBytes, files: kb.files, index: kb.index } : null };
    }),
  };
}

module.exports = { getDefaultScene, setDefaultScene, saveSceneBody, scenesSnapshot,
  PREFIX, DEFAULT_SCENE, CLAUDE_TOOLS, isScenePurpose, isCleanPurpose, sceneIdOf, scenePurpose, supportsScenes,
  listScenes, getScene, readKnowledge, baseSection, composeScenePrompt, applySceneLaunch, scenesDir, knowledgeRoot, parseScene };
