'use strict';
const {preview}=require('./acp-tool-preview');
const cached=new WeakMap();
const sourceOutput=tool=>tool.output ?? (tool.input?.changes ? {changes:tool.input.changes} : null);

// Keep full native items at the writer. Collapsed cards need labels and a small
// preview, not megabytes of the same output inside both input and output.
function compactCodexTools(cards,{hubSessionId,threadId}={}) {
  return cards.map(card=>!card.toolCalls?.length ? card : {...card,toolCalls:card.toolCalls.map(tool=>{
    if(tool.resultRef?.source==='codex-app-server')return {...tool,resultRef:{...tool.resultRef,hubSessionId}};
    const item=tool.input && typeof tool.input==='object' ? tool.input : null;
    let compact=item && cached.get(item);
    if(!compact || compact.originalOutput!==tool.output) {
      const input={};
      for(const key of ['id','type','command','cwd','path','file_path','pattern','query','url','title']) {
        if(typeof item?.[key]==='string')input[key]=item[key].slice(0,512);
      }
      if(Array.isArray(item?.changes))input.changes=item.changes.map(change=>({path:change.path,kind:change.kind}));
      if(Array.isArray(item?.locations))input.locations=item.locations.map(location=>({path:location.path,line:location.line}));
      const output=sourceOutput(tool);
      const running = ['running','inProgress'].includes(item?.status);
      const text = running && item?.type === 'commandExecution' && typeof output === 'string'
        ? output.slice(-2048) : output==null ? '' : preview(output).text;
      compact={input,output:text,originalOutput:tool.output,hasOutput:output!=null};
      if(item)cached.set(item,compact);
    }
    return {...tool,input:compact.input,output:compact.output,resultTruncated:compact.hasOutput,
      resultRef:{source:'codex-app-server',hubSessionId,threadId,turnId:card.providerTurnId,itemId:tool.id}};
  })});
}
function toolResult(cards,reference,threadId) {
  if(reference.threadId!==threadId)throw Error('工具详情不属于当前 Codex 会话');
  const tool=cards.find(card=>card.providerTurnId===reference.turnId)?.toolCalls?.find(tool=>tool.id===reference.itemId);
  if(!tool || tool.resultRef)throw Error('未找到完整 Codex 工具来源，请重新载入会话');
  const value=sourceOutput(tool);
  return typeof value==='string'?value:JSON.stringify(value??'',null,2);
}
module.exports={compactCodexTools,toolResult};
