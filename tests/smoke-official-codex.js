'use strict';
// Real CLI handshake, isolated home and no account/model invocation.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('node:assert/strict');
const {execFileSync}=require('child_process');
const {CodexAppServerClient}=require('../main/codex-app-server-client');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub real codex '));
 const resolved=require('../main/codex-windows-command').resolveWindowsCodex();
 const env={...resolved.env};
 for(const key of Object.keys(env))if(/KEY|TOKEN|SECRET|PASSWORD|FIXTURE|ANTHROPIC|OPENAI|CLAUDE|CODEX_|HUB_/i.test(key))delete env[key];
 Object.assign(env,{HOME:root,USERPROFILE:root,APPDATA:path.join(root,'roaming'),LOCALAPPDATA:path.join(root,'local'),CODEX_HOME:path.join(root,'.codex')});
 for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
 env.PATH=[path.join(process.env.SystemRoot,'System32'),path.dirname(resolved.command)].join(path.delimiter);
 fs.mkdirSync(env.CODEX_HOME,{recursive:true});
 const version=execFileSync(resolved.command,[...resolved.args,'--version'],{env,encoding:'utf8',windowsHide:true,timeout:15000}).trim();
 const client=new CodexAppServerClient({cwd:root,launch:{...resolved,env}});
 try {
   const initialized=await client.start();assert.ok(initialized);
   const account=await client.request('account/read',{refreshToken:false});
   if(account.account!==null)throw Error('Fresh CLI unexpectedly inherited an account; details withheld');
   const result={passed:true,version,initialize:true,account:'not_logged_in',modelInvoked:false,externalNodeOnPath:false};
   fs.mkdirSync('artifacts/official-codex',{recursive:true});
   fs.writeFileSync('artifacts/official-codex/report.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
 }finally{client.close();await client.waitForExit();}
})().catch(e=>{console.error(e.stack);process.exitCode=1;});
