'use strict';
const crypto = require('node:crypto');

// Reuse native Hub cards where supported; bound final-answer records otherwise.
// A phone request never resumes, submits to, or changes the selected session.
function sessionCards(assistant, { sessionId, before = null, limit = 6 } = {}) {
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) throw Error('会话编号无效');
  const meta = assistant.sessionMetadata(sessionId);
  if (!meta) throw Error('原会话已不存在，请刷新会话列表');
  limit = Math.max(1, Math.min(10, Number(limit) || 6));
  let records, issue = null, source = '原生 Hub 卡片';
  const native = assistant.deps.readNativeTurns?.(sessionId);
  if(native?.identity && require('./live-history').nativeId(meta) && native.identity!==require('./live-history').nativeId(meta))throw Error('原生卡片身份与所选会话不符');
  if (Array.isArray(native?.turns) && native.turns.length) {
    records = native.turns.map((r, i) => ({
      id: String(r.id || r.messageId || r.uuid || crypto.createHash('sha256').update(JSON.stringify([i,r])).digest('hex')),
      role: r.role || r.type || 'assistant', text: String(r.text || r.content || ''),
      timestamp: Number(r.timestamp || r.createdAt) || Date.parse(r.timestamp || r.createdAt) || null,
      tools: Array.isArray(r.tools) ? r.tools.map(t => ({ name: String(t.name || t.toolName || '工具'), status: String(t.status || '') })) : [],
    })).filter(r => r.text.trim() && ['user','assistant','message','answer'].includes(r.role));
  } else {
    const result = assistant.readLiveFinal(sessionId);
    records = (result.records || []).map(r => ({ id:r.id || r.messageId, role:'assistant', text:r.text, timestamp:r.timestamp, tools:[] }));
    issue = result.issue || (result.truncated ? '原生文件较长，目前为已核对的最近卡片。' : null);
    source = '绑定原生会话的最终回复';
  }
  const ids = records.map(r => r.id);
  const end = before == null ? records.length : ids.indexOf(before);
  if (end < 0) throw Error('历史卡片发生变化，请刷新后继续');
  const start = Math.max(0,end-limit), page=records.slice(start,end).reverse();
  // Bound an encrypted relay packet; truncation is visible, never called full text.
  const cards=page.map(r => ({...r, originalChars:r.text.length, truncated:r.text.length>24000, text:r.text.slice(0,24000)}));
  return {ok:true,sessionId,title:meta.title || meta.name,loadedAt:Date.now(),source,issue,cards,
    before: start>0 ? records[start].id : null, hasMore:start>0, coverage:`最新在前；当前来源读取到 ${records.length} 张卡片，可能仅覆盖最近记录`};
}
module.exports={sessionCards};
