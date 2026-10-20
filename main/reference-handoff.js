'use strict';
// 交接跟人走（2026-10-20）：会话里发出的消息带【引用会话】时，找出被引用的是哪个 Hub 会话，交给公司联动（home.js handoff）：
// 旧会话已关闭 → 它名下还能追问的编号转给新会话；还开着 → 只记下关系，等它关了再转。
// 被引用的会话怎么认：引用时 Hub 解析出的聊天记录路径（session-reference:resolve）先记在内存里；Hub 重启过就读那份 md 的头部
// 「- Hub 会话：<编号>」（core/session-transcript-md.js）。只认 Hub 聊天记录目录里的文件，别处的路径一律不读。
const fs = require('node:fs');
const path = require('node:path');
const { parseReferenceLines } = require('../core/session-reference.js');

const HEADER_BYTES = 4096;
const REPEAT_MS = 60000;

function createReferenceHandoff({ getTranscriptDir, getBridge, logger = console, now = () => Date.now() } = {}) {
  const resolved = new Map();
  const recent = new Map();
  const norm = p => { const r = path.resolve(String(p || '')); return process.platform === 'win32' ? r.toLowerCase() : r; };
  function insideTranscripts(p) {
    let dir;
    try { dir = getTranscriptDir(); } catch { return false; }
    if (!dir) return false;
    const rel = path.relative(norm(dir), norm(p));
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && /\.md$/i.test(p);
  }
  function noteResolved(filePath, sessionId) {
    if (!filePath || !sessionId) return;
    resolved.set(norm(filePath), String(sessionId));
    if (resolved.size > 500) resolved.delete(resolved.keys().next().value);
  }
  function sourceOf(filePath) {
    const hit = resolved.get(norm(filePath));
    if (hit) return hit;
    if (!insideTranscripts(filePath)) return null;
    let fd = null;
    try {
      fd = fs.openSync(filePath, 'r');
      const buffer = Buffer.alloc(HEADER_BYTES);
      const bytes = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
      const m = buffer.subarray(0, bytes).toString('utf8').match(/^- Hub 会话：(\S+)\s*$/m);
      return m ? m[1] : null;
    } catch { return null; }
    finally { if (fd !== null) { try { fs.closeSync(fd); } catch {} } }
  }
  // 返回本次处理的结果列表（测试用）；没有引用会话、或公司联动不在家里一端时什么也不做。
  function onPrompt(ev) {
    const { hubSessionId, text } = ev || {};
    if (!hubSessionId || !text || !String(text).includes('【引用会话】')) return [];
    let bridge = null;
    try { bridge = getBridge(); } catch { bridge = null; }
    if (!bridge || typeof bridge.handoff !== 'function') return [];
    const out = [];
    for (const ref of parseReferenceLines(text)) {
      if (ref.type !== 'session') continue;
      const source = sourceOf(ref.path);
      if (!source || source === hubSessionId) continue;
      // 同一条消息会从 hook 和原生记录两路各报一次：一分钟内同一对只处理一次。
      const key = hubSessionId + '|' + source;
      if (recent.has(key) && now() - recent.get(key) < REPEAT_MS) continue;
      recent.set(key, now());
      if (recent.size > 200) recent.delete(recent.keys().next().value);
      try { out.push({ source, ...bridge.handoff(hubSessionId, source, { why: '引用会话「' + ref.name + '」' }) }); }
      catch (error) { logger.warn?.('[reference-handoff] 转交失败：' + (error && error.message)); }
    }
    return out;
  }
  return { noteResolved, sourceOf, onPrompt };
}

module.exports = { createReferenceHandoff };
