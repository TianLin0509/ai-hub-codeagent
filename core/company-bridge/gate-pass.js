'use strict';
// 公司网络放行页自动点击（2026-10-15 用户要求：「让它自己点那个我已知晓风险的按钮」）。
// 公司代理隔一段时间要人在网页上点一次「允许访问」，任务通道在那之前只拿到放行页，家里和公司之间就断了。
// 被拦的时候通道是断的，家里没法远程让谁去点，所以由公司 Hub 自己在本机做：
//   AI特战队设置里打开「自动放行（我已知晓风险）」后，通道识别到放行页，Hub 就开一个看不见的窗口打开它，
//   找到「继续访问 / 我已知晓 / 同意」这类按钮点一下，再立即重试连接。
// 窗口用默认会话：和通道请求、手动「打开放行页」共用同一份网络状态，这里点过，后台请求就能通过。
// 有边界：连续 3 次点了仍被拦就停手，提示人工处理，30 分钟后再试；每次尝试写日志，并存一份放行页样本，
// 没点中时据样本改按钮识别。
const fs = require('node:fs');
const path = require('node:path');

const MAX_TRIES = 3;
const COOLDOWN_MS = 30 * 60000;
const SAMPLE_LIMIT = 200 * 1024;
// 按优先级排列：越靠前越像「放行」本身。同一个词命中多个按钮时取页面上靠前的那个。
const GATE_WORDS = ['继续访问', '我已知晓', '知晓风险', '已知晓', '继续', '接受', '同意', '允许', '确定', 'continue', 'proceed', 'i understand', 'accept', 'allow', 'agree', 'ok'];
// 带这些字的是「不同意 / 返回 / 取消」，不点。
const NEGATIVE = /不|取消|拒绝|返回|关闭|cancel|back|decline|deny|close|reject/i;
// 放行页地址退回的是收件箱网页本身（代理会把它跳到放行页）；没被拦时打开的就是它，标题里有这几个字。
const INBOX_TITLE = '公司文件收件箱';

// 候选按钮的文字 → 该点哪一个（下标，没有返回 -1）。纯函数：页面里注入的脚本和单测用的是同一份。
function pickGateButton(texts) {
  const norm = (texts || []).map(t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase());
  for (const word of GATE_WORDS) {
    const i = norm.findIndex(t => t && t.length <= 40 && !NEGATIVE.test(t) && (word === 'ok' ? t === 'ok' : t.includes(word)));
    if (i >= 0) return i;
  }
  return -1;
}
// 注入放行页执行：收集可点击元素，选中后点一下，返回点了什么。
function gateClickScript() {
  return `(() => {
    // 打开的其实是我们自己的收件箱网页（这时已经不拦了）：不点任何按钮。
    if (String(document.title || '').includes(${JSON.stringify(INBOX_TITLE)})) return { clicked: false, notGate: true, text: null, candidates: [] };
    const GATE_WORDS = ${JSON.stringify(GATE_WORDS)}, NEGATIVE = ${NEGATIVE.toString()};
    const pickGateButton = ${pickGateButton.toString()};
    const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const list = [...document.querySelectorAll('button, a, input[type=submit], input[type=button], [role=button]')].filter(visible);
    const texts = list.map(e => e.innerText || e.value || e.getAttribute('aria-label') || e.title || '');
    const i = pickGateButton(texts);
    if (i < 0) return { clicked: false, text: null, candidates: texts.slice(0, 20) };
    list[i].click();
    return { clicked: true, text: texts[i].trim().slice(0, 60), candidates: texts.slice(0, 20) };
  })()`;
}

