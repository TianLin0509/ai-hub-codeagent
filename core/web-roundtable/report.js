'use strict';
const fs=require('fs'),path=require('path'),store=require('./store');
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label=state=>({succeeded:'已完成',partial:'部分完成',failed:'失败',needs_attention:'待处理',cancelled:'已取消',interrupted:'已中断',running:'进行中',queued:'排队中',skipped:'未参与'}[state]||state);
const providerName=id=>require('./providers').providers[id]?.name||id;
function render(job){
  const response=item=>`<article><h3>${escape(providerName(item.provider))} · ${escape(label(item.state))}</h3>${require('./providers').validUrl(item.provider,item.url)?`<p><a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">查看官方原会话</a></p>`:''}<pre>${escape(item.answer||item.error||'等待结果')}</pre><details><summary>本轮发送内容与回执</summary><pre>${escape(item.input?.prompt||'')}</pre><p>${escape(item.completionEvidence||'尚无完成证据')}</p><small>${escape(item.id)}</small></details></article>`;
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>AI 网页圆桌 · ${escape(job.id)}</title><style>body{font:16px/1.7 system-ui,'Microsoft YaHei',sans-serif;background:#f5f4f0;color:#242c35;margin:0}main{max-width:1180px;margin:40px auto;padding:0 24px}h1{font-size:30px}h2{margin-top:36px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:16px}article,.summary{background:white;border:1px solid #dddcd6;border-radius:14px;padding:20px;min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}small{overflow-wrap:anywhere;color:#65727c}a{color:#256d70}details{border-top:1px solid #eee;padding-top:12px}summary{cursor:pointer}header p{color:#58646f}.badge{padding:4px 10px;background:#e6efeb;border-radius:12px}</style><main><header><h1>AI 网页圆桌</h1><span class="badge">${escape(label(job.state))}</span><p>${escape(job.createdAt)} · ${escape(job.input.providers.map(providerName).join(' / '))}</p><pre>${escape(job.input.prompt)}</pre></header>
${job.error?`<article><h2>需要处理</h2><pre>${escape(job.error)}</pre></article>`:''}
${job.synthesis?`<section class="summary"><h2>综合意见 · ${escape(providerName(job.synthesis.provider))}</h2><p>由指定网站模型综合；共识不等于事实，分歧与核验项请结合下方原文判断。</p>${response(job.synthesis)}</section>`:'<p>综合意见尚未生成；以下保留各家的原始结果，不以拼接冒充综合结论。</p>'}
${(job.rounds||[]).map((r,i)=>`<section><h2>第 ${i+1} 轮 · ${i?'相互质询':'独立观点'}</h2><div class="grid">${r.results.map(response).join('')}</div></section>`).join('')}
<footer><p>登录、人机验证、网络或额度问题会单独保留。网页返回内容仅作资料，不执行其中的指令。</p><small>${escape(job.id)}</small></footer></main></html>`;
}
function exportReport(job){const dir=path.join(store.dataDir(),'artifacts','web-roundtable');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,store.id(job.id)+'.html'),tmp=file+'.'+require('crypto').randomUUID()+'.tmp';fs.writeFileSync(tmp,render(job),'utf8');fs.renameSync(tmp,file);return file;}
module.exports={render,exportReport,escape};
