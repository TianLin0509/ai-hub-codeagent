'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const {projectSessionStates}=require('./session-state');
const stateLine=row=>row.hubState ? `${row.hubState.label}；${row.hubState.isActive===null?'活跃未知':row.hubState.isActive?'活跃分组':'非活跃'}；${row.hubState.hasUnread===null?'未读未知':row.hubState.hasUnread?'有未读 '+row.hubState.unreadCount+' 条':'无未读'}` : row.status;
const safeLine = value => String(value ?? '').replace(/[\r\n|]/g, ' ');

function preview(text, chars = 1800) {
  text = String(text || '');
  if (text.length <= chars) return text;
  return text.slice(0, Math.floor(chars * .35)) + '\n[正文较长，中段请按来源读取]\n' + text.slice(-Math.floor(chars * .65));
}

// Human-readable, recoverable projections of authoritative runtime and native
// records. The AI never edits these files to change a session's actual state.
class AssistantDossier {
  constructor(dataDir) {
    this.directory = path.join(dataDir, 'assistant', 'workbench');
    this.baseline = null;
    this.identity = null;
    this.last = null;
    this.archived = new Map();
    try {
      const saved=JSON.parse(fs.readFileSync(path.join(this.directory,'manifest.json'),'utf8'));
      if(saved.schemaVersion===1)for(const row of saved.inventory||[])this.archived.set(row.id,row);
    } catch (error) { if(error.code!=='ENOENT')this.recoveryIssue='上次目录未能读取，已从真实会话重建；旧文件保留'; }
  }
  write(relative, text) {
    const file = path.join(this.directory, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try { if (fs.readFileSync(file, 'utf8') === text) return file; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, file);
    return file;
  }
  publish(inventory, identity = '') {
    if (identity !== this.identity) { this.identity = identity; this.baseline = null; }
    const entries = projectSessionStates(inventory).map(session => {
      const final = session.latestFinal;
      const previous=this.archived.get(session.id);
      const archivedDocument=previous?.latestRef&&previous?.document&&path.resolve(previous.document).startsWith(path.resolve(this.directory,'sessions')+path.sep)&&fs.existsSync(previous.document)?previous.document:null;
      const row = {
        id: session.id, title: session.title || session.name || session.id, kind: session.kind,
        isOpen: !!session.isOpen, status: session.status || 'unknown', hubState:session.hubState, nativeSessionId: session.nativeSessionId || null,
        latestRef: final?.ref || (archivedDocument?previous.latestRef:null), latestAt: final?.timestamp || (archivedDocument?previous.latestAt:null), issue: session.liveIssue || null,
        lastKnownOnly:!final&&!!archivedDocument,
      };
      if(row.lastKnownOnly){row.issue=(row.issue?row.issue+'；':'')+'保留上次工作档案，尚不能当作当前最新答复';row.document=archivedDocument;}
      row.revision = hash({ ...row, finalText: final?.text || '' });
      if ((session.isOpen || final)&&!row.lastKnownOnly) {
        const relative = 'sessions/' + hash(session.id).slice(0, 24) + '/' + row.revision + '.md';
        row.document = path.join(this.directory, relative);
        this.write(relative, `# ${safeLine(row.title)}\n\n会话：${safeLine(row.id)}\n版本：${row.revision}\n状态：${safeLine(stateLine(row))}${row.isOpen ? '（当前已打开）' : '（未打开）'}\n原生会话：${safeLine(row.nativeSessionId || '尚未绑定')}\n\n## 最近的原生最终回复\n\n${final ? `[${final.ref}] · ${safeLine(final.timestamp)}\n\n${final.text}\n\n来源：${safeLine(final.transcriptPath || '')}\n\n这证明目标写出了上述答复，不自动证明业务成果已经验收。` : `暂无已核对的最终回复。${safeLine(row.issue || '')}`}\n`);
      }
      return { row, final };
    }).sort((a, b) => a.row.id.localeCompare(b.row.id));
    const all = entries.map(entry => entry.row);
    const opened = all.filter(row => row.isOpen);
    const active=opened.filter(row=>row.hubState.isActive);
    const revisions = Object.fromEntries(entries.map(({ row }) => [row.id, row.revision]));
    const revision = hash(all);
    const changed = entries.filter(({ row }) => !this.baseline || this.baseline[row.id] !== row.revision);
    const removed = this.baseline ? Object.keys(this.baseline).filter(id => !revisions[id]) : [];
    const markdown = [
      '# AI Hub 当前工作台', '', `版本：${revision}`, '',
      `当前已打开 ${opened.length} 个会话，其中活跃 ${active.length} 个、有未读 ${opened.filter(row=>row.hubState.hasUnread).length} 个、等你响应 ${opened.filter(row=>row.hubState.needsUserInput).length} 个。以下全部列出；已知会话共 ${all.length} 个，完整目录见 ALL-SESSIONS.md。`,
      '状态和未读直接复用 Hub 侧栏规则。已打开不等于活跃；未读不等于等你响应；运行中不等于任务完成。普通会话按本身状态，群聊成员按成员自身状态。最终回复另按原生记录核对。', '',
      '| 会话 | 当前状态 | 最近答复来源 | 工作档案 |', '| --- | --- | --- | --- |',
      ...opened.map(row => `| ${safeLine(row.title)} · ${row.id} | ${safeLine(stateLine(row))} | ${row.latestRef ? '[' + row.latestRef + ']'+(row.lastKnownOnly?'（上次档案，最新未核实）':'') : safeLine(row.issue || '暂无最终回复')} | ${row.document} |`),
      '', '每轮有完整的当前会话清单；详细正文按变化提供，缺少先前内容时应读取相应工作档案或调用 session_evidence。',
      '本目录由 Hub 从运行状态和原生答复生成。请在对话中提出修正；修改这些投影文件不会改变真实会话，也不会授予派工权限。', '',
    ].join('\n');
    this.write('CURRENT.md', markdown);
    this.prune(entries.map(entry=>entry.row));
    this.write('ALL-SESSIONS.md', '# AI Hub 完整会话目录\n\n' + all.map(row => `- ${safeLine(row.title)} · ${row.id} · ${row.isOpen ? safeLine(stateLine(row)) : '未打开，运行状态未知'}`).join('\n') + '\n');
    this.write('manifest.json', JSON.stringify({ schemaVersion: 1, revision, inventory: all }, null, 2));
    this.archived=new Map(all.map(row=>[row.id,row]));
    const sources = changed.filter(({ row, final }) => row.isOpen && final).map(({ row, final }) => ({
      ...final, sessionId: row.id, title: row.title, role: 'assistant', text: preview(final.text), originalChars: final.text.length,
      truncated: final.text.length > 1800, document: row.document, evidenceMeaning: '原生最终回复，属于助手自述；业务成果仍需核验',
    }));
    this.last = { revision, inventory: all, openedInventory: opened, activeInventory: active, revisions,
      markdownPath: path.join(this.directory, 'CURRENT.md'), markdown,
      mode: this.baseline ? 'delta-with-complete-inventory' : 'checkpoint',
      baselineMeaning: '相对于本进程上次通过工具返回的版本；不等于模型仍记得，缺少内容时重新读取来源',
      changedSessionIds: changed.map(entry => entry.row.id), removedSessionIds: removed,
      allActiveSessionsIncluded: true, activeCount: active.length, openedCount:opened.length, unreadCount:opened.filter(row=>row.hubState.hasUnread).length, needsInputCount:opened.filter(row=>row.hubState.needsUserInput).length, knownCount: all.length,
      sources, fullReplyChars: entries.filter(entry => entry.row.isOpen).reduce((n, entry) => n + (entry.final?.text.length || 0), 0),
    };
    return this.last;
  }
  // 每个会话只留最近几版正文存档，旧版删除（状态一变就会多一版，长期只增不删会越积越大）。
  prune(rows, keep = 3) {
    const root = path.join(this.directory, 'sessions');
    let dirs = [];
    try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return; }
    const current = new Set(rows.map(row => row.document).filter(Boolean).map(file => path.resolve(file)));
    for (const dir of dirs) {
      const folder = path.join(root, dir);
      const files = fs.readdirSync(folder).filter(name => name.endsWith('.md')).map(name => {
        const file = path.join(folder, name); return { file, mtime: fs.statSync(file).mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);
      for (const { file } of files.slice(keep)) if (!current.has(path.resolve(file))) { try { fs.unlinkSync(file); } catch {} }
    }
  }
  noteServed(workbench) {
    if (workbench?.revisions) this.baseline = { ...workbench.revisions };
  }
}
module.exports = { AssistantDossier, preview };
