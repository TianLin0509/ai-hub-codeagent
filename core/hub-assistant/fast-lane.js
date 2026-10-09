'use strict';
// 快速通道：手机发来的简单问题（闲聊、常识、计算、天气汇率新闻等实时信息）直接交给百炼快速模型
// （强制联网搜索、流式），约 1 秒出答案；涉及用户工作与 Hub 里的事一律交还完整助理。
// 2026-10-04 实测：不强制联网时实时数字会编造，所以必须 forced_search。
// 模型选 qwen3.8-flash：去掉关键词预筛后，12 道题（6 道该直答、6 道该交还）连测三轮全对，直答约 2 秒；
// qwen-flash 速度相近，但 6 道该交还的工作题全部自己编答案（如「已记录，下午三点开会」），不能当前台。
// 同日走 Token Plan 套餐复测 24 题 × 3 轮：qwen3.8-flash 72/72、直答中位 2.0 秒（P90 2.8）；deepseek-v4.1-flash 72/72、3.0 秒（P90 4.7）；
// deepseek-v4-flash-0731 1.8 秒但把「以后回答简短点」当闲聊没交还（偏好没记下）。答案质量三者相当，故默认 qwen3.8-flash。
const HANDOFF = '【交给助理】';
// 明显涉及 Hub 与工作的说法直接走完整助理，不多花一次模型调用。
// 只拦「要动手」的说法；问进展、问结果交给快答看状态摘要判断（2026-10-04 起快答可读 Hub 状态）。
// 备忘相关的话（记、问、改：第几条、推到、办完、不做了、备忘、待办……）都交给助理会话，它用工具读写真实清单。
// 2026-10-05 实测：快答编过「第3条推到下周一」的答复；即使摘要里给了清单，千问 Flash 问「还有几条」5 次也只对 2 次。
const WORK_RE = /派工|派给|新建|新开|记住|记下|记一下|别忘|提醒|叫我|交给|安排|合并|部署|切换|切到|关注|盯着|继续|代码|html|ppt|群聊|codex|claude|第\s*[0-9一二三四五六七八九十]+\s*条|推到|推迟|延后|改到|办完|做完|搞定了|不做了|取消|划掉|删掉|备忘|待办|清单/i;

