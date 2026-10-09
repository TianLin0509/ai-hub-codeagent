'use strict';
// A loopback CDP endpoint that shows a tool only the pages it owns.
//
// Playwright's connectOverCDP attaches to every target of the browser: the person's own
// windows, other tools' tabs and the cross-origin frames inside them, Cloudflare's challenge
// frame included. In the 2026-09-29 incident the check loop also persisted after detachment;
// attachment alone was not established as its cause. Whole-browser focus emulation did
// trigger refetches in unrelated ChatGPT tabs. Through this
// relay the tool attaches to its own pages and nothing else (the extension relay of
// Playwright MCP serves a single tab the same way):
// - the browser-level auto-attach is answered with the owned pages only;
// - a page's own auto-attach (its frames and workers) is answered without attaching;
// - browser commands are limited to the ones a page tool needs; others are refused;
// - synthetic focus is not emulated (ChatGPT refetches on focus), except on a session the tool
//   opens itself with page.context().newCDPSession(page): the image tool focuses its own page
//   that way while it uses a menu, which closes on blur. Such a session reaches owned pages only.
// Page traffic, cookies and download bytes pass unchanged and are never logged.
const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const RELAY_ID = 1e9;   // ids of the relay's own upstream calls; Playwright counts up from 1
// Browser-level commands a page tool needs. Anything else could reach pages it does not own.
const ROOT_ALLOWED = new Set(['Browser.getVersion', 'Browser.setDownloadBehavior', 'Browser.cancelDownload', 'Browser.grantPermissions', 'Storage.getCookies']);
const ROOT_FOR_OWNED = new Set(['Target.getTargetInfo', 'Target.activateTarget', 'Target.closeTarget']);

function localEndpoint(ep) {
  const url = new URL(ep.ws);
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || Number(url.port) !== ep.port) throw Error('Invalid local browser endpoint');
  return ep.ws;
}

