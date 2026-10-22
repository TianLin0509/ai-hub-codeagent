'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const OPS = new Set(['status', 'catalog', 'search', 'read', 'report']);
const FILES = ['readonly.py', 'index.py', ...['__init__', 'library', 'text', 'selection', 'report', 'assessment', 'view', 'terminal'].map(n => `pptutor_core/${n}.py`)];
const sourceId = file => crypto.createHash('sha256').update(path.resolve(file).toLowerCase()).digest('hex').slice(0, 16);
const normalizedPath = file => path.resolve(file).replace(/\\/g, '/').toLowerCase();

class PptLibrary {
  constructor(assistant, deps = {}) {
    this.a = assistant; this.deps = deps; this.env = deps.pptEnv || process.env;
    this.current = { available: false, files: 0, error: '', checkedAt: null };
    this.reading = null; this.materialized = '';
    this.references = new Map();
    this.taskResults = new Map(); this.taskReports = new Map(); this.taskEvidence = new Map(); this.activeTask = null; this.indexJob = null; this.indexChild = null;
    try { this.indexState = JSON.parse(fs.readFileSync(path.join(this.a.dir, 'ppt-index-state.json'), 'utf8')); }
    catch { this.indexState = { state: 'idle' }; }
    if (this.indexState.state === 'indexing') this.indexState = { ...this.indexState, state: 'interrupted', error: '上次更新被中断，可继续更新' };
  }
  config() { return this.a.settings().ppt || {}; }
  db() {
    return this.config().db || this.env.PPTUTOR_DB || (this.env.PPTX_FINDER_DATA_DIR && path.join(this.env.PPTX_FINDER_DATA_DIR, 'index.db'))
      || path.join(this.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'pptx-finder', 'index.db');
  }
  ownedDb() { return path.join(this.a.dir, 'ppt-index', 'index.db'); }
  sources() {
    const entries = [{ db: this.ownedDb(), label: 'Hub 素材目录', kind: 'hub' }, { db: this.db(), label: 'PPT Doctor 索引', kind: 'doctor' }];
    const seen = new Set();
    return entries.filter(s => { const key = normalizedPath(s.db); if (seen.has(key) || !fs.existsSync(s.db)) return false; seen.add(key); return true; }).map(s => ({ ...s, id: sourceId(s.db) }));
  }
  status() { return { ...this.current, db: this.db(), roots: this.config().roots || [], sources: this.current.sources || this.sources(), indexing: this.indexState }; }
  beginTask(id) { this.activeTask = id; this.taskResults.delete(id); this.taskReports.delete(id); this.taskEvidence.clear(); }
  takeTaskReport(id) { const report = this.taskReports.get(id) || ''; this.taskReports.delete(id); return report; }
  takeTaskResult(id) { const result = this.taskResults.get(id) || []; this.taskResults.delete(id); if (this.activeTask === id) { this.activeTask = null; this.taskEvidence.clear(); } return result; }
  // Python cannot read an Electron asar. Materialize the shipped, allowlisted files by content hash.
  runtime() {
    if (this.materialized) return this.materialized;
    const source = path.join(__dirname, 'pptutor'), hash = crypto.createHash('sha256');
    const files = FILES.map(name => { const bytes = fs.readFileSync(path.join(source, name)); hash.update(name).update(bytes); return { name, bytes }; });
    const dir = path.join(this.a.dir, 'ppt-runtime', hash.digest('hex').slice(0, 16));
    for (const { name, bytes } of files) {
      const dest = path.join(dir, name); fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(bytes)) fs.writeFileSync(dest, bytes);
    }
    this.materialized = path.join(dir, 'readonly.py');
    return this.materialized;
  }
  async execute(op, args = {}) {
    if (!OPS.has(op)) throw new Error('PPT 素材库只支持搜索、读页和汇总，不能移动文件');
    if (op === 'read') return this.read(args);
    if (op === 'report') {
      const taskId = this.activeTask;
      if (this.activeTask) for (const page of args.evidence?.pages || []) {
        const read = this.taskEvidence.get(page.id);
        if (!read || read.text !== page.text || read.ref.page_hash !== page.ref?.page_hash) throw new Error('报告依据必须来自本次实际读到的完整页面，请先调用 ppt_read');
      }
      const evidence = taskId ? { ok: true, truncated: false, pages: [...this.taskEvidence.values()], scope: { roots: this.config().roots || [], extensions: ['.pptx', '.ppt'] } } : args.evidence;
      const result = await this.runPython({ ...args, evidence, op });
      const pages = new Map((evidence?.pages || []).map(p => [p.id, p]));
      result.report = require('./ppt-report').renderPptReport({ rows: result.verified_rows, pages, scope: this.current, indexing: this.indexState, purpose: args.decision.task.purpose });
      delete result.verified_rows;
      const eligible = new Set((result.recommendations || []).map(r => r.id));
      if (taskId && this.activeTask === taskId) {
        this.taskReports.set(taskId, result.report);
        while (this.taskReports.size > 40) this.taskReports.delete(this.taskReports.keys().next().value);
      }
      if (taskId && this.activeTask === taskId) this.taskResults.set(taskId, (args.decision?.results || []).filter(r => eligible.has(r.id)).map(r => {
        const page = pages.get(r.id); return { id: r.id, name: page.ref.name, path: page.ref.path, page: page.ref.page, reason: r.reason, sourceState: page.source_state };
      }));
      return result;
    }
    const sources = this.sources();
    if (!sources.length) throw new Error('还没有 PPT 文字索引。请在助理设置 → PPT 素材库选择 1–3 个素材文件夹，或选择已有的 PPT Doctor 索引。');
    if (op === 'status') {
      const documents = new Map(), results = [], errors = [];
      for (const source of sources) {
        try {
          const value = await this.runPython({ op, db: source.db, includePaths: true });
          for (const d of value.documents || []) if (!documents.has(normalizedPath(d.path))) documents.set(normalizedPath(d.path), d);
          const { documents: _paths, ...status } = value; results.push({ ...source, ...status });
        } catch (error) { errors.push({ source: source.label, message: error.message }); }
      }
      if (!results.length) throw new Error(errors.map(e => `${e.source}：${e.message}`).join('；'));
      // 缓存“文稿 → 页数”，给回答后的出处核对用（只读，不额外调用 Python）。
      this.documents = new Map([...documents.values()].map(d => [normalizedPath(d.path), { name: path.basename(d.path), path: d.path, pages: Number(d.page_count) || 0 }]));
      return { ok: true, sources: results, errors, indexed_files: documents.size, indexed_pages: [...documents.values()].reduce((n, r) => n + r.page_count, 0),
        file_status_counts: [{ ext: '.pptx/.ppt', status: 'ok', files: documents.size }], warnings: results.flatMap(r => r.warnings || []), scope: { read_only: true, images: 'not inspected' } };
    }
    if (op === 'catalog') {
      const selected = args.sourceId ? sources.filter(s => s.id === args.sourceId) : sources;
      if (!selected.length) throw new Error('这个索引来源目前不可用，请重新检索');
      if (args.fileId != null && selected.length > 1) throw new Error('多个索引可能有相同文稿编号，请同时传 sourceId');
      const results = await Promise.all(selected.map(async source => {
        const value = await this.runPython({ ...args, op, db: source.db });
        return { ...value, sourceId: source.id, source: source.label, items: value.items.map(item => ({ ...item, sourceId: source.id })) };
      }));
      return { ok: true, sources: results, items: results.flatMap(r => r.items), has_more: results.some(r => r.has_more), next_offset: results.length === 1 ? results[0].next_offset : undefined };
    }
    const limit = args.limit ?? 30, results = [], errors = [];
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('候选数量 limit 应为 1–100');
    for (const source of sources) {
      try { results.push({ source, result: await this.runPython({ ...args, op, db: source.db, limit: 100 }) }); }
      catch (error) { errors.push({ source: source.label, message: error.message }); }
    }
    if (!results.length) throw new Error(errors.map(e => `${e.source}：${e.message}`).join('；'));
    const byPage = new Map();
    for (const { source, result } of results) for (const item of result.candidates) {
      const ref = { ...item.ref, source_id: source.id }, id = `${source.id}:${item.id}`, key = normalizedPath(ref.path) + ':' + ref.page;
      this.references.set(id, ref);
      if (!byPage.has(key)) byPage.set(key, { ...item, id, ref, source: source.label });
      else {
        const old = byPage.get(key); old.duplicate_refs.push(ref);
        if (old.ref.page_hash === ref.page_hash) old.matched_queries = [...old.matched_queries, ...item.matched_queries];
      }
    }
    while (this.references.size > 2000) this.references.delete(this.references.keys().next().value);
    const candidates = [...byPage.values()].sort((a, b) => b.retrieval_score - a.retrieval_score || a.id.localeCompare(b.id));
    return { ok: true, candidates: candidates.slice(0, limit), unique_candidates: candidates.length, errors,
      truncated: candidates.length > limit || results.some(r => r.result.truncated), queries: results.flatMap(r => r.result.queries.map(q => ({ ...q, source: r.source.label }))),
      scope: { read_only: true, sources: results.map(r => ({ id: r.source.id, label: r.source.label, ...r.result.scope })) },
      coverage: '只检索已提取文字；有错误的来源未完整覆盖；候选排序由宿主阅读后判断' };
  }
  async find({ question, queries, limit = 15 } = {}) {
    if (typeof question !== 'string' || !question.trim()) throw new Error('请保留用户要查找素材的用途 question');
    if (!Array.isArray(queries) || queries.length < 3 || queries.length > 8) throw new Error('请按用途提供 3–8 组短查询，包括原关键词、同义词或中英文表达');
    const plan = { intent: question, queries: queries.map(q => typeof q === 'string' ? { query: q } : q) };
    const result = await this.execute('search', { plan, limit });
    return { ...result, question, candidates: result.candidates.map(c => ({ ...c, snippet: c.snippet.slice(0, 120), snippet_truncated: c.snippet_truncated || c.snippet.length > 120 })) };
  }
  async read(args = {}) {
    const sources = this.sources(), groups = new Map();
    const requested = args.refs || (args.ids || []).map(id => this.references.get(String(id)) || { id: String(id) });
    if (!requested.length || requested.length > 40) throw new Error('每次读取 1–40 个主页面');
    for (const ref of requested) {
      const parts = ref.id ? ref.id.split(':') : [], sid = ref.source_id || (parts.length === 3 ? parts.shift() : '');
      const source = sid ? sources.find(s => s.id === sid) : sources.length === 1 ? sources[0] : null;
      if (!source) throw new Error('页编号的索引来源不明确或已不可用，请使用搜索返回的完整 id 重新读取');
      const resolved = ref.id ? { file_id: Number(parts[0]), page: Number(parts[1]) } : { ...ref };
      if (!groups.has(source.id)) groups.set(source.id, { source, refs: [] });
      groups.get(source.id).refs.push(resolved);
    }
    const pages = [], missing = [], scopes = [];
    for (const { source, refs } of groups.values()) {
      const value = await this.runPython({ op: 'read', db: source.db, refs, neighbors: args.neighbors || 0 });
      for (const item of value.pages) {
        const id = `${source.id}:${item.id}`, ref = { ...item.ref, source_id: source.id };
        const page = { ...item, id, ref, source: source.label };
        pages.push(page); this.references.set(id, ref); if (this.activeTask) this.taskEvidence.set(id, page);
      }
      missing.push(...value.missing.map(m => ({ ...m, sourceId: source.id }))); scopes.push(value.scope);
    }
    return { ok: true, pages, missing, truncated: false, scope: { read_only: true, sources: scopes }, visual_inspection: 'not performed' };
  }
  async runPython(request, options = {}) {
    const script = options.index ? path.join(path.dirname(this.runtime()), 'index.py') : this.runtime();
    const configured = this.config().python || this.env.CLAUDE_HUB_PPT_PYTHON;
    const candidates = configured ? [[configured, []]] : process.platform === 'win32' ? [['python', []], ['py', ['-3']]] : [['python3', []]];
    let result;
    for (const [command, prefix] of candidates) {
      try { result = await this.process(command, [...prefix, script], request, options); break; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (!result) throw new Error('未找到 Python 3，素材文件没有改动。安装 Python 3 后重试。');
    if (result.ok === false) throw Object.assign(new Error(result.error?.message || 'PPT 索引读取失败'), { code: result.error?.code });
    return result;
  }
  process(command, args, request, options = {}) {
    return new Promise((resolve, reject) => {
      const child = (this.deps.pptSpawn || spawn)(command, args, { windowsHide: true, env: { ...this.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdout.setEncoding?.('utf8');
      child.stderr.setEncoding?.('utf8');
      if (options.index) this.indexChild = child;
      let stdout = '', stderr = '', progress = '', settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish(new Error(options.index ? '本次索引更新已运行 30 分钟，已完成部分保留；可继续更新' : 'PPT 索引读取超过 30 秒，请稍后重试')); }, options.index ? 1800000 : 30000);
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 24 * 1024 * 1024) { child.kill(); finish(new Error('本次读页超过 24 MB，请减少页数；结果未截断交付')); } });
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk).slice(-4000);
        if (options.onProgress) {
          progress += chunk; let at;
          while ((at = progress.indexOf('\n')) >= 0) { const line = progress.slice(0, at); progress = progress.slice(at + 1); try { options.onProgress(JSON.parse(line)); } catch {} }
        }
      });
      child.on('error', finish);
      child.stdin.on('error', error => { if (error.code !== 'EPIPE') finish(error); });
      child.on('close', code => {
        if (settled) return;
        try { const value = JSON.parse(stdout); if (code && value.ok !== false) throw new Error(stderr || `Python 退出码 ${code}`); finish(null, value); }
        catch (error) { finish(new Error(stderr || 'PPT 索引未返回可读结果：' + error.message)); }
      });
      child.stdin.end(JSON.stringify(request));
    });
  }
  refresh({ force = false } = {}) {
    if (this.reading) return this.reading;
    if (!force && this.current.checkedAt && this.a.now() - this.current.checkedAt < 10 * 60000) return Promise.resolve(this.status());
    if ((this.config().roots || []).length && !this.indexJob && this.a.now() - (this.indexState.completedAt || this.indexState.startedAt || 0) > 10 * 60000) this.startIndex();
    if (!this.sources().length) { this.current = { available: false, files: 0, pages: 0, error: '', checkedAt: this.a.now() }; this.documents = new Map(); return Promise.resolve(this.status()); }
    this.reading = this.execute('status').then(result => {
      this.current = { available: true, files: result.file_status_counts.reduce((n, r) => n + (r.status === 'ok' ? r.files : 0), 0),
        pages: result.indexed_pages, sources: result.sources, warnings: result.warnings, error: result.errors.map(e => `${e.source}：${e.message}`).join('；'), checkedAt: this.a.now() };
      return this.status();
    }).catch(error => { this.current = { available: false, files: 0, error: error.message, checkedAt: this.a.now() }; this.documents = new Map(); return this.status(); })
      .finally(() => { this.reading = null; this.a.changed(); });
    return this.reading;
  }
  startIndex() {
    if (this.indexJob) return this.status();
    const roots = this.config().roots || [];
    if (!Array.isArray(roots) || roots.length < 1 || roots.length > 3 || roots.some(r => typeof r !== 'string' || !path.isAbsolute(r))) throw new Error('请先选择 1–3 个素材文件夹');
    this.indexState = { state: 'indexing', startedAt: this.a.now(), scanned: 0, indexed: 0, unchanged: 0, failed: 0, skippedPpt: 0 };
    this.a.changed();
    this.indexJob = this.runPython({ db: this.ownedDb(), roots }, { index: true, onProgress: p => { this.indexState = { ...this.indexState, ...p }; this.a.changed(); } })
      .then(result => { this.indexState = { ...this.indexState, ...result, state: result.complete ? 'done' : 'partial', completedAt: this.a.now() }; })
      .catch(error => { this.indexState = { ...this.indexState, state: 'error', error: error.message, completedAt: this.a.now() }; })
      .finally(async () => {
        this.indexChild = null; this.indexJob = null;
        try { fs.mkdirSync(this.a.dir, { recursive: true }); fs.writeFileSync(path.join(this.a.dir, 'ppt-index-state.json'), JSON.stringify(this.indexState)); }
        catch (error) { this.indexState.error = '索引进度没有保存：' + error.message; }
        await this.refresh({ force: true }); this.a.changed();
      });
    return this.status();
  }
  close() { this.indexChild?.kill(); this.indexChild = null; }
  // 回答后的出处核对（v3.1.2）：模型没调用 ppt_library op=report 时，按索引里的文稿与页数
  // 核对回答里写的「文件名 + 第 N 页」。没有索引、没有 Python 或没有引用时一句都不加。
  async citationNote(text) {
    const { extractCitations, checkCitations, renderCitationCheck } = require('./citation-check');
    const citations = extractCitations(text);
    if (!citations.length) return '';
    if (!this.documents || !this.documents.size) await this.refresh().catch(() => {});
    if (!this.documents || !this.documents.size) return '';
    return renderCitationCheck(checkCitations(citations, this.documents));
  }
  async open(id) {
    const result = await this.execute('read', { ids: [id] }), ref = result.pages?.[0];
    if (!ref || ref.source_state === 'source_unavailable') throw new Error('索引中的源文件目前不可用');
    if (ref.source_state === 'source_metadata_changed') throw new Error('源文件已更新，原页码可能变化。请先在 PPT 素材库设置里更新索引，再重新查找');
    const file = ref.ref.path;
    if (!/\.(pptx?|pdf)$/i.test(file)) throw new Error('只打开索引中的演示文稿');
    const focused = !this.deps.openPpt && await (this.deps.openPptSlide || require('./ppt-open').openSlide)(file, ref.ref.page);
    if (focused) return { ok: true, path: file, page: ref.ref.page, pageFocused: true };
    const error = await (this.deps.openPpt || (p => require('electron').shell.openPath(p)))(file);
    if (error) throw new Error('文件没能打开：' + error);
    return { ok: true, path: file, page: ref.ref.page, pageFocused: false };
  }
}
module.exports = { PptLibrary, OPS };
