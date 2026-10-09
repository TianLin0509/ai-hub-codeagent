'use strict';
const {sidebarItemClassification,sidebarItemHasUnread}=require('../session-sidebar-state');
const {nativeId}=require('./live-history');
const LABELS={wait:'等你响应',error:'运行异常',run:'运行中',unread:'未读',dorm:'休眠',idle:'就绪',unknown:'状态未知'};
function sessionHubState(s,sessionMap,now,isOpen=s.isOpen,classify=null){
   if(isOpen&&s.sidebarView&&s.sidebarView.nativeSessionId===nativeId(s))return s.sidebarView.hubState;
   const state=isOpen?(classify?classify(s):sidebarItemClassification(s,{now,sessionMap})).state:'unknown';
   return {source:'Hub 侧栏共用的运行状态与未读规则',state,label:LABELS[state],
     isActive:isOpen?(state==='run'||state==='wait'):null,
     group:isOpen?(state==='run'||state==='wait'?'active':state==='error'?'failed':'inactive'):'history',
     hasUnread:isOpen?sidebarItemHasUnread(s,sessionMap):null,
     unreadCount:isOpen?Math.max(0,Number(s.unreadCount)||0):null,
     needsUserInput:isOpen?state==='wait':null,
     scope:s.meetingId?'群聊成员自身状态；不代表整组都在运行':'单会话状态',
     meaning:isOpen?'已打开、运行中、有未读、等待输入是独立信息；未读不等于需要用户决策。':'未在本窗口打开，当前运行与未读状态未知'};
}
function projectSessionStates(sessions,{now=Date.now()}={}){
 const sessionMap=new Map(sessions.filter(s=>s.isOpen).map(s=>[s.id,s]));
 return sessions.map(s=>({...s,hubState:sessionHubState(s,sessionMap,now)}));
}
// Transfer the sidebar owner's existing projection. Only changed rows cross
// IPC; this transport neither changes runtime truth nor counts unread replies.
function createSessionViewPublisher(send){
 let previous=new Map();
 // The sidebar passes its own `now` and classification so one render classifies
 // each session once instead of twice; without them the result is unchanged.
 return (sessions,{now=Date.now(),classify=null}={})=>{
  const sessionMap=new Map(sessions.map(s=>[s.id,s])),current=new Map(),changed=[];
  for(const s of sessions){
   const row={id:s.id,nativeSessionId:nativeId(s),hubState:{...sessionHubState(s,sessionMap,now,true,classify),source:'Hub 侧栏当前状态快照'}};
   const signature=JSON.stringify(row);current.set(s.id,signature);
   if(previous.get(s.id)!==signature)changed.push(row);
  }
  const removed=[...previous.keys()].filter(id=>!current.has(id));
  if(changed.length||removed.length){send({changed,removed});previous=current;}
 };
}
module.exports={projectSessionStates,createSessionViewPublisher};
