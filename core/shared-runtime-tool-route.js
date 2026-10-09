'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const CALLBACK_KEYS = new Set(['ARENA_HUB_PORT', 'ARENA_HOOK_TOKEN', 'ARENA_HUB_ROUTE_FILE']);
const CODEX_RESEARCH = 'mcp_servers.arena_research.env.';
function researchServer(server) {
  return Array.isArray(server?.args) && server.args.some(arg => /(?:^|[\\/])research-mcp-server\.js$/.test(arg));
}
function stable(value) {
  return Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function transformMcp(config, routeFile) {
  let changed = false;
  for (const server of Object.values(config.mcpServers || {})) {
    if (!researchServer(server)) continue;
    changed = true;
    server.env = { ...server.env };
    for (const key of CALLBACK_KEYS) delete server.env[key];
    if (routeFile) server.env.ARENA_HUB_ROUTE_FILE = routeFile;
  }
  return changed;
}
function claudeArgs(options, routeFile, created = []) {
  const args = [...(options.launchArgs || [])];
  let mcp = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mcp-config') { mcp = true; continue; }
    if (args[i].startsWith('--')) mcp = false;
    if (args[i] === '--settings' && !routeFile) { i++; args[i] = stable(readJson(path.resolve(options.cwd || '.', args[i]))); continue; }
    if (!mcp) continue;
    const original = path.resolve(options.cwd || '.', args[i]);
    const config = readJson(original);
    const changed = transformMcp(config, routeFile);
    if (!routeFile) args[i] = stable(config);
    else if (changed) {
      const target = routeFile + '.' + i + '.mcp.json';
      fs.writeFileSync(target, JSON.stringify(config), { encoding:'utf8', flag:'wx' });
      options.relaunchMcpPaths = { ...options.relaunchMcpPaths, [target]:original };
      created.push(target); args[i] = target;
    }
  }
  return args;
}
function codexArgs(options, routeFile) {
  const args = [...(options.processArgs || [])];
  const managed = args.some(value => value.startsWith('mcp_servers.arena_research.args=') && value.includes('research-mcp-server.js'));
  if (!managed) return args;
  for (let i = args.length - 1; i >= 1; i--) {
    if (args[i - 1] !== '-c' || !args[i].startsWith(CODEX_RESEARCH)) continue;
    if (CALLBACK_KEYS.has(args[i].slice(CODEX_RESEARCH.length).split('=')[0])) args.splice(i - 1, 2);
  }
  if (routeFile) args.push('-c', CODEX_RESEARCH + 'ARENA_HUB_ROUTE_FILE=' + JSON.stringify(routeFile));
  return args;
}
function normalizedLaunch(options) {
  return { processArgs:codexArgs(options), ...(options.nativeProvider === 'claude'
    ? { claudeArgs:claudeArgs(options), executable:options.executable || null, commandArgs:options.commandArgs || [] } : {}) };
}
function prepareToolRoute(options) {
  if (!options.hubDataDir) return null;
  const directory = path.join(options.hubDataDir, 'native-runtime-control');
  // Only room tools need a callback. Ordinary sessions create no route files.
  const hasResearch = options.nativeProvider === 'claude'
    ? (options.launchArgs || []).includes('--mcp-config') && JSON.stringify(claudeArgs(options)).includes('research-mcp-server.js')
    : (options.processArgs || []).some(value => value.startsWith('mcp_servers.arena_research.args=') && value.includes('research-mcp-server.js'));
  if (!hasResearch) return null;
  fs.mkdirSync(directory, { recursive:true });
  const file = path.join(directory, randomUUID() + '.json'), created = [];
  try {
    if (options.nativeProvider === 'claude') options.launchArgs = claudeArgs(options, file, created);
    else options.processArgs = codexArgs(options, file);
  } catch (error) {
    for (const target of created) {
      try { fs.unlinkSync(target); } catch (cleanupError) { console.warn('[native-tool-route] preparation cleanup:', cleanupError.message); }
    }
    throw error;
  }
  let previous;
  return {
    file,
    update(controller, connected) {
      const state = { dataDir:options.hubDataDir, hubPid:controller?.hubPid || null, connected:!!connected };
      const content = JSON.stringify(state);
      if (content === previous) return;
      fs.writeFileSync(file + '.tmp', content, 'utf8'); fs.renameSync(file + '.tmp', file); previous = content;
    },
    invalidate() {
      previous = undefined;
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') console.warn('[native-tool-route] invalidate failed:', error.message); }
    },
    dispose() {
      for (const target of [file, ...created]) {
        try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') console.warn('[native-tool-route]', error.message); }
      }
    },
  };
}
function resolveToolRoute(file, fallback) {
  if (!file) return fallback;
  const route = readJson(file);
  if (!route.connected || !Number.isSafeInteger(route.hubPid) || route.hubPid <= 0) throw Error('操作窗口已断开，请先在 Hub 恢复操作');
  const control = readJson(path.join(route.dataDir, 'control', route.hubPid + '.json'));
  if (control.pid !== route.hubPid || !Number.isInteger(control.hookPort) || control.hookPort <= 0 || !control.token) throw Error('操作窗口连接信息无效');
  return { port:control.hookPort, token:control.token };
}
module.exports = { normalizedLaunch, prepareToolRoute, resolveToolRoute };
