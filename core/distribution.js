'use strict';

// 发行版判定：只认导出脚本写进源码根目录的 community-edition.json。
// 主仓库没有这个文件，行为与以前完全一致；config.json、环境变量都改不了它，
// 所以公开版里任何配置都打不开私人模块，私人版也不会被误切成社区版。
const fs = require('fs');
const path = require('path');

const MARKER_FILE = path.join(__dirname, '..', 'community-edition.json');

function readMarker(file = MARKER_FILE) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  const parsed = JSON.parse(raw.replace(/^﻿/, ''));
  if (!parsed || parsed.edition !== 'community') throw new Error(`community-edition.json 内容无效：${file}`);
  return parsed;
}

const marker = readMarker();
const community = !!marker;

module.exports = Object.freeze({
  community,
  personalModules: !community,
  // 社区版的产品名与版本；主仓库沿用原标题。
  productName: community ? 'AI Hub Community' : null,
  editionVersion: community ? String(marker.version || '') : null,
  upstreamVersion: community ? String(marker.upstreamVersion || '') : null,
  readMarker,
});
