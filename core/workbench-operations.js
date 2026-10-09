'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFile: execFileCallback } = require('child_process');
const { promisify } = require('util');
const { normalizeOperationsConfig } = require('./operations-config.js');
const { acquireLockAsync, releaseLockAsync } = require('./file-lock.js');

const execFileAsync = promisify(execFileCallback);
const MAX_WORKSPACES = 10;
const MAX_FILES_PER_REPO = 300;
const MAX_RECENT_FILES = 24;
const MAX_DIFF_BYTES = 6 * 1024 * 1024;
const OVERVIEW_CACHE_MS = 8_000;
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function hashText(value, length = 16) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function normalizePathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathInside(parent, candidate) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isBroadWorkspaceRoot(value) {
  if (!value) return true;
  const resolved = path.resolve(value);
  const key = normalizePathKey(resolved).replace(/[\\/]+$/, '');
  const drive = normalizePathKey(path.parse(resolved).root).replace(/[\\/]+$/, '');
  const home = normalizePathKey(os.homedir()).replace(/[\\/]+$/, '');
  const vibe = normalizePathKey('C:\\Workspace').replace(/[\\/]+$/, '');
  return key === drive || key === home || key === vibe;
}

function sanitizeWorkspaceHints(raw) {
  const source = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  return source
    .filter(item => item && typeof item.cwd === 'string' && item.cwd.trim())
    .sort((a, b) => Number(b.lastMessageTime || 0) - Number(a.lastMessageTime || 0))
    .filter(item => {
      const key = normalizePathKey(item.cwd);
      if (seen.has(key) || isBroadWorkspaceRoot(item.cwd)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_WORKSPACES)
    .map(item => ({
      cwd: path.resolve(item.cwd),
      sessionId: String(item.sessionId || item.id || ''),
      title: String(item.title || '').slice(0, 160),
      kind: String(item.kind || '').slice(0, 32),
      lastMessageTime: Number(item.lastMessageTime || 0),
    }));
}

async function mapLimit(items, limit, worker) {
  const input = Array.isArray(items) ? items : [];
  const output = new Array(input.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < input.length) {
      const index = nextIndex++;
      output[index] = await worker(input[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), input.length) }, run));
  return output;
}

function parsePorcelainZ(stdout) {
  const fields = String(stdout || '').split('\0');
  const files = [];
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (!filePath) continue;
    let originalPath = '';
    if (/[RC]/.test(status)) originalPath = fields[++index] || '';
    files.push({
      path: filePath.replace(/\\/g, '/'),
      originalPath: originalPath.replace(/\\/g, '/'),
      status,
      staged: status[0] !== ' ' && status[0] !== '?',
      unstaged: status[1] !== ' ',
      untracked: status === '??',
      conflicted: /U|AA|DD/.test(status),
    });
  }
  return files;
}

function parseNumstat(stdout) {
  const result = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const key = parts.slice(2).join('\t').replace(/\\/g, '/');
    const additions = Number(parts[0]);
    const deletions = Number(parts[1]);
    result.set(key, {
      additions: Number.isFinite(additions) ? additions : null,
      deletions: Number.isFinite(deletions) ? deletions : null,
      binary: parts[0] === '-' || parts[1] === '-',
    });
  }
  return result;
}

function mergeNumstat(...maps) {
  const result = new Map();
  for (const map of maps) {
    for (const [key, value] of map.entries()) {
      const previous = result.get(key) || { additions: 0, deletions: 0, binary: false };
      result.set(key, {
        additions: value.additions == null || previous.additions == null
          ? null : previous.additions + value.additions,
        deletions: value.deletions == null || previous.deletions == null
          ? null : previous.deletions + value.deletions,
        binary: previous.binary || value.binary,
      });
    }
  }
  return result;
}

