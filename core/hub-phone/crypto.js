'use strict';
const crypto=require('node:crypto');
// 手机中转地址可用 AI_HUB_PHONE_RELAY 覆盖；社区版不带默认中转，需自建后配置。
const DEFAULT_RELAY='';
const RELAY=String(process.env.AI_HUB_PHONE_RELAY||DEFAULT_RELAY).trim().replace(/\/+$/,'');
function seal(key,channel,id,role,value){const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',Buffer.from(key,'base64url'),iv);c.setAAD(Buffer.from(`${channel}:${id}:${role}`));return Buffer.concat([iv,c.update(JSON.stringify(value),'utf8'),c.final(),c.getAuthTag()]).toString('base64');}
function open(key,channel,id,role,payload){const b=Buffer.from(payload,'base64');if(b.length<29||b.length>8*1024*1024)throw Error('加密消息大小异常');const c=crypto.createDecipheriv('aes-256-gcm',Buffer.from(key,'base64url'),b.subarray(0,12));c.setAAD(Buffer.from(`${channel}:${id}:${role}`));c.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([c.update(b.subarray(12,-16)),c.final()]).toString('utf8'));}
function credentials(){if(!RELAY)throw Error('未配置手机中转服务：自建中转后设置环境变量 AI_HUB_PHONE_RELAY 再重启 Hub');const token=()=>crypto.randomBytes(32).toString('base64url');return{url:RELAY,channel:crypto.randomUUID(),hubToken:token(),phoneToken:token(),key:token()};}
function invite(c){return'AIH1.'+Buffer.from(JSON.stringify({url:c.url,channel:c.channel,token:c.phoneToken,key:c.key})).toString('base64url');}
module.exports={seal,open,credentials,invite,RELAY};
