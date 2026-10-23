'use strict';
function wav(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return b.toString('base64');
}
function distance(a, b) { if (!a || !b || a.length !== b.length) return Infinity; let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]); return sum / a.length; }
function changed(a, b) { if (!a || !b) return true; let pixels = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 24) pixels++; return distance(a, b) >= 3 || pixels / a.length > 0.002; }
class MeetingCapture {
  constructor({ document, window, save, status }) { this.d = document; this.w = window; this.save = save; this.status = status; this.streams = []; this.nodes = []; this.queue = []; this.levels = {}; }
  async open(sourceId, audio) {
    try {
      const stream = await this.w.navigator.mediaDevices.getUserMedia({ audio: audio.system ? { mandatory: { chromeMediaSource: 'desktop' } } : false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 5 } } });
      this.streams.push(stream);
      if (audio.system && !stream.getAudioTracks().length) throw new Error('未获取系统声音，请换为整个屏幕或关闭系统声音后重试');
      this.video = this.d.createElement('video'); this.video.muted = true; this.video.srcObject = stream; await this.video.play();
      for (const t of stream.getVideoTracks()) t.onended = () => { this.paused = true; this.disconnected = true; this.status('共享画面已断开，请结束会议并重新选择窗口'); };
      if (audio.system) this.audio(stream, 'system');
      if (audio.mic) { const mic = await this.w.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }); this.streams.push(mic); this.audio(mic, 'mic'); }
    } catch (e) { await this.dispose(); throw e; }
  }
  audio(stream, track) {
    const ctx = new this.w.AudioContext({ sampleRate: 16000 }), src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1), mute = ctx.createGain(); mute.gain.value = 0;
    const n = { ctx, src, proc, mute, track, samples: [], length: 0, at: null }; this.nodes.push(n);
    proc.onaudioprocess = e => {
      if (!this.running || this.paused) return;
      const copy = new Float32Array(e.inputBuffer.getChannelData(0));
      if (n.at === null) n.at = this.elapsed();
      n.samples.push(copy); n.length += copy.length; let peak = 0; for (const v of copy) peak = Math.max(peak, Math.abs(v)); this.levels[track] = peak;
      if (n.length >= ctx.sampleRate * 15) this.flush(n);
    };
    src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
    stream.getAudioTracks().forEach(t => { t.onended = () => this.status((track === 'mic' ? '麦克风' : '系统声音') + '已断开，其他采集继续，请结束后重新选择设备'); });
  }
  elapsed() { return Math.max(0, Math.round(this.w.performance.now() - this.started)); }
  start(crop) { this.crop = crop; this.started = this.w.performance.now(); this.running = true; this.paused = false; this.timer = setInterval(() => { if (!this.paused) { void this.frame(); this.enqueue({ kind: 'heartbeat', at: this.elapsed() }); } }, 1000); void this.frame(true); }
  enqueue(item) { this.queue.push(item); if (this.queue.length > 30) { this.paused = true; this.status('保存积压，已暂停采集；点击重试保存后继续。尚未写入的片段保留在内存中。'); } void this.drain(); }
  async drain() {
    if (this.saving || this.saveError) return;
    this.saving = true;
    try { while (this.queue.length) { await this.save(this.queue[0]); this.queue.shift(); } }
    catch (e) { this.saveError = e.message; this.paused = true; this.status('材料保存失败，已暂停：' + e.message + '。请重试保存，暂勿关闭 Hub。'); }
    finally { this.saving = false; }
  }
  async retry() { this.saveError = ''; await this.drain(); }
  flush(n) {
    if (!n.length) return;
    const samples = new Float32Array(n.length); let i = 0; for (const b of n.samples) { samples.set(b, i); i += b.length; }
    this.enqueue({ kind: 'audio', track: n.track, at: n.at, end: n.at + Math.round(n.length / n.ctx.sampleRate * 1000), data: wav(samples, n.ctx.sampleRate) });
    n.samples = []; n.length = 0; n.at = null;
  }
  async frame(force = false) {
    if (this.paused) throw new Error('请先继续采集再截图');
    const v = this.video; if (!v?.videoWidth || this.drawing) return; this.drawing = true;
    try {
      const c = this.crop, x = v.videoWidth * c.x, y = v.videoHeight * c.y, width = v.videoWidth * c.w, height = v.videoHeight * c.h;
      const small = this.d.createElement('canvas'); small.width = 160; small.height = 90;
      const ctx = small.getContext('2d', { willReadFrequently: true }); ctx.drawImage(v, x, y, width, height, 0, 0, 160, 90);
      const rgba = ctx.getImageData(0, 0, 160, 90).data, sig = new Uint8Array(160 * 90); for (let i = 0; i < sig.length; i++) sig[i] = (rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]) / 3;
      const stable = distance(sig, this.previous) < 1.5; this.previous = sig;
      if (!force && (!stable || !changed(sig, this.saved))) return;
      const canvas = this.d.createElement('canvas'); canvas.width = Math.round(width); canvas.height = Math.round(height); canvas.getContext('2d').drawImage(v, x, y, width, height, 0, 0, width, height);
      this.enqueue({ kind: 'slide', at: this.elapsed(), data: canvas.toDataURL('image/jpeg', 0.9).split(',')[1], forced: force }); this.saved = sig;
    } finally { this.drawing = false; }
  }
  async flushAll() { for (const n of this.nodes) this.flush(n); while (this.saving) await new Promise(r => setTimeout(r, 30)); await this.drain(); if (this.queue.length) throw new Error('还有材料未保存，请重试保存'); }
  async pause() { this.paused = true; await this.flushAll(); }
  resume() { if (this.disconnected) throw new Error('共享画面已断开，请结束会议后重新选择窗口'); if (this.queue.length) throw new Error('请先重试保存'); this.paused = false; }
  async stop() { this.paused = true; clearInterval(this.timer); await this.flushAll(); this.running = false; await this.dispose(); }
  async dispose() { clearInterval(this.timer); for (const s of this.streams) s.getTracks().forEach(t => t.stop()); for (const n of this.nodes) { n.proc.disconnect(); n.src.disconnect(); await n.ctx.close(); } this.nodes = []; this.streams = []; if (this.video) this.video.srcObject = null; }
}
module.exports = { MeetingCapture, wav, distance, changed };
