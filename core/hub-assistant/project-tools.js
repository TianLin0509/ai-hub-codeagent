'use strict';
const fs=require('node:fs'),path=require('node:path');
// These CLIs load project MCP files. Only the assistant's workspace receives
// this entry; global credentials/settings and other project entries are kept.
function configureProjectTools(kind,opts,cwd) {
  const entry=opts.assistantMcpEntry;
  if(!entry)return;
  if(opts.purpose!=='hub-assistant'||!['gemini','kimi'].includes(kind)
    ||entry.name!=='hub_assistant'||entry.env?.HUB_ASSISTANT_SESSION_ID!==opts.id)
    throw new Error('助理工具配置与会话身份不一致');
  const directory=path.join(cwd,kind==='gemini'?'.gemini':'.kimi-code');
  const file=path.join(directory,kind==='gemini'?'settings.json':'mcp.json');
  fs.mkdirSync(directory,{recursive:true});
  const config=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):{};
  const current=config.mcpServers?.hub_assistant;
  if(current&&current.env?.HUB_ASSISTANT_SESSION_ID!==opts.id)
    throw new Error('该工作目录已绑定另一助理工具，保留原配置');
  const server={command:entry.command,args:entry.args,env:entry.env,
    ...(kind==='gemini'?{trust:true}:{})};
  config.mcpServers={...config.mcpServers,hub_assistant:server};
  const temporary=file+'.'+process.pid+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify(config,null,2),{encoding:'utf8',mode:0o600});
  fs.renameSync(temporary,file);
}
module.exports={configureProjectTools};
