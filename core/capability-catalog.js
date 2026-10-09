'use strict';
// Filesystem inventory, never a claim that a running agent has loaded an item.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { ALL_AI_KINDS, getKindLabel } = require('./ai-kinds');
const {presentation}=require('./capability-presentation');
const {notePath}=require('./capability-notes');

// A deliberately narrow TOML projection: table names and enabled only. No secrets,
// commands or environment values cross the inventory IPC boundary.
function tomlFlags(text) {
  const out = { mcp: [], plugins: [] };
  let current;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) {
      current = null;
      const m = table[1].match(/^(mcp_servers|plugins)\.(?:"((?:\\.|[^"\\])+)"|'([^']+)'|([\w-]+))$/);
      if (m) {
        const name = m[2] ? JSON.parse('"' + m[2] + '"') : m[3] || m[4];
        current = { name, enabled: true };
        out[m[1] === 'plugins' ? 'plugins' : 'mcp'].push(current);
      }
    } else if (current) {
      const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*(?:#.*)?$/);
      if (enabled) current.enabled = enabled[1] === 'true';
    }
  }
  return out;
}

function collectCapabilities({ homeDir, dataDir, projects = [] }) {
  const rows = new Map(), warnings = [], scanned = new Set();
  const warn = (file, e) => { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) warnings.push(`${file}：${e.message}`); };
  const text = file => { try { if (fs.statSync(file).size > 2 * 1024 * 1024) throw Error('文件超过 2 MB，未读取'); return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch (e) { warn(file, e); return null; } };
  const json = file => { const s = text(file); if (s === null) return {}; try { const d=JSON.parse(s); if(!d || typeof d!=='object' || Array.isArray(d))throw Error(); return d; } catch { warnings.push(`${file}：JSON 格式无效，未读取内容`); return {}; } };
  const entries = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('.')); } catch (e) { warn(dir, e); return []; } };
  const real = p => { try { return fs.realpathSync.native(p); } catch (e) { warn(p, e); return p; } };
  function add(type, name, description, source) {
    if (typeof name !== 'string' || !name.trim()) return;
    name = name.slice(0, 250);
    const id = `${type}:${name}`;
    const row = rows.get(id) || { id, type, name, description: String(description || '').slice(0, 2000), sources: [] };
    if ((!row.description || /^(Codex|Claude) 插件$/.test(row.description)) && description) row.description = String(description).slice(0, 2000);
    if (!row.sources.some(s => s.path === source.path && s.agent === source.agent && s.scope === source.scope)) row.sources.push(source);
    rows.set(id, row);
  }
  function scanSkills(root, agents, scope, extra = {}) {
    const key = `${root}:${agents.join(',')}:${scope}:${extra.plugin || ''}`;
    if (scanned.has(key)) return;
    scanned.add(key);
    for (const entry of entries(root)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const dir = path.join(root, entry.name), file = path.join(dir, 'SKILL.md');
      const s = text(file);
      if (s === null) continue;
      const front = s.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
      if (!front) { warnings.push(`${file}：缺少技能元数据`); continue; }
      const field = name => {
        const m = front[1].match(new RegExp('^' + name + ':\\s*([^\\r\\n]*)(?:\\r?\\n((?:[ \\t]+[^\\r\\n]*\\r?\\n?)*))?', 'm'));
        if (!m) return '';
        return (/^[>|][+-]?$/.test(m[1]) ? m[2] || '' : m[1]).trim().replace(/^(['"])([\s\S]*)\1$/, '$2').replace(/\s+/g, ' ');
      };
      const name = field('name') || entry.name;
      for (const agent of agents) add('skill', name, field('description'), {agent,scope,path:file,realPath:real(file), enabled:true,...extra,
        declaredOrigin:['self','external'].includes(field('origin'))?field('origin'):undefined,
        hash:createHash('sha256').update(s.replace(/\r\n/g,'\n')).digest('hex')});
    }
  }
  function mcpEntries(d, file, agent, scope, extra = {}) {
    const servers=d?.mcpServers || d;
    if(!servers || typeof servers!=='object' || Array.isArray(servers))return;
    for (const [name, c] of Object.entries(servers)) {
      if(!c || typeof c!=='object' || Array.isArray(c)){warnings.push(`${file}：MCP 条目格式无效`);continue;}
      add('mcp',name,typeof c.description==='string'?c.description:'标准 MCP 服务器',{agent,scope,path:file,...extra,enabled:extra.enabled!==false && c.enabled!==false && c.disabled!==true,
        transport:['stdio','http','sse','streamable-http'].includes(c.type)?c.type:(c.url ? 'HTTP' : 'stdio')});
    }
  }
  function jsonMcp(file, agent, scope, extra = {}, bare = false) {
    const d = json(file);
    mcpEntries(bare ? d : {mcpServers:d.mcpServers || {}},file,agent,scope,extra);
    return d;
  }
  function pluginContents(root, name, agent, enabled) {
    const file=path.join(root,agent==='claude'?'.claude-plugin':'.codex-plugin','plugin.json');
    const manifest=json(file), extra={plugin:name,enabled};
    const inside=p=>{const rel=path.relative(real(root),real(p));return !rel.startsWith('..')&&!path.isAbsolute(rel);};
    const locations=(v,fallback)=>[...new Set([...(fallback?[fallback]:[]),...(Array.isArray(v)?v:typeof v==='string'?[v]:[])])]
      .filter(p=>{if(typeof p!=='string'||!inside(path.resolve(root,p))){warnings.push(`${file}：未盘点插件目录之外的组件`);return false;}return true;})
      .map(p=>path.resolve(root,p));
    for(const dir of locations(manifest.skills,'skills'))scanSkills(dir,[agent],'plugin',extra);
    for(const config of locations(manifest.mcpServers,'.mcp.json'))jsonMcp(config,agent,'plugin',extra,true);
    if(manifest.mcpServers && typeof manifest.mcpServers==='object' && !Array.isArray(manifest.mcpServers))
      mcpEntries(manifest.mcpServers,file,agent,'plugin',extra);
    if(manifest.apps)warnings.push(`${file}：包含账号连接器声明；账号授权与可调用状态请在原生客户端核对。`);
    if(manifest.hooks || manifest.agents || fs.existsSync(path.join(root,'hooks')) || fs.existsSync(path.join(root,'agents')))
      warnings.push(`${file}：含 hooks / 子代理等扩展，本页仅盘点 Skill 与 MCP 组件。`);
    return manifest;
  }
  function codexConfig(dir, agent, scope) {
    const file = path.join(dir,'config.toml'), raw = text(file);
    let flags = {mcp:[],plugins:[]};
    if (raw !== null) {
      try { flags = tomlFlags(raw); } catch (e) {warn(file,e);}
      if (/^\s*(?:mcp_servers|plugins)\s*=|^\s*\[(?:mcp_servers|plugins)\]\s*$/m.test(raw))
        warnings.push(`${file}：含根表或内联能力声明；静态目录只解析独立命名表，完整状态请查看当前原生回执。`);
      // Only project-independent local disable flags are applied to the user catalog.
      // Other configuration layers remain separate evidence, not effective overrides.
      if(raw.includes('[[skills.config]]')) {
        if(scope!=='user')warnings.push(`${file}：含范围专用技能开关，请在当前会话核对最终生效状态。`);
        else for(const block of raw.split(/^\s*\[\[skills\.config\]\]\s*$/m).slice(1)) {
          const fields=block.split(/^\s*\[/m)[0];
          const match=fields.match(/^\s*path\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*(?:#.*)?$/m);
          if(!match || !/^\s*enabled\s*=\s*false\s*(?:#.*)?$/m.test(fields))continue;
          let skillPath;
          try{skillPath=match[1][0]==='"'?JSON.parse(match[1]):match[1].slice(1,-1);}catch{warnings.push(`${file}：技能开关路径格式无法解析`);continue;}
          if(!path.isAbsolute(skillPath)){warnings.push(`${file}：技能开关使用相对路径，请核对原生状态。`);continue;}
          for(const row of rows.values())if(row.type==='skill')for(const source of row.sources)
            if(source.agent===agent && path.resolve(source.path).toLowerCase()===path.resolve(skillPath).toLowerCase())source.enabled=false;
        }
      }
    }
    for (const c of flags.mcp) add('mcp',c.name,'标准 MCP 服务器',{agent,scope,path:file,enabled:c.enabled});
    for (const c of flags.plugins) add('plugin',c.name,'Codex 插件',{agent,scope,path:file,enabled:c.enabled});
    const active = new Map(flags.plugins.map(p=>[p.name,p.enabled]));
    const cache = path.join(dir,'plugins','cache');
    for (const market of entries(cache)) for (const plugin of entries(path.join(cache,market.name))) {
      const name = `${plugin.name}@${market.name}`;
      if (!active.has(name)) continue; // A cached download alone is not installed evidence.
      const base = path.join(cache,market.name,plugin.name);
      const versions = entries(base).filter(e=>e.isDirectory()).sort((a,b)=>b.name.localeCompare(a.name,undefined,{numeric:true}));
      if (!versions.length) continue;
      if (versions.length > 1) warnings.push(`${base}：存在多个缓存版本；目录展示最新命名候选，实际启用版本需由原生连接确认。`);
      const root = path.join(base,versions[0].name);
      const enabled = active.get(name);
      const manifest = pluginContents(root,name,agent,enabled);
      add('plugin',name,manifest.description,{agent,scope,path:root,enabled,version:versions[0].name});
    }
  }
  const home = (...parts) => path.join(homeDir,...parts);
  const sharedAgents = ['codex','kimi','gemini','deepseek'];
  scanSkills(home('.agents','skills'),sharedAgents,'shared');
  scanSkills(home('.codex','skills'),['codex'],'user');
  scanSkills(home('.codex','skills','.system'),['codex'],'system');
  scanSkills(home('.claude','skills'),['claude'],'user');
  scanSkills(home('.kimi-code','skills'),['kimi'],'user');
  scanSkills(home('.gemini','skills'),['gemini'],'user');
  scanSkills(home('.qwen','skills'),['qwen'],'user');
  codexConfig(home('.codex'),'codex','user');
  codexConfig(path.join(dataDir,'deepseek-codex-profile'),'deepseek','profile');
  const claude = jsonMcp(home('.claude.json'),'claude','user');
  jsonMcp(home('.kimi-code','mcp.json'),'kimi','user');
  jsonMcp(home('.gemini','settings.json'),'gemini','user');
  jsonMcp(home('.qwen','settings.json'),'qwen','user');
  // Skill-invoked MCPs are real dependencies too, even when no native CLI loads them.
  jsonMcp(home('.mcporter','mcporter.json'),'external','user');
  const enabled = json(home('.claude','settings.json')).enabledPlugins || {};
  const installed = json(home('.claude','plugins','installed_plugins.json')).plugins || {};
  for (const name of new Set([...Object.keys(enabled),...Object.keys(installed)])) {
    const installs = Array.isArray(installed[name]) ? installed[name] : [];
    const entry = installs.find(s=>s.scope==='user');
    add('plugin',name,'Claude 插件',{agent:'claude',scope:'user',path:entry?.installPath || home('.claude','settings.json'),enabled:enabled[name] === true,
      missing:!entry?.installPath || !fs.existsSync(entry.installPath),version:entry?.version || null});
    if (typeof entry?.installPath==='string' && fs.existsSync(entry.installPath)) {
      const manifest=pluginContents(entry.installPath,name,'claude',enabled[name]===true);
      add('plugin',name,manifest.description,{agent:'claude',scope:'user',path:entry.installPath,enabled:enabled[name]===true,version:entry.version});
    }
  }
  // Scope discovery to open sessions supplied by Main, never crawl the home/workspace.
  for (const project of projects) {
    const {cwd,kind,profileHome} = project;
    if (!cwd || !ALL_AI_KINDS.includes(kind)) continue;
    const scope = `project:${cwd}`;
    const own = {claude:'.claude',codex:'.agents',deepseek:'.agents',kimi:'.kimi-code',gemini:'.gemini',qwen:'.qwen'}[kind];
    if (own) scanSkills(path.join(cwd,own,'skills'),[kind],scope);
    if (sharedAgents.includes(kind)) scanSkills(path.join(cwd,'.agents','skills'),[kind],scope);
    if (kind==='claude') {
      jsonMcp(path.join(cwd,'.mcp.json'),kind,scope);
      const p = Object.entries(claude.projects || {}).find(([p])=>path.resolve(p).toLowerCase()===path.resolve(cwd).toLowerCase())?.[1];
      for (const [name,c] of Object.entries(p?.mcpServers || {})) add('mcp',name,'项目 MCP 服务器',{agent:kind,scope,path:home('.claude.json'),enabled:c.disabled!==true});
    } else if (kind==='kimi') jsonMcp(path.join(cwd,'.kimi-code','mcp.json'),kind,scope);
    else if (kind==='gemini' || kind==='qwen') jsonMcp(path.join(cwd,own,'settings.json'),kind,scope);
    if (kind==='codex' || kind==='deepseek') {
      codexConfig(path.join(cwd,'.codex'),kind,scope);
      if (profileHome && path.resolve(profileHome)!==home('.codex')) {
        codexConfig(profileHome,kind,`profile:${profileHome}`);
        scanSkills(path.join(profileHome,'skills'),[kind],`profile:${profileHome}`);
      }
    }
  }
  const allRows = [...rows.values()];
  const decorated=allRows.map(r=>presentation({...r,
    accountDependency: require('./tool-account-catalog').dependencyFor(r, allRows),
    shared:r.sources.some(s=>s.scope==='shared'), conflict:r.type==='skill' && new Set(r.sources.map(s=>s.hash).filter(Boolean)).size>1,
    agents:[...new Set(r.sources.map(s=>s.agent))]},json(notePath(dataDir,r.id))));
  return {generatedAt:Date.now(),warnings:[...new Set(warnings)],agents:ALL_AI_KINDS.map(id=>({id,label:getKindLabel(id)})),rows:decorated.sort((a,b)=>a.name.localeCompare(b.name))};
}
if (!isMainThread) {
  try { parentPort.postMessage({ok:true,data:collectCapabilities(workerData)}); }
  catch(error) { parentPort.postMessage({ok:false,error:error.message}); }
}
module.exports = { collectCapabilities, tomlFlags };
