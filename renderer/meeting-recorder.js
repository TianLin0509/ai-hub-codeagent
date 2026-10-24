'use strict';
// Each recorder owns a complete WebM. Time-slice blobs are appended, never treated as separate videos.
class MeetingRecorder {
  constructor({ window, streams, elapsed, save, onError, segmentMs = 30000 }) {
    Object.assign(this, { w: window, streams, elapsed, save, onError, segmentMs }); this.active = new Set(); this.queue = []; this.pending = Promise.resolve(); this.error = ''; this.running = false;
  }
  async open() {
    const MR = this.w.MediaRecorder;
    this.mime = ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8', 'video/webm'].find(x => MR?.isTypeSupported(x));
    if (!this.mime) throw new Error('本机不支持会议视频编码，无法开始连续录制');
    const tracks = this.streams[0].getVideoTracks();
    this.ctx = new this.w.AudioContext(); this.destination = this.ctx.createMediaStreamDestination(); this.sources = [];
    for (const stream of this.streams) if (stream.getAudioTracks().length) {
      const source = this.ctx.createMediaStreamSource(stream), gain = this.ctx.createGain(); gain.gain.value = this.streams.filter(s => s.getAudioTracks().length).length > 1 ? 0.5 : 1;
      source.connect(gain); gain.connect(this.destination); this.sources.push({ source, gain });
    }
    this.stream = new this.w.MediaStream([...tracks, ...(this.sources.length ? this.destination.stream.getAudioTracks() : [])]);
    await this.ctx.resume();
  }
  push(item) { this.queue.push(item); if (this.queue.length > 45) this.fail(new Error('录屏保存积压，已暂停；请重试保存')); void this.drain(); }
  fail(e) { if (!this.error) { this.error = e.message; this.running = false; clearTimeout(this.timer); this.onError(e.message); } }
  async drain() {
    if (this.saving || this.error) return; this.saving = true;
    try { while (this.queue.length) { await this.save(this.queue[0]); this.queue.shift(); } }
    catch (e) { this.fail(e); } finally { this.saving = false; }
  }
  part() {
    const recorder = new this.w.MediaRecorder(this.stream, { mimeType: this.mime, videoBitsPerSecond: 2500000, audioBitsPerSecond: 96000 });
    const key = this.w.crypto.randomUUID(), at = this.elapsed(); let offset = 0, finish;
    const settings = this.stream.getVideoTracks()[0].getSettings();
    const part = { recorder, done: new Promise(r => { finish = r; }) }; this.active.add(part);
    this.push({ kind: 'recording-start', key, at, mime: this.mime, width: settings.width, height: settings.height });
    recorder.ondataavailable = event => {
      const end = this.elapsed();
      this.pending = this.pending.then(async () => { if (event.data.size) { const b = Buffer.from(await event.data.arrayBuffer()); this.push({ kind: 'recording-chunk', key, at: end, offset, data: b.toString('base64') }); offset += b.length; } }).catch(e => this.fail(e));
    };
    recorder.onerror = e => this.fail(new Error(e.error?.message || '视频编码失败'));
    recorder.onstop = () => { const end = this.elapsed(); this.active.delete(part); this.pending = this.pending.then(() => this.push({ kind: 'recording-finish', key, at: end })); finish(); };
    try { recorder.start(1000); } catch(e) { this.active.delete(part); finish(); throw e; } return part;
  }
  start() {
    if (this.running) return;
    if (this.error) throw new Error(this.error); this.running = true; try { this.current = this.part(); this.schedule(); } catch(e) { this.fail(e); throw e; }
  }
  schedule() {
    this.timer = setTimeout(() => {
      if (!this.running) return;
      const old = this.current; try { this.current = this.part(); } catch(e) { this.fail(e); return; }
      // Overlap avoids intentionally dropping frames between independently playable segments.
      setTimeout(() => { if (old.recorder.state !== 'inactive') old.recorder.stop(); }, 500);
      this.schedule();
    }, this.segmentMs);
  }
  async pause() {
    this.running = false; clearTimeout(this.timer); const parts = [...this.active];
    for (const p of parts) if (p.recorder.state !== 'inactive') p.recorder.stop();
    await Promise.all(parts.map(p => p.done)); await this.pending; await this.flush();
  }
  async flush() { while (this.saving) await new Promise(r => setTimeout(r, 25)); await this.drain(); if (this.queue.length || this.error) throw new Error(this.error || '视频尚未保存'); }
  async retry() { this.error = ''; await this.flush(); }
  async close() { try { await this.pause(); } finally { for (const n of this.sources || []) { n.source.disconnect(); n.gain.disconnect(); } if (this.ctx) await this.ctx.close(); } }
}
module.exports = { MeetingRecorder };
