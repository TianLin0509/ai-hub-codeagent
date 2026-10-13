'use strict';
// 「后台」路径开关（公司「点后台卡死」，2026-10-11）：公司版先回到 9 月的做法；2026-10-13 主仓库也默认 9 月做法。
// 真实界面行为见 tests/repro-backstage-render.js（卡片视图里终端按实际尺寸常驻、点后台不再改尺寸）。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { backstagePath, keepsTerminalBehindCards } = require('../core/backstage-path');

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok ${name}`); }

test('各发行版默认 9 月路径；环境变量可强制回 10 月路径', () => {
  assert.strictEqual(backstagePath({ env: {} }), 'september');
  assert.strictEqual(backstagePath({ env: { AI_HUB_BACKSTAGE_PATH: 'October ' } }), 'october');
  assert.strictEqual(backstagePath({ env: { AI_HUB_BACKSTAGE_PATH: 'september' } }), 'september');
  assert.strictEqual(backstagePath({ env: { AI_HUB_BACKSTAGE_PATH: 'other' } }), 'september');
  assert.strictEqual(keepsTerminalBehindCards({ env: {} }), true);
  assert.strictEqual(keepsTerminalBehindCards({ env: { AI_HUB_BACKSTAGE_PATH: 'october' } }), false);
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
