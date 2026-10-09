'use strict';

// Stop traversing when the preview is full. JSON.stringify(...).slice(...) still
// serializes megabytes of hidden tool output on every text update.
function preview(value, limit = 2048) {
  let text = '', truncated = false;
  function append(part) {
    const remaining = limit-text.length;
    if (part.length>remaining) truncated = true;
    text += part.slice(0, Math.max(0,remaining));
  }
  function visit(value, depth = 0) {
    if(text.length>=limit || depth>12){truncated=true;return;}
    if(typeof value==='string'){append(value);return;}
    if(value==null || typeof value!=='object'){append(String(value));return;}
    const array=Array.isArray(value);append(array?'[':'{');
    let first=true;
    for(const key of Object.keys(value)) {
      if(text.length>=limit){truncated=true;break;}
      if(!first)append(', ');first=false;
      if(!array)append(key+': ');
      visit(value[key],depth+1);
    }
    append(array?']':'}');
  }
  visit(value);
  return {text,truncated};
}
const cache = new WeakMap();
function toolPreview(tool, {hubSessionId,threadId,turnId}) {
  const item = tool.input;
  let compact=cache.get(item);
  if(!compact) {
    const output=item.result ?? item.content ?? item.error;
    const result=output==null?{text:'',truncated:false}:preview(output);
    // Preserve the normal activity summary and changed-file identity, without
    // putting rawOutput / repeated content copies into renderer snapshots.
    const input={id:item.id,type:item.type,title:item.title,kind:item.kind,locations:item.locations};
    for(const key of ['file_path','path','command','pattern','query','url','target_path','destination','new_path']) {
      const value=item.rawInput?.[key] ?? item[key];
      if(typeof value==='string')input[key]=value.slice(0,512);
    }
    compact={input,output:result.text,resultTruncated:output!=null,
      resultPreviewTruncated:result.truncated};
    cache.set(item,compact);
  }
  return {...tool,...compact,resultRef:{hubSessionId,threadId,turnId,itemId:item.id}};
}
module.exports = { preview, toolPreview };
