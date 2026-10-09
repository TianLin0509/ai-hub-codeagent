'use strict';
// 手机对话记录：手机发来的每条消息与回复（千问/DeepSeek 快答或助理会话），供助理 Tab 的「对话记录」查看。
// 快答走 API，不进任何 CLI 会话，没有这份记录就无处可看（2026-10-04 用户）。按月一个 JSONL，只追加。
// 条目：{id, at, role:'user'|'assistant'|'system', input?:'text'|'voice', lane?:'fast'|'assistant', by?, text, ms?, durationMs?}
const fs = require('node:fs');
const path = require('node:path');
const MAX_TEXT = 20000;

class DialogLog {
  constructor(directory) { this.dir = path.join(directory, 'dialog'); }
  fileFor(at) { const d = new Date(at); return path.join(this.dir, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}.jsonl`); }
  append(entry) {
    const row = { ...entry, at: entry.at || Date.now(), text: String(entry.text || '').slice(0, MAX_TEXT) };
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this.fileFor(row.at), JSON.stringify(row) + '\n', 'utf8');
    return row;
  }
  // 最近 limit 条（跨月读取最近两个文件），按时间正序。
  recent({ limit = 300 } = {}) {
    if (!fs.existsSync(this.dir)) return [];
    const files = fs.readdirSync(this.dir).filter(f => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().slice(-2);
    const rows = [];
    for (const f of files) for (const line of fs.readFileSync(path.join(this.dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch {}
    }
    return rows.sort((a, b) => a.at - b.at).slice(-Math.max(1, Math.min(2000, limit)));
  }
}
module.exports = { DialogLog };
