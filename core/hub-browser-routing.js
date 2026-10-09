'use strict';
// The subscription sites use the Hub's proxy. Domestic AI endpoints and their
// static/auth resources bypass it, as domestic CLI sessions do. Match domain
// boundaries: deepseek.com.evil.example must never inherit a direct route.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const DIRECT_DOMAINS=Object.freeze([
  'deepseek.com','kimi.com','kimi.ai','moonshot.cn','moonshot.ai',
  'qianwen.com','tongyi.com','aliyun.com','aliyuncs.com','alicdn.com','alipay.com','mmstat.com',
  'doubao.com','bytedance.com','byteimg.com','ibyteimg.com','bytecdn.cn','volccdn.com','volces.com','pstatp.com','snssdk.com',
  'geetest.com','geevisit.com','ishumei.com','cn-fp.apitd.net',
  // Observed subresources of the four domestic AI pages (2026-10-01).
  'qq.com','fengkongcloud.cn','portal101.cn','trustdecision.com','effirst.com',
  'taobao.com','alibaba.com','aliapp.org','ibytedapm.com','bytetcc.com','99uri.com','bytednsdoc.com','zijieapi.com','yhgfb-cn-static.com',
]);
const LOCAL_BYPASS=['<local>','localhost','127.0.0.1','[::1]','10.0.0.0/8','172.16.0.0/12','192.168.0.0/16'];
function normalizeProxy(value){
  const raw=String(value||'').trim();if(!raw)return '';
  let u;try{u=new URL(raw);}catch{}
  if(!u||!['http:','https:','socks4:','socks5:'].includes(u.protocol)||!u.hostname||u.username||u.password||u.search||u.hash||(u.pathname&&u.pathname!=='/'))
    throw Error('Hub 代理地址无效：专属 Chrome 需要无账号密码的 HTTP/HTTPS/SOCKS 代理地址，请检查 Hub 代理设置');
  return u.protocol+'//'+u.host;
}
function policy(value){
  const proxy=normalizeProxy(value),bypass=[...LOCAL_BYPASS,...DIRECT_DOMAINS.flatMap(d=>[d,'*.'+d])].join(';');
  const args=proxy?['--proxy-server='+proxy,'--proxy-bypass-list='+bypass]:['--no-proxy-server'];
  return {proxy,bypass,args,fingerprint:crypto.createHash('sha256').update(JSON.stringify(args)).digest('hex')};
}
function route(url,proxy){const h=new URL(url).hostname.toLowerCase();return !proxy||DIRECT_DOMAINS.some(d=>h===d||h.endsWith('.'+d))?'direct':'hub_proxy';}
const file=root=>path.join(root,'browser-routing.json');
function read(root){try{return JSON.parse(fs.readFileSync(file(root),'utf8'));}catch{return null;}}
function record(root,plan,pid){fs.mkdirSync(root,{recursive:true});const dest=file(root),tmp=dest+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify({version:1,pid,proxy:plan.proxy,fingerprint:plan.fingerprint,startedAt:Date.now()}));fs.renameSync(tmp,dest);}
function status(root,plan,held){
  const saved=read(root);let live=false;
  if(saved?.pid)try{process.kill(saved.pid,0);live=true;}catch{}
  const state=!held?'next_launch':!live?'restart_required':saved.fingerprint===plan.fingerprint?'applied':'restart_required';
  return {state,proxy:plan.proxy,domestic:'direct',foreign:plan.proxy?'hub_proxy':'direct',message:state==='restart_required'?'专属 Chrome 仍在使用旧网络设置；请先保存并关闭其中的网站标签页，再打开账号网页，登录记录会保留。':plan.proxy?'国外 AI 使用 Hub 代理，国内 AI 直连':'Hub 未配置代理，专属 Chrome 全部直连'};
}
function assertCurrent(root,plan,held){const s=status(root,plan,held);if(s.state==='restart_required')throw Object.assign(Error(s.message),{code:'HUB_BROWSER_ROUTE_CHANGED'});}
module.exports={DIRECT_DOMAINS,normalizeProxy,policy,route,read,record,status,assertCurrent};
