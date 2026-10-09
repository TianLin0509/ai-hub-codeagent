'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');
function notePath(dataDir,id){return path.join(dataDir,'capability-notes',createHash('sha256').update(id).digest('hex')+'.json');}
function validateNote(input){
  if(!input||typeof input.id!=='string'||input.id.length>270||! /^(skill|mcp|plugin):.+$/.test(input.id))throw Error('无效的能力条目');
  if(typeof input.summary!=='string'||input.summary.length>180)throw Error('简述最多 180 个字符');
  if(!['auto','self','external','unknown'].includes(input.origin))throw Error('无效的来源类别');
  return {summary:input.summary.trim(),origin:input.origin==='auto'?undefined:input.origin};
}
async function saveNote(dataDir,id,note){
  const file=notePath(dataDir,id),tmp=file+'.'+randomUUID()+'.tmp';
  await fs.promises.mkdir(path.dirname(file),{recursive:true});
  try{
    await fs.promises.writeFile(tmp,JSON.stringify(note,null,2)+'\n','utf8');
    for(let attempt=0;;attempt++){
      try{await fs.promises.rename(tmp,file);break;}
      catch(e){if(!['EBUSY','EPERM','EACCES'].includes(e.code)||attempt>=4)throw e;await new Promise(r=>setTimeout(r,100*(attempt+1)));}
    }
  }catch(e){try{await fs.promises.unlink(tmp);}catch(cleanup){if(cleanup.code!=='ENOENT')e.message+='；临时文件清理失败：'+cleanup.code;}throw e;}
}
module.exports={notePath,validateNote,saveNote};
