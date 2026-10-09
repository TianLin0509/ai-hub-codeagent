'use strict';

const path = require('node:path');

const DEFAULT_MAX_SOURCES = 10_000;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_CHARS = 1024 * 1024;
const DEFAULT_MAX_DOC_CHARS = 128 * 1024;
const DEFAULT_MAX_CANDIDATE_SESSIONS = 1200;
// 2026-08-28 压测：这个上限同时是「每个词的候选行上限」和「打分阶段总行数上限」。
// 20000 时常见词（***、not、hub、的）一次要取两万行，打分阶段 139~316ms；
// 降到 6000 后候选查询本身也从 ~110ms 掉到 ~20ms（LIMIT 越小越早停）。
// 结果只展示 50 个会话，候选按最近活动排序，6000 行足够填满且截断会如实上报。
const DEFAULT_MAX_QUERY_DOCS = 6_000;

function sqlitePathForLegacyCache(cachePath) {
  if (!cachePath) return null;
  return path.join(path.dirname(cachePath), 'session-search-v3.sqlite');
}

module.exports = {
  DEFAULT_MAX_CANDIDATE_SESSIONS,
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_QUERY_DOCS,
  DEFAULT_MAX_SOURCE_CHARS,
  DEFAULT_MAX_SOURCES,
  sqlitePathForLegacyCache,
};
