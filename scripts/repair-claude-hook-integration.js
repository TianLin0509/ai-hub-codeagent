'use strict';

// One-shot production repair. This does not touch or restart any Hub process;
// it only restores the Hub-owned Claude hook entries while preserving all
// unrelated settings and hooks.
const os = require('os');
const fs = require('fs');
const path = require('path');
const {
  ensureClaudeHookIntegration,
  hasManagedHook,
} = require('../core/claude-hook-integration.js');

const appRoot = path.resolve(__dirname, '..');
const home = os.homedir();
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const results = ['.claude', '.claude-deepseek'].map(name => {
  const claudeDir = path.join(home, name);
  const settingsPath = path.join(claudeDir, 'settings.json');
  let backupPath = null;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!hasManagedHook(settings, 'Stop') || !hasManagedHook(settings, 'UserPromptSubmit')) {
      backupPath = `${settingsPath}.hub-before-repair-${stamp}.bak`;
      fs.copyFileSync(settingsPath, backupPath);
    }
  } catch { /* ensureClaudeHookIntegration reports malformed settings */ }
  return {
    ...ensureClaudeHookIntegration({
      claudeDir,
      sourceScriptsDir: path.join(appRoot, 'scripts'),
      logger: console,
    }),
    backupPath,
  };
});

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
if (results.some(result => result.errors.length)) process.exitCode = 1;
