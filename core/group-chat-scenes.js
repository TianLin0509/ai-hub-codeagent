'use strict';
// Group chat scene helpers for research MCP injection.
// Prompt assembly lives in core/group-chat-orchestrator.js.
// This file only keeps the two helpers needed to attach stock research tools.
const fs = require('fs');
const os = require('os');
const path = require('path');

function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}


module.exports = {
};
