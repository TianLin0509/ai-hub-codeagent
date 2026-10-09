'use strict';

const { randomUUID } = require('crypto');
const WebSocket = require('ws');

const MODEL = 'qwen-audio-3.0-asr-flash-streaming';
const MAX_SECONDS = 300;
function normalizeProfile(value = {}) {
  const terms = [...new Set(String(value.terms || '').split(/[,，;；\n]/).map(s => s.trim()).filter(Boolean))];
  if (terms.length > 80 || terms.some(t => t.length > 60)) throw new Error('最多填写 80 个术语，每个不超过 60 字');
  const context = String(value.context || '').trim();
  if ([...context].length > 400) throw new Error('领域说明最多 400 字');
  return { terms: terms.join('\n'), context };
}
function endpoint(config) {
  if (!['beijing', 'singapore'].includes(config.region)) throw new Error('请选择有效的服务地域');
  const workspace = String(config.workspace || '').trim();
  if (workspace && !/^[a-zA-Z0-9-]{1,100}$/.test(workspace)) throw new Error('Workspace ID 格式不正确');
  const host = workspace
    ? `${workspace}.${config.region === 'beijing' ? 'cn-beijing' : 'ap-southeast-1'}.maas.aliyuncs.com`
    : config.region === 'beijing' ? 'dashscope.aliyuncs.com' : 'dashscope-intl.aliyuncs.com';
  return `wss://${host}/api-ws/v1/inference`;
}
function runTask(id, sampleRate, profile, model = MODEL) {
  const { terms, context } = normalizeProfile(profile);
  return {
    header: { action: 'run-task', task_id: id, streaming: 'duplex' },
    payload: { task_group: 'audio', task: 'asr', function: 'recognition', model,
      parameters: { format: 'pcm', sample_rate: sampleRate, language_hints: ['zh', 'en'],
        vocabulary: Object.fromEntries(terms.split('\n').filter(Boolean).map(t => [t, 3])),
        max_sentence_silence: 1300 },
      input: context ? { context: [{ role: 'user', content: [{ type: 'input_text', text: context }] }] } : {} },
  };
}

// One bounded connection per recording. No retries or provider fallback: an error
// is visible, and the partial text remains available for explicit recovery.
class VoiceStream {
  // model：默认 3.0 流式；实时接力用 3.1 流式（免费额度更多、价格更低）。
  constructor({ config, apiKey, sampleRate, profile, onEvent, socketFactory, timeoutMs = 15000, model = MODEL }) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('麦克风采样率不受支持');
    if (!apiKey || /[\r\n]/.test(apiKey)) throw new Error('请先配置百炼语音 API Key');
    this.id = randomUUID();
    this.rate = sampleRate;
    this.bytes = 0;
    this.sentences = new Map();
    this.onEvent = onEvent;
    this.state = 'connecting';
    this.timeoutMs = timeoutMs;
    const request = runTask(this.id, sampleRate, profile, model);
    const url = endpoint(config);
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.socket = (socketFactory || ((url, opts) => new WebSocket(url, opts)))(url, {
      headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: timeoutMs, maxPayload: 1024 * 1024,
    });
    this.arm('语音服务连接超时，请检查网络和配置');
    this.socket.on('open', () => { if (this.state === 'connecting') this.send(JSON.stringify(request)); });
    this.socket.on('message', raw => this.receive(raw));
    this.socket.on('error', () => this.fail('语音连接失败，请检查网络、地域和 API Key'));
    this.socket.on('close', () => { if (!this.ended) this.fail('语音连接中断，已识别的文字可手动保留'); });
  }
  get ended() { return ['done', 'error', 'cancelled'].includes(this.state); }
  text(finalOnly = false) {
    return [...this.sentences.entries()].sort((a, b) => a[0] - b[0])
      .filter(([, s]) => !finalOnly || s.final).map(([, s]) => s.text).join('');
  }
  arm(message) { clearTimeout(this.timer); this.timer = setTimeout(() => this.fail(message), this.timeoutMs); }
  send(data) {
    return new Promise(resolve => {
      try {
        this.socket.send(data, error => { if (error) this.fail('语音数据发送失败'); resolve(!error); });
      } catch { this.fail('语音数据发送失败'); resolve(false); }
    });
  }
  async audio(data) {
    if (this.state !== 'recording') throw new Error('语音服务尚未就绪或已经结束');
    const bytes = Buffer.from(data);
    if (!bytes.length || bytes.length % 2 || bytes.length > 32768) { this.fail('录音数据格式异常'); throw new Error('录音数据格式异常'); }
    this.bytes += bytes.length;
    if (this.bytes > this.rate * 2 * MAX_SECONDS || this.socket.bufferedAmount > this.rate * 4) {
      this.fail('录音过长或网络发送积压，请分段重试'); throw new Error('录音过长或网络发送积压');
    }
    this.arm('麦克风数据中断，请重新录音');
    if (!await this.send(bytes)) throw new Error('语音数据发送失败');
  }
  finish() {
    if (this.state !== 'recording') throw new Error('当前录音无法停止，请取消后重试');
    this.state = 'finishing';
    this.arm('最终转写等待超时，已识别的文字可手动保留');
    return this.send(JSON.stringify({ header: { action: 'finish-task', task_id: this.id, streaming: 'duplex' }, payload: { input: {} } }));
  }
  receive(raw) {
    if (this.ended) return;
    let event;
    try { event = JSON.parse(raw.toString()); } catch { this.fail('语音服务返回了无效数据'); return; }
    if (event.header?.task_id !== this.id) return;
    switch (event.header.event) {
      case 'task-started':
        if (this.state !== 'connecting') return;
        this.state = 'recording'; this.arm('麦克风数据中断，请重新录音'); this.resolveReady(); break;
      case 'result-generated': {
        const s = event.payload?.output?.sentence;
        if (!s || s.heartbeat) return;
        if (!Number.isInteger(s.sentence_id) || s.sentence_id < 0 || typeof s.text !== 'string') { this.fail('语音结果缺少句子编号或文字'); return; }
        if (this.sentences.get(s.sentence_id)?.final && !s.sentence_end) return;
        // begin/end（毫秒）供声纹按句比对
        this.sentences.set(s.sentence_id, { text: s.text, final: s.sentence_end === true, begin: s.begin_time, end: s.end_time });
        this.onEvent({ type: 'partial', text: this.text() }); break;
      }
      case 'task-finished':
        if (this.state !== 'finishing') { this.fail('语音服务提前结束，请检查已识别文字'); return; }
        if ([...this.sentences.values()].some(s => !s.final && s.text)) { this.fail('部分文字尚未确认，请检查后手动保留'); return; }
        this.state = 'done'; this.cleanup(); this.onEvent({ type: 'done', text: this.text(true) }); break;
      case 'task-failed':
        // Do not echo arbitrary provider messages (may contain credentials/input).
        this.fail('语音服务拒绝了请求，请检查 API Key、模型权限和地域'); break;
    }
  }
  cleanup() { clearTimeout(this.timer); this.socket.terminate(); }
  fail(message) {
    if (this.ended) return;
    this.state = 'error'; this.cleanup(); this.rejectReady(new Error(message));
    this.onEvent({ type: 'error', message, text: this.text() });
  }
  cancel() {
    if (this.ended) return;
    this.state = 'cancelled'; this.cleanup(); this.rejectReady(new Error('已取消录音'));
  }
}
module.exports = { VoiceStream, normalizeProfile, endpoint, runTask, MODEL, MAX_SECONDS };
