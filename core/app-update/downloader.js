'use strict';
// 多源下载（2026-10-13，公司版一键更新）：按顺序一个源一个源地试，每个源下完都核对大小和 sha256，
// 不对就写明原因、换下一个源。公司实测：阿里云上的大文件会被公司代理换成 3.5 KB 的拦截网页，
// GitHub 能直下约 2 MB/s；所以拦截页要能认出来并说人话。网络走调用方给的 fetch（Electron 的
// net.fetch 跟系统代理）。
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const IDLE_TIMEOUT_MS = 20000;
const CONNECT_TIMEOUT_MS = 15000;
const MANIFEST_TIMEOUT_MS = 10000;

function fmtBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function fileUrl(source, version, file) {
  return String(source.files || '').replace('{version}', version) + encodeURIComponent(file);
}

function looksLikeWebPage(contentType, head) {
  if (/text\/html|text\/plain|application\/xhtml/i.test(String(contentType || ''))) return true;
  const s = head ? head.toString('utf8', 0, Math.min(head.length, 256)).trimStart().toLowerCase() : '';
  return s.startsWith('<!doctype') || s.startsWith('<html') || s.startsWith('<?xml') || s.startsWith('<head');
}

function reasonOf(error) {
  if (!error) return '未知错误';
  if (error.reason) return error.reason;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return '连接超时';
  const msg = String(error.message || error);
  if (/ENOTFOUND|ERR_NAME_NOT_RESOLVED/i.test(msg)) return '找不到服务器（域名解析失败），可能需要代理或网络不通';
  if (/ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(msg)) return '服务器拒绝连接';
  if (/ECONNRESET|ERR_CONNECTION_RESET|socket hang up/i.test(msg)) return '连接被中断（可能被代理或防火墙重置）';
  if (/certificate|CERT_|SSL/i.test(msg)) return '证书校验失败（可能被公司代理拦截了加密连接）';
  if (/ERR_PROXY|proxy/i.test(msg)) return '代理连接失败';
  if (/ERR_INTERNET_DISCONNECTED|ENETUNREACH/i.test(msg)) return '网络不通';
  return msg.slice(0, 160);
}

const fail = reason => Object.assign(new Error(reason), { reason });
// 收到的是代理的拦截网页：公司代理第一次访问某个网址时先出确认页，用户在浏览器里点「允许」后就放行
// （2026-10-14 用户）。标上 blocked，界面据此给出网址让用户自己去放行。
const blockedFail = reason => Object.assign(new Error(reason), { reason, blocked: true });

