'use strict';
// Pre-publish audit for this public repository: no runtime data, credentials,
// local account directories or machine-specific user paths may be committed.
// Works from a Git checkout (tracked + untracked, respecting .gitignore) and from
// a source ZIP without Git.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'artifacts', 'output']);

function listFiles() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean);
  } catch {
    const out = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(rel); }
        else out.push(rel);
      }
    };
    walk('');
    return out;
  }
}

const FORBIDDEN_PATH = /(^|\/)(?:auth\.json|config\.json|state\.json|\.env(?:\..*)?|\.credentials\.json|Cookies|Login Data|\.claude|\.codex|\.qwen|\.gemini|\.kimi-code|transcripts|electron-userdata|node_modules)(?:\/|$)/i;
const CHECKS = [
  // A real user profile path. Placeholders such as C:\Users\you are allowed.
  ['machine user path', /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!you\b|xxx\b|example-user\b|alice\b|<|%|\$|\{|Public\b|Default\b)[A-Za-z0-9._-]{2,}[\\/]/],
  ['provider key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['email address', /\b[A-Za-z0-9._%+-]+@(?!example\.|users\.noreply\.github\.com|anthropic\.com)[A-Za-z0-9.-]+\.(?:com|cn|edu|org|net)\b/],
];
const TEXT = /\.(?:js|cjs|mjs|json|md|html|css|ps1|bat|cmd|py|yml|yaml|txt)$/i;

const failures = [];
const files = listFiles();
for (const file of files) {
  if (FORBIDDEN_PATH.test(file)) failures.push({ file, rule: 'runtime or account file' });
  const absolute = path.join(root, file);
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { continue; }
  if (stat.isSymbolicLink()) { failures.push({ file, rule: 'symlink' }); continue; }
  if (!TEXT.test(file) || file === 'scripts/audit-public.js' || file === 'package-lock.json') continue;
  const text = fs.readFileSync(absolute, 'utf8');
  if (text.includes('\uFFFD')) failures.push({ file, rule: 'invalid UTF-8' });
  text.split(/\r?\n/).forEach((line, index) => {
    for (const [rule, pattern] of CHECKS) if (pattern.test(line)) failures.push({ file, line: index + 1, rule });
  });
}
console.log(JSON.stringify({ ok: failures.length === 0, files: files.length, failures }, null, 2));
process.exitCode = failures.length ? 1 : 0;
