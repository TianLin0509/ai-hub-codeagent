'use strict';
const fs = require('fs');
const path = require('path');
const { SERVICES, dependencyFor, AI_SERVICES, SERVICE_GROUPS } = require('./tool-account-catalog');
const { integrationStatus } = require('./hub-browser-tool');

// Read-only projection of native stores. Secrets never enter the renderer or audit.
function credentialEvidence(service, home, env) {
  let present = (service.env || []).some(key => !!env[key]);
  let error = false;
  for (const parts of service.files || []) {
    const file = path.join(home, ...parts);
    try {
      const stat = fs.statSync(file);
      if (service.fields) {
        if (stat.size > 1024 * 1024) throw Error('oversize');
        const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        present ||= service.fields.some(key => typeof data[key] === 'string' && !!data[key].trim());
      } else present ||= stat.isDirectory() || stat.size > 0;
    } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes(e.code)) error = true; }
  }
  return { present, error };
}
function buildToolAccounts(catalog, { root, homeDir, env = process.env }) {
  const bindings = integrationStatus(root);
  const externalState = require('./external-accounts').readExternalState(root);
  const tools = catalog.rows.map(r => ({ id: r.id, name: r.displayName || r.name, type: r.type,
    enabled: r.sources.some(s => s.enabled !== false && !s.missing), ...dependencyFor(r, catalog.rows) }));
  // This MCP is supplied at session launch, not necessarily in user config files.
  if (!tools.some(t => t.id === 'mcp:web_roundtable')) tools.push({ id: 'mcp:web_roundtable', name: 'AI 网页圆桌（Hub 内置）', type: 'mcp', enabled: true, state: 'reviewed', services: ['roundtable'] });
  const { RESEARCH_SITES } = require('./external-accounts');
  const always = ['github', ...RESEARCH_SITES];
  const services = Object.entries(SERVICES).filter(([id]) => always.includes(id) || tools.some(t => t.enabled && t.services.includes(id))).map(([id, service]) => {
    const evidence = credentialEvidence(service, homeDir, env);
    const binding = bindings.find(b => b.tool === service.binding);
    const status = id === 'roundtable' ? 'shared' : service.binding ? (binding?.state === 'connected' ? 'bound' : binding?.state === 'changed' ? 'changed' : 'pending')
      : service.kind === 'browser' ? 'pending' : service.kind === 'host' ? 'host' : 'native';
    return { id, group: AI_SERVICES.has(id) ? 'ai' : 'external', name: service.name, kind: service.kind, help: service.help, site: service.site, sites: service.sites,
      website: always.includes(id), canCheck: id === 'github' || RESEARCH_SITES.includes(id), canAuthorize: id === 'github', nativeStatus: externalState[id] || null,
      status, identities: id === 'roundtable' ? [{ identity: 'main' }] : binding?.identities || [],
      credential: evidence.error ? 'read_error' : evidence.present ? 'record_found' : 'not_checked',
      authentication: 'not_checked', consumers: tools.filter(t => t.enabled && t.services.includes(id)).map(t => ({ id: t.id, name: t.name, type: t.type })) };
  });
  return { generatedAt: Date.now(), catalogAt: catalog.generatedAt, tools, services, groups: SERVICE_GROUPS,
    counts: { total: tools.length, enabled: tools.filter(t => t.enabled).length, pending: services.filter(s => ['pending', 'changed'].includes(s.status)).length, unknown: tools.filter(t => t.enabled && t.state === 'unknown').length },
    warnings: catalog.warnings || [], boundary: '盘点本机配置及已打开项目；云端连接器和新增工具需单独核对。绑定、登录与任务成功分别验证。' };
}
module.exports = { buildToolAccounts, credentialEvidence };
