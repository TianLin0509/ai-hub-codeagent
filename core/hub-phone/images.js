'use strict';
const fs=require('node:fs'),path=require('node:path');
function answerImages(text,{roots=[]}={}){
 const files=[];
 for(const m of String(text).matchAll(/!?\[([^\]]*)\]\(([^)]+\.(?:png|jpe?g))(?:\s+"[^"]*")?\)/gi)){
  const candidate=m[2].replace(/^<|>$/g,'');if(!path.isAbsolute(candidate)||!fs.existsSync(candidate))continue;
  const real=fs.realpathSync(candidate);if(!roots.some(root=>{try{const base=fs.realpathSync(root),rel=path.relative(base,real);return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);}catch{return false;}}))continue;
  if(files.some(r=>r.file===real)||fs.statSync(real).size>4*1024*1024)continue;
  const data=fs.readFileSync(real);if(!data.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&!data.subarray(0,3).equals(Buffer.from('ffd8ff','hex')))continue;
  files.push({file:real,data,caption:m[1]||path.basename(real)});
 }
 return files;
}
module.exports={answerImages};
