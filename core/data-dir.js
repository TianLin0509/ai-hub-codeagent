const path = require('path');
const os = require('os');

// Resolve the Hub's data directory root.
// Honors CLAUDE_HUB_DATA_DIR env var so parallel test instances can isolate
// state.json / images without touching the production Hub.
// Default: ~/.ai-hub-community (unchanged production path).
function getHubDataDir() {
  const override = process.env.CLAUDE_HUB_DATA_DIR;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), '.ai-hub-community');
}

// 阶段乙（2026-05-03 maintainer）：判定当前 hub 是否运行在隔离模式。
//   隔离 hub 测试时不希望 sub session 的 cwd 落在用户 home（~），
//   否则归档（.arena/sessions/）会污染生产用户的真实档案目录。
//   隔离模式下 sub cwd 走 <HUB_DATA_DIR>/workspaces/<meetingId>/，归档
//   也自然落到隔离路径下，跟生产数据完全隔开。
function isIsolatedHub() {
  return !!(process.env.CLAUDE_HUB_DATA_DIR && process.env.CLAUDE_HUB_DATA_DIR.trim());
}

// 每个会话一份只含对话的聊天记录 md（会话搜索索引派生，见 core/session-transcript-md.js）。
// 「引用会话」把这里的文件路径发给别的会话读，所以 Claude 原生会话要把它加进 --add-dir。
function getHubTranscriptDir() {
  return path.join(getHubDataDir(), 'transcripts');
}

function getMeetingWorkspaceDir(meetingId) {
  return path.join(getHubDataDir(), 'workspaces', meetingId);
}

module.exports = {
  getHubDataDir,
  getHubTranscriptDir,
  isIsolatedHub,
  getMeetingWorkspaceDir,
};
