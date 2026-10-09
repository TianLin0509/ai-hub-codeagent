'use strict';
const {summaryFor}=require('./capability-descriptions');
const ORIGINS={self:'自建',external:'外部导入',unknown:'来源待确认',mixed:'来源有差异'};
function sourceOrigin(row,source){
  if(['self','external'].includes(source.declaredOrigin))return {kind:source.declaredOrigin,evidence:'技能元数据显式声明'};
  if(source.scope==='system')return {kind:'external',evidence:'客户端内置技能'};
  const plugin=source.plugin||(row.type==='plugin'?row.name:'');
  const market=plugin.includes('@')?plugin.slice(plugin.lastIndexOf('@')+1):'';
  if(market==='personal')return {kind:'self',evidence:'个人插件目录 personal（表示自建封装，不代表所有组件均为原创）'};
  if(market)return {kind:'external',evidence:'插件目录来源：'+market};
  return {kind:'unknown',evidence:'本地目录只能证明已存放，不能证明由谁创建'};
}
function presentation(row,note={}){
  note=note&&typeof note==='object'?note:{};
  const customSummary=typeof note.summary==='string'?note.summary.trim().slice(0,180):'';
  const origins=(row.sources||[]).map(s=>sourceOrigin(row,s));
  const kinds=new Set(origins.map(s=>s.kind));
  let kind=kinds.size===1?[...kinds][0]:kinds.size?'mixed':'unknown';
  let evidence=[...new Set(origins.map(s=>s.evidence))].join('；');
  if(['self','external','unknown'].includes(note.origin)){kind=note.origin;evidence='你在 Hub 中标注的来源；不修改原生客户端配置';}
  const summary=summaryFor(row);
  return {...row,displayName:row.type==='plugin'?row.name.split('@')[0]:row.name,
    summary:customSummary||summary.text,summarySource:customSummary?'你填写的简述':summary.source,
    origin:{kind,label:ORIGINS[kind],evidence:evidence||'未提供可核对的来源信息'},
    note:{summary:customSummary,origin:['self','external','unknown'].includes(note.origin)?note.origin:'auto'}};
}
function mcpSharing(row){
  const sources=row.sources||[],enabled=sources.filter(s=>s.enabled!==false&&!s.missing);
  if(!enabled.length)return {title:'先确认是否启用',text:'现有入口均禁用或安装待核对。共享配置不应自动解除禁用；先在原客户端确认服务与授权。'};
  if(row.name==='arena-research')return {title:'需要 Hub 研究任务上下文',text:'该服务与 Hub 研究任务关联。不能把某次任务的地址或凭据复制给所有会话；应由 Hub 为目标会话提供适配入口。'};
  if(sources.some(s=>s.plugin))return {title:'先核对插件依赖',text:'部分入口由插件提供。目标 Agent 可安装兼容插件，或单独配置标准 MCP 服务；插件路径变量、宿主 API 和登录状态不能直接照搬。'};
  return {title:'可评估复用服务与连接配置',text:'stdio 方式复用同一份服务程序，由各 Agent 启动各自进程；HTTP 方式可连接同一服务地址。将连接配置转换成目标客户端格式，并分别验证依赖、授权和连接状态。'};
}
module.exports={presentation,sourceOrigin,mcpSharing,ORIGINS};
