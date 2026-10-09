'use strict';
// 边说边出字（「本地识别」模式的电脑端录音）：
// - 本地模型已在显卡：只重识别「最近一个小停顿（≥0.3 秒）之后」的那一小截（窗口短、刷新快），
//   小停顿前的半句先识别定下来；说到较长停顿处整段定稿：先做声纹筛查（他人小句静音），再整段识别一次得到最终文字。
// - 本地模型还在装（冷启动约 4～11 秒）：录音同时推给百炼实时 API（3.1 流式，逐字出），
//   模型装好后在下一个停顿处切到本地；这段的声纹在收尾时按句比对。
// - 实时 API 不可用（没配 Key、免费额度用完自动停止、连接失败）：未就绪期间的段落交给 Token Plan，说完一段出一段。
// 与 RecordedVoice 同一接口（ready / audio / finish / cancel / onEvent）。
const plan = require('./voice-tokenplan');
const voiceprint = require('./voiceprint');

const RATE = 16000;
const FRAME_BYTES = RATE / 50 * 2; // 20ms

class LiveVoice {
  // local：LocalAsr；recognizeSegment(pcm, signal)：定稿一段（声纹筛查 + 本地 / Token Plan，见 voice-engine）；
  // context：本地滚动识别用的热词文本；openApi(onEvent)：开一路实时 API（返回 VoiceStream，不可用时返回 null）；
  // vp：{ profile, speaker } 声纹；usage：用量账本。
  constructor({ sampleRate, onEvent, local, recognizeSegment, context = '', openApi = () => null, vp = null,
    usage = () => {}, log = console.warn, rollingMs = 250, maxSeconds = 300 }) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('麦克风采样率不受支持');
    Object.assign(this, { rate: sampleRate, onEvent, local, recognizeSegment, context, vp, usage, log, maxSeconds });
    this.state = 'recording'; this.carry = Buffer.alloc(0); this.seconds = 0;
    this.all = Buffer.alloc(0); this.segStart = 0; this.levels = [];
    const vad = require('./voice-vad'); this.vadStream = vad.available() ? new vad.VadStream() : null; // 有说话检测时用它断句
    this.parts = []; this.preview = ''; this.rolledBytes = 0; this.rolling = false;
    // 段内小句：uttFrom 起是正在滚动识别的那一截；committed 是本段里已定下的前半句
    this.uttFrom = 0; this.committed = []; this.uttScanned = 0; this.uttRun = 0; this.uttSpeech = false;
    this.controller = new AbortController();
    this.api = null;
    this.mode = local?.ready ? 'local' : 'plan';
    if (this.mode !== 'local') this.startApi(openApi);
    this.timer = setInterval(() => this.roll(), rollingMs);
    this.timer.unref?.();
    this.ready = Promise.resolve();
  }
  get ended() { return ['done', 'error', 'cancelled'].includes(this.state); }

  startApi(openApi) {
    let stream = null;
    try { stream = openApi(event => this.onApiEvent(event)); } catch (error) { this.log('[voice] 实时识别未能开启：', error.message); }
    if (!stream) return;
    this.api = { stream, start: 0, end: null, queue: [], ready: false, done: null, text: '', failed: false };
    this.mode = 'api';
    this.api.done = new Promise(resolve => { this.api.resolveDone = resolve; });
    stream.ready.then(async () => {
      this.api.ready = true;
      for (const chunk of this.api.queue.splice(0)) await stream.audio(chunk).catch(() => {});
      if (this.api.finishRequested) stream.finish().catch(() => {});
    }).catch(error => this.apiFailed(error.message));
  }
  onApiEvent(event) {
    if (!this.api) return;
    if (event.type === 'partial') { this.api.text = event.text; this.emit(); }
    else if (event.type === 'done') { this.api.text = event.text; this.api.resolveDone(); this.emit(); }
    else if (event.type === 'error') this.apiFailed(event.message);
  }
  // 实时 API 中途失败：已定稿的句子保留，其后的录音补交 Token Plan / 本地，之后不再用实时 API。
  apiFailed(message) {
    const api = this.api;
    if (!api || api.failed || this.ended) return;
    api.failed = true; this.log('[voice] 实时识别中断，改由 Token Plan / 本地接力：', message);
    const sentences = [...(api.stream.sentences?.values?.() || [])].filter(s => s.final);
    api.text = plan.joinTexts(sentences.map(s => s.text));
    const lastEnd = sentences.reduce((m, s) => Math.max(m, s.end || 0), 0);
    const from = Math.min(this.all.length, api.start + Math.floor(lastEnd * RATE / 1000) * 2);
    const to = api.end ?? this.segStart;
    api.end = from;
    if (to > from) this.finalize(this.all.subarray(from, to));
    this.mode = this.local?.ready ? 'local' : 'plan';
    api.resolveDone?.(); this.emit();
  }

  async audio(data) {
    if (this.state !== 'recording') throw new Error('录音已经结束');
    const bytes = Buffer.concat([this.carry, Buffer.from(data)]);
    const whole = bytes.length - (bytes.length % 2 ? 1 : 0);
    if (!whole || bytes.length > 65536) { this.fail('录音数据格式异常'); throw new Error('录音数据格式异常'); }
    const usable = whole - (whole % (2 * Math.max(1, Math.round(this.rate / RATE))));
    this.carry = bytes.subarray(usable);
    this.seconds += usable / 2 / this.rate;
    if (this.seconds > this.maxSeconds) { this.fail('录音过长，请分段重试'); throw new Error('录音过长'); }
    const chunk = plan.toRate16k(bytes.subarray(0, usable), this.rate);
    this.all = Buffer.concat([this.all, chunk]);
    if (this.mode === 'api' && this.api) {
      if (this.api.ready) await this.api.stream.audio(chunk).catch(error => this.apiFailed(error.message));
      else this.api.queue.push(chunk);
    }
    // 当前段的帧音量（段起点之后的整帧）
    if (this.vadStream) this.levels.push(...this.vadStream.push(chunk));
    else {
      const segBytes = this.all.length - this.segStart;
      const have = this.levels.length * FRAME_BYTES;
      if (segBytes - have >= FRAME_BYTES) this.levels.push(...plan.frameLevels(this.all.subarray(this.segStart), have));
    }
    for (let f; (f = plan.cutFrame(this.levels)) > 0;) this.cut(this.segStart + f * FRAME_BYTES, f);
    if (this.mode === 'local') this.scanUtterances();
  }
  // 段内找 ≥0.3 秒的小停顿：之前那一截先识别定下来，滚动窗口从停顿处重新开始。
  scanUtterances() {
    const voiced = this.levels.filter(v => v > 120).sort((a, b) => a - b);
    const quiet = Math.max(120, (voiced.length ? voiced[Math.floor(voiced.length * 0.9)] : 0) * 0.12);
    for (let f = this.uttScanned; f < this.levels.length; f++) {
      if (this.levels[f] >= quiet) { this.uttSpeech = true; this.uttRun = 0; continue; }
      if (this.uttSpeech && ++this.uttRun >= 15) {
        const at = this.segStart + (f - 7) * FRAME_BYTES;
        if (at - this.uttFrom >= RATE * 2) this.commitUtterance(at);
        this.uttSpeech = false; this.uttRun = 0;
      }
    }
    this.uttScanned = this.levels.length;
  }
  commitUtterance(at) {
    const pcm = this.all.subarray(this.uttFrom, at);
    const item = { text: this.preview ? this.preview + '，' : '' };
    this.committed.push(item);
    this.uttFrom = at; this.preview = ''; this.rolledBytes = 0;
    if (!this.local?.ready) return;
    item.done = this.local.transcribe([pcm], this.context, 3000 + pcm.length / 32000 * 600)
      // 小停顿多半在句中：句末标点换成逗号，整段定稿时以最终识别为准
      .then(([text]) => { item.text = text.replace(/[。．.!！?？]+$/, '，'); this.emit(); })
      .catch(error => this.log('[voice] 本地小句识别失败：', error.message));
  }
  // 在停顿处切段：本地 / Token Plan 模式定稿这一段；实时 API 模式下若本地已就绪，从这里切到本地。
  cut(at, frames) {
    const coveredByApi = this.mode === 'api'; // 这一段已由实时 API 识别，不再定稿
    if (coveredByApi) {
      if (this.local?.ready && this.api && !this.api.failed) {
        this.api.end = at; this.mode = 'local';
        const stream = this.api.stream;
        if (this.api.ready) stream.finish().catch(error => this.apiFailed(error.message));
        else this.api.finishRequested = true;
      }
    }
    // 先把当前预览交给定稿段、清空，再显示：避免同一句短暂显示两遍
    const pcm = this.all.subarray(this.segStart, at), preview = plan.joinTexts([...this.committed.map(c => c.text), this.preview]);
    this.segStart = at; this.levels = this.levels.slice(frames); this.preview = ''; this.rolledBytes = 0;
    this.committed = []; this.uttFrom = at; this.uttScanned = 0; this.uttRun = 0; this.uttSpeech = false;
    if (!coveredByApi) {
      this.finalize(pcm, preview);
      if (this.mode === 'plan' && this.local?.ready) this.mode = 'local';
    }
  }
  finalize(pcm16k, preview = '') {
    if (!plan.hasSpeech(pcm16k)) return;
    const part = { text: '', preview, final: false };
    part.done = this.recognizeSegment(pcm16k, this.controller.signal)
      .then(r => { Object.assign(part, r, { final: true }); this.emit(); })
      .catch(error => this.fail(error.message));
    this.parts.push(part);
    this.emit();
  }
  // 本地滚动识别：当前这句从段起点到现在整句重识别，结果只作预览，定稿时以最终识别为准。
  async roll() {
    if (this.state !== 'recording' || this.mode !== 'local' || !this.local?.ready || this.rolling) return;
    const pcm = this.all.subarray(this.uttFrom);
    if (pcm.length - this.rolledBytes < RATE * 2 * 0.3 || !plan.hasSpeech(pcm)) return;
    this.rolling = true; const segAt = this.uttFrom; this.rolledBytes = pcm.length;
    try {
      const [text] = await this.local.transcribe([pcm], this.context, 3000 + pcm.length / 32000 * 600);
      // 预览是半句话：去掉模型习惯性补上的句末标点，免得看起来像已说完
      if (segAt === this.uttFrom && !this.ended) { this.preview = text.replace(/[。．.!！?？]+$/, ''); this.emit(); }
    } catch (error) { this.log('[voice] 本地滚动识别失败：', error.message); }
    finally { this.rolling = false; }
  }

  // 只保留「已确认本人」后的他人判断：实时 API 段按句比对，与本地段的 me/otherOnly 合并。
  kept() { const anyMe = this.parts.some(p => p.me > 0) || this.api?.me > 0; return this.parts.map(p => !(anyMe && p.otherOnly)); }
  text() {
    const keep = this.kept();
    return plan.joinTexts([this.api?.text || '', ...this.parts.map((p, i) => keep[i] ? (p.final ? p.text : p.preview) : ''), ...this.committed.map(c => c.text), this.preview]);
  }
  // route：当前出字走哪条路（local 本地 / api 实时 API 接力 / plan Token Plan 接力），界面状态栏显示
  emit() { if (!this.ended) this.onEvent({ type: 'partial', text: this.text(), route: this.mode }); }

  // 实时 API 那段的声纹：每句按时间位置取音频比对，确认有本人时去掉他人的句子。
  async screenApi() {
    const api = this.api;
    if (!api || !this.vp) return 0;
    const sentences = [...(api.stream.sentences?.values?.() || [])].filter(s => s.final && s.end > s.begin);
    const judged = sentences.filter(s => (s.end - s.begin) / 1000 >= voiceprint.MIN_JUDGE_SECONDS);
    if (!judged.length) return 0;
    try {
      const pcms = judged.map(s => this.all.subarray(api.start + Math.floor(s.begin * RATE / 1000) * 2, api.start + Math.floor(s.end * RATE / 1000) * 2));
      const vectors = await this.vp.speaker.embed(pcms);
      const threshold = this.vp.profile.threshold ?? voiceprint.DEFAULT_THRESHOLD;
      const scores = vectors.map(v => voiceprint.cosine(v, this.vp.profile.vector));
      api.me = scores.filter(s => s >= threshold).length;
      const anyMe = api.me > 0 || this.parts.some(p => p.me > 0);
      if (!anyMe) return 0;
      const drop = new Set(judged.filter((_, i) => scores[i] < threshold));
      api.text = plan.joinTexts(sentences.filter(s => !drop.has(s)).map(s => s.text)
        .concat([...(api.stream.sentences?.values?.() || [])].filter(s => s.final && !(s.end > s.begin)).map(s => s.text)));
      return drop.size;
    } catch (error) { this.log('[voiceprint] 实时识别段比对失败，不过滤：', error.message); return 0; }
  }

  async finish() {
    if (this.state !== 'recording') throw new Error('当前录音无法停止，请取消后重试');
    this.state = 'finishing'; clearInterval(this.timer); this.vadStream?.destroy();
    if (this.mode === 'api' && this.api && !this.api.failed) {
      this.api.end = this.all.length;
      if (this.api.ready) this.api.stream.finish().catch(error => this.apiFailed(error.message));
      else this.api.finishRequested = true;
    } else { const preview = plan.joinTexts([...this.committed.map(c => c.text), this.preview]); this.preview = ''; this.committed = []; this.finalize(this.all.subarray(this.segStart), preview); }
    this.preview = '';
    void (async () => {
      if (this.api) await this.api.done;
      await Promise.all(this.parts.map(p => p.done));
      if (this.ended) return;
      const apiFiltered = await this.screenApi();
      if (this.api && this.api.end != null) this.usage({ source: 'desktop', via: 'realtime', sec: (this.api.end - this.api.start) / 32000 });
      const via = {};
      if (this.api?.text) via.realtime = 1;
      for (const p of this.parts) if (p.via) via[p.via] = (via[p.via] || 0) + 1;
      const filtered = apiFiltered + this.kept().filter(k => !k).length + this.parts.reduce((n, p) => n + (p.removed || 0), 0);
      if (filtered) via.filtered = filtered;
      this.state = 'done'; this.onEvent({ type: 'done', text: this.text(), via });
    })();
    return true;
  }
  fail(message) {
    if (this.ended) return;
    this.state = 'error'; clearInterval(this.timer); this.controller.abort(); this.vadStream?.destroy();
    if (this.api && !this.api.failed) this.api.stream.cancel?.();
    this.onEvent({ type: 'error', message, text: this.text() });
  }
  cancel() {
    if (this.ended) return;
    this.state = 'cancelled'; clearInterval(this.timer); this.controller.abort(); this.vadStream?.destroy();
    if (this.api) this.api.stream.cancel?.();
  }
}

module.exports = { LiveVoice };
