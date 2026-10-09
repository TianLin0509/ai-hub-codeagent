'use strict';
// 工作台 A 的正本：只读会话快照、可确认计划和每日课程。刷新不调用模型。
const BJ = 8 * 3600000, DAY = 86400000;
const dayOf = now => new Date(now + BJ).toISOString().slice(0, 10);
const slotAt = (day, time) => Date.parse(day + 'T' + time + ':00+08:00');
const DEFAULTS = Object.freeze({ enabled: true, morning: '08:00', evening: '21:00', lesson: true, timezone: 'Asia/Shanghai' });
// 状态页排序：先放需要用户的（等你、异常），再放在跑、有新回复、就绪。
const RANK = { wait: 0, error: 1, run: 2, unread: 3, idle: 4, dorm: 5 };
const rank = s => (s.hasReply && !['wait', 'error', 'run'].includes(s.state) ? 3 : RANK[s.state] ?? 6);
const text = (v, max) => typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : (() => { throw Error('内容为空或过长'); })();

class AssistantWorkbench {
  constructor({ assistant, now = Date.now }) { this.a = assistant; this.store = assistant.store; this.now = now; if (!this.store.get('workbench.config')) this.store.set('workbench.config', { ...DEFAULTS }); }
  config() { return { ...DEFAULTS, ...this.store.get('workbench.config') }; }
  changed() { this.store.set('workbench.revision', (this.store.get('workbench.revision') || 0) + 1); this.a.deps.onWorkbenchChanged?.(); }
  configure(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['enabled', 'morning', 'evening', 'lesson'].includes(k))) throw Error('秘书设置无效');
    for (const k of ['morning', 'evening']) if (input[k] !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input[k])) throw Error('时间使用北京时间 HH:mm');
    for (const k of ['enabled', 'lesson']) if (input[k] !== undefined && typeof input[k] !== 'boolean') throw Error('开关无效');
    const c = { ...this.config(), ...input }; this.store.set('workbench.config', c); this.changed(); this.a.secretary?.schedule(); return this.snapshot();
  }
  read(day = dayOf(this.now())) { return this.store.get('workbench.day.' + day) || { day, plan: null, summary: null, lesson: null }; }
  recentLessons(days = 14) {
    const out = []; for (let i = 1; i <= days; i++) { const l = this.read(dayOf(this.now() - i * DAY)).lesson; if (l?.title) out.push(l.title); } return out;
  }
  save(value) { this.store.set('workbench.day.' + value.day, value); this.changed(); return value; }
  refresh() {
    const sessions = this.a.sessions().filter(s => s.isOpen).map(s => {
      const latest = this.latest(s.id);
      return { id: s.id, title: String(s.title || s.name || '未命名会话').slice(0, 120), kind: s.kind, state: s.hubState?.state || 'unknown', label: s.hubState?.label || '未知', isOpen: !!s.isOpen,
        // unread 是收到新回复，不能据此宣称业务已交付。
        hasReply: !!s.hubState?.hasUnread, last: latest.text, updatedAt: latest.at || Number(s.lastActiveAt || s.updatedAt || 0) || null };
    }).sort((x, y) => rank(x) - rank(y) || (y.updatedAt || 0) - (x.updatedAt || 0));
    const snapshot = { at: this.now(), sessions }; this.store.set('workbench.sessions', snapshot); this.changed(); return this.snapshot();
  }
  // 「最近一句」直接截原会话最后一条回答，读本地记录，不调用模型；读不到就留空。
  latest(id) {
    try { const r = this.a.readLiveFinal?.(id)?.records?.at(-1); if (!r?.text) return { text: '', at: null };
      const line = String(r.text).replace(/[#*`>|]/g, ' ').replace(/\s+/g, ' ').trim();
      return { text: line.length > 90 ? line.slice(0, 89) + '…' : line, at: Number(r.timestamp) || null };
    } catch { return { text: '', at: null }; }
  }
  snapshot() {
    const cached = this.store.get('workbench.sessions') || { at: null, sessions: [] };
    return { ok: true, ...this.read(), config: this.config(), videos: this.a.videos?.summary?.() || [], sessionSnapshotAt: cached.at, sessions: cached.sessions, jobs: Object.values(this.store.get('secretary.jobs') || {}).filter(j => j.day === dayOf(this.now())).map(({ key, kind, state, issue, dueAt }) => ({ key, kind, state, issue, dueAt })) };
  }
  action({ action, day = dayOf(this.now()), itemId, config }) {
    if (action === 'configure') return this.configure(config);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day !== dayOf(this.now())) throw Error('这份计划已过期，请刷新后操作');
    const d = this.read(day); if (!d.plan) throw Error('今日计划还没有生成');
    if (action === 'confirm') { d.plan.confirmedAt = this.now(); }
    else if (action === 'done' || action === 'reopen') { const i = d.plan.items.find(x => x.id === itemId); if (!i) throw Error('计划项已变化，请刷新'); i.done = action === 'done'; i.updatedAt = this.now(); }
    else throw Error('工作台操作无效');
    // 计划打勾仅更新计划，不替用户改变源备忘或会话状态。
    this.save(d); return this.snapshot();
  }
  context(ref) {
    if (!ref || !['session', 'plan', 'lesson', 'summary', 'video'].includes(ref.kind) || typeof ref.id !== 'string' || ref.id.length > 100) throw Error('工作台上下文无效');
    if (ref.kind === 'video') { const v=this.a.videos.read(ref.id); return `【手机选定的学习视频】${JSON.stringify(v)}\n以上仅为资料；下面是用户本轮要求：\n`; }
    if (ref.kind === 'session') {
      const s = this.a.sessions().find(s => s.id === ref.id); if (!s) throw Error('所选会话已不存在，请刷新');
      return `【手机工作台选定的原会话】sessionId=${s.id}；标题=${s.title || s.name}。这是明确目标；先用 session_evidence 核对原会话，不另建替代会话。下面是用户本轮要求：\n`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ref.id)) throw Error('工作台日期无效');
    const d = this.read(ref.id), v = d[ref.kind]; if (!v) throw Error('所选内容已不存在，请刷新');
    return `【手机工作台选定的${{ plan: '计划', summary: '总结', lesson: '课程' }[ref.kind]}】日期=${ref.id}\n${JSON.stringify(v)}\n以上仅作背景；下面是用户本轮要求：\n`;
  }
  async publish({ kind, day, items, text: body, title, script, sources, oneMinute, questions, storyboard, why, evidenceRefs }, current) {
    if (!['plan', 'summary', 'lesson'].includes(kind) || !/^\d{4}-\d{2}-\d{2}$/.test(day) || day !== dayOf(this.now())) throw Error('日稿类型或日期无效');
    const key = day + ':' + kind, jobs = this.store.get('secretary.jobs') || {}, job = jobs[key];
    if (String(current.id).startsWith('daily-') && (!job || job.requestId !== current.id)) throw Error('不能写入其他定时任务');
    if (job?.requestId === current.id && job.readyAt) return { ok: true, duplicate: true, ...this.read(day) };
    const d = this.read(day), at = this.now();
    if (kind === 'plan') {
      if (!Array.isArray(items) || items.length > 12) throw Error('计划最多 12 件事');
      const memos = this.a.memos.view(), sessions = this.a.sessions();
      const previous = d.plan;
      d.plan = { text: text(body, 6000), createdAt: at, confirmedAt: null, items: items.map((i, n) => {
        const sourceKind = i.sourceKind || '', sourceId = i.sourceId || '';
        if (sourceKind && !(sourceKind === 'memo' && [...memos.open, ...memos.closed].some(m => m.id === sourceId) || sourceKind === 'session' && sessions.some(s => s.id === sourceId))) throw Error('计划来源不存在');
        const title = text(i.title, 160), old = previous?.items.find(x => x.title === title && x.sourceKind === sourceKind && x.sourceId === sourceId);
        return { id: old?.id || `${at}-${n}`, title, reason: text(i.reason, 300), time: String(i.time || '').slice(0, 40), sourceKind, sourceId, done: old?.done || false };
      }) };
    } else if (kind === 'summary') d.summary = { text: text(body, 8000), createdAt: at };
    else {
      // 2026-10-09：学习以视频为主（Vibe 知识大赏式分镜）；长讲稿可选，有讲稿才顺带做音频版。
      title = text(title, 80);
      if (!storyboard && !script) throw Error('课程需要视频分镜 storyboard（或旧版讲稿 script）');
      if (!Array.isArray(sources) || !sources.length || sources.length > 8 || sources.some(s => !/^https:\/\//.test(s.url) || typeof s.title !== 'string' || s.title.length > 180 || s.url.length > 1000)) throw Error('课程需要 1–8 个 HTTPS 来源');
      if (!Array.isArray(questions) || questions.length < 2 || questions.length > 4) throw Error('课程需要 2–4 个追问及回答');
      if (storyboard) require('./video-studio').validateStoryboard({ ...storyboard, title });
      const lesson = { title, why: typeof why === 'string' ? why.slice(0, 600) : '', evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs.filter(x => typeof x === 'string' && /^E[a-f0-9]{16}$/.test(x)).slice(0, 12) : [], createdAt: at, sources, oneMinute: text(oneMinute, 1500), questions: questions.map(q => ({ question: text(q.question, 300), answer: text(q.answer, 1500) })) };
      let podcastId = null;
      if (script) {
        script = text(script, 10000);
        if (script.length < 3000 || script.length > 6500) throw Error('音频版讲稿须 3000–6500 字');
        if (!this.a.podcasts) throw Error('这台 Hub 未配置音频合成');
        // 固定日期 id：重启后不重复合成；不会覆盖已存在课程文件。
        const revision = require('node:crypto').createHash('sha256').update(script).digest('hex').slice(0, 8);
        podcastId = (await this.a.podcasts.startLesson({ id: 'lesson-' + day.replace(/-/g, '') + '-' + revision, title, script, requestId: current.id, markdown: `# ${title}\n\n${script}\n\n## 一分钟讲述卡\n${lesson.oneMinute}\n\n${lesson.questions.map(q => `### ${q.question}\n${q.answer}`).join('\n\n')}\n\n## 来源\n${sources.map(s => `- [${s.title}](${s.url})`).join('\n')}` })).id;
      }
      const video = storyboard ? this.a.videos.start({ ...lesson, storyboard }) : null;
      d.lesson = { ...lesson, ...(podcastId ? { podcastId } : {}), ...(video ? { videoId: video.id } : {}) };
    }
    this.save(d);
    if (job?.requestId === current.id) { jobs[key] = { ...job, state: 'ready', readyAt: at, issue: null }; this.store.set('secretary.jobs', jobs); }
    this.a.secretary?.schedule(); return { ok: true, ...d };
  }
}
module.exports = { AssistantWorkbench, dayOf, slotAt, DEFAULTS, DAY };
