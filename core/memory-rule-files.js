'use strict';
// Read-only ownership classification. Equal content alone never grants ownership.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
const normalize = value => String(value).replace(/\r\n?/g, '\n').trim();
function classifyRule(file) {
  if (fs.statSync(file).size > 1024*1024) throw new Error('规则文件超过 1 MB，未分类');
  const text = fs.readFileSync(file, 'utf8');
  const header = text.match(/^<!--[\s\S]*?-->\r?\n\r?\n/);
  const managed = header && /由 AI Hub/.test(header[0]) && /自动复制自 /.test(header[0]);
  const body = managed ? text.slice(header[0].length) : text;
  const source = managed ? header[0].match(/自动复制自 ([^\r\n]+?)(?:，|\r?\n)/)?.[1]?.trim() : null;
  const seed = managed ? header[0].match(/seed-sha256:\s*([a-f0-9]{16})/)?.[1] : null;
  const state = !managed ? 'owned' : !seed ? 'unknown' : digest(body).slice(0,16) === seed ? 'unchanged' : 'modified';
  return { state, source, digest: digest(text), bodyDigest: digest(normalize(body)), bytes: Buffer.byteLength(text),
    note: {owned:'独立规则', unchanged:'Hub 历史副本，正文未改', modified:'历史副本已手改，保留', unknown:'旧副本缺少校验标记，保留'}[state] };
}
function globalRuleFiles(home) {
  return [['codex','.codex','AGENTS.md'],['claude','.claude','CLAUDE.md'],['kimi','.kimi-code','AGENTS.md']]
    .map(([kind,dir,name])=>({kind,path:path.join(home,dir,name)}));
}
// Preserve workspace-specific rules without creating another AGENTS.md in cwd.
// Only the explicit workspace ancestry is considered. Disk discovery is not
// proof of native injection. A separate launch contract suppresses equivalent
// native-covered bodies; unknown coverage keeps the existing supplementation.
function sharedWorkspaceRules({ session, workspaceService, homeDir, nativeCoverage = [] }) {
  // 旧工作根（AI_HUB_LEGACY_WORKSPACE_ROOTS）里的存量会话按它自己所在的根收集规则。
  const cwd = session.cwd;
  const root = (typeof workspaceService.workspaceRootFor === 'function' && workspaceService.workspaceRootFor(cwd))
    || workspaceService.getWorkspaceRoot();
  const relative = path.relative(root,cwd);
  if (!relative || relative === '..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) return [];
  const read = file => { if(fs.statSync(file).size>65536) throw new Error('共享规则核对超过 64 KB，请先拆分：'+file); return fs.readFileSync(file,'utf8'); };
  const bodies = [];
  const result=[];
  let dir=root;
  for (const part of ['', ...relative.split(path.sep).slice(0,-1)]) {
    if (part) dir=path.join(dir,part);
    const override=path.join(dir,'AGENTS.override.md');
    const codex=session.codexSid || /^codex(?:-resume)?$/.test(session.transcriptKind || session.kind);
    // Match the provider's explicit replacement file; do not reintroduce the
    // AGENTS.md that it deliberately overrides. Empty overrides fall through.
    const file=codex && fs.existsSync(override) && fs.statSync(override).size>0 ? override : path.join(dir,'AGENTS.md');
    if (!fs.existsSync(file)) continue;
    const text=read(file);
    const header=text.match(/^<!--[\s\S]*?-->\r?\n\r?\n/);
    const content=header && /由 AI Hub/.test(header[0]) ? text.slice(header[0].length) : text;
    const coverage=require('./native-rule-coverage');
    const body=coverage.normalize(content);
    if (!body || bodies.some(b=>b===body || b.includes(body))) continue;
    if (coverage.stillCovered(content,nativeCoverage)) continue;
    if (Buffer.byteLength(content)>65536) throw new Error('工作区共享规则超过 64 KB，请先拆分：'+file);
    result.push({path:file,content}); bodies.push(body);
  }
  return result;
}
module.exports={classifyRule,globalRuleFiles,sharedWorkspaceRules,digest};