// ep: { port, ws } of the local browser; targetIds: the pages the tool owns.
async function scopedConnection(ep, targetIds, { onRefused, commandTimeoutMs = 15000 } = {}) {
  const endpoint = localEndpoint(ep);
  const owned = new Set(targetIds);
  if (!owned.size) throw Error('No browser session: no owned page');
  const ticket = '/' + crypto.randomUUID();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocket.Server({ noServer: true });
  const sockets = new Set();
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== ticket) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, client => bridge(client));
  });

  function bridge(client) {
    const upstream = new WebSocket(endpoint, { handshakeTimeout: 5000, perMessageDeflate: false });
    sockets.add(client); sockets.add(upstream);
    const pending = new Map(), sessions = new Map();   // sessionId -> targetInfo
    const browserSessions = new Set(), explicit = new Set();   // newCDPSession: browser stand-in, page sessions
    let nextId = RELAY_ID, ready = false, queued = [];
    const stop = () => {
      queued = [];
      for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(Error('Hub browser connection closed')); }
      pending.clear();
      for (const ws of [client, upstream]) { sockets.delete(ws); if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); }
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      if (upstream.readyState !== WebSocket.OPEN) return reject(Error('Hub browser connection closed'));
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      upstream.send(JSON.stringify({ id, method, params }));
    });
    const send = message => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)); };
    const answer = (msg, result) => send({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), result });
    const refuse = (msg, why) => {
      try { onRefused?.(msg.method); } catch {}
      send({ id: msg.id, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}), error: { code: -32000, message: why } });
    };

    function fromClient(msg) {
      const { method, params = {}, sessionId } = msg;
      if (!sessionId) {
        if (method === 'Target.setAutoAttach') {
          answer(msg, {});
          for (const [id, info] of sessions) send({ method: 'Target.attachedToTarget', params: { sessionId: id, targetInfo: { ...info, attached: true }, waitingForDebugger: false } });
          return;
        }
        if (method === 'Target.setDiscoverTargets') { answer(msg, {}); return; }
        // Playwright's newCDPSession goes through a browser session; a stand-in that can attach
        // to owned pages and nothing else.
        if (method === 'Target.attachToBrowserTarget') {
          const id = 'scoped-browser-' + crypto.randomUUID();
          browserSessions.add(id); answer(msg, { sessionId: id }); return;
        }
        const ownedTarget = ROOT_FOR_OWNED.has(method) && (method === 'Target.getTargetInfo' && !params.targetId || owned.has(params.targetId));
        if (!ROOT_ALLOWED.has(method) && !ownedTarget) { refuse(msg, 'Not available through the scoped Hub connection: ' + method); return; }
      } else if (browserSessions.has(sessionId)) {
        if (method === 'Target.attachToTarget' && owned.has(params.targetId)) {
          let attached;
          call('Target.attachToTarget', { targetId: params.targetId, flatten: true }).then(async ({ sessionId: id }) => {
            attached = id;
            sessions.set(id, (await call('Target.getTargetInfo', { targetId: params.targetId })).targetInfo); explicit.add(id);
            answer(msg, { sessionId: id });
          }).catch(async e => {
            if (attached) await call('Target.detachFromTarget', { sessionId: attached }).catch(() => {});
            refuse(msg, e.message);
          });
          return;
        }
        if (method === 'Target.detachFromTarget' && explicit.has(params.sessionId)) {
          call('Target.detachFromTarget', { sessionId: params.sessionId }).then(() => {
            sessions.delete(params.sessionId); explicit.delete(params.sessionId); answer(msg, {});
          }, e => refuse(msg, e.message));
          return;
        }
        refuse(msg, 'Not available through the scoped Hub connection: ' + method); return;
      } else {
        if (!sessions.has(sessionId)) { refuse(msg, 'Unknown session'); return; }
        // The page's frames and workers stay unattached: the challenge frame lives there.
        if (method === 'Target.setAutoAttach') { answer(msg, {}); return; }
        if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled === true && !explicit.has(sessionId)) { answer(msg, {}); return; }
        if (method.startsWith('Target.') && method !== 'Target.getTargetInfo') { refuse(msg, 'Not available through the scoped Hub connection: ' + method); return; }
      }
      upstream.send(JSON.stringify(msg));
    }

    function fromUpstream(msg) {
      if (msg.id >= RELAY_ID) {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        if (!waiter) return;
        clearTimeout(waiter.timer);
        if (msg.error) waiter.reject(Error(msg.error.message)); else waiter.resolve(msg.result);
        return;
      }
      if (msg.id !== undefined) { send(msg); return; }
      if (msg.sessionId) { if (sessions.has(msg.sessionId)) send(msg); return; }
      // Browser-level events: downloads, and the end of an owned page.
      if (msg.method?.startsWith('Browser.')) { send(msg); return; }
      if (msg.method === 'Target.detachedFromTarget' && sessions.has(msg.params?.sessionId)) { sessions.delete(msg.params.sessionId); send(msg); return; }
      if (msg.method === 'Target.targetCrashed' && owned.has(msg.params?.targetId)) send(msg);
    }

    client.on('error', stop); upstream.on('error', stop);
    client.on('close', stop); upstream.on('close', stop);
    client.on('message', bytes => {
      let msg;
      try { msg = JSON.parse(bytes); } catch { stop(); return; }
      if (!ready) { if (queued.length < 1000) queued.push(msg); else stop(); return; }
      fromClient(msg);
    });
    upstream.on('message', bytes => {
      let msg;
      try { msg = JSON.parse(bytes); } catch { return; }
      fromUpstream(msg);
    });
    upstream.on('open', async () => {
      try {
        for (const targetId of owned) {
          const { targetInfo } = await call('Target.getTargetInfo', { targetId });
          if (targetInfo.type !== 'page') throw Error('Owned target is not a page');
          const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
          sessions.set(sessionId, targetInfo);
        }
        ready = true;
        const backlog = queued; queued = [];
        for (const msg of backlog) fromClient(msg);
      } catch { stop(); }
    });
  }

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    endpoint: `ws://127.0.0.1:${server.address().port}${ticket}`,
    async close() { for (const ws of sockets) ws.terminate(); sockets.clear(); wss.close(); await new Promise(resolve => server.close(resolve)); },
  };
}

// Playwright connected to one owned page. `close` disconnects; Chrome and the page stay.
async function connectPage(chromium, ep, targetId, { downloads = false, onRefused } = {}) {
  const scoped = await scopedConnection(ep, [targetId], { onRefused });
  let browser;
  try {
    // noDefaults keeps Playwright from emulating viewport and focus; download scripts need its
    // download handling, and the relay still drops synthetic focus for them.
    browser = await chromium.connectOverCDP(scoped.endpoint, { noDefaults: !downloads });
    const pages = browser.contexts().flatMap(context => context.pages());
    if (pages.length !== 1) throw Error('No browser session: owned Hub page is not visible to the runtime');
    return { browser, page: pages[0], async close() { try { await browser.close(); } finally { await scoped.close(); } } };
  } catch (e) {
    try { await browser?.close(); } finally { await scoped.close(); }
    throw e;
  }
}

module.exports = { scopedConnection, connectPage, ROOT_ALLOWED };
