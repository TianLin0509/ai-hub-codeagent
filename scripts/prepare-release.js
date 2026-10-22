'use strict';
// Run only after tests and packaging have passed in an independent checkout.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFileSync}=require('child_process');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'dist');
const {version}=require('../package.json');
for(const file of ['community-gui/report.json','community-packaged-gui/report.json','official-codex/report.json']) {
  const evidence=JSON.parse(fs.readFileSync(path.join(root,'artifacts',file),'utf8'));
  if(evidence.passed!==true)throw Error('Release verification not passed: '+file);
}
const sha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
for(const name of [`AIHubHuawei-${version}-win-x64.zip`,`AIHubHuawei-Setup-${version}.exe`])if(!fs.existsSync(path.join(dist,name)))throw Error('Missing release asset: '+name);
execFileSync('git',['archive','--format=zip','-o',path.join(dist,`AIHubHuawei-source-${version}.zip`),'HEAD'],{cwd:root});
// The published installer must install this release when run without -Version.
const installer=fs.readFileSync(path.join(root,'scripts/install-release.ps1'),'utf8');
const defaultVersion=(/\[string\]\$Version\s*=\s*'([^']+)'/.exec(installer)||[])[1];
if(defaultVersion!==`v${version}`)throw Error(`install-release.ps1 defaults to ${defaultVersion}, expected v${version}`);
if(process.env.RELEASE_TAG&&process.env.RELEASE_TAG!==`v${version}`)throw Error(`Tag ${process.env.RELEASE_TAG} does not match package version v${version}`);
fs.copyFileSync(path.join(root,'scripts/install-release.ps1'),path.join(dist,'install-release.ps1'));
const names=[`AIHubHuawei-${version}-win-x64.zip`,`AIHubHuawei-Setup-${version}.exe`,`AIHubHuawei-source-${version}.zip`,'install-release.ps1'];
const assets=names.map(name=>({name,bytes:fs.statSync(path.join(dist,name)).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,name))).digest('hex')}));
fs.writeFileSync(path.join(dist,'release-manifest.json'),JSON.stringify({schemaVersion:1,version,sourceSha:sha,platform:'win32-x64',upstream:require('../community-edition.json'),assets,evidence:{ci:true,simulatedCliGui:true,powershellHookRelay:true,realCodexHandshake:true,realProviderLogin:false,realModelReply:false},agentGuide:'docs/AGENT-QUICKSTART.md',customizationGuide:'docs/CUSTOMIZE.md'},null,2));
const manifestHash=crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,'release-manifest.json'))).digest('hex');
// 一键更新（发行目标写了 update 才做）：完整更新包 = app.asar + 非依赖的解包文件；latest.json 描述
// 这次真正打出来的包，GitHub Release 与阿里云放同一份。见 core/app-update。
//
// v3.1.3（2026-10-22）：另外打一个「增量小包」，只装这一版变了的文件，目录里把没变的解包文件记进
// unchanged（只要路径和 sha256），客户端下载前按 requires 核对本机。上一版的文件索引从两个地方取：
// AI_HUB_PREVIOUS_INDEX 指的本机 json（发版脚本用），或发行目标的更新源上已发布的 latest.json。
// 取不到就只发完整更新包（客户端照旧），不影响发版。
const edition=require('../community-edition.json');
const zlib=require('zlib');
const {compareVersions}=require('../core/app-update/manifest');

const validIndex=list=>Array.isArray(list)&&list.length?list.filter(item=>item&&typeof item.path==='string'&&/^[a-f0-9]{64}$/.test(String(item.sha256||''))):null;

// 上一版发布的 latest.json 里直接带 filesIndex（v3.1.3 起）；更早的版本没有，就只取那个更新包开头的目录
// （Range 前 2MB，gzip 部分解压到第一行 JSON），里面就是全部文件的大小和 sha256。
async function indexFromPackage(url){
  try{
    const response=await fetch(url,{headers:{Range:'bytes=0-2097151'},cache:'no-store'});
    if(!response.ok)return null;
    const buf=Buffer.from(await response.arrayBuffer());
    const text=zlib.gunzipSync(buf,{finishFlush:zlib.constants.Z_SYNC_FLUSH}).toString('utf8');
    const nl=text.indexOf('\n');
    if(nl<0||nl>2*1024*1024)return null;
    const header=JSON.parse(text.slice(0,nl));
    if(!header||![1,2].includes(header.schema)||!Array.isArray(header.files)||!header.files.length)return null;
    return validIndex([...header.files,...(Array.isArray(header.unchanged)?header.unchanged:[])]);
  }catch(error){console.warn('读上一版更新包目录失败：'+error.message);return null;}
}

