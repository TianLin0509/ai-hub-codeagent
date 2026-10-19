'use strict';

// An account selected by config directory must not authenticate as the parent
// CodeAgent process. Only remove the auth override from the child's copy when
// that selected profile has usable credentials; keep environment-only login.
const AUTH_TOKEN = 'CODEAGENT3_X_AUTH_TOKEN';

function authTokenKeys(env) {
  return Object.keys(env || {}).filter(key => key.toUpperCase() === AUTH_TOKEN);
}

function authStatus(env) {
  const present = authTokenKeys(env).some(key => !!String(env[key] || '').trim());
  return { present };
}

function applyAccountEnv(env, config) {
  const pool = require('./codeagent-pool');
  const credentials = config.configDir ? pool.readCredentials(config.configDir) : null;
  const ready = !!credentials?.authMaterialPresent && pool.accountState(credentials) === 'ready';
  const status = authStatus(env);
  if (config.configDir) env[config.configDirEnv || 'CODEAGENT3_CONFIG_DIR'] = config.configDir;
  if (ready) for (const key of authTokenKeys(env)) delete env[key];
  return { ...status, ignoredForNewSessions: status.present && ready,
    source: ready ? 'selected-account' : status.present ? 'environment-token' : 'cli-default' };
}

module.exports = { applyAccountEnv, authStatus };
