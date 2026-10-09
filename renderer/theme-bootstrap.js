'use strict';

/**
 * 首帧前把主题打到 <html data-theme> 上。
 *
 * 必须在 index.html <head> 里同步 <script src> 引入（CSP 是 script-src 'self'，
 * 内联脚本会被拦，所以只能走独立文件）。经典脚本会阻塞解析，body 还没开始渲染，
 * 因此不会出现"先深后浅"的闪烁。
 *
 * 这里刻意不依赖 renderer.js 的任何东西：整段包在 try/catch 里，任何一步失败都
 * 只是退回 index.html 的冷白 data-theme，不改变会话启动。
 */

(function bootstrapTheme() {
  try {
    const {
      THEME_ATTRIBUTE,
      readInitialTheme,
    } = require('../core/theme-config.js');

    let storage;
    try { storage = window.localStorage; } catch {}
    const theme = readInitialTheme(storage);
    document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
  } catch (err) {
    // 主题只是观感，任何异常都不该拦住 Hub 启动。
    try { console.warn('[theme] bootstrap skipped:', err && err.message); } catch { /* noop */ }
  }
})();
