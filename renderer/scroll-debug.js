'use strict';

const fs = require('fs');
const pathMod = require('path');

function createScrollDebug(logPath, consoleObj = console) {
  let enabled = false;

  function snap(terminal, sessionId) {
    if (!terminal) return null;
    const buf = terminal.buffer.active;
    const out = {
      sid: sessionId ? sessionId.slice(0, 6) : '?',
      bufLen: buf.length,
      baseY: buf.baseY,
      vpY: buf.viewportY,
      cols: terminal.cols,
      rows: terminal.rows,
    };
    try {
      const vpEl = terminal.element && terminal.element.querySelector('.xterm-viewport');
      if (vpEl) {
        out.scrollH = vpEl.scrollHeight;
        out.scrollT = vpEl.scrollTop;
        out.clientH = vpEl.clientHeight;
        out.canScrollMore = vpEl.scrollHeight - vpEl.scrollTop - vpEl.clientHeight;
      }
      const vpInst = terminal._core && terminal._core._viewport;
      if (vpInst) {
        out.lastBufLen = vpInst._lastRecordedBufferLength;
        out.hasInnerRefresh = typeof vpInst._innerRefresh === 'function';
        out.hasQueueRefresh = typeof vpInst.queueRefresh === 'function';
        if (vpInst._lastRecordedViewportHeight !== undefined) {
          out.lastVpH = vpInst._lastRecordedViewportHeight;
        }
      }
    } catch (e) { out.err = String(e); }
    return out;
  }

  function log(tag, payload) {
    if (!enabled) return;
    try {
      const t = new Date().toISOString().slice(11, 23);
      fs.appendFileSync(logPath, `[${t}] ${tag} ${JSON.stringify(payload)}\n`);
    } catch {}
  }

  function probe(terminal, sessionId) {
    if (!terminal) return;
    try {
      const core = terminal._core || {};
      const out = {
        sid: sessionId ? sessionId.slice(0, 6) : '?',
        coreKeys: Object.keys(core).slice(0, 100),
        publicMethods: ['refresh', 'resize', 'scrollToBottom', 'scrollLines', 'scrollToLine', 'reset', 'clear']
          .filter(m => typeof terminal[m] === 'function'),
      };
      const candidates = ['_viewport', 'viewport', '_renderService', '_inputHandler', '_bufferService', '_renderer'];
      out.coreSubKeys = {};
      for (const k of candidates) {
        if (core[k]) {
          out.coreSubKeys[k] = Object.keys(core[k]).filter(x => /refresh|scroll|update|recompute|resize|inner/i.test(x)).slice(0, 30);
        }
      }
      const el = terminal.element;
      if (el) {
        out.elClasses = el.className;
        out.children = Array.from(el.children).map(c => c.className || c.tagName);
        const vp = el.querySelector('.xterm-viewport');
        if (vp) {
          out.vpChildren = Array.from(vp.children).map(c => `${c.tagName}.${c.className}(h=${c.clientHeight})`);
        }
      }
      fs.appendFileSync(logPath, `[PROBE] ${JSON.stringify(out, null, 2)}\n`);
      consoleObj.log('[scrollDebug] probe written to log');
    } catch (e) {
      fs.appendFileSync(logPath, `[PROBE-ERR] ${String(e)}\n`);
    }
  }

  return {
    on() {
      enabled = true;
      try { fs.writeFileSync(logPath, ''); } catch {}
      consoleObj.log('[scrollDebug] ON, log:', logPath);
    },
    off() {
      enabled = false;
      consoleObj.log('[scrollDebug] OFF');
    },
    log,
    snap,
    probe,
    isOn() { return enabled; },
    path: logPath,
  };
}

function installScrollDebug(targetWindow, baseDir) {
  if (!targetWindow) return null;
  const logPath = pathMod.join(baseDir, '..', 'scroll-debug.log');
  const debug = createScrollDebug(logPath);
  targetWindow.__scrollDebug = debug;
  return debug;
}

module.exports = {
  createScrollDebug,
  installScrollDebug,
};
