'use strict';
// Content is lossless. Coalesce snapshots BEFORE encode(), so a slow reader
// never receives a delta whose base was discarded by transport backpressure.
function assignOwn(target,key,value){Object.defineProperty(target,key,{value,enumerable:true,writable:true,configurable:true});}
function clone(value){
  if(Array.isArray(value))return value.map(clone);
  if(value && typeof value==='object'){
    const copy={};for(const key of Object.keys(value))assignOwn(copy,key,clone(value[key]));return copy;
  }
  return value;
}
function changes(previous,next,path=[],out=[]){
  if(Object.is(previous,next))return out;
  if(typeof previous==='string' && typeof next==='string' && next.startsWith(previous)){
    out.push({op:'append',path,value:next.slice(previous.length)});return out;
  }
  if(Array.isArray(previous) && Array.isArray(next)){
    const common=Math.min(previous.length,next.length);
    for(let i=0;i<common;i++)changes(previous[i],next[i],path.concat(i),out);
    if(previous.length!==next.length)out.push({op:'splice',path,start:common,remove:previous.length-common,values:clone(next.slice(common))});
    return out;
  }
  if(previous && next && typeof previous==='object' && typeof next==='object'
    && !Array.isArray(previous) && !Array.isArray(next)){
    for(const key of Object.keys(previous))if(!Object.hasOwn(next,key))out.push({op:'delete',path:path.concat(key)});
    for(const key of Object.keys(next)){
      if(!Object.hasOwn(previous,key))out.push({op:'set',path:path.concat(key),value:clone(next[key])});
      else changes(previous[key],next[key],path.concat(key),out);
    }
    return out;
  }
  out.push({op:'set',path,value:clone(next)});return out;
}
function apply(previous,patches){
  let result=clone(previous);
  for(const patch of patches){
    if(!Array.isArray(patch.path))throw Error('Invalid shared content patch path');
    let parent=null,key=null,target=result;
    for(const part of patch.path){
      if(typeof part!=='string' && (!Number.isSafeInteger(part)||part<0))throw Error('Invalid shared content path key');
      parent=target;key=part;
      if(!parent || typeof parent!=='object')throw Error('Shared content patch target is missing');
      target=Object.hasOwn(parent,part)?parent[part]:undefined;
    }
    const set=value=>{if(parent)assignOwn(parent,key,value);else result=value;};
    if(patch.op==='set')set(clone(patch.value));
    else if(patch.op==='delete'){
      if(!parent)throw Error('Cannot delete shared content root');delete parent[key];
    }else if(patch.op==='append'){
      if(typeof target!=='string' || typeof patch.value!=='string')throw Error('Invalid shared text append');
      set(target+patch.value);
    }else if(patch.op==='splice'){
      if(!Array.isArray(target)||!Number.isInteger(patch.start)||patch.start<0||patch.start>target.length
        ||!Number.isInteger(patch.remove)||patch.remove<0||patch.start+patch.remove>target.length||!Array.isArray(patch.values))throw Error('Invalid shared content array splice');
      // Avoid spreading a long transcript into the JS call argument limit.
      set(target.slice(0,patch.start).concat(clone(patch.values),target.slice(patch.start+patch.remove)));
    }else throw Error('Unknown shared content patch operation');
  }
  return result;
}
class SharedContentEncoder{
  constructor(){this.entries=new Map();}
  reset(key){this.entries.delete(key);}
  encode(key,value){
    const previous=this.entries.get(key),snapshot=clone(value),sequence=(previous?.sequence||0)+1;
    const encoded=previous?{sequence,base:previous.sequence,patches:changes(previous.value,snapshot)}:{sequence,base:null,snapshot};
    this.entries.set(key,{sequence,value:snapshot});return encoded;
  }
}
class SharedContentDecoder{
  constructor(){this.entries=new Map();}
  reset(key){this.entries.delete(key);}
  decode(key,message){
    if(!Number.isSafeInteger(message?.sequence)||message.sequence<1)throw Error('Invalid shared content sequence');
    const previous=this.entries.get(key);
    if(message.base!==null && (!previous || previous.sequence!==message.base || message.sequence!==message.base+1))throw Error('Shared content sequence gap');
    const value=message.base===null?clone(message.snapshot):apply(previous.value,message.patches);
    if(!value || typeof value!=='object')throw Error('Invalid shared content snapshot');
    this.entries.set(key,{sequence:message.sequence,value});return clone(value);
  }
}
module.exports={SharedContentEncoder,SharedContentDecoder,clone,changes,apply};
