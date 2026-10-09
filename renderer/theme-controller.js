'use strict';

const {
  THEMES,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  THEME_ATTRIBUTE,
  THEME_PREFERENCE_KEY,
  readInitialTheme,
  normalizeTheme,
  nextTheme,
} = require('../core/theme-config.js');

const GITHUB_DARK = {
  background: '#0d1117', foreground: '#f0f6fc', cursor: '#58a6ff',
  cursorAccent: '#0d1117', selectionBackground: 'rgba(88, 166, 255, 0.3)',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#f0f6fc',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
  brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
  brightCyan: '#56d364', brightWhite: '#ffffff',
};

// Warm gold for the real PTY: the terminal supplies ANSI/default colors while
// Claude, Codex and other TUIs still own their truecolor rendering and input.
const DEEP_SEA_DARK = {
  ...GITHUB_DARK,
  background: '#081420', foreground: '#e8e3d8', cursor: '#e6bb7c',
  cursorAccent: '#081420', selectionBackground: 'rgba(230, 187, 124, 0.3)',
  black: '#3a4b5c', red: '#dc8585', green: '#86cda5', yellow: '#ddb575',
  blue: '#92bad5', magenta: '#c4a4ce', cyan: '#80c6c1', white: '#e8e3d8',
  brightBlack: '#8b9fb1', brightRed: '#f0a6a0', brightGreen: '#a9deb8',
  brightYellow: '#f2d29b', brightBlue: '#b0d2e9', brightMagenta: '#dcc0e1',
  brightCyan: '#a6dcd3', brightWhite: '#fff7eb',
};

const COLD_WHITE = {
  background: '#fbfcfd', foreground: '#303b4b', cursor: '#3065bd',
  cursorAccent: '#fbfcfd', selectionBackground: 'rgba(48, 101, 189, 0.20)',
  black: '#303b4b', red: '#b42335', green: '#18704a', yellow: '#856000',
  blue: '#3065bd', magenta: '#7944a1', cyan: '#16717e', white: '#526172',
  brightBlack: '#637084', brightRed: '#b42335', brightGreen: '#18704a',
  brightYellow: '#856000', brightBlue: '#3065bd', brightMagenta: '#7944a1',
  brightCyan: '#16717e', brightWhite: '#222a36',
};

/**
 * Cold white has a light ANSI palette and contrast protection for CLI-owned
 * RGB text. Other themes keep their established palettes. Buffer contents,
 * input, native colors and lifecycle events remain owned by the terminal.
 */
const XTERM_THEMES = THEMES.reduce((acc, t) => {
  acc[t.id] = t.id === 'codex' ? COLD_WHITE : t.id === 'dark' ? DEEP_SEA_DARK : GITHUB_DARK;
  return acc;
}, {});

function resolveXtermTheme(theme) {
  return XTERM_THEMES[normalizeTheme(theme)] || XTERM_THEMES[DEFAULT_THEME];
}

// 公司 Code Agent 的界面（opentui）自己铺满黑底；浅色主题下终端其余部分是白的，黑白拼在一起很突兀。
// 这类会话在浅色主题下整体用深色终端配色，像一张统一的深色控制台卡片（2026-10-08 公司验收后用户提出）。
function resolveXtermOptions(theme, kind = '') {
  const light = normalizeTheme(theme) === 'codex';
  if (light && String(kind || '').startsWith('codeagent')) return { theme: GITHUB_DARK, minimumContrastRatio: 1 };
  return { theme: resolveXtermTheme(theme), minimumContrastRatio: light ? 4.5 : 1 };
}

/**
 * 运行时换主题后强制整树重算样式。
 *
 * Chromium 不会把 :root 上 data-theme 的变化完整传播给所有引用 var() 的后代。
 * 隔离实例实测：419 个可见元素里有 15 个（侧栏搜索入口、会话筛选 tab、章节动作
 * 按钮等）停在上一个主题的颜色上，等多久都不会自己恢复。冷启动时每套皮肤都正确，
 * 只有运行时切换会踩到，所以很容易在开发期漏掉。
 *
 * 短暂 display:none 会把渲染树拆掉，挂回来时样式必然重算。中间那次 offsetHeight
 * 读取是必须的——不强制 flush，浏览器会把两次赋值合并成无事发生。
 * 代价是一帧，换主题本来就是低频操作。
 */
function forceStyleRecalc(root) {
  if (!root || !root.style) return;
  const previous = root.style.display;
  try {
    root.style.display = 'none';
    void root.offsetHeight;
  } finally {
    root.style.display = previous;
  }
}

function buildPickerMarkup() {
  // 菜单项照 THEMES 清单生成：加皮肤只改 core/theme-config.js，这里不用动。
  return THEMES.map(t => (
    '<button type="button" class="options-theme-item" role="radio" aria-checked="false"'
    + ' data-theme-id="' + t.id + '">'
    + '<span class="options-theme-swatch" aria-hidden="true">'
    + t.swatch.map(c => '<i style="background:' + c + '"></i>').join('')
    + '</span>'
    + '<span class="options-theme-copy"><strong>' + t.label + '</strong>'
    + '<small>' + t.hint + '</small></span>'
    + '<span class="options-theme-check" aria-hidden="true">✓</span>'
    + '</button>'
  )).join('');
}

