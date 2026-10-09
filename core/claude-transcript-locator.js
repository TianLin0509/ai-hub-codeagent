'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECT_ROOT_DIRS = [
  '.claude',
  '.claude-deepseek',
];

function defaultHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function claudeProjectRoots(homeDir = defaultHomeDir()) {
  const roots = CLAUDE_PROJECT_ROOT_DIRS.map(dir => path.join(homeDir, dir, 'projects'));
  // 公司 Code Agent 的记录与 Claude 同格式，放在它自己的配置目录（默认 ~/.cac）下。
  try {
    const { configDir } = require('./codeagent-config').resolveCodeAgentConfig({ ...process.env, USERPROFILE: homeDir, HOME: homeDir });
    const root = path.join(configDir, 'projects');
    if (!roots.some(item => path.resolve(item).toLowerCase() === path.resolve(root).toLowerCase())) roots.push(root);
  } catch {}
  return roots;
}

function findTranscriptByCCSessionId(ccSessionId, homeDir = defaultHomeDir()) {
  if (!ccSessionId) return null;
  for (const projectsDir of claudeProjectRoots(homeDir)) {
    try {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const candidate = path.join(projectsDir, d.name, ccSessionId + '.jsonl');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return null;
}

// Claude CLI buckets transcripts by cwd: every non-alphanumeric char becomes '-'.
// `claude --resume <id>` only looks inside the bucket for the *current* cwd, so a
// workspace that moves on disk (scratch → 正式分类归档) leaves its transcript behind
// and the resume fails with "No conversation found with session ID".
function projectSlug(cwd) {
  return path.resolve(String(cwd || '')).replace(/[^A-Za-z0-9]/g, '-');
}

// Copy each session's transcript into the bucket for `toCwd` so the post-archive
// `--resume` finds it. Best-effort: the archive itself already succeeded, so a
// failure here must degrade to "resumes without history", never abort the move.
function migrateTranscriptsForCwdChange(opts = {}) {
  const { toCwd, ccSessionIds = [] } = opts;
  const homeDir = opts.homeDir || defaultHomeDir();
  const logger = opts.logger || console;
  const result = { copied: [], missing: [], errors: [] };
  if (!toCwd) return result;
  const slug = projectSlug(toCwd);

  for (const ccSessionId of ccSessionIds) {
    if (!ccSessionId) continue;
    try {
      const source = findTranscriptByCCSessionId(ccSessionId, homeDir);
      if (!source) {
        result.missing.push(ccSessionId);
        continue;
      }
      // <homeDir>/<.claude|.claude-deepseek>/projects/<slug>/<sid>.jsonl —
      // keep the copy under the same root the CLI variant reads from.
      const projectsDir = path.dirname(path.dirname(source));
      const targetDir = path.join(projectsDir, slug);
      const target = path.join(targetDir, `${ccSessionId}.jsonl`);
      if (path.resolve(source) === path.resolve(target)) {
        result.copied.push(target);
        continue;
      }
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(source, target);
      result.copied.push(target);
    } catch (error) {
      result.errors.push(`${ccSessionId}: ${error && error.message ? error.message : String(error)}`);
      logger.warn?.('[transcript] migrate failed:', error && error.message);
    }
  }
  return result;
}

function extractCwdFromTranscript(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, n).toString('utf-8');
      const m = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse('"' + m[1] + '"');
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return null;
}

function healPersistedCwds(sessions, opts = {}) {
  const logger = opts.logger || console;
  const homeDir = opts.homeDir || defaultHomeDir();
  let fixed = 0;
  for (const s of sessions) {
    if (!s.ccSessionId) continue;
    // 已持久化的 transcriptPath 比按 sid 找到的“第一份副本”更具体；归档会把同一
    // jsonl 复制到新旧两个 bucket，目录枚举顺序不能当权威。
    const tp = (s.transcriptPath && fs.existsSync(s.transcriptPath))
      ? s.transcriptPath
      : findTranscriptByCCSessionId(s.ccSessionId, homeDir);
    if (!tp) continue;
    const realCwd = extractCwdFromTranscript(tp);
    if (!realCwd) continue;

    // transcript 迁移只复制 jsonl，不改写历史消息里的 cwd，所以候选值可能仍是已经
    // 删除的旧 scratch。把 Home “自愈”回另一个失效路径只是制造一次假修复。
    let targetIsDirectory = false;
    try { targetIsDirectory = fs.statSync(realCwd).isDirectory(); } catch {}
    if (!targetIsDirectory) {
      logger.warn?.(`[群聊] skip invalid transcript cwd for "${s.title}": ${realCwd}`);
      continue;
    }

    const key = value => {
      const resolved = path.resolve(String(value || ''));
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    };
    if (key(realCwd) === key(s.cwd)) continue;
    logger.log?.(`[群聊] heal cwd: "${s.title}" ${s.cwd} -> ${realCwd}`);
    s.cwd = realCwd;
    delete s.cwdFellBackFrom;
    fixed++;
  }
  return fixed;
}

module.exports = {
  CLAUDE_PROJECT_ROOT_DIRS,
  claudeProjectRoots,
  extractCwdFromTranscript,
  findTranscriptByCCSessionId,
  healPersistedCwds,
  migrateTranscriptsForCwdChange,
  projectSlug,
};
