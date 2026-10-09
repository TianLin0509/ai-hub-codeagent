'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { getHubDataDir } = require('./data-dir.js');

const DEFAULT_LIMIT = 100;
const MAX_READ_BYTES = 2 * 1024 * 1024;

function managedLaunchAuditPath(hubDataDir = getHubDataDir()) {
  return path.join(hubDataDir, 'diagnostics', 'managed-cli-launches.jsonl');
}

function appendManagedLaunchAudit(record, options = {}) {
  if (!record || typeof record !== 'object') return null;
  const auditPath = options.auditPath || managedLaunchAuditPath(options.hubDataDir);
  try {
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
    return auditPath;
  } catch (error) {
    options.logger?.warn?.('[managed-launch] audit append failed:', error && error.message);
    return null;
  }
}

function readTailText(filePath, maxBytes = MAX_READ_BYTES) {
  const stat = fs.statSync(filePath);
  const size = Math.max(0, Number(stat.size) || 0);
  if (size <= maxBytes) return fs.readFileSync(filePath, 'utf8');
  const fd = fs.openSync(filePath, 'r');
  try {
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const text = buffer.toString('utf8');
    const firstNewline = text.indexOf('\n');
    return firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
  } finally {
    fs.closeSync(fd);
  }
}

function inspectManagedLaunchAudit(options = {}) {
  const auditPath = options.auditPath || managedLaunchAuditPath(options.hubDataDir);
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : null;
  const requestedLimit = Number(options.limit);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, 500)
    : DEFAULT_LIMIT;
  let text;
  try {
    text = readTailText(auditPath, options.maxBytes || MAX_READ_BYTES);
  } catch (error) {
    return {
      auditPath,
      exists: !!error && error.code !== 'ENOENT',
      malformedLines: 0,
      readError: error && error.code === 'ENOENT' ? null : (error && error.message ? error.message : String(error)),
      records: [],
    };
  }
  const records = [];
  let malformedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record !== 'object') continue;
      if (sessionId && record.sessionId !== sessionId) continue;
      records.push(record);
    } catch {
      malformedLines += 1;
    }
  }
  return {
    auditPath,
    exists: true,
    malformedLines,
    readError: null,
    records: records.slice(-limit),
  };
}

function readManagedLaunchAudit(options = {}) {
  return inspectManagedLaunchAudit(options).records;
}

module.exports = {
  MAX_READ_BYTES,
  appendManagedLaunchAudit,
  inspectManagedLaunchAudit,
  managedLaunchAuditPath,
  readManagedLaunchAudit,
};