function createThemeController({ document, localStorage, terminalCache, openConfigModal, onThemeApplied = () => {} }) {
  if (!document) throw new Error('document is required');
  if (!terminalCache) throw new Error('terminalCache is required');
  if (typeof openConfigModal !== 'function') throw new Error('openConfigModal is required');

  const store = localStorage || null;

  function readStoredTheme() {
    if (!store || typeof store.getItem !== 'function') return DEFAULT_THEME;
    try {
      return readInitialTheme(store);
    } catch {
      return DEFAULT_THEME;
    }
  }

  function writeStoredTheme(theme) {
    if (!store || typeof store.setItem !== 'function') return;
    try {
      store.setItem(THEME_STORAGE_KEY, theme);
      store.setItem(THEME_PREFERENCE_KEY, '1');
    } catch {
      // 存不下只影响下次启动的默认值，不该拦住这次切换。
    }
  }

  // theme-bootstrap.js 已经在首帧前打过一次 data-theme；这里以 DOM 上的实际值
  // 为准，读不到再回落 localStorage，保证控制器和页面看到的是同一套主题。
  let currentTheme = (() => {
    const root = document.documentElement;
    const fromDom = root && typeof root.getAttribute === 'function'
      ? root.getAttribute(THEME_ATTRIBUTE)
      : null;
    return fromDom ? normalizeTheme(fromDom) : readStoredTheme();
  })();

  function syncPicker() {
    const host = document.getElementById('options-theme-picker');
    if (!host || typeof host.querySelectorAll !== 'function') return;
    for (const btn of host.querySelectorAll('[data-theme-id]')) {
      const on = btn.getAttribute('data-theme-id') === currentTheme;
      btn.setAttribute('aria-checked', String(on));
      if (btn.classList && typeof btn.classList.toggle === 'function') {
        btn.classList.toggle('selected', on);
      }
    }
  }

  function renderPicker() {
    const host = document.getElementById('options-theme-picker');
    if (!host) return;
    if (!host.dataset || host.dataset.rendered !== '1') {
      host.innerHTML = buildPickerMarkup();
      if (host.dataset) host.dataset.rendered = '1';
      host.addEventListener('click', (e) => {
        const btn = e.target && typeof e.target.closest === 'function'
          ? e.target.closest('[data-theme-id]')
          : null;
        if (!btn) return;
        e.stopPropagation();
        setTheme(btn.getAttribute('data-theme-id'));
      });
    }
    syncPicker();
  }

  function applyTheme(theme = currentTheme) {
    const previousTheme = currentTheme;
    currentTheme = normalizeTheme(theme);

    const root = document.documentElement;
    if (root && typeof root.setAttribute === 'function') {
      root.setAttribute(THEME_ATTRIBUTE, currentTheme);
    }
    if (previousTheme !== currentTheme) forceStyleRecalc(root);

    for (const [, cached] of terminalCache) {
      Object.assign(cached.terminal.options, resolveXtermOptions(currentTheme, cached.kind));
    }

    onThemeApplied(currentTheme);

    syncPicker();
    return currentTheme;
  }

  function setTheme(theme) {
    const applied = applyTheme(theme);
    writeStoredTheme(applied);
    return applied;
  }

  /** 循环到下一套，用于快捷键轮换。 */
  function cycleTheme() {
    return setTheme(nextTheme(currentTheme));
  }

  function getTheme() {
    return currentTheme;
  }

  function init() {
    renderPicker();
    applyTheme();

    // 冷杉 v2 T0：主题选择器从 options 菜单搬到 rail 的主题按钮弹层。
    // 宿主节点 id 仍是 options-theme-picker，所以 renderPicker/syncPicker 一行没改；
    // 这里只多接一个开合。两个弹层共用同一套「点外面 / Esc 关掉」的规则，
    // 用一张表描述，避免第三个弹层出现时再抄一遍。
    const optionsBtn = document.getElementById('btn-options');
    const optionsMenu = document.getElementById('options-menu');
    const themeBtn = document.getElementById('btn-theme');
    const themeMenu = document.getElementById('theme-menu');

    const popovers = [
      { btn: optionsBtn, menu: optionsMenu },
      { btn: themeBtn, menu: themeMenu },
    ].filter(p => p.btn && p.menu);

    if (!popovers.length) return;

    function closeAll(except) {
      for (const p of popovers) {
        if (p === except) continue;
        p.menu.style.display = 'none';
        if (typeof p.btn.setAttribute === 'function' && p.btn.getAttribute('aria-expanded') !== null) {
          p.btn.setAttribute('aria-expanded', 'false');
        }
      }
    }

    for (const p of popovers) {
      p.btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const open = p.menu.style.display === 'none';
        closeAll(p);
        p.menu.style.display = open ? 'block' : 'none';
        if (typeof p.btn.setAttribute === 'function' && p.btn.getAttribute('aria-expanded') !== null) {
          p.btn.setAttribute('aria-expanded', String(open));
        }
      });

      p.menu.addEventListener('mousedown', (e) => {
        if (e.target === p.menu) closeAll(null);
      });
    }

    document.addEventListener('mousedown', (e) => {
      const inside = popovers.some(p => p.btn.contains(e.target) || p.menu.contains(e.target));
      if (!inside) closeAll(null);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAll(null);
    });

    const settingsItem = document.getElementById('options-settings');
    if (settingsItem) {
      settingsItem.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeAll(null);
        openConfigModal();
      });
    }
  }

  init();
  return { applyTheme, setTheme, cycleTheme, getTheme, init };
}

module.exports = {
  XTERM_THEMES,
  resolveXtermTheme,
  resolveXtermOptions,
  forceStyleRecalc,
  buildPickerMarkup,
  createThemeController,
};
