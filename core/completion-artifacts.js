'use strict';

const fs = require('fs');
const path = require('path');
const { collectPathCandidates } = require('../renderer/path-candidates.js');

const MAX_ARTIFACTS = 3;
const MAX_ARTIFACT_BYTES = 28 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
  '.html', '.htm', '.pdf',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.md', '.txt', '.csv',
  '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt',
  '.zip', '.mp4',
]);
const DELIVERY_SIGNAL_RE = /(?:绝对路径|成果|交付|产物|输出路径|已生成|已保存|可打开|下载地址|artifact|deliverable|generated|saved\s+to|output\s+path|report\s+at|preview\s+at)/i;
const TRUSTED_OUTPUT_RE = /(?:[\\/](?:artifacts?|outputs?)[\\/]|[\\/]AI-Artifacts[\\/]|[\\/]Desktop[\\/]claude-artifacts[\\/]|[\\/]AppData[\\/]Artifacts[\\/]Reports[\\/]|[\\/]\.ai-hub-community[\\/]images[\\/])/i;
const SENSITIVE_SEGMENTS = new Set([
  '.git', 'node_modules', '.ssh', '.aws', '.azure', '.lark-cli', '.codex', '.claude',
  'credentials', 'secrets', 'cookies', 'tokens',
]);
const SENSITIVE_BASENAME_RE = /(?:^|[._-])(?:secret|secrets|credential|credentials|password|passwd|token|tokens|cookie|cookies|id_rsa|private[-_]?key|auth)(?:[._-]|$)/i;

function isInsideCodeFence(text, index) {
  const prefix = String(text || '').slice(0, Math.max(0, index));
  return (prefix.match(/```/g) || []).length % 2 === 1;
}

function hasDeliverySignal(text, candidate, filePath) {
  if (TRUSTED_OUTPUT_RE.test(String(filePath || ''))) return true;
  const normalized = String(text || '');
  const candidateStart = Math.max(0, Number(candidate.start) || 0);
  const before = normalized.slice(Math.max(0, candidateStart - 96), candidateStart);
  return DELIVERY_SIGNAL_RE.test(before);
}

function canonicalPath(filePath) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function isSensitiveArtifactPath(filePath) {
  const normalized = String(filePath || '').replace(/\//g, '\\');
  const lower = normalized.toLowerCase();
  const segments = lower.split(/\\+/).filter(Boolean);
  if (segments.some(segment => SENSITIVE_SEGMENTS.has(segment))) return true;
  if (lower.includes('\\.ai-hub-community\\') && !lower.includes('\\.ai-hub-community\\images\\')) return true;
  return SENSITIVE_BASENAME_RE.test(path.basename(normalized));
}

function artifactKind(extension) {
  if (extension === '.html' || extension === '.htm') return 'html';
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return 'image';
  if (extension === '.pdf') return 'pdf';
  if (['.md', '.txt', '.csv'].includes(extension)) return 'text';
  if (['.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt'].includes(extension)) return 'office';
  if (extension === '.mp4') return 'video';
  return 'archive';
}

function discoverCompletionArtifacts(text, cwd = null, options = {}) {
  const requestedMax = options.maxArtifacts === undefined ? MAX_ARTIFACTS : Number(options.maxArtifacts);
  const maxArtifacts = Math.min(
    MAX_ARTIFACTS,
    Math.max(0, Number.isFinite(requestedMax) ? Math.floor(requestedMax) : MAX_ARTIFACTS),
  );
  if (!text || maxArtifacts === 0) return [];
  const candidates = collectPathCandidates(String(text), cwd || null, { includeDirectories: false });
  const artifacts = [];
  const seen = new Set();

  for (const candidate of candidates) {
    if (candidate.isUrl || isInsideCodeFence(text, candidate.start)) continue;
    const resolved = canonicalPath(candidate.openPath);
    if (!resolved || !hasDeliverySignal(text, candidate, resolved)) continue;
    const extension = path.extname(resolved).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension) || isSensitiveArtifactPath(resolved)) continue;
    const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(identity)) continue;
    let stat;
    try { stat = fs.statSync(resolved); } catch { continue; }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) continue;

    seen.add(identity);
    artifacts.push({
      path: resolved,
      name: path.basename(resolved),
      extension,
      kind: artifactKind(extension),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
    if (artifacts.length >= maxArtifacts) break;
  }
  return artifacts;
}

module.exports = {
  ALLOWED_EXTENSIONS,
  MAX_ARTIFACTS,
  MAX_ARTIFACT_BYTES,
  discoverCompletionArtifacts,
  hasDeliverySignal,
  isInsideCodeFence,
  isSensitiveArtifactPath,
};