// 带「连接超时」：拿到响应头之前最多等 CONNECT_TIMEOUT_MS。
async function openResponse(fetchImpl, url, signal, timeoutMs) {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const timer = setTimeout(() => ac.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
  try {
    return { response: await fetchImpl(url, { signal: ac.signal, cache: 'no-store', redirect: 'follow' }), controller: ac };
  } catch (error) {
    if (signal && signal.aborted) throw fail('已取消');
    throw fail(error && (error.name === 'AbortError' || error.name === 'TimeoutError') ? `${Math.round(timeoutMs / 1000)} 秒内没有连上服务器` : reasonOf(error));
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// 查版本：各源并行取清单，返回每个源的结果和版本最高的那份。
async function checkManifests({ sources, fetchImpl, validate, timeoutMs = MANIFEST_TIMEOUT_MS, signal }) {
  const results = await Promise.all(sources.map(async source => {
    const startedAt = Date.now(), controller = new AbortController();
    let response, timer, timedOut = false, rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const onAbort = () => { controller.abort(); rejectStop(fail('已取消')); };
    const assertActive = () => {
      if (signal?.aborted) throw fail('已取消');
      if (timedOut || Date.now() - startedAt >= timeoutMs) throw fail(`版本清单读取超时（${timeoutMs / 1000} 秒内未完成）`);
    };
    if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    timer = setTimeout(() => {
      timedOut = true; controller.abort();
      rejectStop(fail(`版本清单读取超时（${timeoutMs / 1000} 秒内未完成）`));
    }, timeoutMs);
    try {
      // 清单期限覆盖响应头、正文和校验；不能在刚收到响应头时就撤掉计时器。
      const manifest = await Promise.race([stopped, (async () => {
        assertActive();
        response = await fetchImpl(source.manifest, { signal: controller.signal, cache: 'no-store', redirect: 'follow' });
        if (!response.ok) throw fail(response.status === 404 ? '源上还没有版本清单（HTTP 404）' : `服务器返回 HTTP ${response.status}`);
        const text = await response.text();
        assertActive();
        if (looksLikeWebPage(response.headers && response.headers.get && response.headers.get('content-type'), Buffer.from(text.slice(0, 256)))) throw blockedFail(`收到的是网页（${fmtBytes(Buffer.byteLength(text))}）而不是版本清单，可能被公司代理拦截`);
        let checked;
        try { checked = await validate(JSON.parse(text)); } catch (error) { throw fail(`版本清单无效：${error.message}`); }
        assertActive();
        return checked;
      })()]);
      return { id: source.id, name: source.name, ok: true, manifest, ms: Date.now() - startedAt };
    } catch (error) {
      return { id: source.id, name: source.name, ok: false, reason: signal?.aborted ? '已取消' : timedOut ? `版本清单读取超时（${timeoutMs / 1000} 秒内未完成）` : reasonOf(error), blocked: !!error.blocked, url: source.manifest, ms: Date.now() - startedAt };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      controller.abort();
      // 非成功 HTTP 或校验失败也要关流；取消本身不能再把源的期限拖住。
      try { void response?.body?.cancel().catch(() => {}); } catch (_) {}
    }
  }));
  return results;
}

// 从一个源下一个文件到 dest（先写 .part，核对通过才改名）。
async function downloadOne({ source, url, expect, dest, fetchImpl, signal, onProgress, idleTimeoutMs, connectTimeoutMs }) {
  const part = dest + '.part';
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const { response, controller } = await openResponse(fetchImpl, url, signal, connectTimeoutMs);
  if (!response.ok) {
    try { await response.body?.cancel(); } catch (_) {}
    throw fail(response.status === 404 ? '源上没有这个文件（HTTP 404）' : `服务器返回 HTTP ${response.status}`);
  }
  const contentType = response.headers && response.headers.get ? response.headers.get('content-type') : '';
  const declared = Number(response.headers && response.headers.get ? response.headers.get('content-length') : NaN);
  const hash = createHash('sha256');
  const out = fs.openSync(part, 'w');
  let received = 0, head = null, idleTimer = null, idleHit = false, reader = null, renamed = false;
  // openResponse 只把取消信号接到「拿到响应头」为止；下载正文期间也要能取消（2026-10-22 修：
  // 会议室运行时 77MB，用户点取消后原来还会把整个文件收完）。
  const onAbort = () => controller.abort();
  if (signal) { if (signal.aborted) controller.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const startedAt = Date.now();
  let lastTick = startedAt, lastBytes = 0, speed = 0;
  const armIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { idleHit = true; controller.abort(); }, idleTimeoutMs); };
  try {
    if (Number.isFinite(declared) && declared > 0 && declared !== expect.bytes && (declared < 64 * 1024 || looksLikeWebPage(contentType, null))) {
      // 不读完也知道不对：大小差得多且像网页，多半是代理返回的拦截页。顺手读一点内容判断。
      const text = Buffer.from(await response.arrayBuffer());
      if (looksLikeWebPage(contentType, text)) throw blockedFail(`收到 ${fmtBytes(text.length)} 的网页而不是更新包，可能被公司代理拦截`);
      throw fail(`文件大小不对：应为 ${fmtBytes(expect.bytes)}，服务器给的是 ${fmtBytes(declared)}`);
    }
    if (!response.body || typeof response.body.getReader !== 'function') throw fail('服务器没有返回文件内容');
    reader = response.body.getReader();
    armIdle();
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); }
      catch (error) {
        if (signal && signal.aborted) throw fail('已取消');
        if (idleHit) throw fail(`连续 ${Math.round(idleTimeoutMs / 1000)} 秒没有收到数据`);
        throw fail(`下载中断：${reasonOf(error)}`);
      }
      if (chunk.done) break;
      const buf = Buffer.from(chunk.value);
      if (!head) head = buf.subarray(0, 256);
      received += buf.length;
      if (received > expect.bytes) throw fail(`收到的内容比应有的 ${fmtBytes(expect.bytes)} 还大，已停止`);
      hash.update(buf);
      fs.writeSync(out, buf);
      armIdle();
      const now = Date.now();
      if (now - lastTick >= 250 || received === expect.bytes) {
        const inst = (received - lastBytes) / Math.max(0.001, (now - lastTick) / 1000);
        speed = speed ? speed * 0.7 + inst * 0.3 : inst;
        lastTick = now; lastBytes = received;
        onProgress && onProgress({ sourceId: source.id, sourceName: source.name, received, total: expect.bytes, speed,
          etaSec: speed > 0 ? Math.max(0, Math.round((expect.bytes - received) / speed)) : null });
      }
    }
    // 取消信号落在「读完最后一块」之后也不能转正：用户点了取消就当这次没下过。
    if (signal && signal.aborted) throw fail('已取消');
    if (received !== expect.bytes) {
      if (received < 64 * 1024 && looksLikeWebPage(contentType, head)) throw blockedFail(`收到 ${fmtBytes(received)} 的网页而不是更新包，可能被公司代理拦截`);
      throw fail(`文件不完整：应为 ${fmtBytes(expect.bytes)}，只收到 ${fmtBytes(received)}`);
    }
    if (hash.digest('hex') !== expect.sha256) throw fail('文件校验不一致（内容在传输中被改动或源上的文件不对）');
    fs.renameSync(part, dest);
    renamed = true;
    return { bytes: received, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
    // 没读完的响应体要显式取消，否则连接会挂到回收（换源重试时叠加）。
    try { await reader?.cancel(); } catch (_) {}
    fs.closeSync(out);
    // 取消、20 秒没数据、写盘失败、校验不过都走这里：一律不留 .part。
    // 77MB 的半个文件既占盘，也会让下次重试从脏状态开始。
    if (!renamed) { try { fs.rmSync(part, { force: true }); } catch (_) {} }
  }
}