async function previousIndex(){
  const pick=doc=>{
    if(!doc||!/^\d+\.\d+\.\d+$/.test(String(doc.version||''))||compareVersions(doc.version,version)>=0)return null;
    const index=validIndex(doc.filesIndex);
    return index?{version:doc.version,index}:null;
  };
  if(process.env.AI_HUB_PREVIOUS_INDEX){
    try{const hit=pick(JSON.parse(fs.readFileSync(process.env.AI_HUB_PREVIOUS_INDEX,'utf8')));if(hit){console.log(`上一版文件索引来自本机文件（${hit.index.length} 个文件）`);return hit.index;}}catch(error){console.warn('读取上一版索引失败：'+error.message);}
  }
  for(const src of (edition.update.sources||[])){
    if(!src||!src.manifest)continue;
    try{
      const response=await fetch(src.manifest,{cache:'no-store'});
      if(!response.ok)continue;
      const doc=await response.json();
      const hit=pick(doc);
      if(hit){console.log(`上一版文件索引来自 ${src.id||src.manifest} 的 latest.json（${hit.index.length} 个文件）`);return hit.index;}
      // 老版本的 latest.json 没有索引：只读它更新包的目录。
      if(doc&&doc.version&&doc.incremental&&doc.incremental.file&&/^\d+\.\d+\.\d+$/.test(String(doc.version))&&compareVersions(doc.version,version)<0){
        const base=String(src.files||'').replace('{version}',doc.version);
        if(base){
          const index=await indexFromPackage(base+doc.incremental.file);
          if(index){console.log(`上一版文件索引来自 ${src.id||src.manifest} 的更新包目录（${index.length} 个文件）`);return index;}
        }
      }
    }catch(error){console.warn(`从 ${src.id||src.manifest} 取上一版索引失败：${error.message}`);}
  }
  return null;
}

async function main(){
  const extra=[];
  if(edition.update){
    const {packPayload}=require('../core/app-update/payload');
    const {currentRuntime}=require('../core/app-update/manifest');
    const resources=path.join(dist,'win-unpacked','resources');
    const updateName=`AIHubHuawei-${version}-update.gz`;
    const packed=packPayload(resources,path.join(dist,updateName));
    // 小包：和上一版逐字节一致的文件不进包。没有上一版索引、或省不下东西时不发小包。
    const previous=await previousIndex();
    let delta=null,deltaName=`AIHubHuawei-${version}-update-delta.gz`;
    if(previous)delta=packPayload(resources,path.join(dist,deltaName),{previous});
    if(delta&&(!delta.unchanged.length||delta.bytes>=packed.bytes)){try{fs.unlinkSync(path.join(dist,deltaName));}catch(_){}delta=null;}
    const setup=assets.find(a=>a.name===`AIHubHuawei-Setup-${version}.exe`);
    const electronVersion=JSON.parse(fs.readFileSync(path.join(root,'node_modules','electron','package.json'),'utf8')).version;
    const latest={schema:1,product:edition.productName||'AI Hub Community',version,publishedAt:new Date().toISOString(),notes:edition.releaseNotes||[],
      runtime:currentRuntime({resourcesPath:resources,electron:electronVersion}),
      incremental:{file:updateName,bytes:packed.bytes,sha256:packed.sha256},
      ...(delta?{incrementalDelta:{file:deltaName,bytes:delta.bytes,sha256:delta.sha256,
        requires:delta.unchanged.map(item=>({path:item.path,bytes:item.bytes,sha256:item.sha256}))}}:{}),
      // 下一版据此判断哪些文件没变（公司版另存到 latest.json，客户端不用）。
      filesIndex:packed.index,
      installer:{file:setup.name,bytes:setup.bytes,sha256:setup.sha256}};
    fs.writeFileSync(path.join(dist,'latest.json'),JSON.stringify(latest,null,2)+'\n');
    for(const name of [updateName,...(delta?[deltaName]:[]),'latest.json'])extra.push({name,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(dist,name))).digest('hex')});
  }
  fs.writeFileSync(path.join(dist,'SHA256SUMS.txt'),assets.map(a=>a.sha256+'  '+a.name).concat(manifestHash+'  release-manifest.json',...extra.map(a=>a.sha256+'  '+a.name)).join('\n')+'\n');
  console.log(JSON.stringify({version,sha,assets,extra}));
}

main().catch(error=>{console.error(error.message);process.exitCode=1;});
