'use strict';
// Directory discovery is intentionally off the Electron main thread. No history DB.
const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData, isMainThread } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const inspector = require('./memory-inspector');
const { projectRoot } = require('./hub-memory-service');
const { projectPathKey } = require('./session-search-projects');
const { classifyRule, globalRuleFiles } = require('./memory-rule-files');

function collectCatalog({ homeDir, workspaceRoot, memoryRoot, sessions, workspaces = [], legacyWorkspaceRoots = [] }) {
  // 旧工作根（AI_HUB_LEGACY_WORKSPACE_ROOTS）里的会话按自己所在的根截断规则链。
  const knownRoots = [workspaceRoot, ...legacyWorkspaceRoots].filter(Boolean);
  const rootFor = cwd => {
    for (const root of knownRoots) {
      const rel = path.relative(path.resolve(root), path.resolve(cwd));
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return root;
    }
    return workspaceRoot;
  };
  const files = new Map(), projects = new Map(), directories = new Set(), warnings = [];
  const roots = new Map();
  const warn = (p, e) => { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') warnings.push(`${p}：${e.message}`); };
  const real = p => { try { return fs.realpathSync.native(p); } catch (e) { warn(p, e); return p; } };
  function project(cwd) {
    const key = projectPathKey(cwd);
    if (!key) return null;
    if (roots.has(key)) return roots.get(key);
    const root = projectRoot(cwd), rootKey = projectPathKey(root);
    const id = createHash('sha256').update(rootKey).digest('hex').slice(0, 24);
    const p = projects.get(id) || { id, cwd: root, label: path.basename(root) || root };
    projects.set(id, p); roots.set(key, p); return p;
  }
  function add(p, group, projectId = '') {
    const canonical = real(p), key = projectPathKey(canonical);
    const existing = files.get(key);
    if (existing) {
      if (projectId && !existing.projectIds.includes(projectId)) existing.projectIds.push(projectId);
      return;
    }
    let rule;
    if (/^(?:AGENTS(?:\.override)?|CLAUDE(?:\.local)?|GEMINI)\.md$/i.test(path.basename(canonical))) {
      try { rule = classifyRule(canonical); } catch (e) { warnings.push(`${canonical}：${e.message}`); }
    }
    if (rule?.state === 'unchanged') group = '历史规则副本';
    else if (['modified', 'unknown'].includes(rule?.state)) group = '需要核对的规则';
    files.set(key, { path: canonical, label: path.basename(canonical), group, rule,
      projectIds: projectId ? [projectId] : [], owner: group, status: rule?.note || '文件库' });
  }
  function walk(dir, group, projectId = '', depth = 0) {
    const canonical = real(dir), key = projectPathKey(canonical);
    if (directories.has(key)) return;
    directories.add(key);
    if (depth > 16) { warnings.push(`${dir}：超过 16 层，未继续扫描`); return; }
    let entries;
    try { entries = fs.readdirSync(canonical, { withFileTypes: true }); } catch (e) { warn(dir, e); return; }
    for (const e of entries) {
      const p = path.join(canonical, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p, group, projectId, depth + 1);
      else if (e.isFile() && /\.md$/i.test(e.name)) add(p, group, projectId);
    }
  }
  const seeds = ['claude', 'codex', 'kimi', 'gemini'].map(kind => ({ kind, cwd: homeDir }));
  // Read only explicit registry paths, never recursively search an aggregate root.
  for (const w of workspaces) {
    const cwd = w.path;
    if (!cwd) continue;
    for (const name of ['AGENTS.md','AGENTS.override.md','CLAUDE.md','GEMINI.md']) {
      const file = path.join(cwd,name);
      try { if (fs.statSync(file).isFile()) add(file,'原生规则',project(cwd)?.id); }
      catch (e) { warn(file,e); }
    }
  }
  for (const root of knownRoots) {
    if (projectPathKey(root) !== projectPathKey(homeDir))
      seeds.push(...['claude', 'codex', 'kimi', 'gemini'].map(kind => ({ kind, cwd: root })));
  }
  const providers = new Set(), codexHomes = new Set([path.join(homeDir, '.codex')]);
  for (const s of [...seeds, ...sessions]) {
    if (!s.cwd || s.purpose === 'memory-dream') continue;
    let p;
    try { p = seeds.includes(s) ? null : project(s.cwd); }
    catch (e) { warnings.push(`${s.cwd}：${e.message}`); continue; }
    if (p && s.id) { p.sessionIds ||= []; if (!p.sessionIds.includes(s.id)) p.sessionIds.push(s.id); }
    const kind = s.transcriptKind || s.kind;
    const providerKey = JSON.stringify([kind, projectPathKey(s.cwd), s.codexSessionsRoot]);
    if (providers.has(providerKey)) continue;
    providers.add(providerKey);
    try {
      if (s.codexSessionsRoot) codexHomes.add(path.dirname(s.codexSessionsRoot));
      const view = inspector.getSessionFiles({ ...s, homeDir, workspaceRoot: rootFor(s.cwd) || homeDir, rulesOnly: true });
      for (const f of view.files || []) if (f.exists) add(f.path, '原生规则', p?.id);
    } catch (e) { warnings.push(`${s.cwd}：${e.message}`); }
  }
  for (const dir of codexHomes) walk(path.join(dir, 'memories'), 'Codex 原生记忆');
  for (const name of ['.claude', '.claude-deepseek']) {
    const dir = path.join(homeDir, name, 'projects');
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { warn(dir, e); continue; }
    // Follow a known bucket's root junction once; deduplicate its canonical target.
    for (const e of entries) if (e.isDirectory()) walk(path.join(dir, e.name, 'memory'), 'Claude 原生记忆');
  }
  let entries;
  try { entries = fs.readdirSync(memoryRoot); } catch (e) { warn(memoryRoot, e); entries = []; }
  for (const id of entries.filter(n => /^[a-f0-9]{24}$/.test(n))) {
    try {
      const dir = path.join(memoryRoot, id);
      if (!projects.has(id)) {
        const jobIds = fs.readdirSync(path.join(dir, 'jobs')).filter(n=>/^[\w-]+$/.test(n));
        for (const jobId of jobIds) {
          const job = JSON.parse(fs.readFileSync(path.join(dir, 'jobs', jobId, 'job.json'), 'utf8'));
          if (job.project?.cwd) { projects.set(id, { id, cwd: job.project.cwd, label: job.project.label || path.basename(job.project.cwd) }); break; }
        }
      }
      const pointer = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'));
      if (!/^[\w-]+$/.test(pointer.version)) throw new Error('记忆版本无效');
      if (!projects.has(id) && /^[\w-]+$/.test(pointer.jobId)) {
        const job = JSON.parse(fs.readFileSync(path.join(dir, 'jobs', pointer.jobId, 'job.json'), 'utf8'));
        if (job.project?.cwd) projects.set(id, { id, cwd: job.project.cwd, label: job.project.label || path.basename(job.project.cwd) });
      }
      walk(path.join(dir, 'versions', pointer.version), 'Hub 梦境', id);
    } catch (e) { warn(path.join(memoryRoot, id), e); }
  }
  const globalRules = globalRuleFiles(homeDir).map(f => {
    try { return {...f, ...classifyRule(f.path), exists:true}; }
    catch(e) { warn(f.path,e); return {...f,exists:false}; }
  });
  return { files: [...files.values()], globalRules,
    globalRulesAligned: globalRules.every(f=>f.exists) && new Set(globalRules.map(f=>f.digest)).size === 1,
    projects: [...projects.values()].sort((a, b) => a.cwd.localeCompare(b.cwd)), warnings, generatedAt: Date.now() };
}
if (!isMainThread) {
  try { parentPort.postMessage({ ok: true, data: collectCatalog(workerData) }); }
  catch (error) { parentPort.postMessage({ ok: false, error: error.stack || error.message }); }
}
module.exports = { collectCatalog };
