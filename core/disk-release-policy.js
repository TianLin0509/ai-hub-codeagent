'use strict';

const os = require('os');
const path = require('path');
const AGE_MS = 48 * 60 * 60 * 1000;

function inside(root, target, allowRoot = false) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return (allowRoot || rel !== '') && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function defaultScopes({ dataDir, testRoot } = {}) {
  const home = os.homedir();
  const temporary = os.tmpdir();
  if (testRoot) {
    if (!dataDir || !inside(path.dirname(dataDir), testRoot) || !inside(temporary, testRoot)) {
      throw new Error('测试清理目录必须位于本次隔离测试范围内');
    }
    return [{ root: path.resolve(testRoot), mode: 'tests', label: '隔离测试目录' }];
  }
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const vibeTemp = path.join(process.env.SystemDrive || 'C:', 'AppData', 'Temp');
  return [
    { root: temporary, mode: 'tests', label: '临时测试数据' },
    { root: vibeTemp, mode: 'tests', label: 'AppData 临时测试数据' },
    { root: vibeTemp, mode: 'emulators', label: 'Android 临时测试设备' },
    { root: path.join(local, 'npm-cache', '_cacache'), mode: 'cache', label: 'npm 下载缓存', note: '保留已安装的程序；以后安装相同依赖时会重新下载。' },
    { root: path.join(local, 'pip', 'cache'), mode: 'cache', label: 'pip 下载缓存', note: '保留 Python 环境；以后安装相同依赖时会重新下载。' },
    { root: path.join(local, 'uv', 'cache'), mode: 'cache', label: 'uv 下载缓存', note: '以后安装依赖时可能需要重新下载。' },
    { root: path.join(local, 'Yarn', 'Cache'), mode: 'cache', label: 'Yarn 下载缓存', note: '以后安装依赖时需要重新下载。' },
    { root: path.join(home, '.gradle', 'caches'), mode: 'cache', label: 'Gradle 构建缓存',
      activeNames: ['java.exe', 'javaw.exe', 'gradle.exe'], note: '以后 Android 构建会重新下载或生成缓存；运行 Java 或构建时保留。' },
    ...[
      path.join(local, 'Google', 'Chrome', 'User Data'),
      path.join(local, 'Microsoft', 'Edge', 'User Data'),
      path.join(process.env.SystemDrive || 'C:', 'AppData', 'BrowserProfiles'),
    ].map(root => ({ root, mode: 'browserCaches', label: '浏览器缓存',
      activeNames: ['chrome.exe', 'msedge.exe'], note: '只清理页面缓存，保留登录、Cookie、书签和浏览记录；浏览器运行时保留。' })),
  ];
}

function testLabel(name) {
  if (/^hub-writing/.test(name)) return 'Hub 写作测试';
  if (/^hub-(orch|orchestrator)/.test(name)) return 'Hub 编排测试';
  if (/^hub-devflow/.test(name)) return 'Hub 开发流程测试';
  if (/^hub-answers/.test(name)) return 'Hub 回答展示测试';
  if (/^xresearch-/.test(name)) return '投研工具测试';
  if (/^assistant-/.test(name)) return 'Hub 助手测试';
  return 'Hub 临时测试';
}

function recognizedTest(name) {
  return /^(hub-|assistant-|xresearch-.*hub|claude-session-hub-)/i.test(name);
}

module.exports = { AGE_MS, inside, defaultScopes, recognizedTest, testLabel };
