'use strict';
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// Where the Codex CLI on this Windows machine lives. Every entry point that starts
// Codex (account check and login, App Server, usage, PTY sessions, first-run
// detection) goes through this one lookup so "installed" and "can start" never disagree.
//
// Order:
//   1. CODEX_INSTALL_DIR\codex.exe       an explicitly chosen native install
//   2. %APPDATA%\npm\codex.cmd           the npm install (previous sole behaviour)
//   3. PATH, in order                    codex.exe = native, codex.cmd = npm shim
//   4. %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe
//                                        the official native installer's default,
//                                        found even before a new PATH reaches this process
function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function pathDirs(env) {
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  return String(env[pathKey] || '').split(path.delimiter).map(dir => dir.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

function locateWindowsCodex(env = process.env) {
  if (env.CODEX_INSTALL_DIR) {
    const explicit = path.join(env.CODEX_INSTALL_DIR, 'codex.exe');
    if (isFile(explicit)) return { kind: 'native', command: explicit, source: 'CODEX_INSTALL_DIR' };
  }
  const npmShim = path.join(env.APPDATA || '', 'npm', 'codex.cmd');
  if (env.APPDATA && isFile(npmShim)) return { kind: 'npm', shim: npmShim, source: 'APPDATA' };
  for (const dir of pathDirs(env)) {
    const exe = path.join(dir, 'codex.exe');
    if (isFile(exe)) return { kind: 'native', command: exe, source: 'PATH' };
    const shim = path.join(dir, 'codex.cmd');
    if (isFile(shim)) return { kind: 'npm', shim, source: 'PATH' };
  }
  if (env.LOCALAPPDATA) {
    const official = path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
    if (isFile(official)) return { kind: 'native', command: official, source: 'official-installer' };
  }
  return null;
}

// Resolve the binary belonging to the selected npm shim, never another PATH version.
// The npm JS wrapper spawns a console process without windowsHide on Windows.
function resolveNpmShim(env, shim, options = {}) {
  const match = fs.readFileSync(shim, 'utf8').match(/"([^"\r\n]*[\\/]bin[\\/]codex(?:-managed)?\.js)"/i);
  if (!match) throw new Error('无法解析 Codex npm 启动器：' + shim);
  const script = match[1].replace(/%dp0%/gi, path.dirname(shim) + path.sep);
  const source = fs.readFileSync(script, 'utf8');
  const packageRoot = path.resolve(path.dirname(script), '..');
  const arch = options.arch || process.arch;
  const triple = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!triple) throw new Error('不支持的 Codex Windows 架构：' + arch);
  let vendor = path.join(packageRoot, 'vendor');
  try {
    vendor = path.join(path.dirname(createRequire(script).resolve(`@openai/codex-win32-${arch}/package.json`)), 'vendor');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  const target = path.join(vendor, triple + '-pc-windows-msvc');
  const command = ['bin', 'codex'].map(dir => path.join(target, dir, 'codex.exe')).find(file => fs.existsSync(file));
  if (!command) throw new Error('Codex 原生程序不存在：' + target);
  const managed = source.match(/CODEX_MANAGED_PACKAGE_ROOT:\s*("(?:[^"\\]|\\.)*")/);
  const launchEnv = { ...env, CODEX_MANAGED_PACKAGE_ROOT: managed ? JSON.parse(managed[1]) : packageRoot };
  for (const key of ['NPM', 'BUN', 'PNPM', 'VITE_PLUS']) delete launchEnv['CODEX_MANAGED_BY_' + key];
  launchEnv.CODEX_MANAGED_BY_NPM = '1';
  const pathKey = Object.keys(launchEnv).find(key => key.toLowerCase() === 'path') || 'PATH';
  const pathDir = path.join(target, 'path');
  if (fs.existsSync(pathDir)) launchEnv[pathKey] = pathDir + path.delimiter + (launchEnv[pathKey] || '');
  return { command, args: [], env: launchEnv };
}

function resolveWindowsCodex(env = process.env, options = {}) {
  if (options.shim) return resolveNpmShim(env, options.shim, options);
  const found = locateWindowsCodex(env);
  if (!found) throw new Error('未找到 Codex CLI：请安装官方 Codex（原生安装器或 npm），装好后重新检测。');
  if (found.kind === 'npm') return resolveNpmShim(env, found.shim, options);
  // The official native installer ships a self-contained codex.exe; run it as-is.
  return { command: found.command, args: [], env: { ...env } };
}

// A PTY session types `codex` into PowerShell. When the only install is a native one whose
// folder has not reached this process's PATH yet, put that folder in front for this session.
function ensureCodexOnSessionPath(sessionEnv) {
  const found = locateWindowsCodex(sessionEnv);
  if (!found || found.kind !== 'native' || found.source === 'PATH') return false;
  const dir = path.dirname(found.command);
  const pathKey = Object.keys(sessionEnv).find(key => key.toLowerCase() === 'path') || 'PATH';
  sessionEnv[pathKey] = dir + path.delimiter + (sessionEnv[pathKey] || '');
  return true;
}

module.exports = { resolveWindowsCodex, locateWindowsCodex, ensureCodexOnSessionPath };
