'use strict';

const CARD_FONT_SIZE_MIN = 13;
const CARD_FONT_SIZE_MAX = 22;
const DEFAULT_CARD_FONT_SIZE = 15;
const DEFAULT_CARD_FONT_FAMILY = 'system';
const CARD_FONT_FAMILY_IDS = Object.freeze(['system', 'yahei', 'serif', 'mono']);

function normalizeCardFontSize(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_CARD_FONT_SIZE;
  return Math.min(CARD_FONT_SIZE_MAX, Math.max(CARD_FONT_SIZE_MIN, parsed));
}

function normalizeCardFontFamily(value) {
  const id = String(value || '').trim().toLowerCase();
  return CARD_FONT_FAMILY_IDS.includes(id) ? id : DEFAULT_CARD_FONT_FAMILY;
}

function normalizeCardDisplayConfig(config = {}) {
  return {
    cardFontSize: normalizeCardFontSize(config.cardFontSize),
    cardFontFamily: normalizeCardFontFamily(config.cardFontFamily),
  };
}

module.exports = {
  CARD_FONT_SIZE_MIN,
  CARD_FONT_SIZE_MAX,
  DEFAULT_CARD_FONT_SIZE,
  DEFAULT_CARD_FONT_FAMILY,
  CARD_FONT_FAMILY_IDS,
  normalizeCardFontSize,
  normalizeCardFontFamily,
  normalizeCardDisplayConfig,
};
