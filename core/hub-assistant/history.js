'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { SearchCursorStore } = require('../session-search-query');

// Reuse the existing natural-language index. Never opens a native transcript or
// mutates the production index. Evidence ids bind to content, not recyclable row ids.
class AssistantHistory {
  constructor(databasePath) { this.databasePath = databasePath; }
  context({ query = '', userOnly = false, hours = 3, now = Date.now(), from, to, rangeKind, timeZone, maxChars = 24000, excludeSessionId, excludeNativeSessionId, excludeSessionIds=[], excludeNativeSessionIds=[] } = {}) {
    if (!fs.existsSync(this.databasePath)) return { available: false, sources: [], coverage: '历史索引尚未建立', asOf: now };
    hours = Math.max(1, Math.min(168, Number(hours) || 3));
    maxChars = Math.max(2000, Math.min(48000, Number(maxChars) || 24000));
    const db = new DatabaseSync(this.databasePath, { readOnly: true });
    let search;
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000; BEGIN');
      const since = Number.isFinite(from)?from:now-hours*3600000;
      const until = Number.isFinite(to)?Math.min(to,now):now;
      const filterArgs=[excludeSessionId||'__none__',excludeNativeSessionId||'__none__'];
      const hubIds=[...new Set(excludeSessionIds)],nativeIds=[...new Set(excludeNativeSessionIds)];
      filterArgs.push(...hubIds,...nativeIds);
      const base = `FROM docs d JOIN sessions s ON s.key=d.session_key JOIN sources z ON z.key=s.source_key
        WHERE ${userOnly?"d.scope='user'":"d.scope IN ('user','assistant')"} AND d.event_id <> 'last-output-preview'
        AND z.searchable=1 AND z.stale=0 AND s.provider<>'meeting' AND COALESCE(s.hub_session_id,'')<>? AND COALESCE(s.native_session_id,'')<>?
        ${hubIds.length?'AND COALESCE(s.hub_session_id,\'\') NOT IN ('+hubIds.map(()=>'?').join(',')+')':''}
        ${nativeIds.length?'AND COALESCE(s.native_session_id,\'\') NOT IN ('+nativeIds.map(()=>'?').join(',')+')':''}`;
      const total = db.prepare(`SELECT count(*) count ${base} AND d.timestamp>=? AND d.timestamp<=?`).get(...filterArgs, since, until).count;
      let rows;
      let searchPartial = false;
      if (query.trim()) {
        search = new SearchCursorStore({ databasePath: this.databasePath, maxQueryDocs: 12000, getStats: () => ({ readOnly: true }) });
        const result = search.search({ query: query.slice(0, 180), limit: 8 });
        if (result.error) throw new Error(result.error);
        searchPartial = result.truncated;
        rows = result.results.flatMap(hit => {
          const anchor=hit.bestMatch?.eventId?db.prepare('SELECT ordinal FROM docs WHERE session_key=? AND event_id=?').get(hit.key,hit.bestMatch.eventId):null;
          return anchor?db.prepare(`SELECT d.*,s.title,s.provider,s.hub_session_id ${base} AND s.key=? ORDER BY abs(d.ordinal-?),d.ordinal LIMIT 6`).all(...filterArgs,hit.key,anchor.ordinal)
            :db.prepare(`SELECT d.*,s.title,s.provider,s.hub_session_id ${base} AND s.key=? ORDER BY d.ordinal DESC LIMIT 6`).all(...filterArgs,hit.key);
        });
      } else {
        // Round robin recent messages across sessions, so a single noisy session
        // cannot consume the complete evidence budget.
        rows = db.prepare(`SELECT * FROM (SELECT d.*,s.title,s.provider,s.hub_session_id,
          row_number() OVER (PARTITION BY s.key ORDER BY d.timestamp DESC,d.ordinal DESC) slot
          ${base} AND d.timestamp>=? AND d.timestamp<=?) ORDER BY slot,timestamp DESC LIMIT 160`).all(...filterArgs, since, until);
      }
      let used = 0;
      const sources = [];
      for (const row of rows) {
        const room = maxChars - used;
        if (room < 200) break;
        const cap = Math.min(3500, room);
        // Keep the end too: final results and waiting decisions often follow
        // an implementation narrative. Mark the omitted middle explicitly.
        const text = row.text.length <= cap ? row.text : row.text.slice(0, Math.floor(cap * .35)) + '\n[中段省略]\n' + row.text.slice(-Math.floor(cap * .65) + 10);
        const ref = 'E' + createHash('sha256').update(JSON.stringify([row.session_key,row.event_id,row.text])).digest('hex').slice(0,16);
        sources.push({ ref, sessionKey: row.session_key, eventId: row.event_id, sessionId: row.hub_session_id,
          title: row.title, provider: row.provider, role: row.scope, timestamp: row.timestamp, text,
          originalChars: row.text.length, truncated: text.length < row.text.length });
        used += text.length;
      }
      return { available: true, asOf: now, ...(query.trim()?{range:'all-indexed-history'}:{range:rangeKind||'rolling-window',since,until,timeZone,hours:(until-since)/3600000,windowMessages:total}), query, sources, selectedChars: used,
        truncated: searchPartial || rows.length > sources.length || (!query.trim() && total > sources.length) || sources.some(s => s.truncated),
        coverage: query.trim() ? '此部分为检索命中的单会话自然语言片段；未命中不代表任务不存在。群聊材料由独立文件来源提供。'
          : '此部分为时间窗口内已入库的单会话自然语言片段；工具结果未读，未打开会话的实时状态未知。群聊材料由独立文件来源提供。' };
    } finally { search?.close(); try { db.exec('ROLLBACK'); } catch {} db.close(); }
  }
}
module.exports = { AssistantHistory };
