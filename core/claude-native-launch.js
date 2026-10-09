'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const PERMISSIONS = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);
function literal(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error('Invalid Claude ' + label);
  return value;
}

// Inputs are resolved by SessionManager using its existing backend/profile
// choices. No model, effort, permissions, or environment fallback occurs here.
function buildClaudeNativeArgs(options) {
  const args = ['--model', literal(options.model, 'model')];
  if (options.effort !== null) {
    if (!EFFORTS.has(options.effort)) throw new Error('Unsupported Claude effort');
    args.push('--effort', options.effort);
  }
  if (options.permissionMode) {
    if (!PERMISSIONS.has(options.permissionMode)) throw new Error('Unsupported Claude permission mode');
    args.push('--permission-mode', options.permissionMode);
  }
  if (options.appendSystemPromptFile) args.push('--append-system-prompt-file', literal(options.appendSystemPromptFile, 'system prompt file'));
  if (options.settingsFile) args.push('--settings', literal(options.settingsFile, 'settings file'));
  if (options.mcpConfigPaths?.length) {
    args.push('--mcp-config', ...options.mcpConfigPaths.map(value => literal(value, 'MCP config path')));
  }
  if (options.strictMcpConfig === true) args.push('--strict-mcp-config');
  for (const dir of options.addDirs || []) args.push('--add-dir', literal(dir, 'additional directory'));
  if (options.settingSources !== undefined) {
    if (!Array.isArray(options.settingSources) || options.settingSources.some(v => !['user', 'project', 'local'].includes(v))) {
      throw new Error('Invalid Claude setting sources');
    }
    args.push('--setting-sources', options.settingSources.join(','));
  }
  return args;
}

function mergeSettings(base, overlay) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid Claude settings key');
    result[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? mergeSettings(result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) ? result[key] : {}, value)
      : value;
  }
  return result;
}

// CLI --settings is one overlay. Combine room policy and Fast settings instead
// of passing it twice and risking the later option shadowing the earlier one.
function prepareClaudeSettingsOverlay(files, { directory, sessionId, overrides = {} }) {
  if (!files.length && !Object.keys(overrides).length) return null;
  if (!path.isAbsolute(directory) || !/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('Invalid settings output scope');
  let settings = {};
  for (const file of files) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude settings overlay must be an object');
    settings = mergeSettings(settings, value);
  }
  settings = mergeSettings(settings, overrides);
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, sessionId + '.json');
  const temporary = path.join(directory, sessionId + '.' + randomUUID() + '.tmp');
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporary, destination);
  return destination;
}

// Fast is a per-session flag, but a reconnect or resume relaunches the CLI with
// the same --settings overlay.  Rewriting that file keeps the tier the user
// last confirmed instead of silently falling back to the launch value.
function mergeClaudeSettingsFile(file, patch) {
  if (!path.isAbsolute(file)) throw new Error('Invalid Claude settings overlay path');
  const current = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Claude settings overlay must be an object');
  const merged = mergeSettings(current, patch);
  const temporary = file + '.' + randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(merged, null, 2), { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporary, file);
  return merged;
}

function claudeNativeResumeConfig(options) {
  const result = {};
  for (const key of ['permissionMode', 'mcpConfigFile', 'appendSystemPromptFile', 'addDirs', 'settingSources']) {
    if (options[key] !== undefined) result[key] = Array.isArray(options[key]) ? [...options[key]] : options[key];
  }
  return result;
}

module.exports = { buildClaudeNativeArgs, prepareClaudeSettingsOverlay, mergeClaudeSettingsFile, claudeNativeResumeConfig };
