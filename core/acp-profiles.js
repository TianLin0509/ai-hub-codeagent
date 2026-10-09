'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const ACP_KINDS = ['qwen', 'deepseek-acp', 'glm'];
const PLAN_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const { HARNESS_LABELS: LABELS } = require('./ai-kinds');
function isAcpKind(kind) { return ACP_KINDS.includes(String(kind).replace(/-resume$/, '')); }
function writeJson(file, object) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(object, null, 2), { encoding: 'utf8', mode: 0o600 });
}
function buildAcpOptions(kind, opts, config, dataDir, baseEnv = process.env) {
  kind = kind.replace(/-resume$/, '');
  if (!isAcpKind(kind)) throw new Error('未知 ACP Harness');
  const profile = config.acp || {};
  const entry = profile.providers?.[kind];
  const key = profile.apiKey || baseEnv.AI_HUB_TOKEN_PLAN_KEY;
  if (!key) throw new Error('请先配置套餐专属 Key');
  if (!entry?.entryPath || !profile.nodePath || !entry.model) throw new Error('请配置原生 Harness 路径、Node 路径和套餐模型');
  for (const file of [entry.entryPath, profile.nodePath]) {
    if (!path.isAbsolute(file) || !fs.statSync(file).isFile()) throw new Error('Harness 可执行文件不存在或不是绝对路径');
  }
  const model = opts.model || entry.model;
  const models = require('./acp-model-catalog').acpModelOptions(kind, model);
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model))throw new Error('请填写套餐模型 ID，不可切到其他供应商命名空间');
  let mcpServers=[];
  if(opts.assistantMcpServers) {
    if(opts.purpose!=='hub-assistant'||!Array.isArray(opts.assistantMcpServers)
      ||opts.assistantMcpServers.length!==1||opts.assistantMcpServers[0]?.name!=='hub_assistant'
      ||!opts.assistantMcpServers[0].env?.some(e=>e.name==='HUB_ASSISTANT_SESSION_ID'&&e.value===opts.id))
      throw new Error('助理 MCP 配置身份不一致');
    mcpServers=opts.assistantMcpServers;
  }
  if(entry.mcpConfigPath && !opts.assistantMcpServers) {
    if(!path.isAbsolute(entry.mcpConfigPath))throw new Error('MCP 配置文件必须使用绝对路径');
    mcpServers=JSON.parse(fs.readFileSync(entry.mcpConfigPath,'utf8').replace(/^\uFEFF/,''));
    if(!Array.isArray(mcpServers))throw new Error('MCP 配置应为 ACP server 数组');
    const names=new Set();
    for(const s of mcpServers) {
      if(!s || typeof s.name!=='string' || !s.name || names.has(s.name))throw new Error('MCP 名称为空或重复');names.add(s.name);
      const pairs=items=>Array.isArray(items) && items.every(i=>i && typeof i.name==='string' && typeof i.value==='string');
      if(!s.type || s.type==='stdio') {
        if(typeof s.command!=='string' || !s.command || !Array.isArray(s.args) || !s.args.every(a=>typeof a==='string') || !pairs(s.env || []))throw new Error('MCP stdio 配置无效：'+s.name);
      } else if(['http','sse'].includes(s.type)) {
        if(!/^https?:\/\//.test(s.url || '') || !pairs(s.headers || []))throw new Error('MCP 网络配置无效：'+s.name);
      } else throw new Error('MCP 传输类型无效：'+s.name);
    }
  }
  const baseURL = profile.baseURL || PLAN_BASE_URL;
  // A shared subscription credential must never be routed to an unrelated host.
  if (baseURL.replace(/\/$/, '') !== PLAN_BASE_URL) throw new Error('套餐 profile 只允许已核对的阿里云 Token Plan 端点');
  const profileId = 'aliyun-token-plan:' + kind;
  const sessionRoot = path.join(dataDir, 'acp', createHash('sha256').update(opts.id).digest('hex'));
  const home = path.join(sessionRoot, 'home');
  if (opts.acpFork) {
    const source = fs.realpathSync(opts.acpFork.home);
    const allowed = fs.realpathSync(path.join(dataDir,'acp')) + path.sep;
    if (!source.startsWith(allowed) || source === home || fs.existsSync(home)) throw new Error('ACP 分叉目录身份无效');
    fs.cpSync(source,home,{recursive:true,dereference:false,errorOnExist:true,force:false,
      filter: file => !path.relative(source,file).split(path.sep).includes('node_modules')});
  }
  fs.mkdirSync(home, { recursive: true });
  const env = { ...baseEnv, HOME: home, USERPROFILE: home };
  for (const name of Object.keys(env)) {
    if (/API_KEY|AUTH_TOKEN|CODEX_THREAD|CODEX_SESSION|CLAUDE_HUB_(TOKEN|PORT|SESSION)|AI_TEAM_HUB_CALLBACK/.test(name)
        || /^(ZCODE_|DSH_|QWEN_|CODEX_)/.test(name)
        || ['AI_HUB_TOKEN_PLAN_KEY','ELECTRON_RUN_AS_NODE','NODE_OPTIONS','CLAUDECODE','CLAUDE_CONFIG_DIR'].includes(name)) delete env[name];
  }
  let args = [entry.entryPath];
  let authMethod;
  let authMeta;
  if (kind === 'qwen') {
    args.push('--acp', '--model', model, '--approval-mode', 'yolo');
    Object.assign(env, { OPENAI_API_KEY: key, OPENAI_BASE_URL: baseURL, OPENAI_MODEL: model,
      QWEN_CODE_DISABLE_AUTO_UPDATE: '1', NO_COLOR: '1' });
    authMethod = 'openai';
    writeJson(path.join(home, '.qwen/settings.json'), {
      general: { enableAutoUpdate: false },
      modelProviders: { openai: models.map(({id}) => ({ id, name: id, baseUrl: baseURL, envKey: 'OPENAI_API_KEY' })) },
    });
  } else if (kind === 'deepseek-acp') {
    if(!entry.bridgePath)throw new Error('DeepSeek 完整交互需要配置 ACP 扩展包目录');
    env.DSH_HOME = path.join(home, '.dsh');
    env.BAILIAN_API_KEY = key;
    // authenticate persists the native provider credential in this isolated
    // profile. DSH rejects that write if the same key is injected read-only
    // through BAILIAN_TPP_API_KEY. The model adapter uses BAILIAN_API_KEY.
    const settings = {
      'agent-default-model': { provider: 'bailian-tpp', model },
      'llm-pi-ai': { providers: { 'bailian-tpp': { api: 'openai-completions', baseURL,
        apiKeyEnv: 'BAILIAN_API_KEY', models: models.map(({id}) => ({ id,
          reasoningEfforts: require('./acp-model-catalog').deepseekReasoningEfforts(id),
          compat: { thinkingFormat: 'deepseek', supportsDeveloperRole: false } })) } } },
    };
    writeJson(path.join(env.DSH_HOME, 'settings.yaml'), settings);
    const patch = path.join(sessionRoot, 'acp-route.yaml');
    const routePatches = [{ id: 'llm-pi-ai', config: settings['llm-pi-ai'] },
      { id: 'agent-default-model', config: settings['agent-default-model'] },
      { id: 'acp', config: { provider: 'bailian-tpp', model } }];
    if (entry.bridgePath) {
      if (!path.isAbsolute(entry.bridgePath) || !fs.existsSync(path.join(entry.bridgePath, 'package.json'))) throw new Error('DeepSeek ACP 扩展包路径无效');
      const scope = path.join(env.DSH_HOME, 'profiles/acp/node_modules/@openma');
      fs.mkdirSync(scope, { recursive: true });
      const link = path.join(scope, 'deepseek-harness-acp');
      if (!fs.existsSync(link)) fs.symlinkSync(entry.bridgePath, link, process.platform === 'win32' ? 'junction' : 'dir');
      if (fs.realpathSync(link) !== fs.realpathSync(entry.bridgePath)) throw new Error('ACP 扩展包链接目标已变化');
      writeJson(path.join(env.DSH_HOME, 'profiles/acp/package.json'), { name: 'hub-dsh-acp-profile', private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@openma/deepseek-harness-acp'], patchReload: 'startup' } } });
      Object.assign(env, { DSH_PROVIDER: 'bailian-tpp', DSH_MODEL: model,
        DSH_ACP_MODELS: models.map(m => m.id).join(','), DSH_SESSION_ROOT: path.join(env.DSH_HOME, 'sessions') });
      authMethod = 'api-key:bailian-tpp';
      authMeta = { 'api-key': { provider:'bailian-tpp',apiKey:key } };
      routePatches.pop();
      routePatches.push({ id: 'acp-plugin', config: { provider: 'bailian-tpp', model } });
      routePatches.push({ id:'acp-bridge',disabled:true });
      routePatches.push({ insert:[{id:'hub-acp-bridge',name:path.join(__dirname,'acp-dsh-stdio.mjs')}] });
      env.AI_HUB_DSH_BRIDGE = entry.bridgePath;
    }
    writeJson(patch, routePatches);
    args.push('--profile', 'acp', '--patch', patch);
  } else {
    if (!entry.backendPath || !path.isAbsolute(entry.backendPath) || !fs.existsSync(entry.backendPath)) throw new Error('缺少原生 ZCode 后端路径');
    Object.assign(env, { ZCODE_BIN: entry.backendPath, ZCODE_NODE: profile.nodePath, ZCODE_MODEL: model,
      ZCODE_BASE_URL: baseURL, ZCODE_ACP_RUNTIME: 'node', ZCODE_ACP_REMOTE: '0' });
    // Explicit custom provider prevents the bridge's built-in GLM quota route.
    writeJson(path.join(home, '.zcode/v2/config.json'), { provider: { 'hub-token-plan': {
      name: '阿里云 Token Plan', kind: 'openai', enabled: true,
      options: { baseURL, apiKey: key }, models: { [model]: { name: model } },
    } } });
  }
  // Credentials/history remain isolated; personal rules use the same source.
  require('./agent-user-context').syncNativeUserContext({kind,
    nativeHome:path.join(home,{qwen:'.qwen','deepseek-acp':'.dsh',glm:'.zcode'}[kind]),
    env:baseEnv,dataDir});
  return { id: opts.id, kind, cwd: opts.cwd, profileId, model, effort: opts.effort,mcpServers,
    permissionPolicy: 'bypass',
    defaultMode: {qwen:'yolo','deepseek-acp':'danger-full-access',glm:'yolo'}[kind],
    resumeId: opts.acpFork?.sessionId || opts.acpSid, forkCli:opts.acpFork?.forkCli===true, restoredRuntime: opts.nativeRuntime, forkHistory: opts.acpFork?.history,
    storeDir: path.join(dataDir, 'acp-history'), home, authMethod, authMeta,
    launch: { command: profile.nodePath, args, cwd: opts.cwd, env, secrets: [key] } };
}
module.exports = { ACP_KINDS, LABELS, PLAN_BASE_URL, isAcpKind, buildAcpOptions };
