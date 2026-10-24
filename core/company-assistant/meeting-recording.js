'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const keyOK = key => /^[a-f0-9-]{36}$/.test(String(key));
const hash = b => createHash('sha256').update(b).digest('hex');
class MeetingRecording {
  constructor(meetings) { this.m = meetings; }
  state(m) { return m.recording ||= { segments: [], gaps: [], bytes: 0, savedThrough: 0 }; }
  file(id, segment) {
    if (!keyOK(segment.key) || segment.file !== `recording-${segment.key}.webm`) throw new Error('录制文件无效');
    return path.join(this.m.dir(id), segment.file);
  }
  accept(m, r) {
    const rec = this.state(m), at = this.m.time(r.at);
    if (r.kind === 'recording-gap-open') { rec.openGap = { at, reason: String(r.reason || '暂停').slice(0,250) }; return; }
    if (r.kind === 'recording-gap') {
      const end = this.m.time(r.end); if (end < at) throw new Error('缺口时间无效');
      rec.gaps.push({ at, end, reason: String(r.reason || '暂停').slice(0, 250) }); delete rec.openGap; return;
    }
    if (!keyOK(r.key)) throw new Error('录制分段编号无效');
    let segment = rec.segments.find(s => s.key === r.key);
    if (r.kind === 'recording-start') {
      if (segment) return;
      if (!/^video\/webm(?:;codecs=(?:vp8|vp9)(?:,opus)?)?$/.test(r.mime)) throw new Error('录制编码不支持');
      segment = { key: r.key, file: `recording-${r.key}.webm`, at, end: at, mime: r.mime, bytes: 0, status: 'writing', width: r.width, height: r.height };
      const file = this.file(m.id, segment);
      if (fs.existsSync(file)) { if (fs.statSync(file).size !== 0) throw new Error('录制分段已有未登记内容'); }
      else fs.writeFileSync(file, Buffer.alloc(0), { flag: 'wx' }); rec.segments.push(segment); return;
    }
    if (!segment) throw new Error('录制分段尚未开始');
    if (r.kind === 'recording-chunk') {
      const bytes = Buffer.from(String(r.data || ''), 'base64');
      if (!bytes.length || bytes.length > 32 * 1024 * 1024 || !Number.isSafeInteger(r.offset) || r.offset < 0) throw new Error('录制数据无效');
      const file = this.file(m.id, segment), size = fs.statSync(file).size;
      if (size >= r.offset && size < r.offset + bytes.length) {
        if (segment.status !== 'writing') throw new Error('录制分段已结束');
        if (!r.offset && !bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) throw new Error('缺少 WebM 文件头');
        const written = size - r.offset;
        if (written) {
          const fd=fs.openSync(file,'r'),prefix=Buffer.alloc(written);try{fs.readSync(fd,prefix,0,written,r.offset);}finally{fs.closeSync(fd);}
          if(!prefix.equals(bytes.subarray(0,written)))throw new Error('录制部分写入内容不一致');
        }
        const fd = fs.openSync(file, 'a'); try { fs.writeFileSync(fd, bytes.subarray(written)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } else if (size >= r.offset + bytes.length) {
        // A save acknowledgement can be lost after durable append. Retry must not duplicate bytes.
        const fd = fs.openSync(file, 'r'), old = Buffer.alloc(bytes.length);
        try { fs.readSync(fd, old, 0, old.length, r.offset); } finally { fs.closeSync(fd); }
        if (hash(old) !== hash(bytes)) throw new Error('录制重试数据不一致');
      } else throw new Error('录制数据顺序不连续');
      segment.bytes = fs.statSync(file).size; segment.end = Math.max(segment.end, at);
      rec.bytes = rec.segments.reduce((n, s) => n + s.bytes, 0);
      rec.savedThrough = Math.max(rec.savedThrough, at); return;
    }
    if (r.kind === 'recording-finish') {
      if (at < segment.at || !segment.bytes) throw new Error('录制分段未完整保存');
      segment.end = at; segment.status = 'ready'; rec.savedThrough = Math.max(rec.savedThrough, at); return;
    }
    throw new Error('录制操作无效');
  }
  recover(m) {
    const rec = this.state(m);
    if(rec.openGap) { rec.gaps.push({...rec.openGap,end:Math.max(rec.openGap.at,m.capturedMs),open:true,reason:rec.openGap.reason+'后中断，缺口结束时间未知'}); delete rec.openGap; }
    for (const s of rec.segments) if (s.status === 'writing') { const next = rec.segments.filter(x => x.at > s.at).sort((a,b)=>a.at-b.at)[0]; s.status = 'interrupted'; rec.gaps.push({ at: s.at, end: Math.min(Math.max(s.end, m.capturedMs), next?.at ?? Infinity), reason: '异常退出：此分段可能不完整，已写入文件保留' }); }
  }
  index(id) {
    const m = this.m.load(id), rec = this.state(m);
    return { title: m.title, durationMs: m.capturedMs, recording: rec, note: '仅ready分段可可靠回放；暂停和异常缺口见gaps。原片不自动提供给模型。' };
  }
  locate(id, at) {
    at = this.m.time(at); const m = this.m.load(id), rec = this.state(m);
    if (rec.openGap && at >= rec.openGap.at || rec.gaps.some(g=>at>=g.at&&(g.open||at<g.end))) throw new Error('此时间位于暂停或中断缺口，没有完整录像');
    const s = rec.segments.filter(s => s.status === 'ready' && s.at <= at && s.end > at).sort((a,b) => b.at - a.at)[0];
    if (!s) throw new Error('此时间没有已完成的录制片段：可能正在保存、曾暂停或录制中断');
    return { segment: s, url: pathToFileURL(this.file(id, s)).href, offsetMs: at - s.at };
  }
}
module.exports = { MeetingRecording };
