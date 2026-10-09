'use strict';

const {
  normalizeCardDisplayConfig,
} = require('../core/card-display-config.js');

const CARD_FONT_STACKS = Object.freeze({
  system: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif',
  yahei: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  serif: '"Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, serif',
  mono: '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", monospace',
});

function applyCardDisplaySettings(document, config = {}) {
  const normalized = normalizeCardDisplayConfig(config);
  const root = document && document.documentElement;
  if (root && root.style && typeof root.style.setProperty === 'function') {
    root.style.setProperty('--card-content-font-size', `${normalized.cardFontSize}px`);
    root.style.setProperty('--card-content-font-family', CARD_FONT_STACKS[normalized.cardFontFamily]);
  }
  return normalized;
}

module.exports = {
  CARD_FONT_STACKS,
  applyCardDisplaySettings,
};
