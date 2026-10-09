'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getHubDataDir } = require('./data-dir.js');
const modelCatalog = require('./deepseek-codex-model-catalog.json');

const DEEPSEEK_CODEX_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_CODEX_MODELS = Object.freeze([
  'deepseek-v4-pro',
  'deepseek-v4-flash',
]);
const DEEPSEEK_CODEX_BASE_URL = 'https://api.deepseek.com/';
const DEEPSEEK_CODEX_MIN_VERSION = '0.144.0';

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function toTomlPath(value) {
  return path.resolve(value).replace(/\\/g, '/');
}

function getDeepSeekCodexHome(dataDir = getHubDataDir()) {
  return path.join(dataDir, 'deepseek-codex-profile');
}

function buildDeepSeekCodexCatalog() {
  const sourceModels = Array.isArray(modelCatalog.models) ? modelCatalog.models : [];
  const bySlug = new Map(sourceModels.filter(Boolean).map(model => [model.slug, model]));
  const flashTemplate = bySlug.get(DEEPSEEK_CODEX_MODEL);
  if (!flashTemplate) throw new Error(`DeepSeek Codex catalog missing ${DEEPSEEK_CODEX_MODEL}`);

  const models = DEEPSEEK_CODEX_MODELS.map((slug) => {
    const existing = bySlug.get(slug);
    if (existing) return existing;
    if (slug === 'deepseek-v4-pro') {
      // DeepSeek V4 Pro and Flash expose the same Responses/Codex capability
      // surface and 1M context. Keep one vetted Codex template, overriding only
      // model identity, user-facing description, and picker priority.
      return {
        ...flashTemplate,
        slug,
        display_name: 'DeepSeek-V4-Pro',
        description: 'DeepSeek V4 Pro frontier reasoning and agentic coding model.',
        priority: Math.max(2, Number(flashTemplate.priority) || 0),
      };
    }
    throw new Error(`DeepSeek Codex catalog cannot derive ${slug}`);
  });
  return { ...modelCatalog, models };
}

function ensureDeepSeekCodexProfile(projectDir, opts = {}) {
  const codexHome = path.resolve(opts.codexHome || getDeepSeekCodexHome(opts.dataDir));
  const projectKey = path.resolve(projectDir || os.homedir());
  const catalogPath = path.join(codexHome, 'models.json');
  const configPath = path.join(codexHome, 'config.toml');
  const trustedProjectsPath = path.join(codexHome, 'trusted-projects.json');

  const effectiveCatalog = buildDeepSeekCodexCatalog();
  for (const model of effectiveCatalog.models) {
    if (model.minimal_client_version !== DEEPSEEK_CODEX_MIN_VERSION) {
      throw new Error(`DeepSeek Codex catalog requires unexpected client ${model.minimal_client_version || '(missing)'}`);
    }
  }

  fs.mkdirSync(codexHome, { recursive: true });
  let trustedProjects = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(trustedProjectsPath, 'utf8'));
    if (Array.isArray(parsed)) trustedProjects = parsed.filter(item => typeof item === 'string' && item.trim());
  } catch {}
  const trustedByKey = new Map(trustedProjects.map(item => [path.resolve(item).toLowerCase(), path.resolve(item)]));
  trustedByKey.set(projectKey.toLowerCase(), projectKey);
  trustedProjects = [...trustedByKey.values()].sort((a, b) => a.localeCompare(b));

  fs.writeFileSync(catalogPath, `${JSON.stringify(effectiveCatalog, null, 2)}\n`, 'utf8');
  fs.writeFileSync(trustedProjectsPath, `${JSON.stringify(trustedProjects, null, 2)}\n`, 'utf8');
  const configLines = [
    'disable_response_storage = true',
    `model = ${tomlString(DEEPSEEK_CODEX_MODEL)}`,
    'model_provider = "deepseek"',
    'preferred_auth_method = "apikey"',
    'forced_login_method = "api"',
    'model_reasoning_effort = "max"',
    `model_catalog_json = ${tomlString(toTomlPath(catalogPath))}`,
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    'project_root_markers = [".git", ".vibe-root"]',
    '',
    '[notice]',
    'hide_rate_limit_model_nudge = true',
    'hide_full_access_warning = true',
    '',
    '[windows]',
    'sandbox = "unelevated"',
    '',
    '[model_providers.deepseek]',
    'name = "DeepSeek"',
    `base_url = ${tomlString(DEEPSEEK_CODEX_BASE_URL)}`,
    'env_key = "DEEPSEEK_API_KEY"',
    'wire_api = "responses"',
    '',
  ];
  for (const trustedProject of trustedProjects) {
    configLines.push(`[projects.${tomlString(trustedProject)}]`, 'trust_level = "trusted"', '');
  }
  fs.writeFileSync(configPath, configLines.join('\n'), 'utf8');

  return { codexHome, catalogPath, configPath, trustedProjectsPath, model: DEEPSEEK_CODEX_MODEL };
}

module.exports = {
  DEEPSEEK_CODEX_BASE_URL,
  DEEPSEEK_CODEX_MIN_VERSION,
  DEEPSEEK_CODEX_MODEL,
  DEEPSEEK_CODEX_MODELS,
  buildDeepSeekCodexCatalog,
  ensureDeepSeekCodexProfile,
  getDeepSeekCodexHome,
};
