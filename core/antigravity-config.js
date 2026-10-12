'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const ENGINE = 'antigravity';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_MODEL = 'gemini-3.1-pro-high';
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
function home(env = process.env) { return env.CLAUDE_HUB_HOME_DIR || env.USERPROFILE || os.homedir(); }
function configRoot(env = process.env) { return path.join(home(env), '.gemini', 'antigravity-cli'); }
function resolveCommand(env = process.env) {
  if (env.AI_HUB_ANTIGRAVITY_COMMAND) return env.AI_HUB_ANTIGRAVITY_COMMAND;
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path');
  const dirs = String(env[key] || '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(env.LOCALAPPDATA || path.join(home(env), 'AppData', 'Local'), 'agy', 'bin'));
  if (process.platform === 'win32') dirs.push('D:/DevTools/AntigravityCLI/bin');
  for (const dir of dirs) {
    const file = path.join(dir.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'agy.exe' : 'agy');
    if (fs.existsSync(file)) return file;
  }
  return process.platform === 'win32' ? 'agy.exe' : 'agy';
}
// Google OAuth refresh and model calls cross the same proxy as the session PTY.
// A Hub started from the desktop shortcut has no proxy env; without this agy
// waits 10 s on the expired-token refresh and then reports "not logged in".
function cliEnv(env = process.env, proxy = require('./hub-config').getConfig().proxy) {
  const out = {...env};
  const value = String(proxy || '').trim();
  if (!value) return out;
  for (const key of Object.keys(out)) if (/^(https?|all|no)_proxy$/i.test(key)) delete out[key];
  Object.assign(out, {HTTP_PROXY:value, HTTPS_PROXY:value, http_proxy:value, https_proxy:value,
    NO_PROXY:'localhost,127.0.0.1', no_proxy:'localhost,127.0.0.1'});
  return out;
}
function isAntigravity(session = {}) {
  return session.geminiProjectHash === ENGINE || /[\\/]antigravity-cli[\\/]brain[\\/]/i.test(session.transcriptPath || session.resumeTranscriptPath || '');
}
function launchArgs(opts = {}) {
  // Never send a legacy Gemini UUID to an unrelated Antigravity conversation.
  if (opts.useResume && opts.geminiChatId && !isAntigravity(opts))
    throw new Error('这是旧 Gemini CLI 历史，可继续查看；请新建 Antigravity 会话，旧会话 ID 不能直接迁移。');
  // Hub runs every agent unattended (Codex/Claude also bypass approvals); a tool
  // review prompt would stall group-chat members that must write answer files.
  const args = ['--dangerously-skip-permissions'];
  const model = opts.model || DEFAULT_MODEL;
  if (!/^[\w.-]+$/.test(model)) throw new Error('Antigravity 模型 ID 无效');
  args.push('--model', model);
  if (opts.effort) {
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(opts.effort)) throw new Error('Antigravity 思考档无效');
    args.push('--effort', opts.effort);
  }
  if (opts.useResume && opts.geminiChatId) {
    if (!UUID.test(opts.geminiChatId)) throw new Error('Antigravity conversation ID 无效');
    args.push('--conversation', opts.geminiChatId);
  } else if (opts.useResume) throw Error('请从历史记录选择具体的 Antigravity 会话；缺少会话 ID，无法安全恢复。');
  return args;
}
// agy asks "Do you trust the contents of this project?" for every new folder,
// and Hub creates a fresh folder per default session, so the TUI would sit on
// that prompt. Same pre-trust as Claude's hasTrustDialogAccepted.
function ensureWorkspaceTrusted(cwd, env = process.env) {
  if (!cwd) return false;
  const file = path.join(configRoot(env), 'settings.json'), target = path.resolve(cwd);
  let settings = {};
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim() || '{}');
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Antigravity settings.json 格式无效');
  if (settings.trustedWorkspaces !== undefined && !Array.isArray(settings.trustedWorkspaces)) throw new Error('Antigravity trustedWorkspaces 不是数组，未改写');
  const list = settings.trustedWorkspaces || [];
  const same = value => process.platform === 'win32' ? String(value).toLowerCase() === target.toLowerCase() : value === target;
  if (list.some(same)) return false;
  settings.trustedWorkspaces = [...list, target];
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return true;
}
// Newest conversation that has at least one user message, by transcript mtime.
function latestConversation(env = process.env) {
  const brain = path.join(configRoot(env), 'brain');
  let best = null;
  let entries = [];
  try { entries = fs.readdirSync(brain, {withFileTypes: true}); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const transcriptPath = path.join(brain, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
    let stat;
    try { stat = fs.statSync(transcriptPath); } catch { continue; }
    if (best && stat.mtimeMs <= best.mtimeMs) continue;
    if (!/"type"\s*:\s*"USER_INPUT"/.test(fs.readFileSync(transcriptPath, 'utf8'))) continue;
    best = {conversationId: entry.name, transcriptPath, mtimeMs: stat.mtimeMs};
  }
  return best;
}
function launchCommand(opts, env) { return ' & ' + [resolveCommand(env), ...launchArgs(opts)].map(quote).join(' ') + '\r\n'; }
function eventsFile(dataDir, id) {
  if (!/^[\w-]+$/.test(id)) throw new Error('Hub session ID 无效');
  return path.join(dataDir, 'antigravity-events', id + '.jsonl');
}
function receiptsFile(id, dataDir = require('./data-dir').getHubDataDir()) {
  if(!UUID.test(id))throw Error('Antigravity conversation ID 无效');
  return path.join(dataDir,'antigravity-events','native-'+id+'.json');
}
function migrateConfiguration(env=process.env) {
  const receipt=path.join(configRoot(env),'ai-hub-migration.json');
  if(fs.existsSync(receipt)&&JSON.parse(fs.readFileSync(receipt,'utf8')).version===1)return;
  const root=path.join(home(env),'.gemini'),legacy=path.join(root,'settings.json');
  const target=path.join(root,'config','mcp_config.json');
  if(fs.existsSync(legacy)){
    const old=JSON.parse(fs.readFileSync(legacy,'utf8').replace(/^\uFEFF/,''));
    const current=fs.existsSync(target)?JSON.parse(fs.readFileSync(target,'utf8').replace(/^\uFEFF/,'').trim()||'{}'):{};
    let changed=false;
    for(const [name,server] of Object.entries(old.mcpServers||{})){
      current.mcpServers ||= {};
      if(Object.hasOwn(current.mcpServers,name))continue;
      const {url,httpUrl,trust,...entry}=server;
      current.mcpServers[name]={...entry,...(httpUrl||url?{serverUrl:httpUrl||url}:{})};changed=true;
    }
    if(changed){
      fs.mkdirSync(path.dirname(target),{recursive:true});
      if(fs.existsSync(target))fs.copyFileSync(target,target+'.before-hub-'+Date.now());
      fs.writeFileSync(target,JSON.stringify(current,null,2)+'\n','utf8');
    }
  }
  const skills=path.join(root,'skills'),newSkills=path.join(configRoot(env),'skills');
  if(fs.existsSync(skills))for(const entry of fs.readdirSync(skills,{withFileTypes:true})){
    const destination=path.join(newSkills,entry.name);
    if(!entry.isDirectory()||entry.isSymbolicLink()||fs.existsSync(destination))continue;
    fs.cpSync(path.join(skills,entry.name),destination,{recursive:true,errorOnExist:true,force:false});
  }
  fs.mkdirSync(path.dirname(receipt),{recursive:true});
  fs.writeFileSync(receipt,JSON.stringify({version:1,completedAt:new Date().toISOString()}),'utf8');
}
function installHooks(env, dataDir, id) {
  migrateConfiguration(env);
  const root = configRoot(env), configFile = path.join(home(env), '.gemini', 'config', 'hooks.json');
  let config = {};
  if (fs.existsSync(configFile)) config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '').trim()||'{}');
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Antigravity hooks.json 格式无效');
  const script = path.join(root, 'ai-hub-hook.cjs');
  fs.mkdirSync(root, {recursive: true});
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'antigravity-hub-hook.cjs'), script);
  const node = process.execPath;
  const prefix = process.versions.electron ? process.platform==='win32' ? 'set "ELECTRON_RUN_AS_NODE=1" && ' : 'ELECTRON_RUN_AS_NODE=1 ' : '';
  // agy's Go cmd /c launcher escapes embedded quotes on Windows. Encoding the
  // PowerShell command preserves paths with spaces and inherited JSON stdin.
  const cmd = event => {
    if (process.platform !== 'win32') return prefix + '"' + node + '" "' + script + '" ' + event;
    const ps = (process.versions.electron ? "$env:ELECTRON_RUN_AS_NODE='1'; " : '') +
      '& ' + [node, script, event].map(quote).join(' ') + '; exit $LASTEXITCODE';
    return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(ps, 'utf16le').toString('base64');
  };
  config['ai-hub-lifecycle'] = {enabled:true,
    PreInvocation:[{type:'command',command:cmd('PreInvocation'),timeout:5}],
    PostInvocation:[{type:'command',command:cmd('PostInvocation'),timeout:5}],
    Stop:[{type:'command',command:cmd('Stop'),timeout:5}]};
  fs.mkdirSync(path.dirname(configFile), {recursive:true});
  const raw = JSON.stringify(config, null, 2) + '\n';
  if (!fs.existsSync(configFile) || fs.readFileSync(configFile, 'utf8') !== raw) {
    if (fs.existsSync(configFile)) fs.copyFileSync(configFile, configFile + '.before-hub-' + Date.now());
    fs.writeFileSync(configFile, raw, 'utf8');
  }
  const file = eventsFile(dataDir, id);
  fs.mkdirSync(path.dirname(file), {recursive:true});
  env.AI_HUB_ANTIGRAVITY_EVENTS_FILE = file;
  env.AI_HUB_ANTIGRAVITY_SESSION_ID = id;
  return {eventsFile:file, configFile};
}
module.exports = {ENGINE, UUID, DEFAULT_MODEL, home, configRoot, resolveCommand, cliEnv, ensureWorkspaceTrusted, latestConversation, isAntigravity, launchArgs, launchCommand, eventsFile, receiptsFile, migrateConfiguration, installHooks};