const timeout = (promise, ms, what) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(what + '超时')), ms))]);
// 在看不见的窗口里打开放行页并点按钮。只在 Electron 主进程里调用（BrowserWindow 由调用方传入，测试可换）。
async function openHiddenGateWindow(BrowserWindow, url, { loadTimeoutMs = 20000, settleMs = 5000 } = {}) {
  const result = { loaded: false, clicked: false, text: null, candidates: [], html: null, finalUrl: null, error: null };
  if (!/^https?:\/\//i.test(String(url || ''))) return { ...result, error: '放行页地址无效' };
  const win = new BrowserWindow({ show: false, skipTaskbar: true, focusable: false, width: 1100, height: 780,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const js = (code, ms = 5000) => timeout(win.webContents.executeJavaScript(code, true), ms, '读取放行页');
  try {
    // 放行页常常再跳转一次，loadURL 会因中途跳转报错：报错后仍按页面最终停下的样子继续。
    try { await timeout(win.loadURL(url), loadTimeoutMs, '打开放行页'); }
    catch (error) { result.loadError = error.message; if (win.webContents.isLoading()) await timeout(new Promise(r => win.webContents.once('did-stop-loading', r)), loadTimeoutMs, '打开放行页').catch(() => {}); }
    result.loaded = true;
    result.html = String(await js('document.documentElement ? document.documentElement.outerHTML : ""') || '');
    const clicked = await js(gateClickScript());
    Object.assign(result, { clicked: !!clicked?.clicked, notGate: !!clicked?.notGate, text: clicked?.text || null, candidates: clicked?.candidates || [] });
    if (result.clicked) {
      // 点完等页面跳走并加载完；没有跳转（按钮只发了个请求）就等满 settleMs。
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(done, settleMs);
        win.webContents.once('did-navigate', () => win.webContents.once('did-stop-loading', done));
      });
    }
    result.finalUrl = win.webContents.getURL();
  } catch (error) { result.error = error.message; }
  finally { if (!win.isDestroyed()) win.destroy(); }
  return result;
}

class GatePasser {
  // open(url) → openHiddenGateWindow 的结果；logDir 放日志和放行页样本。
  constructor({ open, logDir, now, notify }) {
    this.open = open; this.logDir = logDir; this.now = now || (() => Date.now()); this.notify = notify || (() => {});
    this.tries = 0; this.cooldownUntil = 0; this.last = null;
  }
  status() { return { tries: this.tries, maxTries: MAX_TRIES, cooldownUntil: this.cooldownUntil > this.now() ? this.cooldownUntil : null, last: this.last }; }
  log(entry) {
    this.last = { at: this.now(), ...entry };
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
      fs.appendFileSync(path.join(this.logDir, 'company-gate.log'), JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry }) + '\n');
    } catch {}
  }
  // 通道仍被拦：在额度内点一次。返回 true 表示点到了按钮，调用方应立即重试连接。
  async attempt(url) {
    if (this.cooldownUntil > this.now()) return false;
    if (this.tries >= MAX_TRIES) {
      this.tries = 0; this.cooldownUntil = this.now() + COOLDOWN_MS;
      this.log({ host: hostOf(url), result: 'gave-up', note: `连续 ${MAX_TRIES} 次没放行，30 分钟后再试` });
      this.notify('自动放行没成功', `连续点了 ${MAX_TRIES} 次放行页仍被拦：请在「AI特战队专用功能」里点「打开放行页」手动放行；30 分钟后会再自动试。`);
      return false;
    }
    this.tries += 1;
    let r;
    try { r = await this.open(url); } catch (error) { r = { error: error.message }; }
    if (r && r.html) {
      try { fs.mkdirSync(this.logDir, { recursive: true }); fs.writeFileSync(path.join(this.logDir, 'company-gate-sample.html'), Buffer.from(r.html, 'utf8').subarray(0, SAMPLE_LIMIT)); } catch {}
    }
    this.log({ host: hostOf(url), try: this.tries, clicked: !!r?.clicked, button: r?.text || null,
      result: r?.error ? 'error' : r?.clicked ? 'clicked' : r?.notGate ? 'not-gate' : 'no-button', error: r?.error || null, candidates: r?.clicked ? undefined : (r?.candidates || []).slice(0, 10) });
    return !!r?.clicked;
  }
  // 通道恢复：清零计数；之前自动点过就记一笔成功。
  passed() {
    if (!this.tries) return false;
    this.log({ result: 'passed', tries: this.tries });
    this.tries = 0; this.cooldownUntil = 0;
    return true;
  }
}
function hostOf(url) { try { return new URL(url).host; } catch { return null; } }

module.exports = { GatePasser, pickGateButton, gateClickScript, openHiddenGateWindow, GATE_WORDS, MAX_TRIES, COOLDOWN_MS };
