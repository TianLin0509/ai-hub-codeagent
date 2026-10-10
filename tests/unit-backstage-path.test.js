'use strict';
// 「后台」路径开关（公司「点后台卡死」，2026-10-11）：公司版默认回到 9 月的做法，主仓库保持 10 月的做法。
// 真实界面行为见 tests/repro-backstage-render.js（卡片视图里终端按实际尺寸常驻、点后台不再改尺寸）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { backstagePath, keepsTerminalBehindCards } = require('../core/backstage-path');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok ${name}`); }

test('社区版默认 9 月路径，主仓库默认 10 月路径；环境变量可强制', () => {
  assert.strictEqual(backstagePath({ env: {}, community: true }), 'september');
  assert.strictEqual(backstagePath({ env: {}, community: false }), 'october');
  assert.strictEqual(backstagePath({ env: { AI_HUB_BACKSTAGE_PATH: 'October' }, community: true }), 'october');
  assert.strictEqual(backstagePath({ env: { AI_HUB_BACKSTAGE_PATH: 'september' }, community: false }), 'september');
  assert.strictEqual(backstagePath({ env: { AI_HUB_BACKSTAGE_PATH: 'other' }, community: false }), 'october');
  assert.strictEqual(keepsTerminalBehindCards({ env: {}, community: true }), true);
  assert.strictEqual(keepsTerminalBehindCards({ env: {}, community: false }), false);
});

test('界面里 10 月新增的三处「卡片视图收起终端」都受同一个开关控制', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(src, /const BACKSTAGE_KEEPS_TERMINAL = require\('\.\.\/core\/backstage-path\.js'\)\.keepsTerminalBehindCards\(\);/);
  assert.match(src, /function primaryTerminalDormant\(\) \{ return currentView !== 'pty' && !BACKSTAGE_KEEPS_TERMINAL; \}/);
  // 136e13ec：卡片视图卸掉绘制层
  assert.match(src, /if \(embedded \|\| !primaryTerminalDormant\(\)\) loadGpuRenderer\(cached\);/);
  assert.match(src, /if \(mode === 'card' && !BACKSTAGE_KEEPS_TERMINAL && typeof terminalCache !== 'undefined'\) \{/);
  // 4164c127：卡片视图 display:none
  assert.match(src, /setCardHiddenTerminal\(cached, primaryTerminalDormant\(\)\);/);
  // d676f451：卡片视图不调尺寸
  assert.match(src, /terminalPanelEl && primaryTerminalDormant\(\)\) return false;/);
  assert.match(src, /activeSessionId !== sessionId \|\| primaryTerminalDormant\(\)\)\)\) return;/);
});

console.log(`unit-backstage-path: ${passed} passed`);
