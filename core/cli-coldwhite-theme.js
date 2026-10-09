'use strict';

const os = require('os');
const path = require('path');
const gold = require('./cli-warm-gold-theme');
const SLUG = 'ai-hub-coldwhite-v1';

// These are per-launch overlays; user settings and a CLI's stored preference
// are never rewritten. Only the cold-white Hub theme opts into this palette.
const CLAUDE_THEME = {
  name: 'AI Hub · 冷白', base: 'light', overrides: {
    claude: '#3065bd', claudeShimmer: '#4778ca', text: '#303b4b',
    inactive: '#637084', subtle: '#637084',
    promptBorder: '#778395', promptBorderShimmer: '#3065bd',
    permission: '#856000', permissionShimmer: '#976c00',
    planMode: '#16717e', autoAccept: '#18704a',
    success: '#18704a', error: '#b42335', warning: '#856000',
    diffAdded: '#e6f4ed', diffRemoved: '#fbecef',
    diffAddedWord: '#c5e7d4', diffRemovedWord: '#f4cbd2',
    userMessageBackground: '#edf1f6', userMessageBackgroundHover: '#e4eaf3',
    briefLabelYou: '#3065bd', briefLabelClaude: '#18704a',
  },
};
const CODEX_THEME = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>name</key><string>AI Hub Cold White</string>
<key>settings</key><array>
<dict><key>settings</key><dict><key>background</key><string>#fbfcfd</string><key>foreground</key><string>#303b4b</string><key>caret</key><string>#3065bd</string><key>selection</key><string>#d6e2f5</string></dict></dict>
${[
  ['comment','#637084'],['string','#18704a'],['keyword,storage','#7944a1'],
  ['constant.numeric,constant.language','#856000'],
  ['entity.name.function,support.function','#3065bd'],['variable,entity.name.type','#303b4b'],
  ['markup.inserted','#18704a'],['markup.deleted','#b42335'],
].map(([scope,color])=>`<dict><key>scope</key><string>${scope}</string><key>settings</key><dict><key>foreground</key><string>${color}</string></dict></dict>`).join('\n')}
</array></dict></plist>
`;

function ensureClaudeTheme(env = process.env, theme) {
  if (theme !== 'codex') return gold.ensureClaudeWarmGoldTheme(env);
  gold.ensureThemeFile(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    '.json', JSON.stringify(CLAUDE_THEME, null, 2) + '\n', SLUG);
  return 'custom:' + SLUG;
}
function ensureCodexTheme(env = process.env, theme) {
  if (theme !== 'codex') return gold.ensureCodexWarmGoldTheme(env);
  gold.ensureThemeFile(env.CODEX_HOME || path.join(os.homedir(), '.codex'), '.tmTheme', CODEX_THEME, SLUG);
  return SLUG;
}

module.exports = { SLUG, CLAUDE_THEME, CODEX_THEME, ensureClaudeTheme, ensureCodexTheme };
