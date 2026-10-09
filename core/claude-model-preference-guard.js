'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { renameWithRetrySync } = require('./claude-project-trust');

function claudeSettingsPath(configDir) {
  const root = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(root, 'settings.json');
}

function readJsonObject(filePath, fsModule = fs) {
  try {
    const value = JSON.parse(fsModule.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error && error.code === 'ENOENT') return {};
    throw error;
  }
}

function captureClaudeModelPreference(targetModel, options = {}) {
  const fsModule = options.fsModule || fs;
  const settingsPath = options.settingsPath || claudeSettingsPath(options.configDir);
  const settings = readJsonObject(settingsPath, fsModule);
  return {
    settingsPath,
    targetModel: String(targetModel || ''),
    hadModel: Object.prototype.hasOwnProperty.call(settings, 'model'),
    previousModel: settings.model,
  };
}

function claudePreferenceMatchesTarget(currentModel, targetModel) {
  const current = String(currentModel || '').replace(/\[1m\]$/i, '').toLowerCase();
  const target = String(targetModel || '').replace(/\[1m\]$/i, '').toLowerCase();
  if (!current || !target) return false;
  if (current === target) return true;
  return ['fable', 'opus', 'sonnet', 'haiku'].some(alias => (
    target === alias && current.includes(`-${alias}-`)
  ));
}

function writeJsonAtomic(filePath, value, fsModule = fs) {
  fsModule.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.hub-model-restore-${process.pid}-${Date.now()}.tmp`;
  try {
    fsModule.writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameWithRetrySync(tempPath, filePath, { fsImpl: fsModule, retries: 8, retryDelayMs: 15 });
  } catch (error) {
    try { fsModule.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
}

function restoreClaudeModelPreference(snapshot, options = {}) {
  if (!snapshot || !snapshot.settingsPath) return { restored: false, status: 'missing-snapshot' };
  const fsModule = options.fsModule || fs;
  const settings = readJsonObject(snapshot.settingsPath, fsModule);
  const currentModel = Object.prototype.hasOwnProperty.call(settings, 'model') ? settings.model : undefined;
  // Compare-and-swap: never overwrite a different model chosen concurrently by
  // the user or another process after this Hub switch began.
  if (!claudePreferenceMatchesTarget(currentModel, snapshot.targetModel)) {
    return { restored: false, status: 'changed-externally', currentModel };
  }
  if (snapshot.hadModel) settings.model = snapshot.previousModel;
  else delete settings.model;
  writeJsonAtomic(snapshot.settingsPath, settings, fsModule);
  return {
    restored: true,
    status: snapshot.hadModel ? 'restored-previous' : 'removed-temporary-default',
    previousModel: snapshot.previousModel,
  };
}

module.exports = {
  captureClaudeModelPreference,
  claudePreferenceMatchesTarget,
  claudeSettingsPath,
  readJsonObject,
  restoreClaudeModelPreference,
  writeJsonAtomic,
};
