'use strict';
// Launch contract used to avoid a SECOND Hub copy. This is NOT native request
// evidence and must never be presented as "confirmed injected" in the UI.
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const digest=x=>createHash('sha256').update(x).digest('hex');
const normalize=x=>String(x).replace(/^\uFEFF/,'').replace(/<!--[\s\S]*?-->/g,'').replace(/\r\n?/g,'\n').trim();
function parents(cwd){const dirs=[];for(let p=path.resolve(cwd);;p=path.dirname(p)){dirs.unshift(p);if(path.dirname(p)===p)break;}return dirs;}
function read(file){try{const s=fs.statSync(file);if(!s.isFile()||s.size>32768)return null;const content=fs.readFileSync(file,'utf8');return content.trim()?{path:file,content,digest:digest(content)}:null;}catch{return null;}}
function json(file){try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch(e){if(e.code==='ENOENT')return {};return null;}}
function captureNativeRuleCoverage({kind,cwd,env={},claudeSettingsFile,settingSources}) {
  const dirs=parents(cwd);let chosen=[],rows=[];
  const add=(dir,names,first=false)=>{for(const name of names){const row=read(path.join(dir,name));if(row){rows.push(row);if(first)break;}}};
  if(kind==='codex'||kind==='deepseek'){
    // SessionManager pins these markers on the managed native launch.
    let start=dirs.length-1;
    for(let i=dirs.length-1;i>=0;i--)if(['.git','.vibe-root'].some(n=>fs.existsSync(path.join(dirs[i],n)))){start=i;break;}
    chosen=dirs.slice(start);
    for(const dir of chosen)add(dir,['AGENTS.override.md','AGENTS.md'],true);
    // Codex's cumulative project-document budget includes user instructions.
    const home=env.CODEX_HOME;
    // Custom document budgets/fallback candidates can change which body fits.
    // Leave supplementation conservative when the contract cannot bound them.
    for(const file of [home&&path.join(home,'config.toml'),...dirs.map(d=>path.join(d,'.codex/config.toml'))].filter(Boolean)){
      try{if(/^\s*["']?(?:project_doc_max_bytes|project_doc_fallback_filenames)["']?\s*=/m.test(fs.readFileSync(file,'utf8')))return [];}catch(e){if(e.code!=='ENOENT')return [];}
    }
    const global=home&&(read(path.join(home,'AGENTS.override.md'))||read(path.join(home,'AGENTS.md')));
    if(rows.reduce((n,r)=>n+Buffer.byteLength(r.content)+64,global?Buffer.byteLength(global.content)+64:0)>32768)return [];
  } else if(kind==='claude'){
    const home=env.CLAUDE_CONFIG_DIR||path.join(env.USERPROFILE||env.HOME||'','.claude');
    const configs=[json(path.join(home,'settings.json')),claudeSettingsFile?json(claudeSettingsFile):{},
      ...dirs.flatMap(d=>[json(path.join(d,'.claude/settings.json')),json(path.join(d,'.claude/settings.local.json'))])];
    if(configs.some(c=>!c||c.claudeMdExcludes?.length||c.pluginConfigs?.['agents-md@builtin']?.options?.instructionFiles==='managed-only'))return [];
    if(settingSources&&!settingSources.includes('project'))return [];
    for(const dir of dirs)add(dir,['CLAUDE.md','CLAUDE.local.md','.claude/CLAUDE.md']);
    // AGENTS fallback is deliberately not guessed across CLI/plugin versions.
  } else if(kind==='qwen'||kind==='gemini'){
    const folder=kind==='qwen'?'.qwen':'.gemini';
    const configs=[json(path.join(env.USERPROFILE||env.HOME||'',folder,'settings.json')),...dirs.map(d=>json(path.join(d,folder,'settings.json')))];
    if(configs.some(c=>!c||c.context?.fileName)||env.QWEN_CODE_SAFE_MODE)return [];
    let start=0;
    for(let i=dirs.length-1;i>=0;i--)if(fs.existsSync(path.join(dirs[i],'.git'))){start=i;break;}
    for(const dir of dirs.slice(start))add(dir,kind==='qwen'?['QWEN.md','AGENTS.md']:['GEMINI.md']);
  } else if(kind==='deepseek-acp'||kind==='kimi'){
    let start=dirs.length-1;
    for(let i=dirs.length-1;i>=0;i--)if(fs.existsSync(path.join(dirs[i],'.git'))){start=i;break;}
    for(const dir of dirs.slice(start))add(dir,kind==='kimi'?['AGENTS.md']:['AGENTS.md','CLAUDE.md','AGENTS.local.md','CLAUDE.local.md']);
  } else if(kind==='glm'){
    for(const dir of [...dirs].reverse()){
      const row=read(path.join(dir,'AGENTS.md'));if(row){rows.push(row);break;}
      if(fs.existsSync(path.join(dir,'.git')))break;
    }
  }
  return rows;
}
function stillCovered(content,snapshot=[]){
  const wanted=normalize(content);if(!wanted)return false;
  return snapshot.some(row=>{
    const current=read(row.path);
    if(!current||current.digest!==row.digest)return false;
    const native=normalize(row.content);
    return native===wanted||('\n'+native+'\n').includes('\n'+wanted+'\n');
  });
}
module.exports={captureNativeRuleCoverage,stillCovered,normalize};
