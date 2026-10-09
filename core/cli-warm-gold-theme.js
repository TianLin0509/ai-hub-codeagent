'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const THEME_SLUG = 'ai-hub-warm-gold-v1';

// Claude owns its TUI colors. A per-session --settings overlay selects this
// namespaced theme without changing the user's theme preference.
const CLAUDE_THEME = {
  name: 'AI Hub · 暖金',
  base: 'dark',
  overrides: {
    claude: '#e6bb7c', claudeShimmer: '#f5d9ac',
    text: '#e8e3d8', inactive: '#a5b5c5', subtle: '#71879b',
    promptBorder: '#d7ac70', promptBorderShimmer: '#f0d29f',
    permission: '#dfb778', permissionShimmer: '#f2d4a5',
    planMode: '#86b8c8', autoAccept: '#8dccaa',
    success: '#8dccaa', error: '#e48d88', warning: '#edc380',
    diffAdded: '#193a35', diffRemoved: '#462e38',
    diffAddedWord: '#2f6553', diffRemovedWord: '#7a454a',
    userMessageBackground: '#183047',
    userMessageBackgroundHover: '#213e55',
    briefLabelYou: '#f1ce9a', briefLabelClaude: '#8dccaa',
  },
};

// Codex currently exposes custom themes for syntax-highlighted code and diff.
// Its own TUI chrome remains CLI-owned; the xterm palette covers ANSI output.
const CODEX_THEME = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>name</key><string>AI Hub Warm Gold</string>
<key>settings</key><array>
  <dict><key>settings</key><dict><key>background</key><string>#081420</string><key>foreground</key><string>#e8e3d8</string><key>caret</key><string>#e6bb7c</string><key>selection</key><string>#344052</string></dict></dict>
  <dict><key>scope</key><string>comment</string><key>settings</key><dict><key>foreground</key><string>#8799aa</string></dict></dict>
  <dict><key>scope</key><string>string</string><key>settings</key><dict><key>foreground</key><string>#a7d5ab</string></dict></dict>
  <dict><key>scope</key><string>keyword,storage</string><key>settings</key><dict><key>foreground</key><string>#e6bb7c</string></dict></dict>
  <dict><key>scope</key><string>constant.numeric,constant.language</string><key>settings</key><dict><key>foreground</key><string>#d5a4cc</string></dict></dict>
  <dict><key>scope</key><string>entity.name.function,support.function</string><key>settings</key><dict><key>foreground</key><string>#9cc9e7</string></dict></dict>
  <dict><key>scope</key><string>variable,entity.name.type</string><key>settings</key><dict><key>foreground</key><string>#e8d5b5</string></dict></dict>
  <dict><key>scope</key><string>markup.inserted</string><key>settings</key><dict><key>foreground</key><string>#8dccaa</string></dict></dict>
  <dict><key>scope</key><string>markup.deleted</string><key>settings</key><dict><key>foreground</key><string>#e48d88</string></dict></dict>
</array></dict></plist>
`;

function ensureThemeFile(home, extension, contents, slug = THEME_SLUG) {
  if (!path.isAbsolute(home)) throw new Error('CLI theme home must be absolute');
  const directory = path.join(home, 'themes');
  const file = path.join(directory, slug + extension);
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== contents) throw new Error('Existing CLI theme differs: ' + file);
    return file;
  }
  try { fs.writeFileSync(file, contents, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) {
    // Two sessions may start together. Accept the other writer's complete
    // file, but never replace a different user file at this path.
    if (error.code !== 'EEXIST' || fs.readFileSync(file, 'utf8') !== contents) throw error;
  }
  return file;
}

function ensureClaudeWarmGoldTheme(env = process.env) {
  const home = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  ensureThemeFile(home, '.json', JSON.stringify(CLAUDE_THEME, null, 2) + '\n');
  return 'custom:' + THEME_SLUG;
}

function ensureCodexWarmGoldTheme(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  ensureThemeFile(home, '.tmTheme', CODEX_THEME);
  return THEME_SLUG;
}

module.exports = { THEME_SLUG, CLAUDE_THEME, CODEX_THEME, ensureThemeFile, ensureClaudeWarmGoldTheme, ensureCodexWarmGoldTheme };
