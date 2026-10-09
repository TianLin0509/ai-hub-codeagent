'use strict';
// Additive local sharing. No installed skill is overwritten, moved or deleted.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
function exists(p){try{fs.lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function planSharing(homeDir){
  const roots=['.agents','.claude','.codex'].map(x=>path.join(homeDir,x,'skills'));
  const sources=new Map();
  for(const root of roots){if(!exists(root))continue;for(const e of fs.readdirSync(root,{withFileTypes:true})){
    if(e.name.startsWith('.') || !fs.existsSync(path.join(root,e.name,'SKILL.md')))continue;
    if(!sources.has(e.name))sources.set(e.name,path.join(root,e.name));
  }}
  const operations=[],existing=[];
  for(const [name,source] of sources)for(const root of roots.slice(0,2)){
    const target=path.join(root,name);
    if(exists(target)){
      const f=path.join(target,'SKILL.md');
      const hash=p=>createHash('sha256').update(fs.readFileSync(p,'utf8').replace(/\r\n/g,'\n')).digest('hex');
      existing.push({name,target,source,disposition:fs.existsSync(f)&&hash(f)===hash(path.join(source,'SKILL.md'))?'existing-same-body':'existing-preserved'});continue;
    }
    operations.push({name,source:fs.realpathSync.native(source),target});
  }
  return {homeDir,generatedAt:new Date().toISOString(),operations,existing,
    consumers:{'.agents/skills':['Codex','Kimi Code','Gemini','DeepSeek Codex runtime'],'.claude/skills':['Claude']},
    boundary:'Only ordinary user skills; archived/system/plugin-cache/Cat Cafe-only skills excluded. Client-specific tool dependencies are not installed by this operation. Existing variants preserved.'};
}
async function createLink(source,target){
  for(let attempt=0;;attempt++){
    try{await fs.promises.symlink(source,target,'junction');return attempt;}
    catch(e){
      if(!['EBUSY','EPERM'].includes(e.code)||attempt>=5||exists(target))throw e;
      await new Promise(resolve=>setTimeout(resolve,Math.min(1600,200*2**attempt)));
    }
  }
}
async function applySharing(plan,manifest){
  const report={...plan,created:[],errors:[],retries:[]};
  fs.mkdirSync(path.dirname(manifest),{recursive:true});
  const save=()=>fs.writeFileSync(manifest,JSON.stringify(report,null,2)+'\n','utf8');save();
  for(const op of plan.operations){
    try{
      if(exists(op.target))throw Error('目标已经存在，未覆盖');
      if(!fs.existsSync(path.join(op.source,'SKILL.md')))throw Error('技能来源已失效');
      fs.mkdirSync(path.dirname(op.target),{recursive:true});
      const retries=await createLink(op.source,op.target);
      if(retries)report.retries.push({name:op.name,count:retries});
      report.created.push(op);save();
      if(fs.realpathSync.native(op.target).toLowerCase()!==fs.realpathSync.native(op.source).toLowerCase())throw Error('链接目标核对失败');
    }catch(e){report.errors.push({...op,error:e.message});save();break;}
  }
  save();return report;
}
if(require.main===module){
  const args=process.argv.slice(2),homeAt=args.indexOf('--home'),outAt=args.indexOf('--out');
  const home=homeAt>=0?path.resolve(args[homeAt+1]):os.homedir();
  const out=outAt>=0?path.resolve(args[outAt+1]):path.resolve('artifacts/capability-center/skill-sharing-'+Date.now()+'.json');
  const plan=planSharing(home);
  if(args.includes('--apply')){
    applySharing(plan,out).then(result=>{console.log(JSON.stringify({created:result.created.length,preserved:result.existing.length,errors:result.errors,retries:result.retries,manifest:out}));
      if(result.errors.length)process.exitCode=1;
    }).catch(error=>{console.error(error);process.exitCode=1;});
  }else{
    fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(plan,null,2)+'\n','utf8');
    console.log(JSON.stringify({planned:plan.operations.length,preserved:plan.existing.length,manifest:out}));
  }
}
module.exports={planSharing,applySharing};
