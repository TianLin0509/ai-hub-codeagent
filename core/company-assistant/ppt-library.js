'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const OPS = new Set(['status', 'catalog', 'search', 'read', 'report']);
const FILES = ['readonly.py', ...['__init__', 'library', 'text', 'selection', 'report', 'assessment', 'view', 'terminal'].map(n => `pptutor_core/${n}.py`)];

class PptLibrary {
  constructor(assistant, deps = {}) {
    this.a = assistant; this.deps = deps; this.env = deps.pptEnv || process.env;
    this.current = { available: false, files: 0, error: '', checkedAt: null };
    this.reading = null; this.materialized = '';
    this.references = new Map();
  }
  config() { return this.a.settings().ppt || {}; }
  db() {
    return this.config().db || this.env.PPTUTOR_DB || (this.env.PPTX_FINDER_DATA_DIR && path.join(this.env.PPTX_FINDER_DATA_DIR, 'index.db'))
      || path.join(this.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'pptx-finder', 'index.db');
  }
  status() { return { ...this.current, db: this.db() }; }
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
    const request = { ...args, op, db: this.db() };
    if (op === 'read' && !args.refs && args.ids) request.refs = args.ids.map(id => this.references.get(String(id)) || { file_id: Number(String(id).split(':')[0]), page: Number(String(id).split(':')[1]) });
    const script = this.runtime();
    const configured = this.config().python || this.env.CLAUDE_HUB_PPT_PYTHON;
    const candidates = configured ? [[configured, []]] : process.platform === 'win32' ? [['python', []], ['py', ['-3']]] : [['python3', []]];
    let result;
    for (const [command, prefix] of candidates) {
      try { result = await this.process(command, [...prefix, script], request); break; }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (!result) throw new Error('未找到 Python 3。PPT Doctor 的文字索引保留完整；安装 Python 3 后重试。');
    if (result.ok === false) throw Object.assign(new Error(result.error?.message || 'PPT 索引读取失败'), { code: result.error?.code });
    for (const item of result.candidates || result.pages || []) if (item.id && item.ref) this.references.set(item.id, item.ref);
    // Bound in-memory references without changing result completeness.
    while (this.references.size > 500) this.references.delete(this.references.keys().next().value);
    return result;
  }
  process(command, args, request) {
    return new Promise((resolve, reject) => {
      const child = (this.deps.pptSpawn || spawn)(command, args, { windowsHide: true, env: { ...this.env, PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child.kill(); finish(new Error('PPT 索引读取超过 30 秒，请稍后重试')); }, 30000);
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 24 * 1024 * 1024) { child.kill(); finish(new Error('本次读页超过 24 MB，请减少页数；结果未截断交付')); } });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
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
    if (!fs.existsSync(this.db())) { this.current = { available: false, files: 0, error: '', checkedAt: this.a.now() }; return Promise.resolve(this.status()); }
    this.reading = this.execute('status').then(result => {
      this.current = { available: true, files: result.file_status_counts.reduce((n, r) => n + (r.status === 'ok' ? r.files : 0), 0),
        pages: result.indexed_pages, warnings: result.warnings, error: '', checkedAt: this.a.now() };
      return this.status();
    }).catch(error => { this.current = { available: false, files: 0, error: error.message, checkedAt: this.a.now() }; return this.status(); })
      .finally(() => { this.reading = null; this.a.changed(); });
    return this.reading;
  }
  async open(id) {
    const result = await this.execute('read', { ids: [id] }), ref = result.pages?.find(p => p.id === id);
    if (!ref || ref.source_state === 'source_unavailable') throw new Error('索引中的源文件目前不可用');
    const file = ref.ref.path;
    if (!/\.(pptx?|pdf)$/i.test(file)) throw new Error('只打开索引中的演示文稿');
    const error = await (this.deps.openPpt || (p => require('electron').shell.openPath(p)))(file);
    if (error) throw new Error('文件没能打开：' + error);
    return { ok: true, path: file, page: ref.ref.page };
  }
}
module.exports = { PptLibrary, OPS };
