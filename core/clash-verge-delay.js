'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

function yamlScalar(source, key) {
  const match = String(source || '').match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return match ? match[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

const PIPE_ROOT = '\\\\.\\pipe\\';

// Clash Verge 换内核运行方式（sidecar / service）后，clash-verge.yaml 里的管道名可能是旧的，
// 所以除了配置里的名字，再补上本机实际存在的 verge-mihomo* 管道。只接受这一类本地管道。
function listVergeMihomoPipes(readdir = fs.readdirSync) {
  try {
    return readdir(PIPE_ROOT).filter(name => /^verge-mihomo/.test(name)).map(name => PIPE_ROOT + name);
  } catch { return []; }
}

function controllerPipeCandidates(config, listPipes = listVergeMihomoPipes) {
  const candidates = [];
  const fromConfig = yamlScalar(config, 'external-controller-pipe');
  if (fromConfig.startsWith(`${PIPE_ROOT}verge-mihomo`)) candidates.push(fromConfig);
  for (const pipe of listPipes()) if (!candidates.includes(pipe)) candidates.push(pipe);
  return candidates;
}

function selectedNode(proxies) {
  const groups = Object.entries(proxies || {});
  const group = groups.find(([name, value]) => value?.type === 'Selector' && /节点选择/.test(name))
    || groups.find(([name, value]) => value?.type === 'Selector' && /^(PROXY|Proxy)$/i.test(name));
  if (!group) return null;
  let name = group[0];
  const seen = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    if (seen.has(name)) return null;
    seen.add(name);
    const value = proxies[name];
    if (!value) return null;
    if (['Direct', 'Reject', 'RejectDrop', 'Pass'].includes(value.type)) return null;
    if (!value.now) return { name, value };
    name = value.now;
  }
  return null;
}

function latestDelay(node, now = Date.now()) {
  const history = node?.value?.history;
  if (!Array.isArray(history) || !history.length) return null;
  const last = history[history.length - 1];
  const delayMs = Number(last?.delay);
  const measuredAt = Date.parse(last?.time);
  if (!(delayMs > 0) || !Number.isFinite(measuredAt) || now - measuredAt < 0 || now - measuredAt > 60 * 60 * 1000) return null;
  return { delayMs: Math.round(delayMs), measuredAt, nodeName: node.name };
}

function readProxies(httpApi, socketPath, secret) {
  return new Promise((resolve, reject) => {
    const request = httpApi.request({
      socketPath, path: '/proxies', method: 'GET', timeout: 1_500,
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error('controller-unavailable')); return; }
      let body = '';
      response.setEncoding?.('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 2_000_000) request.destroy(new Error('response-too-large'));
      });
      response.on('end', () => {
        try { resolve(JSON.parse(body).proxies || {}); } catch (error) { reject(error); }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('controller-timeout')));
    request.on('error', reject);
    request.end();
  });
}

function createClashVergeDelayReader(options = {}) {
  const readFile = options.readFile || (file => fs.promises.readFile(file, 'utf8'));
  const httpApi = options.http || http;
  const now = options.now || Date.now;
  const configPath = options.configPath || path.join(process.env.APPDATA || '', 'io.github.clash-verge-rev.clash-verge-rev', 'clash-verge.yaml');
  const listPipes = options.listPipes || listVergeMihomoPipes;
  const ttlMs = Math.max(5_000, Number(options.ttlMs) || 30_000);
  let cached = null;
  let pending = null;
  async function sample() {
    if (cached && now() - cached.at < ttlMs) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      let value = { status: 'unavailable' };
      try {
        const config = await readFile(configPath);
        // Never connect to an arbitrary address from a configuration file.
        for (const socketPath of controllerPipeCandidates(config, listPipes)) {
          let proxies;
          try { proxies = await readProxies(httpApi, socketPath, yamlScalar(config, 'secret')); } catch { continue; }
          const measurement = latestDelay(selectedNode(proxies), now());
          if (measurement) value = { status: 'ok', ...measurement };
          break;
        }
      } catch { /* Clash may be closed or expose no controller. */ }
      cached = { at: now(), value };
      return value;
    })().finally(() => { pending = null; });
    return pending;
  }
  return { sample };
}

module.exports = {
  createClashVergeDelayReader, selectedNode, latestDelay, yamlScalar, controllerPipeCandidates, listVergeMihomoPipes,
};