// 按顺序逐个源下载，任何一个成功就停。attempts 记下每个源的结果（成功/失败 + 原因），给界面显示。
async function downloadWithFallback({ sources, version, expect, dest, fetchImpl, signal, onProgress, onAttempt,
  idleTimeoutMs = IDLE_TIMEOUT_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS }) {
  const attempts = [];
  for (const source of sources) {
    if (signal && signal.aborted) break;
    const url = fileUrl(source, version, expect.file);
    const attempt = { id: source.id, name: source.name, url, status: 'downloading', startedAt: Date.now() };
    attempts.push(attempt);
    onAttempt && onAttempt(attempts.map(a => ({ ...a })));
    try {
      const r = await downloadOne({ source, url, expect, dest, fetchImpl, signal, onProgress, idleTimeoutMs, connectTimeoutMs });
      Object.assign(attempt, { status: 'ok', bytes: r.bytes, ms: r.ms });
      onAttempt && onAttempt(attempts.map(a => ({ ...a })));
      return { ok: true, source: { id: source.id, name: source.name }, attempts };
    } catch (error) {
      Object.assign(attempt, { status: signal && signal.aborted ? 'cancelled' : 'failed', reason: reasonOf(error), blocked: !!error.blocked, ms: Date.now() - attempt.startedAt });
      onAttempt && onAttempt(attempts.map(a => ({ ...a })));
      if (signal && signal.aborted) break;
    }
  }
  return { ok: false, cancelled: !!(signal && signal.aborted), attempts };
}

module.exports = { checkManifests, downloadWithFallback, fileUrl, looksLikeWebPage, reasonOf, fmtBytes };