function classifyFileRisk(file) {
  const name = String(file.path || '').toLowerCase();
  const changedLines = Math.max(0, Number(file.additions || 0)) + Math.max(0, Number(file.deletions || 0));
  let score = 10;
  const reasons = [];
  if (file.conflicted) { score += 90; reasons.push('存在 Git 冲突'); }
  if (/(^|\/)(main|preload)\.(?:js|ts)$|ipc|permission|auth|secret|credential|\.env|package-lock\.json/.test(name)) {
    score += 42; reasons.push('触及启动、权限、IPC 或敏感配置');
  }
  if (/migration|state-store|session-store|database|persist|cache|storage/.test(name)) {
    score += 30; reasons.push('触及持久化或缓存');
  }
  if (/(^|\/)core\//.test(name)) { score += 14; reasons.push('核心逻辑变更'); }
  if (file.binary) { score += 20; reasons.push('二进制内容无法逐行审阅'); }
  if (changedLines >= 500) { score += 35; reasons.push(`改动规模较大（${changedLines} 行）`); }
  else if (changedLines >= 150) { score += 18; reasons.push(`改动超过 ${changedLines} 行`); }
  if (file.untracked) { score += 8; reasons.push('新文件尚未纳入版本控制'); }
  const level = score >= 70 ? 'high' : score >= 38 ? 'medium' : 'low';
  return { score, level, reasons: reasons.length ? reasons : ['局部、低规模改动'] };
}

function summarizeRepoRisk(files) {
  const max = files.reduce((value, file) => Math.max(value, file.riskScore || 0), 0);
  const totalLines = files.reduce((value, file) => value + Math.max(0, file.additions || 0) + Math.max(0, file.deletions || 0), 0);
  const score = Math.min(100, max + (files.length >= 12 ? 12 : files.length >= 5 ? 6 : 0) + (totalLines >= 1000 ? 10 : 0));
  return { score, level: score >= 70 ? 'high' : score >= 38 ? 'medium' : 'low' };
}

function parseCommitRecord(raw) {
  const parts = String(raw || '').trim().split('\x1f');
  if (parts.length < 6) return null;
  return {
    hash: parts[0], shortHash: parts[1], timestamp: Number(parts[2]) * 1000,
    author: parts[3], email: parts[4], subject: parts.slice(5).join('\x1f'),
  };
}

function requestBody(urlValue, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlValue); } catch { reject(new Error('invalid_url')); return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { reject(new Error('invalid_protocol')); return; }
    const transport = parsed.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    const request = transport.request(parsed, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain;q=0.8',
        'User-Agent': 'AI-HUB-Operations/1.0',
        ...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {}),
      },
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects < 2) {
        response.resume();
        let redirected;
        try {
          redirected = new URL(response.headers.location, parsed);
        } catch {
          reject(new Error('invalid_redirect'));
          return;
        }
        // Never leak a configured bearer token to a different redirect origin.
        resolve(requestBody(redirected.toString(), {
          ...options,
          bearerToken: redirected.origin === parsed.origin ? options.bearerToken : '',
        }, redirects + 1));
        return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes <= 256 * 1024) chunks.push(chunk);
        else request.destroy(new Error('response_too_large'));
      });
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = text.trim(); }
        resolve({ statusCode: response.statusCode || 0, body, latencyMs: Date.now() - startedAt });
      });
    });
    request.setTimeout(Math.max(500, Number(options.timeoutMs) || 3_500), () => request.destroy(new Error('timeout')));
    request.on('error', reject);
    request.end();
  });
}

function firstFinite(...values) {
  for (const value of values) {
    if (value == null || value === '' || typeof value === 'boolean') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function nested(source, pathValue) {
  return String(pathValue).split('.').reduce((value, key) => value && value[key], source);
}

function parseStorageMetrics(body) {
  if (!body || typeof body !== 'object') return null;
  const candidates = [
    body.storage, body.disk, nested(body, 'metrics.storage'), nested(body, 'metrics.disk'),
    nested(body, 'data.storage'), nested(body, 'data.disk'),
  ].filter(value => value && typeof value === 'object');
  for (const value of candidates) {
    const totalBytes = firstFinite(value.totalBytes, value.total_bytes, value.total);
    const usedBytes = firstFinite(value.usedBytes, value.used_bytes, value.used);
    const freeBytes = firstFinite(value.freeBytes, value.free_bytes, value.free);
    let usagePct = firstFinite(value.usagePct, value.usage_pct, value.usedPct, value.used_percent, value.percent);
    if (usagePct != null && usagePct <= 1) usagePct *= 100;
    if (usagePct == null && totalBytes > 0 && usedBytes != null) usagePct = usedBytes / totalBytes * 100;
    if (usagePct == null && totalBytes > 0 && freeBytes != null) usagePct = (totalBytes - freeBytes) / totalBytes * 100;
    return {
      totalBytes, usedBytes, freeBytes,
      usagePct: usagePct == null ? null : Math.max(0, Math.min(100, Math.round(usagePct))),
      mount: String(value.mount || value.path || '/'),
    };
  }
  return null;
}

async function readRemoteServerStatus(config, options = {}) {
  const monitor = normalizeOperationsConfig(config).aliyunMonitor;
  const checkedAt = Date.now();
  if (!monitor.enabled || !monitor.healthUrl) {
    return { configured: false, online: false, label: monitor.label, checkedAt };
  }
  try {
    const health = await (options.request || requestBody)(monitor.healthUrl, {
      bearerToken: monitor.bearerToken,
      timeoutMs: options.timeoutMs,
    });
    const online = health.statusCode >= 200 && health.statusCode < 300
      && !(health.body && typeof health.body === 'object' && (
        health.body.ok === false
        || health.body.healthy === false
        || /^(?:down|error|failed)$/i.test(String(health.body.status || ''))
      ));
    let metricsBody = health.body;
    let metricsError = '';
    if (online && monitor.metricsUrl && monitor.metricsUrl !== monitor.healthUrl) {
      try {
        const metrics = await (options.request || requestBody)(monitor.metricsUrl, {
          bearerToken: monitor.bearerToken,
          timeoutMs: options.timeoutMs,
        });
        if (metrics.statusCode >= 200 && metrics.statusCode < 300) metricsBody = metrics.body;
        else metricsError = `HTTP ${metrics.statusCode}`;
      } catch (error) {
        metricsError = error && error.message ? error.message : 'metrics_failed';
      }
    }
    return {
      configured: true,
      online,
      label: monitor.label,
      checkedAt,
      latencyMs: health.latencyMs,
      statusCode: health.statusCode,
      storage: parseStorageMetrics(metricsBody),
      cpuPct: firstFinite(nested(metricsBody, 'cpuPct'), nested(metricsBody, 'cpu.usagePct'), nested(metricsBody, 'metrics.cpuPct')),
      memoryPct: firstFinite(nested(metricsBody, 'memoryPct'), nested(metricsBody, 'memory.usagePct'), nested(metricsBody, 'metrics.memoryPct')),
      metricsError: metricsError || null,
      error: online ? null : `HTTP ${health.statusCode}`,
    };
  } catch (error) {
    return {
      configured: true, online: false, label: monitor.label, checkedAt,
      error: error && error.message ? error.message : 'unreachable',
    };
  }
}

function parseUnifiedDiff(raw, layer = 'working') {
  const text = String(raw || '');
  const hunks = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (match) {
      if (current) hunks.push(current);
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      current = { header: line, layer, lines: [] };
      continue;
    }
    if (!current) continue;
    let kind = 'context';
    let oldNumber = oldLine;
    let newNumber = newLine;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      kind = 'add'; oldNumber = null; newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      kind = 'del'; newNumber = null; oldLine += 1;
    } else if (line.startsWith('\\ No newline')) {
      kind = 'meta'; oldNumber = null; newNumber = null;
    } else {
      oldLine += 1; newLine += 1;
    }
    current.lines.push({ kind, oldLine: oldNumber, newLine: newNumber, text: line });
  }
  if (current) hunks.push(current);
  for (const hunk of hunks) hunk.id = hashText(`${layer}\n${hunk.header}\n${hunk.lines.map(line => line.text).join('\n')}`, 20);
  return hunks;
}

