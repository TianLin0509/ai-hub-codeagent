'use strict';
const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('../../core/data-dir');
const { VoiceStream, normalizeProfile, endpoint, MODEL } = require('../../core/voice-input');
const planVoice = require('../../core/voice-tokenplan');
const voiceEngine = require('../../core/voice-engine');
const { getLocalAsr, getSpeakerWorker } = require('../../core/local-asr/manager');
const voiceprint = require('../../core/voiceprint');
const { LiveVoice } = require('../../core/voice-live');
const voiceText = require('../../core/voice-text');
// 冷启动接力用的实时识别模型：3.1 流式（免费额度 100 万 token，已开「用完自动停止」）
const REALTIME_MODEL = 'qwen-audio-3.1-asr-flash-streaming';

const ENGINE_LABEL = { local: '本地 Qwen3-ASR-1.7B（未就绪时 Token Plan 接力）', tokenplan: planVoice.MODEL + '（Token Plan）', streaming: MODEL + '（按量）' };

function registerVoiceInputIpc(ipcMain, { safeStorage, app, createStream = options => new VoiceStream(options),
  createRecorded = options => new planVoice.RecordedVoice(options), createLive = options => new LiveVoice(options),
  getLocal = getLocalAsr, getSpeaker = getSpeakerWorker, envStartDelayMs = 20000,
  // 动态背景：给定 Hub 会话 id，返回该会话最近的对话文字（只给本地模型）；main.js 注入，测试可替换
  getRecentContext = async () => '' }) {
  const dataDir = getHubDataDir();
  const usage = voiceEngine.usageLogger(dataDir);
  const filename = path.join(dataDir, 'voice-input.json');
  const streams = new Map();
  const owners = new Set();
  function read() {
    try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { region: 'beijing', profiles: {} }; throw new Error('语音配置读取失败，请检查 voice-input.json'); }
  }
  function profileKey(value) { return String(value || '').trim().toLowerCase().replace(/\\/g, '/'); }
  function view(project) {
    const c = read();
    const { engine, planKey, localReady } = voiceEngine.resolveEngine(c, dataDir);
    const meteredKey = !!(c.encryptedKey || process.env.DASHSCOPE_API_KEY);
    const local = localReady ? getLocal(c) : null;
    return { region: c.region, workspace: c.workspace || '', engine, planReady: !!planKey, meteredKeySet: meteredKey,
      localInstalled: localReady, localState: local?.state || 'off', model: ENGINE_LABEL[engine],
      voiceprint: { ...voiceprint.status(dataDir), available: !!getSpeaker(c), appliesTo: engine === 'streaming' ? 'none' : 'all' },
      keySet: engine === 'local' ? localReady : engine === 'tokenplan' ? !!planKey : meteredKey, envKey: !c.encryptedKey && !!process.env.DASHSCOPE_API_KEY,
      profile: c.profiles?.[profileKey(project)] || { terms: '', context: '' }, global: c.global || { terms: '', personal: '' },
      prefs: prefsOf(c), learnedCount: (c.learned || []).length };
  }
  ipcMain.handle('voice:config', (_e, project) => view(project));
  ipcMain.handle('voice:save-config', (_e, patch = {}) => {
    if (streams.size) throw new Error('请先停止或取消录音，再修改配置');
    const c = read();
    c.region = patch.region; c.workspace = String(patch.workspace || '').trim(); endpoint(c);
    if (patch.engine !== undefined) {
      if (!voiceEngine.ENGINES.includes(patch.engine)) throw new Error('识别方式无效');
      c.engine = patch.engine;
    }
    if (patch.clearKey) delete c.encryptedKey;
    if (patch.apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密不可用，无法保存 API Key');
      const key = String(patch.apiKey).trim();
      if (key.length > 1024 || /[\r\n]/.test(key)) throw new Error('API Key 格式不正确');
      c.encryptedKey = safeStorage.encryptString(key).toString('base64');
    }
    const project = profileKey(patch.project);
    if (project.length > 1000 || ['__proto__', 'constructor', 'prototype'].includes(project)) throw new Error('项目标识无效');
    c.profiles = { ...c.profiles, [project]: normalizeProfile(patch.profile) };
    if (patch.global !== undefined) c.global = voiceText.normalizeGlobal(patch.global);
    if (patch.prefs !== undefined) c.prefs = normalizePrefs(patch.prefs);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(`${filename}.tmp`, JSON.stringify(c, null, 2), 'utf8');
    fs.renameSync(`${filename}.tmp`, filename);
    return view(patch.project);
  });
  function owned(event, id) {
    const item = streams.get(event.sender.id);
    if (!item || item.id !== id) throw new Error('录音已结束或不属于当前窗口');
    return item;
  }
  function cancelOwner(senderId) {
    const item = streams.get(senderId);
    if (item) { streams.delete(senderId); item.stream.cancel(); }
  }
  ipcMain.handle('voice:start', async (event, request = {}) => {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(request.id || '')) throw new Error('录音标识无效');
    const sender = event.sender;
    if (streams.has(sender.id)) throw new Error('已有录音正在进行');
    const c = read();
    const { engine, planKey, localReady } = voiceEngine.resolveEngine(c, dataDir);
    let apiKey = process.env.DASHSCOPE_API_KEY || '';
    let local = null;
    if (engine === 'local') {
      if (!localReady) throw new Error('本地识别未安装（缺少运行环境或模型），请在语音设置里改用 Token Plan');
      local = getLocal(c);
      void local.prepare().catch(error => console.warn('[voice] 本地识别准备失败：', error.message)); // 与说话同时装载模型
    } else if (engine === 'tokenplan') {
      apiKey = planKey;
      if (!apiKey) throw new Error('未找到百炼 Token Plan 套餐 Key，请在语音设置里改用按量识别');
    } else {
      if (c.encryptedKey) {
        try { apiKey = safeStorage.decryptString(Buffer.from(c.encryptedKey, 'base64')); }
        catch { throw new Error('无法解密语音 API Key，请重新配置'); }
      }
      if (!apiKey) throw new Error('请先配置百炼语音 API Key');
    }
    if (!owners.has(sender.id)) {
      owners.add(sender.id);
      sender.once('destroyed', () => { cancelOwner(sender.id); owners.delete(sender.id); });
      sender.on('render-process-gone', () => cancelOwner(sender.id));
      sender.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancelOwner(sender.id); });
    }
    const id = request.id;
    const projectProfile = c.profiles?.[profileKey(request.project)] || {};
    // 云端只拿词表（项目术语 + 通用热词，≤80 个）；本地另有个人背景与当前会话最近的对话，不出本机
    const profile = voiceText.cloudProfile(projectProfile, c.global);
    let background;
    if (engine === 'local') {
      const dynamic = await Promise.race([getRecentContext(request.sessionId).catch(() => ''), new Promise(r => setTimeout(() => r(''), 400))]);
      background = voiceText.localBackground(projectProfile, c.global, dynamic);
    }
    // 声纹过滤只作用于分段识别（本地 / Token Plan）；按量流式逐字出，无法按段剔除。
    const vpProfile = engine === 'streaming' ? null : voiceprint.active(dataDir);
    const speaker = vpProfile ? getSpeaker(c) : null;
    const vp = vpProfile && speaker ? { profile: vpProfile, speaker } : null;
    const recognizeSegment = engine === 'streaming' ? undefined
      : voiceEngine.segmentRecognizer({ engine, planKey, profile, background, local, source: 'desktop', usage, vp,
        onConfident: vectors => voiceprint.adapt(dataDir, vectors) });
    const onEvent = result => {
      if (streams.get(sender.id)?.id !== id) return;
      if (['done', 'error'].includes(result.type)) streams.delete(sender.id);
      // 所有识别方式统一去掉独立的语气词（嗯、呃、啊……）
      if (!sender.isDestroyed()) sender.send('voice:event', { ...result, ...(typeof result.text === 'string' ? { text: voiceText.cleanFillers(result.text) } : {}), id });
    };
    let stream;
    if (engine === 'local') {
      // 冷启动期间用实时 API 逐字出字：需要按量识别的百炼 Key（没有就由 Token Plan 接力）
      let meteredKey = process.env.DASHSCOPE_API_KEY || '';
      if (c.encryptedKey) { try { meteredKey = safeStorage.decryptString(Buffer.from(c.encryptedKey, 'base64')); } catch { meteredKey = ''; } }
      const openApi = apiEvent => meteredKey ? createStream({ config: c, apiKey: meteredKey, sampleRate: 16000, profile, model: REALTIME_MODEL, onEvent: apiEvent }) : null;
      stream = createLive({ sampleRate: request.sampleRate, local, recognizeSegment, context: background, openApi, vp, usage, onEvent });
    } else {
      stream = (engine === 'streaming' ? createStream : createRecorded)({ config: c, apiKey, sampleRate: request.sampleRate, profile, recognizeSegment, onEvent });
    }
    streams.set(sender.id, { id, stream });
    try { await stream.ready; return { id }; }
    catch (error) { if (streams.get(sender.id)?.id === id) streams.delete(sender.id); throw error; }
  });
  // 声纹：录入（整段朗读 PCM 一次传入）、开关与门槛、删除。只存向量，不存录音。
  ipcMain.handle('voice:voiceprint-enroll', async (_e, { pcm, sampleRate } = {}) => {
    const bytes = Buffer.from(pcm || []);
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw new Error('麦克风采样率不受支持');
    if (bytes.length < 2 || bytes.length > sampleRate * 2 * 60) throw new Error('录入录音需在 60 秒以内');
    const speaker = getSpeaker(read());
    if (!speaker) throw new Error('本机未安装声纹模型');
    return voiceprint.enroll(dataDir, planVoice.toRate16k(bytes.subarray(0, bytes.length - (bytes.length % 2)), sampleRate), { speaker, frameLevels: planVoice.frameLevels });
  });
  // 麦克风时序诊断：排查「开头几个字漏掉」卡在哪一步（只记毫秒数，不记音频）
  ipcMain.handle('voice:diag', (_e, d = {}) => {
    const n = v => (Number.isFinite(v) && v >= 0 && v < 600000 ? Math.round(v) : null);
    usage({ source: 'desktop', via: 'mic', sec: 0, engine: String(d.engine || ''), clickToCaptureMs: n(d.clickToCaptureMs), captureToSoundMs: n(d.captureToSoundMs), clickToReadyMs: n(d.clickToReadyMs) });
    return true;
  });
  // 从你的修改里学：识别结果 vs 实际发出的文字，改正过的词加入通用热词（本地与云端都会用上）。
  // learned 记下「错 → 对」与次数，供撤销和以后排查；只存词，不存原句。
  function writeConfig(c) {
    fs.writeFileSync(`${filename}.tmp`, JSON.stringify(c, null, 2), 'utf8');
    fs.renameSync(`${filename}.tmp`, filename);
  }
  const termList = s => String(s || '').split(/\r?\n/).map(t => t.trim()).filter(Boolean);
  ipcMain.handle('voice:learn', (_e, { original, edited } = {}) => {
    const pairs = voiceText.correctionPairs(original, edited);
    if (!pairs.length) return { added: [] };
    const c = read();
    const global = c.global || { terms: '', personal: '' };
    const terms = termList(global.terms);
    const added = [], now = new Date().toISOString();
    c.learned = Array.isArray(c.learned) ? c.learned : [];
    for (const { wrong, right } of pairs) {
      const item = c.learned.find(x => x.right === right);
      if (item) { item.count += 1; item.last = now; if (!item.wrongs.includes(wrong)) item.wrongs.push(wrong); }
      else c.learned.push({ right, wrongs: [wrong], count: 1, first: now, last: now });
      if (!terms.includes(right)) { if (terms.length >= voiceText.LIMITS.terms) terms.shift(); terms.push(right); added.push({ wrong, right }); }
    }
    c.learned = c.learned.slice(-200);
    c.global = voiceText.normalizeGlobal({ ...global, terms: terms.join('\n') });
    writeConfig(c);
    return { added };
  });
  ipcMain.handle('voice:unlearn', (_e, { right } = {}) => {
    const c = read();
    const global = c.global || { terms: '', personal: '' };
    c.global = { ...global, terms: termList(global.terms).filter(t => t !== right).join('\n') };
    c.learned = (c.learned || []).filter(x => x.right !== right);
    writeConfig(c);
    return true;
  });
  ipcMain.handle('voice:voiceprint-set', (_e, options = {}) => voiceprint.setOptions(dataDir, options));
  ipcMain.handle('voice:voiceprint-delete', () => voiceprint.remove(dataDir));
  ipcMain.handle('voice:audio', async (e, { id, data } = {}) => { await owned(e, id).stream.audio(data); return true; });
  ipcMain.handle('voice:stop', async (e, id) => { if (!await owned(e, id).stream.finish()) throw new Error('停止录音失败'); return true; });
  ipcMain.handle('voice:cancel', (e, id) => { if (streams.get(e.sender.id)?.id === id) cancelOwner(e.sender.id); return true; });
  app.on('before-quit', () => { for (const senderId of streams.keys()) cancelOwner(senderId); getLocal(read())?.stop(); getSpeaker(read())?.stop(); });
  // 运行环境常驻（不占显存）：启动后稍等再拉起，不拖慢 Hub 启动；第一次说话只需装模型约 5 秒。
  const warmEnv = setTimeout(() => {
    try {
      const c = read();
      if (voiceEngine.resolveEngine(c, dataDir).engine !== 'local') return;
      const local = getLocal(c);
      if (!local) return;
      local.keepWarm = () => { try { return inWindow(prefsOf(read()).keepWarm); } catch { return false; } };
      local.start();
      // 工作时段常驻：每分钟看一次，进入时段就提前装好模型（时段外照常空闲 10 分钟释放）
      const tick = setInterval(() => { if (local.keepWarm() && ['env', 'off'].includes(local.state)) void local.prepare().catch(() => {}); }, 60000);
      tick.unref?.();
    } catch (error) { console.warn('[voice] 本地识别环境未启动：', error.message); }
  }, envStartDelayMs);
  warmEnv.unref?.();
  void require('../../core/voice-vad').load(); // 说话检测（断句更稳）；缺文件时自动退回按音量判断
}

