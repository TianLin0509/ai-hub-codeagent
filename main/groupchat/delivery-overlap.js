'use strict';
// Cross-task awareness: which other in-flight runs have a candidate in the
// same Git repository, and which files they touch. Advisory only — it feeds
// prompts, never blocks a run.
const fs = require('node:fs'), path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseCandidate } = require('./delivery-gate');

const filesBySha = new Map();
function git(cwd, args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim(); }
function repoOf(dir) {
  try { return path.resolve(git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toLowerCase(); } catch { return null; }
}
function trunkOf(worktree) {
  try { return JSON.parse(fs.readFileSync(path.join(worktree, '.agents', 'project.json'), 'utf8')).trunk || 'master'; } catch { return 'master'; }
}
function changedFiles(candidate) {
  if (filesBySha.has(candidate.sha)) return filesBySha.get(candidate.sha);
  let files = [];
  // Only successful lookups are cached; a transient git failure is retried next time.
  try { files = git(candidate.worktree, ['diff', '--name-only', `${trunkOf(candidate.worktree)}...${candidate.sha}`]).split(/\r?\n/).filter(Boolean); filesBySha.set(candidate.sha, files); } catch {}
  return files;
}
// Latest candidate named by a build delivery of this run.
function latestCandidate(run) {
  for (const step of [...(run.steps || [])].reverse()) {
    if (run.stages[step.index]?.phase !== 'build') continue;
    for (const d of Object.values(step.deliveries || {})) {
      try { const c = parseCandidate(fs.readFileSync(d.path, 'utf8')); if (c) return c; } catch {}
    }
  }
  return null;
}
/**
 * others: [{ title, run }] for other non-terminal runs.
 * own: this run's candidate (null before the first build delivery).
 * workspace: fallback repository hint before a candidate exists.
 */
function overlaps({ own, workspace, others }) {
  const repo = own ? repoOf(own.worktree) : workspace ? repoOf(workspace) : null;
  if (!repo) return [];
  const mine = own ? new Set(changedFiles(own)) : null;
  const out = [];
  for (const { title, run } of others) {
    const c = latestCandidate(run);
    if (!c || (own && c.sha === own.sha) || repoOf(c.worktree) !== repo) continue;
    const files = changedFiles(c).filter(f => !mine || mine.has(f));
    if (files.length) out.push({ title, files });
  }
  return out;
}

module.exports = { overlaps, latestCandidate, changedFiles };
