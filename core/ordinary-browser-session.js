'use strict';
// Official extension transport. Chrome owns the login; this client owns only
// the new pages in its own extension group. Never launch a debugging browser.
const fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');
const guard=require('./web-risk-guard');
const EXTENSION_ID='mmlmfjhmonkocbjadbfplnigmagldckm';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function pairingFile(root,identity){return path.join(root,'extension-pairing-'+identity+'.json');}
function readToken(options){
  let record;
  try{record=JSON.parse(fs.readFileSync(options.tokenFile,'utf8'));}catch{throw Error('Extension pairing required');}
  if(record.version!==1||record.identity!==options.identity||typeof record.root!=='string'||typeof record.protectedToken!=='string'||
    path.resolve(record.root).toLowerCase()!==path.resolve(options.browserRoot).toLowerCase())throw Error('Extension pairing required');
  const result=spawnSync('python',[path.join(__dirname,'ordinary-browser-token.py'),'unprotect'],
    {input:record.protectedToken,encoding:'utf8',windowsHide:true,timeout:10000});
  if(result.error||result.status!==0||result.stdout.trim().length<16)throw Error('Extension pairing required');
  return result.stdout.trim();
}

class OrdinarySession {
  constructor(options,{factory,launch,token=readToken,wait=sleep,now=Date.now,settleMs=12000,risk=guard,log=()=>{}}={}){
    if(!['main','alt'].includes(options.identity)||!['browserRoot','playwright','tokenFile'].every(k=>typeof options[k]==='string'&&path.isAbsolute(options[k])))throw Error('Invalid ordinary browser binding');
    Object.assign(this,{options,factory,launch,token,wait,now,settleMs,risk,log});
    this.pages=new Map();this.browser=null;this.connecting=null;
  }
  async connection(){
    if(this.browser?.isConnected())return this.browser;
    if(this.connecting)return this.connecting;
    this.connecting=this.connect().finally(()=>{this.connecting=null;});return this.connecting;
  }
  async connect(){
    const token=this.token(this.options);
    if(this.launch)await this.launch(this.options);
    else await new (require('./personal-chrome').PersonalChrome)({root:this.options.browserRoot})
      .open(this.options.identity,[`chrome-extension://${EXTENSION_ID}/status.html`]);
    let factory=this.factory;
    if(!factory){
      const runtime=path.dirname(require.resolve(this.options.playwright));
      factory=require(path.join(path.dirname(runtime),'playwright-core','lib','coreBundle.js')).tools.createBrowserWithInfo;
    }
    process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN=token;delete process.env.DEBUG;
    let result;
    try{result=await factory({extension:true,browser:{browserName:'chromium',userDataDir:this.options.browserRoot,launchOptions:{}}},
      {clientName:'ai-hub-ordinary-'+this.options.identity},{browser:'chrome',executablePath:require('./hub-chrome').chromeExecutable()});}
    finally{delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;}
    const browser=result.browser,contexts=browser.contexts();
    if(contexts.length!==1||contexts[0].pages().some(p=>!p.url().startsWith(`chrome-extension://${EXTENSION_ID}/connect.html`))){await browser.close();throw Error('Extension ownership check failed');}
    this.browser=browser;
    browser.once('disconnected',()=>{if(this.browser===browser){this.browser=null;this.pages.clear();}});
    return browser;
  }
  async disconnect(){const browser=this.browser;this.browser=null;this.pages.clear();if(browser)await browser.close();}
  assert(url,navigate=false){this.risk.assertAutomationAllowed(this.options.browserRoot,{identity:this.options.identity,url,navigate});}
  async page(lane){const page=this.pages.get(lane);if(!page||page.isClosed()||!this.browser?.isConnected())throw Error('No browser session');return page;}
  async inspect(page,lane){
    if(!this.risk.siteOf(page.url()))return false;
    let probe=await page.evaluate(this.risk.CHALLENGE_PROBE);
    if(!probe?.challenge)return false;
    const until=this.now()+this.settleMs;
    while(probe.challenge&&this.now()<until){
      await this.wait(Math.min(500,until-this.now()));
      try{probe=await page.evaluate(this.risk.CHALLENGE_PROBE);}
      catch(error){if(!/Execution context was destroyed|Cannot find context|Inspected target navigated/.test(error.message))throw error;}
    }
    if(!probe.challenge){this.log('automatic_check_finished',{lane});return false;}
    const site=this.risk.siteOf(page.url());
    try{await page.goto('about:blank',{waitUntil:'commit',timeout:5000});}
    finally{this.risk.recordChallenge(this.options.browserRoot,{identity:this.options.identity,site,kind:probe.kind,source:lane});await this.disconnect();}
    return true;
  }
  async step(page,lane,fn){
    this.assert(page.url());
    if(await this.inspect(page,lane))throw Error('Site challenged');
    let result;
    try{result=await fn();}
    catch(error){if(await this.inspect(page,lane))throw Error('Site challenged');throw error;}
    if(await this.inspect(page,lane))throw Error('Site challenged');
    return result;
  }
  async execute(lane,argv){
    const [command,...args]=require('./hub-browser-tool').argumentsOf(argv);
    if(command==='transport-release'){await this.disconnect();return {released:true,browserPreserved:true};}
    if(command==='human-open'){
      await this.disconnect();const url=args[0]||'https://chatgpt.com/',site=this.risk.siteOf(url);
      const lease=this.risk.startHandoff(this.options.browserRoot,{identity:this.options.identity,site,by:lane,mode:'extension'});
      await new (require('./personal-chrome').PersonalChrome)({root:this.options.browserRoot}).open(this.options.identity,[url]);
      return {handoff:true,until:lease.until,sharedBrowser:true};
    }
    if(command==='human-done'){
      const lease=this.risk.handoff(this.options.browserRoot);
      const site=this.risk.siteOf(args[0]||'https://chatgpt.com/');
      if(lease&&lease.identity!==this.options.identity)throw Error('Human handoff: another account is in use');
      if(lease?.site&&site&&lease.site!==site)throw Error('Human handoff: another site is in use');
      if(lease)this.risk.endHandoff(this.options.browserRoot,lease.id);
      if(site)this.risk.releaseSite(this.options.browserRoot,this.options.identity,site);
      return {handoff:false,site};
    }
    if(command==='close'){const page=this.pages.get(lane);this.pages.delete(lane);if(page&&!page.isClosed())await page.close();return {closed:!!page};}
    if(command==='state-load')return {managedBy:'ordinary-chrome-extension',imported:false};
    if(command==='state-save'){
      // Legacy bridge saves via .new, then atomically renames. Preserve the
      // snapshot contract without exporting any cookies from the shared login.
      const file=path.resolve(args[0]);if(!fs.existsSync(file)){
        if(file.endsWith('.new')&&fs.existsSync(file.slice(0,-4)))fs.copyFileSync(file.slice(0,-4),file);
        else{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({cookies:[],origins:[],managedBy:'ordinary-chrome-extension'}));}
      }return {managedBy:'ordinary-chrome-extension',exported:false};
    }
    if(this.risk.handoff(this.options.browserRoot)){await this.disconnect();throw Error('Human handoff');}
    this.assert();
    if(command==='open'){
      if(this.pages.has(lane)&&!this.pages.get(lane).isClosed())return {reused:true,sharedBrowser:true};
      const browser=await this.connection();this.assert();
      const page=await browser.contexts()[0].newPage();this.pages.set(lane,page);
      const errors=[];page.on('response',r=>{if(r.status()>=400){try{const u=new URL(r.url());errors.push({site:u.origin,path:u.pathname.replace(/[0-9a-f-]{30,}/gi,'<id>'),status:r.status()});if(errors.length>10)errors.shift();}catch{}}});page.hubNetworkErrors=errors;
      const url=args.find(a=>!a.startsWith('--'))||'about:blank';
      if(url!=='about:blank')await this.navigate(lane,page,url);
      return {reused:false,sharedBrowser:true};
    }
    const page=await this.page(lane);
    if(command==='goto')return this.navigate(lane,page,args[0]);
    if(command==='network-errors')return page.hubNetworkErrors||[];
    if(command==='evaluate')return this.step(page,lane,()=>page.evaluate(args[0]));
    if(command==='keyboard')return this.step(page,lane,()=>{const [action,value]=args;if(!['insertText','down','up'].includes(action))throw Error('Unsupported keyboard action');return page.keyboard[action](value);});
    if(command==='run-code'){
      const at=args.indexOf('--filename');if(at<0||!args[at+1])throw Error('run-code requires filename');
      const source=require('./chatgpt-selector-compat').adaptSource(fs.readFileSync(args[at+1],'utf8'));
      const fn=new Function('return ('+source+'\n)')();
      const result=await this.step(page,lane,()=>fn(page));
      if(result?.challenge===true){
        const probe=await page.evaluate(this.risk.CHALLENGE_PROBE);
        if(!probe?.challenge){const corrected={...result,challenge:false,cloudflare:false,auth_state:'page_not_ready'};if(corrected.error_code==='browser_challenge')delete corrected.error_code;return corrected;}
        if(await this.inspect(page,lane))throw Error('Site challenged');
      }
      return result;
    }
    throw Error('Unsupported ordinary browser command');
  }
  async navigate(lane,page,url){this.assert(url,true);await this.step(page,lane,()=>page.goto(url,{waitUntil:'domcontentloaded',timeout:30000}));return {url:page.url()};}
}
module.exports={OrdinarySession,pairingFile,readToken,EXTENSION_ID};
