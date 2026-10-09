'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { buildLaunchSpec } = require('./windows-shell-integration.js');

// A new Hub owns its own control endpoint. Keep data/home overrides so an
// isolated Hub can never launch a production instance by clicking its logo.
function buildHubInstanceEnv(baseEnv) {
  const env = { ...baseEnv };
  const parentKeys = new Set([
    'ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN',
    'CLAUDE_HUB_SESSION_ID', 'AI_TEAM_HUB_CALLBACK_URL', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID',
  ]);
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (parentKeys.has(upper) || upper.startsWith('CLAUDE_CODE_') || upper.startsWith('ARENA_HUB_')) delete env[key];
  }
  return env;
}

function launchHubInstance({ appRoot, execPath, isPackaged = false, env = process.env, spawnImpl = spawn, logger = console }) {
  // Same executable/root/cwd contract as the taskbar's New Hub task. Pass the
  // root as one argv entry (no shell, no inherited CDP port or parent CLI args).
  const launch = buildLaunchSpec({ appRoot, execPath, isPackaged });
  return new Promise((resolve, reject) => {
    const child = spawnImpl(launch.target, isPackaged ? [] : [path.resolve(appRoot)], {
      cwd: launch.cwd,
      env: buildHubInstanceEnv(env),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ pid: child.pid });
    });
    child.once('exit', (code, signal) => {
      if (code !== 0) logger.warn(`[hub-instance] PID ${child.pid} exited: code=${code}, signal=${signal || 'none'}`);
    });
  });
}

module.exports = { buildHubInstanceEnv, launchHubInstance };