function synthesizeUntrackedDiff(text) {
  const lines = String(text || '').split(/\r?\n/).slice(0, 2_000);
  const header = `@@ -0,0 +1,${lines.length} @@ 新文件`;
  const hunk = {
    header,
    layer: 'untracked',
    lines: lines.map((line, index) => ({ kind: 'add', oldLine: null, newLine: index + 1, text: `+${line}` })),
  };
  hunk.id = hashText(`untracked\n${header}\n${text}`, 20);
  return [hunk];
}

function hunkEvidenceHash(hunk) {
  if (!hunk) return null;
  return hashText(`${hunk.header}\n${(hunk.lines || []).map(line => line.text).join('\n')}`, 32);
}

function sanitizeSessionHints(hints, repoRoot) {
  return sanitizeWorkspaceHints(hints)
    .filter(hint => isPathInside(repoRoot, hint.cwd) || isPathInside(hint.cwd, repoRoot))
    .map(hint => ({
      sessionId: hint.sessionId,
      title: hint.title,
      kind: hint.kind,
      cwd: hint.cwd,
      lastMessageTime: hint.lastMessageTime,
    }));
}

function createWorkbenchOperationsService(options = {}) {
  const dataDir = path.resolve(options.dataDir || path.join(os.homedir(), '.ai-hub-community'));
  const getConfig = options.getConfig || (() => ({}));
  const execFile = options.execFile || execFileAsync;
  const now = options.now || Date.now;
  const request = options.request;
  const logger = options.logger || console;
  const cache = { key: '', at: 0, value: null, pending: null };
  const checkpointLocks = new Map();
  const reviewLocks = new Map();

  async function runGit(repoRoot, args, extra = {}) {
    const result = await execFile('git', args, {
      cwd: repoRoot,
      windowsHide: true,
      timeout: extra.timeout || 8_000,
      maxBuffer: extra.maxBuffer || MAX_DIFF_BYTES,
      encoding: 'utf8',
      env: extra.env || process.env,
    });
    return String(result && result.stdout || '');
  }

  async function resolveRepoRoot(cwd) {
    if (!cwd || isBroadWorkspaceRoot(cwd)) return null;
    try {
      const stat = await fs.promises.stat(cwd);
      if (!stat.isDirectory()) return null;
      const root = (await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim();
      return root && !isBroadWorkspaceRoot(root) ? path.resolve(root) : null;
    } catch {
      return null;
    }
  }

  async function scanRepo(repoRoot, hints) {
    const [statusRaw, unstagedRaw, stagedRaw, branchRaw, headRaw, commitRaw] = await Promise.all([
      runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      runGit(repoRoot, ['diff', '--numstat', '--no-renames']),
      runGit(repoRoot, ['diff', '--cached', '--numstat', '--no-renames']),
      runGit(repoRoot, ['branch', '--show-current']).catch(() => ''),
      runGit(repoRoot, ['rev-parse', 'HEAD']).catch(() => ''),
      runGit(repoRoot, ['log', '-1', '--format=%H%x1f%h%x1f%at%x1f%an%x1f%ae%x1f%s']).catch(() => ''),
    ]);
    const allStatusFiles = parsePorcelainZ(statusRaw);
    const statusFiles = allStatusFiles.slice(0, MAX_FILES_PER_REPO);
    const stats = mergeNumstat(parseNumstat(unstagedRaw), parseNumstat(stagedRaw));
    const associated = sanitizeSessionHints(hints, repoRoot);
    const files = await Promise.all(statusFiles.map(async file => {
      const stat = stats.get(file.path) || { additions: null, deletions: null, binary: false };
      const absolutePath = path.resolve(repoRoot, file.path);
      let modifiedAt = 0;
      let size = null;
      let isSymlink = false;
      let exists = false;
      let isFile = false;
      try {
        const info = await fs.promises.lstat(absolutePath);
        exists = true;
        modifiedAt = info.mtimeMs;
        size = info.size;
        isSymlink = info.isSymbolicLink();
        isFile = info.isFile();
      } catch {}
      if (file.untracked && !isSymlink && Number.isFinite(size) && size <= 1024 * 1024) {
        try {
          const buffer = await fs.promises.readFile(absolutePath);
          if (!buffer.includes(0)) {
            const text = buffer.toString('utf8');
            stat.additions = text ? text.split(/\r?\n/).length - (text.endsWith('\n') ? 1 : 0) : 0;
            stat.deletions = 0;
          }
        } catch {}
      }
      const risk = classifyFileRisk({ ...file, ...stat });
      const nearestCandidate = associated
        .filter(item => item.lastMessageTime > 0)
        .sort((a, b) => Math.abs((modifiedAt || now()) - a.lastMessageTime) - Math.abs((modifiedAt || now()) - b.lastMessageTime))[0] || null;
      const nearestSession = nearestCandidate
        && Math.abs((modifiedAt || now()) - nearestCandidate.lastMessageTime) <= 24 * 60 * 60_000
        ? nearestCandidate
        : null;
      return {
        ...file, ...stat, absolutePath, modifiedAt, size, exists, isFile, isSymlink,
        risk: risk.level, riskScore: risk.score, riskReasons: risk.reasons,
        session: nearestSession,
      };
    }));
    files.sort((a, b) => b.riskScore - a.riskScore || b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path));
    const risk = summarizeRepoRisk(files);
    const commit = parseCommitRecord(commitRaw);
    return {
      id: hashText(normalizePathKey(repoRoot)),
      root: repoRoot,
      name: path.basename(repoRoot),
      branch: branchRaw.trim() || '(detached)',
      head: headRaw.trim(),
      commit,
      files,
      risk: risk.level,
      riskScore: risk.score,
      additions: files.reduce((sum, file) => sum + Math.max(0, file.additions || 0), 0),
      deletions: files.reduce((sum, file) => sum + Math.max(0, file.deletions || 0), 0),
      testFiles: files.filter(file => /(^|\/)(?:test|tests|spec|specs)(\/|\.)|\.(?:test|spec)\./i.test(file.path)).length,
      sessions: associated,
      totalFileCount: allStatusFiles.length,
      truncated: allStatusFiles.length > statusFiles.length,
    };
  }

  async function listCheckpoints(repoRoot = '') {
    const dir = path.join(dataDir, 'provenance', 'checkpoints');
    let names = [];
    try { names = await fs.promises.readdir(dir); } catch { return []; }
    const wanted = repoRoot ? normalizePathKey(repoRoot) : '';
    const manifests = [];
    for (const name of names.filter(value => /^cp-[a-z0-9-]+\.json$/i.test(value)).sort().slice(-200)) {
      try {
        const parsed = JSON.parse(await fs.promises.readFile(path.join(dir, name), 'utf8'));
        if (!wanted || normalizePathKey(parsed.repoRoot) === wanted) manifests.push(parsed);
      } catch (error) {
        logger.warn?.(`[workbench-operations] checkpoint manifest ignored (${name}): ${error && error.message ? error.message : 'unreadable'}`);
      }
    }
    return manifests.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  }

  function scanError(repoRoot, error) {
    const timedOut = error && (
      error.killed === true
      || error.code === 'ETIMEDOUT'
      || /timed out|timeout/i.test(String(error.message || ''))
    );
    return {
      root: repoRoot,
      name: path.basename(repoRoot),
      error: timedOut ? 'git_scan_timeout' : 'git_scan_failed',
    };
  }

  async function overview(payload = {}) {
    const hints = sanitizeWorkspaceHints(payload.workspaces);
    const key = hashText(JSON.stringify(hints.map(item => [item.cwd, item.lastMessageTime])));
    if (payload.force !== true && cache.value && cache.key === key && now() - cache.at < OVERVIEW_CACHE_MS) return cache.value;
    if (cache.pending && cache.pending.key === key) return cache.pending.promise;
    cache.key = key;
    const scanRequest = { key, promise: null };
    scanRequest.promise = (async () => {
      const rootPairs = await mapLimit(hints, 3, async hint => ({ hint, root: await resolveRepoRoot(hint.cwd) }));
      const grouped = new Map();
      for (const pair of rootPairs) {
        if (!pair.root) continue;
        const rootKey = normalizePathKey(pair.root);
        if (!grouped.has(rootKey)) grouped.set(rootKey, { root: pair.root, hints: [] });
        grouped.get(rootKey).hints.push(pair.hint);
      }
      const scanned = await mapLimit([...grouped.values()], 3, async entry => {
        try { return { repo: await scanRepo(entry.root, entry.hints), error: null }; }
        catch (error) { return { repo: null, error: scanError(entry.root, error) }; }
      });
      const repos = scanned.map(item => item.repo).filter(Boolean).filter(repo => repo.files.length > 0)
        .sort((a, b) => b.riskScore - a.riskScore || b.files.length - a.files.length);
      const scanErrors = scanned.map(item => item.error).filter(Boolean);
      const recentFiles = repos.flatMap(repo => repo.files.filter(file => file.exists && (file.isFile || file.isSymlink)).map(file => ({
        ...file,
        repoId: repo.id,
        repoName: repo.name,
        repoRoot: repo.root,
        source: 'git',
      }))).sort((a, b) => b.modifiedAt - a.modifiedAt || b.riskScore - a.riskScore).slice(0, MAX_RECENT_FILES);
      const remote = await readRemoteServerStatus(getConfig().operations || {}, { request });
      const checkpoints = await listCheckpoints();
      const value = {
        checkedAt: now(),
        repos,
        scanErrors,
        recentFiles,
        remote,
        checkpoints: checkpoints.slice(0, 20),
        summary: {
          repos: repos.length,
          files: repos.reduce((sum, repo) => sum + Number(repo.totalFileCount || repo.files.length), 0),
          highRisk: repos.filter(repo => repo.risk === 'high').length,
          mediumRisk: repos.filter(repo => repo.risk === 'medium').length,
          scanErrors: scanErrors.length,
        },
      };
      if (cache.pending === scanRequest && cache.key === key) {
        cache.value = value;
        cache.at = now();
      }
      return value;
    })().finally(() => {
      if (cache.pending === scanRequest) cache.pending = null;
    });
    cache.pending = scanRequest;
    return scanRequest.promise;
  }

  async function requireRepo(repoRoot) {
    const resolved = await resolveRepoRoot(repoRoot);
    if (!resolved || normalizePathKey(resolved) !== normalizePathKey(repoRoot)) throw new Error('invalid_repo_root');
    return resolved;
  }

  function resolveRepoFile(repoRoot, filePath) {
    const candidate = path.resolve(repoRoot, String(filePath || ''));
    if (!isPathInside(repoRoot, candidate) || candidate === path.resolve(repoRoot)) throw new Error('invalid_file_path');
    return candidate;
  }

  function reviewFilePath(repoRoot) {
    return path.join(dataDir, 'provenance', 'reviews', `${hashText(normalizePathKey(repoRoot), 24)}.json`);
  }

  async function withReviewFileLock(repoRoot, worker) {
    const target = reviewFilePath(repoRoot);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const lockPath = `${target}.lock`;
    const lock = await acquireLockAsync(lockPath, { retries: 100, retryDelayMs: 10 });
    if (!lock) throw new Error('review_state_busy');
    try {
      return await worker();
    } finally {
      await releaseLockAsync(lock, lockPath);
    }
  }

  async function readReviewState(repoRoot) {
    try {
      const raw = await fs.promises.readFile(reviewFilePath(repoRoot), 'utf8');
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new Error('review_state_corrupt'); }
      return parsed && typeof parsed === 'object' ? parsed : { version: 1, decisions: {} };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { version: 1, repoRoot, decisions: {} };
      if (error && error.message === 'review_state_corrupt') throw error;
      throw new Error('review_state_unreadable');
    }
  }

  async function writeReviewState(repoRoot, state) {
    const target = reviewFilePath(repoRoot);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
      await fs.promises.rename(temporary, target);
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function diff(payload = {}) {
    const repoRoot = await requireRepo(payload.repoRoot);
    const absolutePath = resolveRepoFile(repoRoot, payload.filePath);
    const relativePath = path.relative(repoRoot, absolutePath).replace(/\\/g, '/');
    const [workingRaw, stagedRaw, statusRaw] = await Promise.all([
      runGit(repoRoot, ['diff', '--no-ext-diff', '--unified=3', '--', relativePath]).catch(() => ''),
      runGit(repoRoot, ['diff', '--cached', '--no-ext-diff', '--unified=3', '--', relativePath]).catch(() => ''),
      runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--', relativePath]).catch(() => ''),
    ]);
    const status = parsePorcelainZ(statusRaw)[0] || null;
    let hunks = [...parseUnifiedDiff(stagedRaw, 'staged'), ...parseUnifiedDiff(workingRaw, 'working')];
    let binary = /Binary files .* differ|GIT binary patch/.test(`${stagedRaw}\n${workingRaw}`);
    let truncated = false;
    if (!hunks.length && status && status.untracked) {
      try {
        const info = await fs.promises.lstat(absolutePath);
        if (info.isSymbolicLink()) {
          hunks = synthesizeUntrackedDiff(`symlink -> ${await fs.promises.readlink(absolutePath)}`);
        } else {
          const buffer = await fs.promises.readFile(absolutePath);
          if (buffer.includes(0)) binary = true;
          else {
            const text = buffer.toString('utf8');
            truncated = text.split(/\r?\n/).length > 2_000;
            hunks = synthesizeUntrackedDiff(text);
          }
        }
      } catch {}
    }
    if (!hunks.length && binary) {
      const hunk = { header: '二进制文件', layer: status && status.staged ? 'staged' : 'working', lines: [] };
      hunk.id = hashText(`${relativePath}:binary`, 20);
      hunks = [hunk];
    }
    const state = await readReviewState(repoRoot);
    for (const hunk of hunks) hunk.review = state.decisions && state.decisions[`${relativePath}:${hunk.id}`] || null;
    return {
      repoRoot, filePath: relativePath, absolutePath, status,
      hunks, binary, truncated,
      diffHash: hashText(`${stagedRaw}\n${workingRaw}`, 32),
    };
  }

  async function setReviewDecision(payload = {}) {
    const repoRoot = await requireRepo(payload.repoRoot);
    const lockKey = normalizePathKey(repoRoot);
    const previous = reviewLocks.get(lockKey) || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const relativePath = path.relative(repoRoot, resolveRepoFile(repoRoot, payload.filePath)).replace(/\\/g, '/');
      const decision = String(payload.decision || 'pending');
      if (!['accepted', 'rejected', 'pending'].includes(decision)) throw new Error('invalid_review_decision');
      const hunkId = String(payload.hunkId || 'file').replace(/[^a-z0-9_-]/gi, '').slice(0, 64) || 'file';
      const blobBefore = await worktreeBlobId(repoRoot, relativePath);
      const current = await diff({ repoRoot, filePath: relativePath });
      const selectedHunk = hunkId === 'file' ? null : current.hunks.find(hunk => hunk.id === hunkId);
      if (hunkId !== 'file' && !selectedHunk) throw new Error('stale_hunk');
      if (typeof options.onReviewDiffCaptured === 'function') {
        await options.onReviewDiffCaptured({ repoRoot, relativePath, hunkId, current });
      }
      const blobId = await worktreeBlobId(repoRoot, relativePath);
      if (blobBefore !== blobId) throw new Error('stale_hunk');
      const currentHunkIds = new Set(current.hunks.map(hunk => hunk.id));
      return withReviewFileLock(repoRoot, async () => {
        const state = await readReviewState(repoRoot);
        state.version = 1;
        state.repoRoot = repoRoot;
        state.updatedAt = now();
        state.decisions = state.decisions || {};
        const prefix = `${relativePath}:`;
        for (const existingKey of Object.keys(state.decisions)) {
          if (!existingKey.startsWith(prefix)) continue;
          const existingHunkId = existingKey.slice(prefix.length);
          if (existingHunkId !== 'file' && !currentHunkIds.has(existingHunkId)) delete state.decisions[existingKey];
        }
        const key = `${relativePath}:${hunkId}`;
        if (decision === 'pending' && !String(payload.comment || '').trim()) delete state.decisions[key];
        else state.decisions[key] = {
          decision,
          comment: String(payload.comment || '').trim().slice(0, 4_000),
          updatedAt: now(),
          diffHash: current.diffHash,
          blobId,
          hunkHash: selectedHunk ? hunkEvidenceHash(selectedHunk) : null,
          binary: current.binary === true,
        };
        await writeReviewState(repoRoot, state);
        return { ok: true, filePath: relativePath, hunkId, review: state.decisions[key] || null };
      });
    });
    reviewLocks.set(lockKey, pending);
    try {
      return await pending;
    } finally {
      if (reviewLocks.get(lockKey) === pending) reviewLocks.delete(lockKey);
    }
  }

  async function worktreeBlobId(repoRoot, relativePath) {
    const absolutePath = resolveRepoFile(repoRoot, relativePath);
    try {
      await fs.promises.lstat(absolutePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return 'missing';
      throw error;
    }
    return (await runGit(repoRoot, ['hash-object', `--path=${relativePath}`, '--', relativePath], {
      timeout: 20_000,
      maxBuffer: 256 * 1024,
    })).trim();
  }

  async function checkpointBlobId(repoRoot, commit, relativePath) {
    try {
      return (await runGit(repoRoot, ['rev-parse', `${commit}:${relativePath}`], {
        timeout: 20_000,
        maxBuffer: 256 * 1024,
      })).trim();
    } catch {
      return 'missing';
    }
  }

  async function createCheckpoint(payload = {}) {
    const repoRoot = await requireRepo(payload.repoRoot);
    if (checkpointLocks.has(normalizePathKey(repoRoot))) return checkpointLocks.get(normalizePathKey(repoRoot));
    const pending = (async () => {
      const id = `cp-${new Date(now()).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
      const provenanceDir = path.join(dataDir, 'provenance');
      const checkpointDir = path.join(provenanceDir, 'checkpoints');
      const temporaryDir = path.join(provenanceDir, 'tmp');
      await fs.promises.mkdir(checkpointDir, { recursive: true });
      await fs.promises.mkdir(temporaryDir, { recursive: true });
      const indexPath = path.join(temporaryDir, `${id}.index`);
      const env = {
        ...process.env,
        GIT_INDEX_FILE: indexPath,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'AI HUB Checkpoint',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'checkpoint@ai-hub.local',
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'AI HUB Checkpoint',
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'checkpoint@ai-hub.local',
      };
      let createdRef = '';
      try {
        const baseHead = (await runGit(repoRoot, ['rev-parse', 'HEAD']).catch(() => '')).trim();
        if (baseHead) await runGit(repoRoot, ['read-tree', baseHead], { env, timeout: 20_000 });
        else await runGit(repoRoot, ['read-tree', '--empty'], { env, timeout: 20_000 });
        await runGit(repoRoot, ['add', '-A', '--', '.'], { env, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
        const tree = (await runGit(repoRoot, ['write-tree'], { env, timeout: 30_000 })).trim();
        const label = String(payload.label || 'AI HUB review checkpoint').trim().slice(0, 160);
        const commitArgs = ['commit-tree', tree];
        if (baseHead) commitArgs.push('-p', baseHead);
        commitArgs.push('-m', label);
        const commit = (await runGit(repoRoot, commitArgs, { env, timeout: 30_000 })).trim();
        if (typeof options.onCheckpointTreeCaptured === 'function') {
          await options.onCheckpointTreeCaptured({ repoRoot, tree, commit, id });
        }
        const ref = `refs/ai-hub/checkpoints/${id}`;
        await runGit(repoRoot, ['update-ref', ref, commit], { timeout: 20_000 });
        createdRef = ref;
        const branch = (await runGit(repoRoot, ['branch', '--show-current']).catch(() => '')).trim();
        const statusRaw = await runGit(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
        const reviewDecisions = await withReviewFileLock(repoRoot, async () => {
          const reviewState = await readReviewState(repoRoot);
          const valid = {};
          const blobs = new Map();
          const capturedHunks = new Map();
          for (const [key, review] of Object.entries(reviewState.decisions || {}).slice(0, 2_000)) {
            const separator = key.lastIndexOf(':');
            if (separator <= 0 || !review || !review.blobId) continue;
            const relativePath = key.slice(0, separator);
            let blobId = blobs.get(relativePath);
            if (!blobId) {
              blobId = await checkpointBlobId(repoRoot, commit, relativePath);
              blobs.set(relativePath, blobId);
            }
            if (blobId !== review.blobId) continue;
            const hunkId = key.slice(separator + 1);
            if (hunkId !== 'file' && review.binary !== true) {
              let hashes = capturedHunks.get(relativePath);
              if (!hashes) {
                const raw = await runGit(repoRoot, ['diff', '--no-ext-diff', '--unified=3', baseHead || EMPTY_TREE_HASH, commit, '--', relativePath])
                  .catch(() => '');
                hashes = new Set(parseUnifiedDiff(raw, 'checkpoint').map(hunkEvidenceHash).filter(Boolean));
                capturedHunks.set(relativePath, hashes);
              }
              if (!review.hunkHash || !hashes.has(review.hunkHash)) continue;
            }
            valid[key] = review;
          }
          return valid;
        });
        const manifest = {
          version: 1, id, createdAt: now(), label,
          repoRoot, repoName: path.basename(repoRoot), branch: branch || '(detached)',
          baseHead, tree, commit, ref,
          files: parsePorcelainZ(statusRaw),
          sessions: sanitizeSessionHints(payload.sessions, repoRoot),
          reviewDecisions,
          evidence: { tests: 'not_recorded' },
        };
        const manifestPath = path.join(checkpointDir, `${id}.json`);
        const temporaryManifest = `${manifestPath}.${process.pid}.tmp`;
        try {
          await fs.promises.writeFile(temporaryManifest, JSON.stringify(manifest, null, 2), 'utf8');
          await fs.promises.rename(temporaryManifest, manifestPath);
        } finally {
          await fs.promises.rm(temporaryManifest, { force: true }).catch(() => {});
        }
        cache.at = 0;
        return { ok: true, checkpoint: manifest };
      } catch (error) {
        if (createdRef) await runGit(repoRoot, ['update-ref', '-d', createdRef], { timeout: 20_000 }).catch(() => {});
        throw error;
      } finally {
        await fs.promises.rm(indexPath, { force: true }).catch(() => {});
        await fs.promises.rm(`${indexPath}.lock`, { force: true }).catch(() => {});
      }
    })().finally(() => checkpointLocks.delete(normalizePathKey(repoRoot)));
    checkpointLocks.set(normalizePathKey(repoRoot), pending);
    return pending;
  }

  async function restoreCheckpoint(payload = {}) {
    const id = String(payload.checkpointId || '');
    if (!/^cp-[a-z0-9-]+$/i.test(id)) throw new Error('invalid_checkpoint_id');
    const manifestPath = path.join(dataDir, 'provenance', 'checkpoints', `${id}.json`);
    let manifest;
    try {
      const raw = await fs.promises.readFile(manifestPath, 'utf8');
      try { manifest = JSON.parse(raw); } catch { throw new Error('checkpoint_corrupt'); }
    } catch (error) {
      if (error && error.code === 'ENOENT') throw new Error('checkpoint_missing');
      if (error && error.message === 'checkpoint_corrupt') throw error;
      throw new Error('checkpoint_unreadable');
    }
    const repoRoot = await requireRepo(manifest.repoRoot);
    await runGit(repoRoot, ['cat-file', '-e', `${manifest.commit}^{commit}`]);
    const config = normalizeOperationsConfig(getConfig().operations || {});
    const defaultRoot = process.platform === 'win32' && fs.existsSync('C:\\Workspace\\Worktrees')
      ? 'C:\\Workspace\\Worktrees'
      : path.join(os.homedir(), 'AIHubWorktrees');
    const restoreRoot = path.resolve(config.restoreRoot || process.env.CLAUDE_HUB_RESTORE_ROOT || defaultRoot);
    const destination = path.join(restoreRoot, String(manifest.repoName || path.basename(repoRoot)).replace(/[^a-z0-9._-]/gi, '-'), id);
    if (isPathInside(repoRoot, destination) || isPathInside(destination, repoRoot)) throw new Error('unsafe_restore_destination');
    try { await fs.promises.access(destination); throw new Error('restore_destination_exists'); } catch (error) {
      if (error && error.message === 'restore_destination_exists') throw error;
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const branch = `ai-hub/restore-${id.slice(3)}`;
    await runGit(repoRoot, ['worktree', 'add', '-b', branch, destination, manifest.commit], { timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, branch, destination, checkpoint: manifest };
  }

  async function lineProvenance(payload = {}) {
    const repoRoot = await requireRepo(payload.repoRoot);
    const absolutePath = resolveRepoFile(repoRoot, payload.filePath);
    const relativePath = path.relative(repoRoot, absolutePath).replace(/\\/g, '/');
    const line = Math.max(1, Math.min(10_000_000, Number(payload.line) || 1));
    const blameRaw = await runGit(repoRoot, ['blame', '--line-porcelain', '-L', `${line},${line}`, '--', relativePath]);
    const first = blameRaw.split(/\r?\n/, 1)[0] || '';
    const commitHash = first.split(' ')[0] || '';
    if (!/^[a-f0-9]{40}$/i.test(commitHash) || /^0+$/.test(commitHash)) {
      return {
        trust: 'missing', contentTrust: 'missing', confidence: 0, repoRoot, filePath: relativePath, line,
        reason: '该行尚未提交，只有当前工作树证据；先创建 Checkpoint 才能形成可恢复关联。',
        commit: null, checkpoint: null, sessions: [], reviewDecisions: {},
      };
    }
    const commit = parseCommitRecord(await runGit(repoRoot, ['show', '-s', '--format=%H%x1f%h%x1f%at%x1f%an%x1f%ae%x1f%s', commitHash]));
    const commitTree = (await runGit(repoRoot, ['rev-parse', `${commitHash}^{tree}`])).trim();
    const checkpoints = await listCheckpoints(repoRoot);
    const exact = checkpoints.find(item => item.tree === commitTree) || null;
    const hints = sanitizeSessionHints(payload.sessions, repoRoot);
    const inferred = exact ? [] : hints.filter(item => commit && item.lastMessageTime
      && Math.abs(item.lastMessageTime - commit.timestamp) <= 12 * 60 * 60_000).slice(0, 4);
    const exactSessions = exact && Array.isArray(exact.sessions) ? exact.sessions : [];
    const explicitSession = exact && exact.sourceSessionId
      ? exactSessions.find(item => item.sessionId === exact.sourceSessionId) || null
      : null;
    const trust = explicitSession ? 'verified' : exactSessions.length || inferred.length ? 'inferred' : 'missing';
    const reviewDecisions = exact && exact.reviewDecisions && typeof exact.reviewDecisions === 'object'
      ? Object.fromEntries(Object.entries(exact.reviewDecisions).filter(([key]) => key.startsWith(`${relativePath}:`)))
      : {};
    return {
      trust,
      contentTrust: exact ? 'verified' : 'missing',
      confidence: explicitSession ? 100 : exactSessions.length ? 75 : inferred.length ? 65 : 0,
      repoRoot, filePath: relativePath, line, commit, checkpoint: exact,
      sessions: exact ? exactSessions : inferred,
      reviewDecisions,
      reason: explicitSession
        ? 'Git tree、AI HUB Checkpoint 与显式来源 Session 完整闭环，内容和来源均已验证。'
        : exact && exactSessions.length
          ? 'Git tree 与 AI HUB Checkpoint 完全一致，代码内容已验证；Checkpoint 只记录了同工作区 Session，尚无 hook 证明具体因果，因此来源仍标为推断。'
          : exact
            ? 'Git tree 与 AI HUB Checkpoint 完全一致，代码内容已验证；但没有足够记录关联原始 Session 或决策。'
        : inferred.length
          ? '仅依据工作区与时间接近推断，不能证明该 Session 导致了这次提交。'
          : 'Git commit 可验证，但没有足够证据关联到原始 Session 或决策。',
    };
  }

  async function timeline(payload = {}) {
    const repoRoot = await requireRepo(payload.repoRoot);
    const limit = Math.max(5, Math.min(50, Number(payload.limit) || 20));
    const logRaw = await runGit(repoRoot, ['log', `-${limit}`, '--format=%H%x1f%h%x1f%at%x1f%an%x1f%ae%x1f%s']);
    const events = logRaw.split(/\r?\n/).filter(Boolean).map(line => {
      const commit = parseCommitRecord(line);
      return { id: `git:${commit.hash}`, type: 'commit', trust: 'verified', timestamp: commit.timestamp, commit };
    });
    const checkpoints = await listCheckpoints(repoRoot);
    for (const checkpoint of checkpoints.slice(0, limit)) {
      events.push({
        id: `checkpoint:${checkpoint.id}`, type: 'checkpoint', trust: 'verified',
        timestamp: checkpoint.createdAt, checkpoint,
      });
    }
    const hints = sanitizeSessionHints(payload.sessions, repoRoot);
    for (const session of hints.slice(0, limit)) {
      events.push({
        id: `session:${session.sessionId || hashText(session.cwd + session.lastMessageTime)}`,
        type: 'session', trust: 'inferred', timestamp: session.lastMessageTime, session,
      });
    }
    return { repoRoot, events: events.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit * 2) };
  }

  return {
    createCheckpoint,
    diff,
    lineProvenance,
    listCheckpoints,
    overview,
    restoreCheckpoint,
    setReviewDecision,
    timeline,
  };
}

module.exports = {
  MAX_FILES_PER_REPO,
  MAX_RECENT_FILES,
  MAX_WORKSPACES,
  classifyFileRisk,
  createWorkbenchOperationsService,
  isBroadWorkspaceRoot,
  mergeNumstat,
  mapLimit,
  parseNumstat,
  parsePorcelainZ,
  parseStorageMetrics,
  parseUnifiedDiff,
  readRemoteServerStatus,
  requestBody,
  sanitizeWorkspaceHints,
};