function systemPrompt({ userPrefs = '', memory = '', now = new Date(), hubStatus = '' } = {}) {
  // 快答的记忆＝助理沉淀的两份 Markdown：USER.md（用户的偏好与习惯）、MEMORY.md（长期事实与约定），由助理会话维护。
  const clean = text => String(text || '').replace(/^#.*$/gm, '').replace(/^>.*$/gm, '').trim();
  // 一律按北京时间（电脑系统时区可能不是北京时间）。
  const day = now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const clock = now.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
  return [
    `你是用户的 AI Hub 助理的快速通道，负责当场答复简单问题。现在是北京时间${day} ${clock}，用户常在江苏南通。`,
    '你能直接回答：闲聊、常识、计算、翻译，以及天气、汇率、新闻、时间这类实时信息（已开启联网搜索，数字和事实以搜索结果为准，并说明是何时何地的数据）。',
    ...(hubStatus ? ['用户问进展、哪些会话在跑、某个任务完成没、最近有什么结果、有什么提醒时，先看下面的 AI Hub 状态摘要：能据此回答就直接答，说明是几点的情况；摘要里没有，或要看原文细节、分析判断时，交给完整助理。', '【AI Hub 状态摘要】', String(hubStatus).slice(0, 1800), '【摘要结束】'] : []),
    `凡是要动手办的事——派工、新建或继续任务、改文件、写代码或报告、设提醒、要记住的偏好（包括用户说「以后……」这类要长期照做的要求）——以及之前让助理办的事、要回忆以往对话的问题、摘要回答不了的工作问题，只输出「${HANDOFF}」，不加别的，由完整助理处理。`,
    '判断只看用户最新这一句本身要做什么；前面的对话只用来理解「那个」「刚才」这类指代。最新这句是闲聊、常识、计算、翻译或实时信息时，直接回答。',
    '回答用中文口语，一到三句，先给结论，开头称呼「用户」。需要强调时用标准 Markdown 加粗：**短语**，标点放在星号外面；不用标题和表格。遵守用户的偏好：',
    clean(userPrefs).slice(0, 1500) || '（暂无）',
    ...(clean(memory) ? ['用户的长期记忆（事实与约定，回答时用得上就用，不必复述）：', clean(memory).slice(0, 1500)] : []),
  ].join('\n');
}

class FastLane {
  constructor({ credentials, fetchImpl = fetch, model = require('./front-desk').defaultModel(), timeoutMs = 6000 } = {}) {
    this.credentials = credentials; this.fetch = fetchImpl; this.model = model; this.timeoutMs = timeoutMs;
  }
  eligible(text) { const t = String(text || '').trim(); return !!t && t.length <= 300 && !WORK_RE.test(t); }
  // 返回 {handoff:true}（交还完整助理）或 {text, model, via, ms, firstMs}；出错由调用方回退到完整助理。
  // credentials() 返回一个或按优先级排列的多个调用凭据 {key, base, via}，前一个请求失败（如套餐额度用完）就换下一个。
  async answer(question, { history = [], userPrefs = '', memory = '', now = new Date(), model = this.model, hubStatus = '' } = {}) {
    const sources = [].concat(this.credentials()).filter(Boolean);
    if (!sources.length) throw new Error('快速通道没有可用的百炼 Key');
    const messages = [{ role: 'system', content: systemPrompt({ userPrefs, memory, now, hubStatus }) }];
    for (const row of history.slice(-6)) if (row?.text) messages.push({ role: row.role === 'user' ? 'user' : 'assistant', content: String(row.text).slice(0, 400) });
    messages.push({ role: 'user', content: String(question) });
    const started = Date.now(), controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let text = '', firstMs = null;
    try {
      // 温度调低：「当场答还是交给助理」这个判断要稳定，不随机摇摆。
      const body = JSON.stringify({ model, stream: true, temperature: 0.3, enable_thinking: false, enable_search: true, search_options: { forced_search: true, search_strategy: 'turbo' }, messages });
      let response = null, via = null, failure = null;
      for (const source of sources) {
        try {
          const r = await this.fetch(source.base + '/compatible-mode/v1/chat/completions', {
            method: 'POST', headers: { Authorization: 'Bearer ' + source.key, 'Content-Type': 'application/json' }, signal: controller.signal, body });
          if (r.ok) { response = r; via = source.via || null; break; }
          failure = new Error('快速通道请求失败（' + (source.via || '百炼') + ' ' + r.status + '）');
        } catch (e) { if (controller.signal.aborted) throw e; failure = e; }
      }
      if (!response) throw failure;
      this.lastVia = via;
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim(); if (data === '[DONE]') continue;
          let delta = ''; try { delta = JSON.parse(data).choices?.[0]?.delta?.content || ''; } catch {}
          if (!delta) continue;
          if (firstMs === null) firstMs = Date.now() - started;
          text += delta;
          // 一看到交还标记就停，不白等后面的输出。
          if (text.includes(HANDOFF)) { controller.abort(); return { handoff: true, ms: Date.now() - started }; }
        }
      }
    } finally { clearTimeout(timer); }
    const clean = text.trim();
    if (!clean || clean.includes(HANDOFF)) return { handoff: true, ms: Date.now() - started };
    return { text: clean, model, via: this.lastVia, ms: Date.now() - started, firstMs };
  }
}

const PLAN_BASE = 'https://token-plan.cn-beijing.maas.aliyuncs.com';
// 调用凭据按优先级：先用 Hub 已配置的阿里云 Token Plan 套餐（包月额度，不另花钱），
// 再用语音设置里的百炼按量 Key 兜底。读不到的来源直接跳过。
function fastLaneSources({ dataDir, safeStorage, fs = require('node:fs'), path = require('node:path') }) {
  const sources = [];
  try {
    const acp = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8').replace(/^\uFEFF/, '')).acp || {};
    const base = String(acp.baseURL || PLAN_BASE + '/compatible-mode/v1').replace(/\/compatible-mode\/v1\/?$/, '');
    if (acp.apiKey && base === PLAN_BASE) sources.push({ key: acp.apiKey, base, via: 'token-plan' });
  } catch {}
  try { const { key, base } = require('../hub-phone/voice').dashscopeCredentials({ dataDir, safeStorage }); sources.push({ key, base, via: 'dashscope' }); } catch {}
  return sources;
}
module.exports = { FastLane, HANDOFF, systemPrompt, WORK_RE, fastLaneSources };
