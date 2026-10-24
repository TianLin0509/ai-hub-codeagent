'use strict';
// 项目档案（2026-10-23）：负责人跨任务保留的项目认识，按工作目录一份，放在 Hub 数据目录里，
// 不写进项目仓库（免得弄脏 git 状态）；成员按绝对路径只读。内容由负责人维护，Hub 只建模板。
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function briefFile(dataDir, meeting) {
  const workspace = String(meeting?.workspace || '').trim();
  const key = workspace ? path.resolve(workspace).toLowerCase() : 'meeting:' + String(meeting?.id || '');
  const name = (workspace ? path.basename(workspace) : 'group').replace(/[^\w一-鿿.-]+/g, '_').slice(0, 40) || 'project';
  return path.join(dataDir, 'orchestration', 'project-briefs', `${name}-${createHash('sha256').update(key).digest('hex').slice(0, 10)}.md`);
}

function template(meeting) {
  return [
    `# 项目档案：${meeting?.workspace || meeting?.title || '本群'}`,
    '',
    '由负责人维护：接任务先读，结项时更新。只写对后续任务有用的稳定认识，保持简明。',
    '',
    '## 项目是什么、怎么跑',
    '',
    '## 架构与关键模块',
    '',
    '## 约定与边界（测试、合并、不能碰的地方）',
    '',
    '## 踩过的坑',
    '',
    '## 历次决定（日期 + 决定 + 原因）',
    '',
  ].join('\n');
}

// 没有档案时建一份模板；已有的一律不动。失败只返回路径，不影响编排。
function ensureBrief(dataDir, meeting) {
  const file = briefFile(dataDir, meeting);
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, template(meeting), { encoding: 'utf8', flag: 'wx' });
    }
  } catch (error) { if (error.code !== 'EEXIST') console.warn('[orchestration] project brief unavailable:', error.message); }
  return file;
}

module.exports = { briefFile, ensureBrief };
