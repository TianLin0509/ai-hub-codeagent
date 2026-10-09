'use strict';
// 助理的成长记忆（Hub 保管，各后端共用）：
//   USER.md   用户的偏好与习惯（怎么和他合作）
//   MEMORY.md 长期事实、约定与常用资料入口
// 写入只走 update_memory 工具：每条带日期与来源，超长要求先合并精简，疑似密钥拒绝，改动前自动备份。
// Claude 通过 --append-system-prompt-file 每轮生效；其他后端在新会话第一轮读取（见 context.js）。
const fs = require('node:fs');
const path = require('node:path');

const FILES = {
  user: { name: 'USER.md', title: '用户的偏好与习惯', cap: 3000,
    intro: '助理和用户合作时要遵守的偏好、习惯和表达方式。每条一行，带日期和来源；过时的删掉，重复的合并。' },
  memory: { name: 'MEMORY.md', title: '长期记忆', cap: 6000,
    intro: '长期有效的事实、约定、常用项目与资料入口。一次性任务不记；实时进展以 Hub 资料为准。' },
};
const SECRET_RE = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:password|passwd|密码|口令|token|api[_ -]?key)\s*[:：=]\s*\S{6,})/i;

class AssistantMemory {
  constructor(directory) {
    this.directory = directory;
    this.historyDir = path.join(directory, 'history');
    this.promptPath = path.join(directory, 'assistant-system-prompt.md');
    fs.mkdirSync(this.historyDir, { recursive: true });
    for (const spec of Object.values(FILES)) {
      const file = path.join(directory, spec.name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${spec.title}\n\n> ${spec.intro}\n\n`, 'utf8');
    }
    this.writePrompt();
  }
  file(kind) { const spec = FILES[kind]; if (!spec) throw new Error('记忆文件只能是 user（USER.md）或 memory（MEMORY.md）'); return path.join(this.directory, spec.name); }
  read() { return Object.fromEntries(Object.keys(FILES).map(kind => [kind, fs.readFileSync(this.file(kind), 'utf8')])); }
  entries(kind) { return this.read()[kind].split('\n').filter(line => line.startsWith('- ')); }
  // 系统提示文件：Claude 助理每次启动时读入；其他后端在新会话第一轮通过资料包读取同样内容。
  promptText() {
    const { user, memory } = this.read();
    return ['# 助理的成长记忆', '',
      '下面是你（用户的 AI Hub 助理）跨会话积累的记忆，由 Hub 保管，换班、换模型都会保留。回答和办事时遵守这里的偏好。',
      '用户说「记住……」时一定记；他没说时，你也要主动判断：明确表态或反复体现的偏好、长期约定、常用资料入口，用 update_memory 记下来。一句话一条，具体可执行；偏好写进 user，事实与约定写进 memory。只出现一次的推测、一次性任务、实时进展和任何密钥不记。发现旧条目过时或重复时，用 remove 或 rewrite 整理。',
      '这两份文件是所有模型共用的正本（Claude、Codex、千问等当助理时都读它）。关于用户本人的偏好与约定，只记在这里；你自带的记忆目录不会被其他模型自动读到。',
      '', user.trim(), '', memory.trim(), ''].join('\n');
  }
  writePrompt() { const tmp = `${this.promptPath}.${process.pid}.tmp`; fs.writeFileSync(tmp, this.promptText(), 'utf8'); fs.renameSync(tmp, this.promptPath); return this.promptPath; }
  packet() {
    const { user, memory } = this.read();
    return { userPath: this.file('user'), memoryPath: this.file('memory'), user, memory,
      meaning: '助理的成长记忆：USER.md 是用户的偏好与习惯，MEMORY.md 是长期事实与约定。本会话全程遵守；用 update_memory 维护。' };
  }
  update({ file, action, text = '', reason = '', now = Date.now() } = {}) {
    const target = this.file(file), spec = FILES[file];
    const clean = String(text).replace(/\r/g, '').trim();
    if (!['add', 'remove', 'rewrite'].includes(action)) throw new Error('action 只能是 add、remove 或 rewrite');
    if (!clean) throw new Error('内容不能为空');
    reason = String(reason || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
    if (SECRET_RE.test(clean) || SECRET_RE.test(reason)) throw new Error('内容疑似包含密钥或密码，未写入；记忆里不保存任何凭据');
    const before = fs.readFileSync(target, 'utf8');
    let after;
    if (action === 'add') {
      if (clean.includes('\n') || clean.length > 300) throw new Error('add 只写一句话（不超过 300 字）；整理多条请用 rewrite');
      if (this.entries(file).some(line => line.slice(2).startsWith(clean))) return { ok: true, unchanged: true, file: target, note: '已有相同条目' };
      const d = new Date(now), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      // 日期和来源由 Hub 统一加（本地日期）；助理自己写的括注日期去掉，免得一条两个日期。
      const body = clean.replace(/[（(][^（）()]*\d{4}-\d{2}-\d{2}[^（）()]*[）)]\s*$/, '').replace(/[。.]\s*$/, '');
      after = before.replace(/\n*$/, '\n') + `- ${body}（${day}${reason ? '，' + String(reason).trim().slice(0, 60) : ''}）\n`;
    } else if (action === 'remove') {
      const hits = before.split('\n').filter(line => line.startsWith('- ') && line.includes(clean));
      if (hits.length !== 1) throw new Error(hits.length ? `匹配到 ${hits.length} 条，请给出更具体的原文片段` : '没有找到包含这段文字的条目');
      after = before.split('\n').filter(line => line !== hits[0]).join('\n');
    } else {
      after = `# ${spec.title}\n\n> ${spec.intro}\n\n` + clean.replace(/^#[^\n]*\n+(>[^\n]*\n+)?/, '') + '\n';
    }
    if (after.length > spec.cap) throw new Error(`${spec.name} 将超过 ${spec.cap} 字上限，请先用 rewrite 合并精简（删掉过时、合并重复）`);
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(this.historyDir, `${stamp}-${Math.random().toString(36).slice(2, 7)}-${spec.name}`), before, 'utf8');
    const backups = fs.readdirSync(this.historyDir).sort();
    for (const old of backups.slice(0, Math.max(0, backups.length - 60))) { try { fs.unlinkSync(path.join(this.historyDir, old)); } catch {} }
    const tmp = `${target}.${process.pid}.tmp`; fs.writeFileSync(tmp, after, 'utf8'); fs.renameSync(tmp, target);
    fs.appendFileSync(path.join(this.directory, 'CHANGES.md'), `- ${new Date(now).toISOString()} · ${spec.name} · ${action} · ${clean.split('\n')[0].slice(0, 80)}${reason ? ' · ' + String(reason).slice(0, 60) : ''}\n`, 'utf8');
    this.writePrompt();
    return { ok: true, file: target, chars: after.length, cap: spec.cap, appliesTo: '当前会话已知；新会话（换班、换模型后）自动读入' };
  }
}
module.exports = { AssistantMemory, FILES };