// 使用偏好：说「发送」自动发出（默认开）、停顿自动结束（秒，0=关）、工作时段常驻显卡（默认关）
function prefsOf(c = {}) {
  const p = c.prefs || {};
  return { voiceSend: p.voiceSend !== false, autoStopSec: Number(p.autoStopSec) || 0,
    keepWarm: { enabled: !!p.keepWarm?.enabled, from: p.keepWarm?.from || '09:00', to: p.keepWarm?.to || '22:00' } };
}
function normalizePrefs(p = {}) {
  const time = v => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : null);
  const autoStopSec = Number(p.autoStopSec) || 0;
  if (autoStopSec && (autoStopSec < 1 || autoStopSec > 10)) throw new Error('停顿自动结束需在 1～10 秒之间');
  const from = time(p.keepWarm?.from ?? '09:00'), to = time(p.keepWarm?.to ?? '22:00');
  if (!from || !to) throw new Error('常驻时段格式应为 HH:MM');
  return { voiceSend: p.voiceSend !== false, autoStopSec, keepWarm: { enabled: !!p.keepWarm?.enabled, from, to } };
}
// 当前时刻是否在常驻时段内（支持跨午夜，如 22:00～02:00）
function inWindow(w, now = new Date()) {
  if (!w?.enabled) return false;
  const m = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const t = now.getHours() * 60 + now.getMinutes(), a = m(w.from), b = m(w.to);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}
module.exports = { registerVoiceInputIpc, prefsOf, normalizePrefs, inWindow };
