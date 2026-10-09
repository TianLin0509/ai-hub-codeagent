'use strict';
// Read-only DOM samples captured 2026-09-25: the new ChatGPT composer has
// data-composer-markdown / contenteditable=true, and the controls use aria-labels.
// Only selector arguments are translated. Prompt literals and message text stay intact.
const COMPOSER = ':is(#prompt-textarea,[contenteditable=true][data-composer-markdown])';
const PROFILE = ':is([data-testid="accounts-profile-button"],button[aria-label="Open profile menu"])';
const OLD_IMAGE_PILL = '[data-inline-selection-pill][data-system-hint-type="picture_v2"]';
const IMAGE_MODE = `${COMPOSER} ${OLD_IMAGE_PILL},[data-composer-body] button[aria-label="Remove Create image"]`;
const BUTTONS = {
  'send-button': '[data-testid="send-button"],button[aria-label="Send"]',
  'composer-plus-btn': '[data-testid="composer-plus-btn"],button[aria-label="Add files and more"]',
};
function adaptSource(source) {
  // Walk complete literals, never recursively rewrite text inside a prompt string.
  let out = '', i = 0;
  while (i < source.length) {
    if (source.startsWith('//', i) || source.startsWith('/*', i)) {
      const line = source[i + 1] === '/', end = source.indexOf(line ? '\n' : '*/', i + 2);
      const next = end < 0 ? source.length : end + (line ? 1 : 2);
      out += source.slice(i, next); i = next; continue;
    }
    const quote = source[i];
    if (!['\'', '"', '`'].includes(quote)) { out += source[i++]; continue; }
    const start = i++;
    while (i < source.length) { if (source[i] === '\\') { i += 2; continue; } if (source[i++] === quote) break; }
    const literal = source.slice(start, i);
    const call = out.match(/\b(locator|querySelector|querySelectorAll|nodes|getByTestId)\(\s*$/);
    if (!call || quote === '`') { out += literal; continue; }
    let value;
    try { value = new Function('return ' + literal)(); } catch { out += literal; continue; }
    if (call[1] === 'getByTestId') {
      if (!BUTTONS[value]) { out += literal; continue; }
      out = out.slice(0, -call[0].length) + 'locator(' + JSON.stringify(BUTTONS[value]);
    } else {
      let replaced = value.replaceAll('#prompt-textarea', COMPOSER).replaceAll('[data-testid="accounts-profile-button"]', PROFILE);
      if (value === '#prompt-textarea ' + OLD_IMAGE_PILL) replaced = IMAGE_MODE;
      if (value === OLD_IMAGE_PILL && /\bcomposer\.locator\(\s*$/.test(out)) {
        out = out.replace(/\bcomposer\.locator\(\s*$/, 'page.locator(');
        replaced = IMAGE_MODE;
      }
      if (value === '[role="menu"], [role="group"]') replaced += ', [data-menu-row-content]';
      out += value === replaced ? literal : JSON.stringify(replaced);
    }
  }
  return out;
}
module.exports = { adaptSource, COMPOSER, PROFILE, BUTTONS, IMAGE_MODE };
