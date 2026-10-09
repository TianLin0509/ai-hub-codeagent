'use strict';
// Community edition: generic tool-to-account dependencies only.
// Unknown tools remain unknown; installing a plugin is not a login.
const SERVICES = {
  roundtable: { name: 'AI 网页圆桌', kind: 'browser', help: 'DeepSeek、Kimi、千问共用 Hub 主账号；会话还需启用网页 MCP。', sites: ['deepseek', 'kimi', 'qwen'] },
  playwright: { name: 'Playwright 浏览器工具', kind: 'browser', help: '通用浏览器有自己的资料目录；迁移前须确认页面归属和原扩展依赖。' },
  hostBrowser: { name: '客户端内置浏览器', kind: 'host', help: 'browser-use 由原生客户端提供浏览器；目前没有 Hub Chrome 接入接口。' },
  hostImage: { name: '客户端内置生图', kind: 'host', help: 'image_gen 使用客户端自己的授权。' },
  github: { name: 'GitHub', kind: 'credential', help: '复用 GitHub CLI / Git 的原生授权；浏览器登录不等于仓库访问授权。', files: [['AppData', 'Roaming', 'GitHub CLI', 'hosts.yml'], ['.config', 'gh', 'hosts.yml']], env: ['GH_TOKEN', 'GITHUB_TOKEN'] },
  openaiApi: { name: 'OpenAI API', kind: 'credential', help: '仅在工具显式选择 API 模式时使用；ChatGPT 网页订阅不替代 API Key。', env: ['OPENAI_API_KEY'] },
};
const DEPENDENCIES = {
  web_roundtable: ['roundtable'],
  playwright: ['playwright'], browser: ['hostBrowser'], 'browser-use': ['hostBrowser'],
  imagegen: ['hostImage', 'openaiApi'],
  'skill-installer': ['github'], 'commit-commands': ['github'],
};
const AI_SERVICES = new Set(['roundtable', 'hostImage', 'openaiApi']);
const SERVICE_GROUPS = [{ id: 'ai', name: 'AI 工具账号', help: '网页工具复用 Hub 专属浏览器里的登录。' },
  { id: 'external', name: '外部服务', help: 'GitHub 与其他工具授权单独管理。' }];
const LOCAL = new Set();
function dependencyFor(row, rows = [], seen = new Set()) {
  if (seen.has(row.id)) return { state: 'unknown', services: [] };
  seen.add(row.id);
  const name = row.name.split('@')[0].toLowerCase();
  if (Object.hasOwn(DEPENDENCIES, name)) return { state: 'reviewed', services: [...DEPENDENCIES[name]] };
  if (row.type === 'plugin') {
    const children = rows.filter(r => r.sources?.some(s => s.plugin === row.name));
    if (children.length) {
      const deps = children.map(r => dependencyFor(r, rows, new Set(seen)));
      return { state: deps.some(d => d.state === 'unknown') ? 'unknown' : 'reviewed', services: [...new Set(deps.flatMap(d => d.services))] };
    }
  }
  return { state: LOCAL.has(name) ? 'reviewed' : 'unknown', services: [] };
}
module.exports = { SERVICES, dependencyFor, AI_SERVICES, SERVICE_GROUPS };
