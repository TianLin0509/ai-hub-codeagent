'use strict';
// User identity belongs to the person, not to an API/subscription account.
// Opt-in source; absent in clean installs and isolated test homes.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
function contextHome(env, dataDir) {
  const explicit = env.CLAUDE_HUB_HOME_DIR;
  const home = explicit || env.USERPROFILE || env.HOME;
  if (!home) return null;
  // Never import real personal context into an isolated Hub implicitly.
  if (!explicit && dataDir && path.resolve(dataDir).toLowerCase() !== path.resolve(home, '.ai-hub-community').toLowerCase()) return null;
  return path.resolve(home);
}
function loadUserContext(env, dataDir) {
  const home = contextHome(env, dataDir);
  if (!home) return null;
  const source = path.join(home, '.agents', 'USER_CONTEXT.md');
  if (!fs.existsSync(source)) return null;
  if (fs.statSync(source).size > 32768) throw new Error('个人基础规则超过 32 KB，请先精简：' + source);
  const content = fs.readFileSync(source, 'utf8');
  if (!content.trim()) throw new Error('个人基础规则为空：' + source);
  return { home, source, content, digest:hash(content) };
}
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const tmp = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(tmp, content, {encoding:'utf8',flag:'wx'}); fs.renameSync(tmp,file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
function syncNativeUserContext({kind, nativeHome, env=process.env, dataDir}) {
  const source = loadUserContext(env,dataDir);
  if (!source || !nativeHome) return null;
  if (env.CLAUDE_HUB_HOME_DIR && dataDir) {
    const relative=path.relative(path.dirname(path.resolve(dataDir)),path.resolve(nativeHome));
    if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('原生规则目标超出隔离 Hub 目录，未同步');
  }
  const filename = kind === 'claude' ? 'CLAUDE.md' : kind === 'gemini' ? 'GEMINI.md' : kind === 'qwen' ? 'QWEN.md' : 'AGENTS.md';
  const file = path.join(nativeHome,filename), receipt = path.join(nativeHome,'.hub-user-context.json');
  const old = fs.existsSync(file) ? fs.readFileSync(file,'utf8') : null;
  if (old !== source.content) {
    let previous;
    try { previous = JSON.parse(fs.readFileSync(receipt,'utf8')); }
    catch(e) { if(e.code !== 'ENOENT') throw e; }
    // Adopt copies created by the user's explicit synchronization manifest.
    if (!previous && old !== null) {
      const manifest = path.join(source.home,'.agents','user-context-targets.json');
      if(fs.existsSync(manifest)) {
        const target = JSON.parse(fs.readFileSync(manifest,'utf8')).targets?.find(r=>path.resolve(r.path).toLowerCase()===path.resolve(file).toLowerCase());
        if(target?.last_sha256) previous={digest:target.last_sha256};
      }
    }
    if (old !== null && hash(old) !== previous?.digest) throw new Error('个人规则存在独立修改，未覆盖：' + file);
    if(fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('个人规则为链接，未覆盖：'+file);
    writeAtomic(file,source.content);
  }
  const record={source:source.source,digest:source.digest};
  const serialized=JSON.stringify(record,null,2)+'\n';
  if(!fs.existsSync(receipt)||fs.readFileSync(receipt,'utf8')!==serialized) writeAtomic(receipt,serialized);
  if(kind==='codex'){
    const policyHooks=readPolicy(env,dataDir)?.codexHooks;
    // PTY 模式下 Hub 自己的 hook 是 Codex 状态与卡片绑定的来源（codex-hook-integration）。
    // 期望内容 = 个人策略 + 补齐的 Hub 条目；否则两边轮流改写 hooks.json，
    // 下一次启动这里会把 Hub 的补充当成「独立修改」而拒绝启动。
    const hooks=policyHooks && require('./agent-runtime-mode').usesPtyAgentRuntime('codex')
      ? require('./codex-hook-integration').mergeHubCodexHooks(policyHooks,require('./codex-hook-integration').hubHookScriptPath(nativeHome)).hooksFile
      : policyHooks;
    if(hooks){
      const hookFile=path.join(nativeHome,'hooks.json'),hookReceipt=path.join(nativeHome,'.hub-shared-hooks.json');
      const next=JSON.stringify(hooks,null,2)+'\n';
      const current=fs.existsSync(hookFile)?fs.readFileSync(hookFile,'utf8'):null;
      const previous=fs.existsSync(hookReceipt)?JSON.parse(fs.readFileSync(hookReceipt,'utf8')):null;
      // 现有内容若就是策略原样（个人同步脚本写的、没有 Hub 收据），不是「独立修改」，可以升级为
      // 策略 + Hub 条目（2026-09-26 生产现场：second 账号因此所有 Codex 会话都恢复不了）。
      const currentJson=current!==null?JSON.stringify(JSON.parse(current.replace(/^\uFEFF/,''))):null;
      const knownContent=currentJson===JSON.stringify(hooks)||(!!policyHooks&&currentJson===JSON.stringify(policyHooks));
      if(current!==null&&!knownContent&&hash(current)!==previous?.digest)throw new Error('Codex hooks 存在独立修改，未覆盖：'+hookFile);
      if(current!==next)writeAtomic(hookFile,next);
      const saved=JSON.stringify({digest:hash(next)})+'\n';
      if(!fs.existsSync(hookReceipt)||fs.readFileSync(hookReceipt,'utf8')!==saved)writeAtomic(hookReceipt,saved);
    }
  }
  return {path:file,digest:source.digest};
}
function readPolicy(env,dataDir) {
  const home=contextHome(env,dataDir);
  if(!home)return null;
  const file=path.join(home,'.agents','context-policy.json');
  if(!fs.existsSync(file))return null;
  const policy=JSON.parse(fs.readFileSync(file,'utf8'));
  if(policy.version!==1)throw new Error('未知的个人上下文策略版本');
  return policy;
}
function codexSharedConfig(env,dataDir) {
  const policy=readPolicy(env,dataDir);if(!policy)return {};
  // Endpoint, provider credentials and history ownership can never come from
  // this policy. Per-session explicit choices are applied after these defaults.
  const allowed=['model','model_reasoning_effort','model_reasoning_summary','approval_policy','sandbox_mode','service_tier','features','notice','tui','windows','mcp_servers','plugins','marketplaces','skills','project_root_markers','memories'];
  return Object.fromEntries(Object.entries(policy.codexDefaults||{}).filter(([k])=>allowed.includes(k)));
}
function claudeSharedConfig(env,dataDir){
  const policy=readPolicy(env,dataDir);
  return Object.fromEntries(Object.entries(policy?.claudeDefaults||{}).filter(([k])=>['autoMemoryDirectory','hooks'].includes(k)));
}
function codexTomlValue(value) {
  if(typeof value==='string'||typeof value==='boolean'||typeof value==='number')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(codexTomlValue).join(',')+']';
  if(value && typeof value==='object')return '{'+Object.entries(value).map(([k,v])=>JSON.stringify(k)+'='+codexTomlValue(v)).join(',')+'}';
  throw new Error('不支持的 Codex 默认配置值');
}
module.exports={contextHome,loadUserContext,syncNativeUserContext,codexSharedConfig,claudeSharedConfig,codexTomlValue};
