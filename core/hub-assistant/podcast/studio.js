'use strict';
// 资料口播 · 任务调度：用户说「把 X 做成口播」→ 助理调 make_podcast → 这里在后台把资料拆章、写稿、合成，
// 每集做好就更新清单（手机「资料」页随之刷新），全部做完发一条提醒。
// 产物在 Hub 数据目录 assistant/podcasts/<id>/：manifest.json、NN.md（手机阅读版）、NN-稿.md（口播稿）、NN.ogg（音频）。
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

async function pool(items, limit, fn) {
  let i = 0; const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}
class PodcastStudio {
  constructor({ dataDir, extract, writers, synthesize, listener = () => '', onChange = () => {}, onDone = () => {}, writeLimit = 3, voiceLimit = 2 }) {
    this.listener = listener;
    this.root = path.join(dataDir, 'assistant', 'podcasts'); this.extract = extract; this.writers = writers; this.synthesize = synthesize;
    this.onChange = onChange; this.onDone = onDone; this.writeLimit = writeLimit; this.voiceLimit = voiceLimit; this.running = new Map();
    fs.mkdirSync(this.root, { recursive: true });
    // Hub 重启时还没做完的任务：标成中断，用户可以让助理重做。
    for (const m of this.list()) if (m.status === 'working') this.save({ ...m, status: 'interrupted', episodes: m.episodes.map(e => ['done', 'reading'].includes(e.status) ? e : { ...e, status: 'interrupted' }) });
  }
  dir(id) { if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new Error('口播编号无效'); return path.join(this.root, id); }
  read(id) { return JSON.parse(fs.readFileSync(path.join(this.dir(id), 'manifest.json'), 'utf8')); }
  save(m) { fs.mkdirSync(this.dir(m.id), { recursive: true }); const f = path.join(this.dir(m.id), 'manifest.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(m, null, 1)); fs.renameSync(f + '.tmp', f); try { this.onChange(m); } catch {} return m; }
  list() {
    const out = []; for (const id of fs.existsSync(this.root) ? fs.readdirSync(this.root) : []) { try { out.push(this.read(id)); } catch {} }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
  // 给手机与助理看的精简清单。
  summary() {
    return this.list().slice(0, 30).map(m => ({ id: m.id, title: m.title, status: m.status, createdAt: m.createdAt, voice: m.voice || '', writer: m.writer || '',
      episodes: m.episodes.map(e => ({ n: e.n, title: e.title, status: e.status, seconds: e.seconds || 0, bytes: e.bytes || 0, readOnly: !!e.readOnly })) }));
  }
  signature() { return JSON.stringify(this.summary().map(m => [m.id, m.status, m.episodes.map(e => e.status + (e.seconds || ''))])); }
  update(id, fn) { const m = this.read(id); fn(m); return this.save(m); }
  // 开始一个任务：同步完成拆章（几秒），写稿和合成在后台进行。
  async start(file, { title } = {}) {
    if (!fs.existsSync(file)) throw new Error('找不到这份资料：' + file);
    const doc = await this.extract(file);
    if (!doc.chapters.length) throw new Error('这份资料里没有找到可讲的正文');
    const id = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + randomUUID().slice(0, 8);
    const m = { id, title: (title || doc.title).slice(0, 60), source: file, createdAt: Date.now(), status: 'working', episodes: doc.chapters.map((c, i) => ({ n: i + 1, title: c.title, status: c.readOnly ? 'reading' : 'queued', readOnly: c.readOnly, chars: c.text.length })) };
    fs.mkdirSync(this.dir(id), { recursive: true });
    doc.chapters.forEach((c, i) => { fs.writeFileSync(path.join(this.dir(id), `${String(i + 1).padStart(2, '0')}.md`), c.markdown, 'utf8'); fs.writeFileSync(path.join(this.dir(id), `${String(i + 1).padStart(2, '0')}.txt`), c.text, 'utf8'); });
    this.save(m);
    const job = this.produce(m, doc).catch(e => this.update(id, x => { x.status = 'failed'; x.error = e.message; })).finally(() => this.running.delete(id));
    this.running.set(id, job);
    const speak = m.episodes.filter(e => !e.readOnly);
    return { id, title: m.title, episodes: m.episodes.length, audio: speak.length, minutes: Math.round(speak.reduce((s, e) => s + Math.min(10, Math.max(4, e.chars / 900)), 0)) };
  }
  async startLesson({ id, title, script, markdown, requestId }) {
    const previous = fs.existsSync(path.join(this.dir(id), 'manifest.json')) ? this.read(id) : null;
    if (previous && (['working', 'done'].includes(previous.status) || this.running.has(id) || requestId && previous.sourceRequestId === requestId)) return { id, duplicate: true };
    const m = { id, title, createdAt: Date.now(), status: 'working', source: 'daily-secretary', sourceRequestId: requestId || '', retryCount: previous ? (previous.retryCount || 0) + 1 : 0, previousError: previous?.error || '', episodes: [{ n: 1, title, status: 'voicing', readOnly: false, chars: script.length }] };
    this.save(m);
    for (const [suffix, content] of [['.md', markdown], ['-稿.md', script]]) fs.writeFileSync(path.join(this.dir(id), '01' + suffix), content, 'utf8');
    const job = (async () => {
      try {
        const r = await this.synthesize(script, path.join(this.dir(id), '01.ogg'));
        const done = this.update(id, x => { x.status = 'done'; x.finishedAt = Date.now(); Object.assign(x.episodes[0], { status: 'done', seconds: r.seconds, bytes: r.bytes, voice: r.voice }); x.voice = r.voice; if (r.seconds < 600 || r.seconds > 900) x.durationNote = '实际时长未落在 10–15 分钟，请调整课程稿后重做'; });
        try { this.onDone(done); } catch (e) { console.warn('[assistant] lesson completion notice', e.message); }
      } catch (e) { this.update(id, x => { x.status = 'failed'; x.error = e.message; x.episodes[0].status = 'failed'; }); console.warn('[assistant] lesson synthesis', e.message); }
    })().finally(() => this.running.delete(id));
    this.running.set(id, job); return { id };
  }
  async produce(m, doc) {
    const { buildPrompt, writeScript } = require('./script');
    const todo = m.episodes.filter(e => !e.readOnly);
    const scripts = new Map();
    const writing = pool(todo, this.writeLimit, async e => {
      this.update(m.id, x => { x.episodes[e.n - 1].status = 'writing'; });
      try {
        // 导读这一集附上全书章节，讲成一张全书地图。
        const text = doc.chapters[e.n - 1].text + (e.title === '导读' ? '\n\n本书各集：' + todo.filter(x => x.title !== '导读').map(x => x.title).join('；') : '');
        const prompt = buildPrompt({ book: m.title, chapter: e.title, index: todo.indexOf(e) + 1, total: todo.length, text, listener: (() => { try { return this.listener(); } catch { return ''; } })() });
        const s = await writeScript(prompt, this.writers);
        fs.writeFileSync(path.join(this.dir(m.id), `${String(e.n).padStart(2, '0')}-稿.md`), s.text, 'utf8'); scripts.set(e.n, s);
        this.update(m.id, x => { Object.assign(x.episodes[e.n - 1], { status: 'voicing', writer: s.writer, scriptChars: s.text.length, writeMs: s.ms }); x.writer = s.writer; });
      } catch (err) { this.update(m.id, x => { Object.assign(x.episodes[e.n - 1], { status: 'failed', error: err.message.slice(0, 200) }); }); }
    });
    // 写完一集就进合成队列，不等全部写完：第一集尽早可听。
    const voiced = new Set(); let voiceQueue = Promise.resolve();
    const speakReady = async () => {
      const ready = todo.filter(e => scripts.has(e.n) && !voiced.has(e.n)); ready.forEach(e => voiced.add(e.n));
      await pool(ready, this.voiceLimit, async e => {
        try {
          const r = await this.synthesize(scripts.get(e.n).text, path.join(this.dir(m.id), `${String(e.n).padStart(2, '0')}.ogg`));
          this.update(m.id, x => { Object.assign(x.episodes[e.n - 1], { status: 'done', seconds: r.seconds, bytes: r.bytes, voice: r.voice }); x.voice = r.voice; });
        } catch (err) { this.update(m.id, x => { Object.assign(x.episodes[e.n - 1], { status: 'failed', error: err.message.slice(0, 200) }); }); }
      });
    };
    const ticker = setInterval(() => { voiceQueue = voiceQueue.then(speakReady); }, 1500); ticker.unref?.();
    await writing; clearInterval(ticker); await voiceQueue; await speakReady();
    const done = this.update(m.id, x => { const failed = x.episodes.filter(e => e.status === 'failed').length; x.status = failed === todo.length ? 'failed' : 'done'; x.finishedAt = Date.now(); });
    try { this.onDone(done); } catch {}
  }
  file(id, n, kind) {
    const base = path.join(this.dir(id), String(Number(n)).padStart(2, '0'));
    const f = kind === 'audio' ? base + '.ogg' : kind === 'script' ? base + '-稿.md' : base + '.md';
    if (!fs.existsSync(f)) throw new Error(kind === 'audio' ? '这一集的音频还没做好' : '没有这一集');
    return f;
  }
  remove(id) { if (this.running.has(id)) throw new Error('还在制作，做完再删'); fs.rmSync(this.dir(id), { recursive: true, force: true }); try { this.onChange(null); } catch {} }
}
module.exports = { PodcastStudio, pool };
