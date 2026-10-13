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
// 发行目标可以只保留部分 AI（target.json 的 kinds，例如公司纯净版只留 CodeAgent）；没写就全部保留。
// 恢复类 kind（codeagent-resume）跟随它的本体。
function makeKindFilter(kinds) {
  const list = Array.isArray(kinds) && kinds.length ? Object.freeze(kinds.map(String)) : null;
  return { allowedKinds: list, kindAllowed: kind => !list || list.includes(String(kind || '').replace(/-resume$/, '')) };
}
const { allowedKinds, kindAllowed } = makeKindFilter(marker && marker.kinds);

module.exports = Object.freeze({
  community,
  personalModules: !community,
  // 社区版的产品名与版本；主仓库沿用原标题。
  // 发行目标可以换产品显示名与版本标注（公司版 2026-10-13 起有自己的名字和「内测先锋版」标注，见 target.json）。
  // 只改界面上看到的名字；exe 文件名、安装目录、数据目录不变，旧版本能原地升级。
  productName: community ? String(marker.productName || 'AI Hub Community') : null,
  editionBadge: community && marker.editionBadge ? String(marker.editionBadge) : null,
  // 一键更新的下载源（只有写了 update 的发行目标才开启，见 core/app-update）。
  updateConfig: community && marker.update && typeof marker.update === 'object' ? marker.update : null,
  editionVersion: community ? String(marker.version || '') : null,
  upstreamVersion: community ? String(marker.upstreamVersion || '') : null,
  // 发行目标可以关掉个别功能（target.json 的 features，例如公司版关掉助理）；未列出的功能一律开启。
  // 「规则」页的通用规则从哪个频道拉：公司版 target.json 写 company，其余都是 public。
  rulesChannel: (marker && marker.rulesChannel) || 'public',
  featureEnabled: name => !(marker && marker.features && marker.features[name] === false),
  allowedKinds,
  kindAllowed,
  makeKindFilter,
  readMarker,
});
