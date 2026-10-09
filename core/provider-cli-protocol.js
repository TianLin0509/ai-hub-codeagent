'use strict';
function normalizeProviderCwd(message, mcpServers=[]) {
  if (!['session/new','session/load','session/resume','session/fork'].includes(message.method)) return message;
  if(mcpServers.length){const existing=message.params?.mcpServers||[];const names=new Set(existing.map(s=>s.name));
    message={...message,params:{...message.params,mcpServers:[...existing,...mcpServers.filter(s=>!names.has(s.name))]}};}
  const cwd=message.params?.cwd;
  // Rust canonicalize emits the extended Windows spelling. DSH's parent-rule
  // walker currently mishandles it as C: (drive-relative), so use the equivalent
  // ordinary absolute spelling. UNC paths retain their server/share identity.
  if(typeof cwd!=='string'||!cwd.startsWith('\\\\?\\'))return message;
  const normal=cwd.startsWith('\\\\?\\UNC\\')?'\\\\'+cwd.slice(8):/^[A-Za-z]:\\/.test(cwd.slice(4))?cwd.slice(4):cwd;
  return {...message,params:{...message.params,cwd:normal}};
}
module.exports={normalizeProviderCwd};
