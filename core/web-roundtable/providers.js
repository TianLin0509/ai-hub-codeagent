'use strict';
// Every adapter is a small, fixed DOM contract. No private website API, cookies,
// arbitrary URL, or caller-supplied JavaScript is exposed through MCP.
const providers = {
  deepseek:{ name:'DeepSeek', url:'https://chat.deepseek.com/', conversation:'^/a/chat/s/[a-zA-Z0-9-]+$', composer:'textarea[placeholder="Message DeepSeek"]', answer:'.ds-assistant-message-main-content', container:'[data-virtual-list-item-key]', done:'[aria-label="Read aloud"],[aria-label="朗读"]', send:'[role="button"].ds-button--primary.ds-button--circle' },
  kimi:{ name:'Kimi', url:'https://www.kimi.com/', conversation:'^/chat/[a-zA-Z0-9-]+$', composer:'.chat-input-editor[contenteditable="true"]', auth:'[data-testid="sidebar-user-menu-trigger"] .user-name', quota:'.chat-input-bar-content', answer:'.segment-assistant', content:'.markdown', exclude:'.thinking-container,.toolcall-content', done:'.segment-assistant-actions .icon-button' },
  qwen:{ name:'千问', url:'https://www.qianwen.com/', conversation:'^/chat/[a-zA-Z0-9-]+$', composer:'[role="textbox"][data-slate-editor="true"]', answer:'.answer-common-card .qk-markdown', doneSelf:'qk-markdown-complete', send:'button[aria-label="发送消息"]' },
};
function get(provider) { if(!Object.hasOwn(providers,provider))throw Error('Unsupported web provider: '+provider); return providers[provider]; }
function validUrl(provider,url) { try { const p=get(provider),u=new URL(url); return u.origin===new URL(p.url).origin && !u.username && !u.password && new RegExp(p.conversation).test(u.pathname); } catch { return false; } }
// Executed inside the official page, with no credential access.
function inspectPage(p, prompt='') {
  const visible=e=>!!e&&e.getClientRects().length>0;
  const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
  const controls=[...document.querySelectorAll('button,a,[role="button"]')].filter(visible);
  const labels=controls.map(e=>(e.getAttribute('aria-label')||e.innerText||'').trim());
  // A top-level Cloudflare gate has no iframe; its title plus Cloudflare's own script is the proof.
  const gate=/^(Just a moment|请稍候|請稍候)/.test(document.title)&&(typeof window._cf_chl_opt==='object'||!!document.querySelector('script[src*="/cdn-cgi/challenge-platform/"]'));
  const visibleChallenge=e=>{if(!visible(e)||(e.checkVisibility&&!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})))return false;const r=e.getBoundingClientRect(),s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&s.visibility!=='collapse'&&r.width>0&&r.height>0&&r.right>0&&r.bottom>0&&r.left<innerWidth&&r.top<innerHeight;};
  const challenge=gate||!![...document.querySelectorAll('iframe[src*="challenges.cloudflare.com"],.ds-shumei-captcha-modal,[class*="captcha_verify_container"]')].find(visibleChallenge);
  const login=labels.some(t=>/^(log in|sign in|登录|登入|登录账号|登录帐号)$/i.test(t)) || /\/sign_in|\/login|from_logout/.test(location.href);
  const composer=[...document.querySelectorAll(p.composer)].find(visible);
  const answers=[...document.querySelectorAll(p.answer)].map(e=>{
    const container=p.container?e.closest(p.container):e;
    const parts=p.content?[...e.querySelectorAll(p.content)].filter(n=>!n.closest(p.exclude)):[e];
    return {text:parts.map(n=>n.innerText.trim()).filter(Boolean).join('\n\n'),done:p.doneSelf?e.classList.contains(p.doneSelf):!!container?.querySelector(p.done),key:container?.getAttribute('data-virtual-list-item-key')||null};
  });
  const echo=prompt?[...document.querySelectorAll('p,div,span')].filter(e=>!e.closest('[contenteditable],textarea')&&!e.closest(p.answer) && normalize(e.innerText)===normalize(prompt) && ![...e.children].some(c=>normalize(c.innerText)===normalize(prompt))).length:0;
  const editor=composer?.cloneNode(true);editor?.querySelectorAll('[data-slate-placeholder],[data-slate-zero-width]').forEach(e=>e.remove());
  const authReady=!p.auth||[...document.querySelectorAll(p.auth)].some(e=>visible(e)&&e.textContent.trim()&&!/登录|sign in|log in/i.test(e.textContent));
  const quotaMessage=p.quota?[...document.querySelectorAll(p.quota)].filter(e=>visible(e)&&!e.closest(p.answer)&&!e.closest('[contenteditable],textarea')).map(e=>normalize(e.innerText)).find(t=>/\bquota (?:is )?(?:used up|exhausted)|额度.{0,8}(?:用完|耗尽|不足)|次数.{0,8}(?:用完|耗尽)/i.test(t))||null:null;
  return {url:location.href,host:location.host,challenge,login,quotaMessage,ready:!!composer&&authReady,composerText:composer?(composer.value??editor.textContent):'',echo,answers};
}
function expression(provider, prompt) { return `(${inspectPage.toString()})(${JSON.stringify(get(provider))},${JSON.stringify(prompt||'')})`; }
async function snapshot(page,provider,prompt) { const value=await page.evaluate(expression(provider,prompt)); if(value.host!==new URL(get(provider).url).host)throw Error('Official page redirected; manual verification required'); return value; }
async function focus(page,provider) { const selector=get(provider).composer; await page.evaluate(`(()=>{const a=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.getClientRects().length);if(a.length!==1)throw Error('Composer changed');const c=a[0].cloneNode(true);c.querySelectorAll('[data-slate-placeholder],[data-slate-zero-width]').forEach(e=>e.remove());if((a[0].value||c.textContent||'').trim())throw Error('Composer contains a draft');a[0].focus();return true})()`); }
async function send(page,provider) { const p=get(provider); if(p.send){await page.evaluate(`(()=>{const a=[...document.querySelectorAll(${JSON.stringify(p.send)})].filter(e=>e.getClientRects().length&&!e.disabled&&e.getAttribute('aria-disabled')!=='true');if(a.length!==1)throw Error('Send button unavailable');a[0].click();return true})()`);}else{await page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});await page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});} }
async function dismissPromo(page,provider) { if(provider==='qwen')await page.evaluate(`(()=>{for(const d of document.querySelectorAll('[role="dialog"]')){if(d.innerText.includes('工作助理再升级')){const b=[...d.querySelectorAll('button')].find(e=>e.getAttribute('aria-label')==='关闭'||e.innerText.trim()==='关闭');b?.click();}}return true})()`); }
module.exports={providers,get,validUrl,inspectPage,expression,snapshot,focus,send,dismissPromo};
