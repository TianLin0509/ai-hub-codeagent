'use strict';
// Community edition contract: edition marker, no private modules, hooks that
// need neither Python nor Node, and no changes to the user's global CLI
// permission settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

test('edition marker enables the community edition and records the upstream version', () => {
  const marker = JSON.parse(read('community-edition.json'));
  assert.equal(marker.edition, 'community');
  assert.match(marker.upstreamVersion, /^\d+\.\d+\.\d+$/);
  const distribution = require('../core/distribution');
  assert.equal(distribution.community, true);
  assert.equal(distribution.personalModules, false);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'ai-hub-community');
  assert.equal(pkg.version, marker.version);
  assert.equal(pkg.build.productName, 'AI Hub Community');
  assert.ok(pkg.build.files.includes('community-edition.json'));
  // Run without -Version, the published installer must install this release.
  const installer = read('scripts/install-release.ps1');
  assert.equal(/\[string\]\$Version\s*=\s*'([^']+)'/.exec(installer)?.[1], `v${pkg.version}`);
  for (const doc of ['README.md', 'INSTALL.md', 'docs/AGENT-QUICKSTART.md', 'scripts/install-release.ps1']) {
    assert.doesNotMatch(read(doc), /@@COMMUNITY_|@@UPSTREAM_/, doc);
  }
});

test('private module entry points are absent from the page and the tree', () => {
  const html = read('renderer/index.html');
  assert.doesNotMatch(html, /id="(?:btn-research|btn-study|study-panel|chatgpt-web-panel)"/);
  assert.doesNotMatch(html, /data-action="sync-(?:chatgpt|company)"/);
  assert.doesNotMatch(html, /@community-/);
  assert.match(html, /<script src="community-welcome\.js"><\/script>/);
  for (const rel of ['main/ipc/study-handlers.js', 'renderer/study.js', 'main/ipc/committee-handlers.js']) {
    assert.equal(fs.existsSync(path.join(root, rel)), false, rel);
  }
  const main = read('main.js');
  assert.doesNotMatch(main, /registerStudyIpc|registerCommitteeIpc|registerChatgptBridgeIpc/);
  assert.match(main, /ipcMain\.handle\('community:setup'/);
});

test('hooks run through Windows PowerShell, not Python or Node', () => {
  const { hookRunner } = require('../core/hook-runner');
  const runner = hookRunner({});
  assert.equal(runner.name, 'powershell');
  assert.equal(runner.script, 'session-hub-hook.ps1');
  assert.ok(fs.existsSync(path.join(root, 'scripts', runner.script)));
});

test('Claude hook deployment writes PowerShell hooks and leaves global permissions and status line alone', () => {
  const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'community-claude-'));
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'my-status' } }));
  const result = ensureClaudeHookIntegration({ claudeDir, sourceScriptsDir: path.join(root, 'scripts'), logger: {} });
  assert.deepEqual(result.errors, []);
  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8'));
  const stop = settings.hooks.Stop[0].hooks[0].command;
  assert.match(stop, /^powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ".*session-hub-hook\.ps1" stop$/);
  assert.doesNotMatch(JSON.stringify(settings.hooks), /python /);
  assert.equal(settings.permissionMode, undefined, 'global permission mode is not changed');
  assert.equal(settings.statusLine.command, 'my-status', 'an existing status line is kept');
  assert.ok(fs.existsSync(path.join(claudeDir, 'scripts', 'session-hub-hook.ps1')));
});

test('Codex hook trust is written without Python', () => {
  const { ensureCodexHookIntegration } = require('../core/codex-hook-integration');
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'community-codex-'));
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-5"\n\n[tui]\nstatus_line = ["model"]\n');
  const result = ensureCodexHookIntegration({ codexHome, logger: {} });
  assert.deepEqual(result.errors, []);
  assert.ok(result.trusted.length >= 6);
  const hooks = JSON.parse(fs.readFileSync(path.join(codexHome, 'hooks.json'), 'utf8'));
  assert.match(hooks.hooks.Stop[0].hooks[0].command, /^powershell .*session-hub-hook\.ps1" stop$/);
  const config = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(config, /^model = "gpt-5"$/m, 'existing settings are preserved');
  assert.match(config, /trusted_hash = "sha256:[0-9a-f]{64}"/);
});

test('data directory and product naming are separate from any private installation', () => {
  const dataDir = require('../core/data-dir');
  const saved = process.env.CLAUDE_HUB_DATA_DIR;
  delete process.env.CLAUDE_HUB_DATA_DIR;
  try { assert.equal(path.basename(dataDir.getHubDataDir()), '.ai-hub-community'); }
  finally { if (saved !== undefined) process.env.CLAUDE_HUB_DATA_DIR = saved; }
  assert.match(read('core/windows-shell-integration.js'), /AI Hub Community\.lnk/);
  assert.match(read('main.js'), /AI Hub Community v\$\{_pkgVersion\}/);
});

test('API defaults point to official endpoints', () => {
  const config = read('core/hub-config.js');
  assert.match(config, /claude_api_base_url: 'https:\/\/api\.anthropic\.com'/);
  assert.match(config, /codex_api_base_url: 'https:\/\/api\.openai\.com\/v1'/);
  assert.match(config, /proxy: ''/);
});
