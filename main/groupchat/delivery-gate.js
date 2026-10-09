'use strict';
// Hub-run test gate on a build candidate. The Hub itself runs the project's
// declared test commands on the exact commit, so the result can be trusted by
// the reviewer; a failure goes back to the builder without spending a review.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const TIMEOUT_MS = 40 * 60_000;
const TAIL_LINES = 80;

// The last CANDIDATE line wins (a delivery may quote an earlier candidate first).
function parseCandidate(text) {
  const all = [...String(text || '').matchAll(/CANDIDATE:[*_`\s]*(.+?)\s+[`"']?([0-9a-fA-F]{40})(?![0-9a-fA-F])/g)];
  const m = all.at(-1);
  return m ? { worktree: m[1].trim().replace(/^[*_"'`]+|[*_"'`]+$/g, ''), sha: m[2].toLowerCase() } : null;
}
function git(cwd, args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim(); }
// The gate must not inherit this Hub's control channel or data directory.
function gateEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_HUB_')) delete env[k];
  return env;
}
// Returns { commands } or { skipped: reason }. Never throws.
function preflight(candidate) {
  if (!candidate) return { skipped: '交付中没有 CANDIDATE 行' };
  const { worktree, sha } = candidate;
  try {
    if (!path.isAbsolute(worktree) || !fs.statSync(worktree).isDirectory()) return { skipped: `候选目录不存在：${worktree}` };
    if (git(worktree, ['rev-parse', 'HEAD']).toLowerCase() !== sha) return { skipped: `候选目录当前提交不是 ${sha}` };
    if (git(worktree, ['status', '--porcelain', '--untracked-files=no'])) return { skipped: '候选目录有未提交改动，测试结果无法绑定该提交' };
    const config = JSON.parse(fs.readFileSync(path.join(worktree, '.agents', 'project.json'), 'utf8'));
    const commands = (Array.isArray(config.test) ? config.test : []).filter(c => typeof c === 'string' && c.trim());
    return commands.length ? { commands } : { skipped: '项目未声明测试命令（.agents/project.json 的 test）' };
  } catch (error) { return { skipped: `无法核对候选：${error.message.split('\n')[0]}` }; }
}
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}
function runCommand(command, cwd, log, timeoutMs, signal) {
  return new Promise(resolve => {
    fs.appendFileSync(log, `\n$ ${command}\n`, 'utf8');
    const child = spawn(command, { cwd, env: gateEnv(), shell: true, windowsHide: true, detached: process.platform !== 'win32' });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
    const append = chunk => { try { fs.appendFileSync(log, chunk); } catch {} };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => { append(`\n[hub-gate] 超时 ${Math.round(timeoutMs / 60000)} 分钟，已终止\n`); killTree(child); }, timeoutMs);
    const abort = () => { append('\n[hub-gate] Hub 退出，已终止\n'); killTree(child); };
    signal?.addEventListener('abort', abort, { once: true });
    const done = code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(code); };
    child.on('error', error => { append(`\n[hub-gate] ${error.message}\n`); done(-1); });
    child.on('close', code => done(code === null ? -1 : code));
  });
}
function tail(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-TAIL_LINES).join('\n'); } catch { return ''; }
}
// Runs commands sequentially; stops at the first failure.
async function runGate({ candidate, commands, logPath, timeoutMs = TIMEOUT_MS, signal }) {
  const started = Date.now();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `Hub 测试闸门 · ${candidate.sha}\n工作目录：${candidate.worktree}\n`, 'utf8');
  for (const command of commands) {
    const exitCode = await runCommand(command, candidate.worktree, logPath, timeoutMs, signal);
    if (signal?.aborted) return { state: 'cancelled' };
    if (exitCode !== 0) return { state: 'failed', sha: candidate.sha, worktree: candidate.worktree, commands, failedCommand: command, exitCode, durationMs: Date.now() - started, logPath };
  }
  return { state: 'passed', sha: candidate.sha, worktree: candidate.worktree, commands, exitCode: 0, durationMs: Date.now() - started, logPath };
}
// A pinned input for the next build step, like a member delivery.
function writeFailureNote(file, result) {
  const text = [`# Hub 测试闸门未通过`, '', `候选：${result.worktree} ${result.sha}`, `失败命令：${result.failedCommand}（退出码 ${result.exitCode}）`, `完整日志：${result.logPath}`, '',
    '## 日志末尾', '', '```', tail(result.logPath), '```', ''].join('\n');
  fs.writeFileSync(file, text, 'utf8');
  return { path: file, hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), outcome: 'hub-gate' };
}

module.exports = { TIMEOUT_MS, parseCandidate, preflight, runGate, writeFailureNote, gateEnv };
