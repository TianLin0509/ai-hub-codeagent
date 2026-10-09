'use strict';
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { dataDir, sleep } = require('./store');
class CDP {
  constructor(ws) { this.ws=ws; this.next=0; this.pending=new Map();this.networkErrors=[];
    ws.on('message', bytes => { let m; try { m=JSON.parse(bytes); } catch { this.fail(Error('Invalid CDP message')); return; }
      if(m.method==='Network.responseReceived'&&m.params.response.status>=400){const r=m.params.response;try{const u=new URL(r.url);this.networkErrors.push({site:u.origin,path:u.pathname,status:r.status});this.networkErrors=this.networkErrors.slice(-10);}catch{ /* Non-URL network metadata is not useful. */ }}
      const p=this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); m.error?p.reject(Error(m.error.message)):p.resolve(m.result); });
    ws.on('error', e=>this.fail(e)); ws.on('close',()=>this.fail(Error('Browser disconnected')));
  }
  static async connect(url, port) { const u=new URL(url); if (!['127.0.0.1','localhost'].includes(u.hostname) || Number(u.port)!==port || u.protocol!=='ws:') throw Error('Unsafe CDP endpoint'); const ws=new WebSocket(u.href); const c=new CDP(ws); await new Promise((resolve,reject)=>{ const timer=setTimeout(()=>{ ws.terminate(); reject(Error('CDP connect timeout')); },5000); ws.once('open',()=>{clearTimeout(timer);resolve();}); ws.once('error',e=>{clearTimeout(timer);reject(e);}); }); return c; }
  fail(e) { for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);} this.pending.clear(); }
  call(method,params={}) { return new Promise((resolve,reject)=>{ if(this.ws.readyState!==WebSocket.OPEN)return reject(Error('Browser disconnected')); const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timeout: '+method));},15000); this.pending.set(id,{resolve,reject,timer}); this.ws.send(JSON.stringify({id,method,params})); }); }
  async evaluate(expression) { const r=await this.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true}); if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text); return r.result?.value; }
  close(){this.ws.close();}
}
async function endpoint(profile) {
  let text; try { text=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split('\n'); } catch(e){if(e.code==='ENOENT')return null;throw e;}
  const port=Number(text[0]); if(!Number.isInteger(port)||port<1024||port>65535)return null;
  try { const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1500)}); if(!r.ok)return null; const value=await r.json(); if(new URL(value.webSocketDebuggerUrl).pathname!==text[1]?.trim())throw Error('Profile CDP identity mismatch'); return {port,...value}; }
  catch(e){if(e.message==='Profile CDP identity mismatch')throw e;return null;}
}
// Every website task runs as a tab in the Hub's one Chrome, in the identity that holds the
// login (the main one unless told otherwise). No per-site browser is started any more, and
// closing the task closes only its tab.
async function open(provider, url, options={}) {
  const { HubChrome } = require('../hub-chrome');
  const hub=options.hubChrome||new HubChrome({env:options.env||process.env});
  // Open blank first so Network is enabled before the site's own first requests.
  const {targetId}=await hub.openTab(options.identity||'main','about:blank');
  let page;
  try {
    page=await hub.page(targetId);
    // Off-screen windows may report hidden even though the tab is selected. Keep
    // this owned page rendering and accepting keyboard input without taking focus
    // from the person using the desktop. The override ends with this CDP session.
    await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
    await page.call('Page.enable');await page.call('Network.enable');await page.call('Page.navigate',{url});
    return {page,targetId,owned:false,browserPid:null,headless:false,async close(){page.close();await hub.closeTab(targetId);}};
  } catch(e){page?.close();await hub.closeTab(targetId);throw e;}
}
module.exports={CDP,endpoint,open};
