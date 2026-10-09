'use strict';
// A delivery is a durable result for one member in one frozen workflow step.
// Provider turn completion is deliberately absent from this protocol.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const VERSION = 1;
const LIMIT = 6;
// Automatic budget: independent reviews, not steps. Only review -> rework
// loops, so other stages need no cap; every build still gets its review.
const REVIEW_LIMIT = 3;
const MAX_BYTES = 2 * 1024 * 1024;
const enabled = m => !!(m?.groupChat && m.serialWorkflow?.deliveryVersion === VERSION);
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function segment(value) {
  if (!/^[a-zA-Z0-9_-]{1,255}$/.test(String(value))) throw new Error('工作流路径身份无效');
  return String(value);
}
function directory(dataDir, meetingId) { return path.join(dataDir, 'task-docs', segment(meetingId), 'deliveries'); }
function paths(base, run, step, member) {
  const dir = path.join(base, segment(run.id), `step-${step.number}`, segment(member));
  return {dir, draft:path.join(dir,'草稿.md'), ready:path.join(dir,'已交付.md'), rework:path.join(dir,'需返工.md'), blocked:path.join(dir,'阻塞.md')};
}
function ticket(run, step, member) { return hash(JSON.stringify([run.id, step.id, member, step.inputHash])); }
function header(run, step, member) { return `<!-- hub-delivery:${ticket(run,step,member)} -->`; }
function readDelivery(base, run, step, member) {
  const p = paths(base,run,step,member);
  // A leftover draft next to a final state is ignored (agents sometimes copy
  // instead of rename); only two conflicting final states are an error.
  const finals = ['ready','rework','blocked'].filter(k=>fs.existsSync(p[k]));
  if (!finals.length) return null;
  if (finals.length!==1) throw new Error(`${member} 同时存在多个交付状态（${finals.join('、')}），请核对任务文件`);
  const outcome=finals[0], file=p[outcome], stat=fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size>MAX_BYTES) throw new Error(`${member} 交付文件类型或大小无效`);
  // Reject redirected member/run directories, not just a final-file symlink.
  const realBase=fs.realpathSync(base), realFile=fs.realpathSync(file);
  const relative=path.relative(realBase,realFile);
  if (relative.startsWith('..') || path.isAbsolute(relative) || path.resolve(realFile).toLowerCase()!==path.resolve(file).toLowerCase()) throw new Error('交付路径被重定向');
  const text=fs.readFileSync(file,'utf8');
  const mark=header(run,step,member);
  // The exact run/step/member path already identifies the delivery; the ticket
  // line is a second check. Agents sometimes drop it when rewriting the file,
  // so a missing ticket is accepted and only a ticket of another round rejects.
  const tickets=[...text.matchAll(/<!-- hub-delivery:([0-9a-f]+) -->/g)].map(m=>m[1]);
  if (tickets.some(t=>t!==ticket(run,step,member))) throw new Error(`${member} 交付文件头属于其他轮次；请核对是否抄错了文件`);
  if (!text.split(mark).join('').trim() || text.includes('\uFFFD')) throw new Error(`${member} 交付正文为空或编码无效`);
  if (outcome==='rework' && run.stages[step.index].after!=='review') throw new Error('此步骤未配置返工接续，请交付结果或记录阻塞');
  return {memberId:member,outcome,path:file,hash:hash(text),acceptedAt:Date.now()};
}
function reviewsInBudget(run) {
  return run.steps.slice(run.budgetStart || 0).filter(s=>run.stages[s.index]?.after==='review' && s.members.every(m=>s.deliveries?.[m])).length;
}
function newStep(run,index) {
  const number=run.steps.length+1;
  // Hub notes (e.g. a failed test gate) are pinned inputs like member deliveries.
  const inputs=run.steps.flatMap(s=>[...Object.values(s.deliveries || {}),...(s.hubNotes || [])]).filter(d=>d.path).map(d=>({path:d.path,hash:d.hash,outcome:d.outcome}));
  return {id:crypto.randomUUID(),number,index,inputHash:hash(JSON.stringify([run.goal,run.stages,inputs])),inputs,
    members:[...run.stages[index].members],deliveries:{},dispatches:[],createdAt:Date.now()};
}
function skipperLabel(by) { return by==='orchestrator' ? '编排员' : '用户'; }
function protocol() { return '按文件交付推进：每位成员只写自己的结果；完成本轮职责及必要验证后，UTF-8 保存并回读，再在同目录将草稿原子改名为已交付文件。聊天回答、CLI 空闲和超时不算交付。不得修改文件头、覆盖已交付结果或代交其他成员的文件。后台验证未结束时保留草稿。阻塞要写清原因，不伪造完成。'; }
function prompt(base,run,step,members=[],extras={}) {
  const stage=run.stages[step.index], name=id=>members.find(m=>m.memberId===id)?.displayName || members.find(m=>m.memberId===id)?.title || id;
  const lines=[`【文件交付工作流 · 第 ${step.number} 轮 · ${stage.name}】`,`本次目标：${run.goal}`,`项目：${run.workspace || '先核实任务项目'}`,run.projectLocator || '',protocol(),
    '本轮共享职责：',stage.prompt,'本轮每位成员各有交付文件；同轮全部交付后才接续。只处理自己的分工，其他成员的文件只读。',
    ...step.inputs.map(d=>`前序输入（固定交付版本）：${d.path}（sha256 ${d.hash}）`),
    ...run.steps.slice(0,step.number-1).flatMap(s=>Object.values(s.deliveries || {}).filter(d=>d.outcome==='skipped').map(d=>`前序第 ${s.number} 轮：${name(d.memberId)} 被${skipperLabel(d.skippedBy)}跳过，没有交付${d.reason?`（原因：${d.reason}）`:''}。`)),
    ...step.members.flatMap(id=>{const p=paths(base,run,step,id);return [`${name(id)} [${id}]：`,`草稿：${p.draft}`,`完成后改名为：${p.ready}`,`客观阻塞改名为：${p.blocked}`,...(stage.after==='review'?[`确有需返工问题改名为：${p.rework}`]:[]),`文件第一行必须原样保留：${header(run,step,id)}`];})];
  if (run.kind==='file') lines.push(
    '先读真实项目根的 AGENTS.md、.agents/project.json；开题和实现负责人读 .agents/AUTHOR.md，独立审查负责人读 .agents/MERGER.md。核实项目验证、版本、合并入口及后置检查要求，不自行换入口。',
    '开发交付规则：开题只核实目标、范围、验收和项目，不改代码；实现使用独立 worktree，交付完整 SHA、实际验证与风险；审查者独立验证，不采信自报通过。',
    '每轮第一位是阶段负责人，其他成员只交付分工建议。实现负责人不得自行合并。审查负责人只有在本任务已获授权且真实合并及后置检查成功后才交付完成；缺陷交付需返工，环境或审批阻碍交付阻塞。项目既有审批条件优先。',
    '用户明确按本开发流程开工即授权开题范围内实现和独立验证通过后的项目合并；不从一般讨论或非开发模板推导合并权限。');
  if(run.kind==='file')lines.push(...require('./delivery-dev-guidance').lines(run,step,extras));
  if(run.kind==='file' && stage.after==='review' && step.members.length>1)lines.push(`本轮审查负责人 ${name(step.members[0])} 必须先等其他审查成员交付并读取本轮文件；有任何返工或阻塞意见则不合并，逐项核实后交付需返工或阻塞。其他成员先独立交付，不等待负责人。`);
  lines.push('已有交付文件先核对，不覆盖不重做；收到继续时复用已完成工作。交付后不再修改该候选，后续变更另轮处理。聊天中简短汇报结果与文件位置，不重复全文。');
  return lines.join('\n\n');
}
function prepare(base,run,step) {
  for (const member of step.members) {
    const p=paths(base,run,step,member);fs.mkdirSync(p.dir,{recursive:true});
    if (['ready','rework','blocked'].some(k=>fs.existsSync(p[k]))) continue;
    try { fs.writeFileSync(p.draft,header(run,step,member)+'\n\n',{encoding:'utf8',flag:'wx'}); }
    catch(error) { if(error.code!=='EEXIST')throw error; }
  }
}
module.exports={skipperLabel,VERSION,LIMIT,REVIEW_LIMIT,reviewsInBudget,enabled,hash,directory,paths,ticket,header,readDelivery,newStep,prompt,prepare,protocol};
