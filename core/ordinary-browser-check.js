'use strict';
const sharedSites=new Set(['chatgpt','deepseek','kimi','qwen']);
async function check(chrome,identity,site,signal,{transport=require('./ordinary-browser-client'),wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  const binding=transport.options({identity},chrome.env),url=require('./hub-chrome').SITES[site].url;
  const lane='account-check-'+identity+'-'+site;
  await transport.call(binding,lane,['human-done',url]);
  try{
    await transport.call(binding,lane,['open']);await transport.call(binding,lane,['goto',url]);
    for(let n=0;n<30;n++){
      if(signal?.aborted)throw Error('检查已取消');
      const r=await transport.call(binding,lane,['evaluate',require('./account-browser').PROBE]);
      if(r?.host===new URL(url).hostname){
        if(r.login)return {state:'signed_out',source:'ordinary-chrome-extension'};
        if(r.profile&&!r.challenge)return {state:'signed_in',source:'ordinary-chrome-extension'};
      }
      await wait(500);
    }
    return {state:'unknown',reason:'unrecognized_page',source:'ordinary-chrome-extension'};
  }finally{await transport.call(binding,lane,['close']);}
}
module.exports={sharedSites,check};
