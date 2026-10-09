'use strict';
// 说话检测（TEN VAD，WebAssembly，CPU 上约 7 毫秒处理 1 秒音频）：判断每 20 毫秒是不是人在说话。
// 比按音量判断稳：实测强背景噪声下，按音量把 8 句话认成 1 句（断不开、预览越刷越慢、声纹分不出插话），
// 换成它后能正常断句。模型文件放在 C:\AppData\models\vad（附加许可条件，不随 Hub 代码分发）；
// 文件不在或加载失败时 available() 为 false，调用方退回按音量判断。
// 输出与音量帧同一格式：说话帧记 1000、非说话帧记 0，现有的断句与「有没有人声」规则可直接复用。
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIR = process.env.HUB_VAD_DIR || 'C:/AppData/models/vad';
const HOP = 160;            // 10ms，两个 hop 合成一个 20ms 帧
const THRESHOLD = 0.5;
let mod = null, loading = null;

function load(dir = DIR) {
  if (mod) return Promise.resolve(true);
  if (loading) return loading;
  const js = path.join(dir, 'ten_vad.js'), wasm = path.join(dir, 'ten_vad.wasm');
  if (!fs.existsSync(js) || !fs.existsSync(wasm)) return Promise.resolve(false);
  loading = import(pathToFileURL(js).href)
    .then(m => m.default({ wasmBinary: fs.readFileSync(wasm) }))
    .then(m => { mod = m; return true; })
    .catch(error => { console.warn('[voice-vad] 加载失败，退回按音量判断：', error.message); return false; })
    .finally(() => { loading = null; });
  return loading;
}
const available = () => !!mod;

// 一条录音一个实例（检测器有前后文状态）；push 16kHz PCM，返回新凑满的 20ms 帧的「音量」（1000 / 0）。
class VadStream {
  constructor() {
    if (!mod) throw new Error('说话检测未加载');
    this.handlePtr = mod._malloc(4);
    if (mod._ten_vad_create(this.handlePtr, HOP, THRESHOLD) !== 0) throw new Error('说话检测初始化失败');
    this.handle = mod.HEAP32[this.handlePtr >> 2];
    this.inPtr = mod._malloc(HOP * 2); this.probPtr = mod._malloc(4); this.flagPtr = mod._malloc(4);
    this.carry = Buffer.alloc(0); this.half = null;
  }
  push(pcm16k) {
    const bytes = Buffer.concat([this.carry, Buffer.from(pcm16k)]);
    const levels = [];
    let at = 0;
    for (; at + HOP * 2 <= bytes.length; at += HOP * 2) {
      mod.HEAP16.set(new Int16Array(bytes.buffer.slice(bytes.byteOffset + at, bytes.byteOffset + at + HOP * 2)), this.inPtr >> 1);
      mod._ten_vad_process(this.handle, this.inPtr, HOP, this.probPtr, this.flagPtr);
      const speech = mod.HEAP32[this.flagPtr >> 2] === 1;
      if (this.half === null) this.half = speech;
      else { levels.push(this.half || speech ? 1000 : 0); this.half = null; }
    }
    this.carry = Buffer.from(bytes.subarray(at));
    return levels;
  }
  destroy() {
    if (!this.handlePtr) return;
    mod._ten_vad_destroy(this.handlePtr);
    for (const p of [this.handlePtr, this.inPtr, this.probPtr, this.flagPtr]) mod._free(p);
    this.handlePtr = 0;
  }
}

// 整段音频一次算完（手机整段录音、定稿段内切小句用）。
function vadLevels(pcm16k) {
  const s = new VadStream();
  try { return s.push(pcm16k); } finally { s.destroy(); }
}

module.exports = { load, available, VadStream, vadLevels, DIR };
