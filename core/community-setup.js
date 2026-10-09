'use strict';
// First-run diagnostic for the community edition: which official CLIs are on
// this machine, and whether the runtime pieces the Hub itself needs are here.
// It never reads credentials; "installed" is not proof of login or model access.
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROVIDERS = Object.freeze([
  { id: 'claude', name: 'Claude Code', command: 'claude', login: 'claude auth login', docs: 'https://code.claude.com/docs/en/setup' },
  { id: 'codex', name: 'Codex', command: 'codex', login: 'codex login', docs: 'https://developers.openai.com/codex/cli/' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', login: 'gemini', docs: 'https://github.com/google-gemini/gemini-cli' },
  { id: 'kimi', name: 'Kimi Code', command: 'kimi', login: 'kimi login', docs: 'https://github.com/MoonshotAI/kimi-cli' },
  // 公司内网的 Code Agent CLI（Claude 形态，见 docs/COMPANY-CODE-AGENT.md）；只在公司电脑上会被检测到。
  { id: 'codeagent', name: 'CodeAgent', command: 'codeagent', login: 'codeagent auth login', docs: 'https://github.com/TianLin0509/ai-hub-codeagent/blob/main/docs/COMPANY-CODE-AGENT.md' },
]);

function searchDirs(command, env, platform) {
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path');
  const dirs = String(env[pathKey] || '').split(path.delimiter).filter(Boolean);
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
    dirs.push(path.join(env.USERPROFILE || os.homedir(), '.local', 'bin'));
  }
  return dirs;
}

function findCommand(command, env = process.env, platform = process.platform) {
  // Code Agent 的命令可以配置成完整路径（例如没有这个 CLI 的电脑上的测试替身）。
  if (command === 'codeagent') {
    const configured = require('./codeagent-config').resolveCodeAgentConfig(env, {}).command;
    if (path.isAbsolute(configured)) { try { return fs.statSync(configured).isFile() ? configured : null; } catch { return null; } }
    command = configured;
  }
  // Codex: the same lookup that actually starts it (account check, login, sessions, App Server),
  // so the first-run panel can never report an install the Hub then fails to launch.
  if (command === 'codex' && platform === 'win32') {
    const found = require('../main/codex-windows-command').locateWindowsCodex(env);
    return found ? (found.command || found.shim) : null;
  }
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of searchDirs(command, env, platform)) for (const extension of extensions) {
    const candidate = path.join(dir.replace(/^"|"$/g, ''), command + extension);
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch (e) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(e.code)) throw e; }
  }
  return null;
}

// Claude Code on Windows runs its tools and hooks through Git Bash.
function findGitBash(env = process.env) {
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    path.join(env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ].filter(Boolean);
  const git = findCommand('git', env);
  if (git) candidates.push(path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe'));
  return candidates.find(candidate => { try { return fs.statSync(candidate).isFile(); } catch { return false; } }) || null;
}

// Managed machines can block the hook script: a Group Policy execution policy
// overrides -ExecutionPolicy Bypass, and Constrained Language Mode blocks the
// .NET calls it needs. Either way the CLI would run but cards never complete.
const POLICY_SCRIPT = '$ExecutionContext.SessionState.LanguageMode; Get-ExecutionPolicy -Scope MachinePolicy; Get-ExecutionPolicy -Scope UserPolicy';

function parsePolicy(error, stdout, stderr) {
  if (error) return { ok: false, detail: String(error.message || stderr || '').trim() };
  const [languageMode, machine, user] = String(stdout).trim().split(/\r?\n/).map(s => s.trim());
  const blocked = ['Restricted', 'AllSigned'];
  return { ok: languageMode === 'FullLanguage' && !blocked.includes(machine) && !blocked.includes(user), languageMode, machine, user };
}

function probePowerShellPolicy(env = process.env) {
  const result = require('child_process').spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', POLICY_SCRIPT],
    { env, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return parsePolicy(result.error || (result.status !== 0 ? new Error('exit ' + result.status) : null), result.stdout, result.stderr);
}

function inspectSetup({ root = path.resolve(__dirname, '..'), env = process.env, platform = process.platform,
  version = process.versions.node, packaged = false, probePolicy = false, knownPolicy = undefined } = {}) {
  const electron = path.join(root, 'node_modules', 'electron', 'dist', platform === 'win32' ? 'electron.exe' : 'electron');
  const providers = PROVIDERS.map(p => ({ ...p, installed: !!findCommand(p.command, env, platform), auth: 'not_checked' }));
  // CLI status hooks run through Windows PowerShell, so no Python or Node is needed for them.
  const requirements = {
    windows: platform === 'win32',
    powershell: platform !== 'win32' || !!findCommand('powershell', env, platform),
    electron: packaged || fs.existsSync(electron),
    ...(packaged ? {} : { node22: Number(String(version).split('.')[0]) >= 22 }),
  };
  const advisories = [];
  if (providers.find(p => p.id === 'claude').installed && platform === 'win32' && !findGitBash(env)) {
    advisories.push('Claude Code 在 Windows 上需要 Git for Windows（Git Bash）；未找到时 Claude 会话无法执行工具。');
  }
  const policy = knownPolicy !== undefined ? knownPolicy : probePolicy ? probePowerShellPolicy(env) : null;
  if (policy && !policy.ok) {
    advisories.push('这台电脑的 PowerShell 策略会拦截 Hub 的状态回报脚本（' + [policy.languageMode, policy.machine, policy.user].filter(Boolean).join(' / ')
      + '），会话能运行但卡片可能一直不显示完成。请联系管理员放行，或在 INSTALL.md 查看说明。');
  }
  return { schemaVersion: 2, edition: 'community', runtime: packaged ? 'bundled' : 'source', hookRunner: 'powershell',
    requirements, ready: Object.values(requirements).every(Boolean), providers, advisories, powershellPolicy: policy,
    next: providers.some(p => p.installed) ? 'Open Accounts, check login, then create a session.' : 'Install one provider with scripts/install-provider.ps1, then sign in.',
    note: 'Command discovery is not proof of login or model access. No credentials are read by this diagnostic.' };
}

// The Hub's first-run panel: probe the PowerShell policy once, off the main
// thread's critical path, and reuse the answer for later refreshes.
let policyProbe = null;
async function inspectSetupAsync(options = {}) {
  if (process.platform === 'win32' && !policyProbe) {
    policyProbe = new Promise(resolve => {
      require('child_process').execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', POLICY_SCRIPT],
        { encoding: 'utf8', windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => resolve(parsePolicy(error, stdout, stderr)));
    });
  }
  const knownPolicy = policyProbe ? await policyProbe : null;
  return inspectSetup({ ...options, knownPolicy });
}

module.exports = { PROVIDERS, findCommand, findGitBash, inspectSetup, inspectSetupAsync, probePowerShellPolicy };
