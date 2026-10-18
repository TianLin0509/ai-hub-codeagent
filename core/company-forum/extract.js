'use strict';
// 从论坛首页的抓取结果里认出热帖（core/company-forum/sites.js 说明了两个站点）。
// 抓取结果来自 Hub 的隐藏浏览器窗口（main/company-forum-browser.js）：页面取数据时截下来的 JSON 响应，加上页面里的链接和板块文字。
// 认帖子的顺序：页面上对应板块里的帖子链接（顺序就是站点自己的排行）→ 截到的 JSON 里像帖子列表的数组 → 板块里的文字行（只有标题）。
// JSON 补阅读、回复、时间这些数字。字段名以公司真机回执 Q-1018-01 第 2 轮为准（稼先 browseCount / commentCount / favoriteCount /
// upvoteCount / submitUsers / resourceId，心声排行卡片里的 postId / title / link），其余按常见写法多认几种。
// 心声的两个排行在同一个「卡片」接口里：数组的每个元素是一张卡片（有自己的标题和 list），按榜名找卡片，不把卡片当帖子。

const pick = (o, keys) => {
  if (!o || typeof o !== 'object') return undefined;
  const lower = new Map(Object.keys(o).map(k => [k.toLowerCase(), k]));
  for (const k of keys) { const real = lower.get(k.toLowerCase()); if (real !== undefined && o[real] !== null && o[real] !== '') return o[real]; }
  return undefined;
};
const TITLE = ['title', 'postTitle', 'topicTitle', 'subject', 'resourceName', 'resourceTitle', 'articleTitle', 'headline', 'name'];
const ID = ['postId', 'topicId', 'tid', 'articleId', 'resourceId', 'infoId', 'contentId', 'id', 'uuid'];
const VIEWS = ['browseCount', 'viewCount', 'readCount', 'views', 'readNum', 'clickCount', 'clickNum', 'browseCount', 'visitCount', 'pv', 'hits', 'readTimes'];
const REPLIES = ['replyCount', 'commentCount', 'replyNum', 'commentNum', 'replies', 'comments', 'commentTotal'];
const LIKES = ['upvoteCount', 'likeCount', 'praiseCount', 'likeNum', 'praiseNum', 'likes', 'upCount', 'thumbsUpCount', 'agreeCount'];
const FAVS = ['collectCount', 'favoriteCount', 'favCount', 'collectNum', 'favorites'];
const TIME = ['publishTime', 'createTime', 'postTime', 'releaseTime', 'createdAt', 'gmtCreate', 'createDate', 'publishDate', 'time'];
const AUTHOR = ['authorName', 'submitUsers', 'author', 'userName', 'nickName', 'nickname', 'creatorName', 'createUserName', 'publisher', 'createBy'];
const BOARD = ['boardName', 'forumName', 'sectionName', 'plateName', 'groupName', 'channelName', 'categoryName', 'columnName'];
const URL_KEYS = ['detailUrl', 'url', 'link', 'href', 'jumpUrl', 'linkUrl'];

const clean = s => String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const titleKey = s => clean(s).replace(/[\s，。、！？!?·:：「」“”"'【】[\]()（）-]/g, '').toLowerCase();
// 「1.2万」「3k」「4,432」都认成数字。
function count(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = /^([\d.,]+)\s*([万wWkK千]?)\+?$/.exec(String(v).trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * ({ 万: 1e4, w: 1e4, W: 1e4, k: 1e3, K: 1e3, 千: 1e3 }[m[2]] || 1));
}
function timeOf(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) { const n = Number(v); return n < 1e11 ? n * 1000 : n; }
  const t = Date.parse(String(v).replace(/^(\d{4}-\d\d-\d\d) (\d)/, '$1T$2'));
  return Number.isFinite(t) ? t : null;
}
const authorOf = v => Array.isArray(v) ? v.map(authorOf).filter(Boolean).slice(0, 3).join('、')
  : typeof v === 'object' && v ? clean(pick(v, ['name', 'userName', 'nickName', 'displayName', 'cnName', 'userNameCn']) || '') : clean(v || '');
// 对象里有没有「至少 3 个对象」的数组：有就是卡片 / 分组这类容器，不是帖子。
const isContainer = o => Object.values(o).some(v => Array.isArray(v) && v.filter(x => x && typeof x === 'object').length >= 3);

// 一个 JSON 对象像不像一条帖子：有像样的标题和编号。
function postFromObject(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o) || isContainer(o)) return null;
  const title = clean(pick(o, TITLE));
  if (title.length < 4 || title.length > 200) return null;
  const idRaw = pick(o, ID);
  const id = idRaw === undefined ? '' : String(idRaw);
  const url = pick(o, URL_KEYS);
  if (!id && !url) return null;
  return {
    id, title, url: typeof url === 'string' ? url : '',
    views: count(pick(o, VIEWS)), replies: count(pick(o, REPLIES)), likes: count(pick(o, LIKES)), favs: count(pick(o, FAVS)),
    time: timeOf(pick(o, TIME)), author: authorOf(pick(o, AUTHOR)), board: clean(pick(o, BOARD) || ''),
  };
}
// JSON 里所有「多数元素像帖子」的数组（至少 3 条），按出现顺序。
function postArrays(json, out = [], depth = 0) {
  if (!json || typeof json !== 'object' || depth > 8) return out;
  if (Array.isArray(json)) {
    const objs = json.filter(x => x && typeof x === 'object' && !Array.isArray(x));
    if (objs.length >= 3) {
      const posts = objs.map(postFromObject);
      const good = posts.filter(Boolean);
      if (good.length >= 3 && good.length / objs.length >= 0.6) { out.push(good); return out; }
    }
    for (const x of json) postArrays(x, out, depth + 1);
    return out;
  }
  for (const v of Object.values(json)) postArrays(v, out, depth + 1);
  return out;
}

// 标题等于（或包含）榜名的卡片里的帖子列表，例如心声的「24小时点击排行」卡片。
const headingKey = s => clean(s).replace(/\s+/g, '');
function namedList(json, heading, depth = 0) {
  if (!json || typeof json !== 'object' || depth > 8) return null;
  if (!Array.isArray(json)) {
    const t = headingKey(pick(json, ['title', 'name', 'cardName', 'cardTitle']) || '');
    if (t && (t === headingKey(heading) || t.includes(headingKey(heading)))) {
      for (const v of Object.values(json)) {
        if (!Array.isArray(v)) continue;
        const posts = v.map(postFromObject).filter(Boolean);
        if (posts.length >= 3) return posts;
      }
    }
  }
  for (const v of Object.values(json)) { const hit = namedList(v, heading, depth + 1); if (hit) return hit; }
  return null;
}
// 帖子详情页截到的接口数据里补阅读、回复、点赞、收藏、时间（心声的排行只有标题和链接）。
function countsFromJson(list) {
  const out = {};
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 6) return;
    if (!Array.isArray(o)) {
      for (const [k, keys] of [['views', VIEWS], ['replies', REPLIES], ['likes', LIKES], ['favs', FAVS]]) if (out[k] == null) { const n = count(pick(o, keys)); if (n != null) out[k] = n; }
      if (out.time == null) { const t = timeOf(pick(o, ['publishTime', 'createTime', 'postTime', 'releaseTime', 'createdAt', 'gmtCreate'])); if (t) out.time = t; }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, d + 1);
  };
  for (const json of list || []) walk(json, 0);
  return out;
}

function absolute(href, base) { try { return new URL(href, base).href; } catch { return ''; } }
function linkPosts(links, site, base) {
  const seen = new Set(), out = [];
  for (const l of links || []) {
    const href = absolute(l.href, base || 'http://localhost/');
    const m = site.postLink.exec(href);
    const title = clean(l.text);
    if (!m || title.length < 4 || title.length > 200) continue;
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ id: m[1], title, url: href, views: null, replies: null, likes: null, favs: null, time: null, author: '', board: '' });
  }
  return out;
}
// 链接里拿不到帖子时退到板块里的文字行：去掉序号和末尾的数字，剩下像标题的留下（没有链接，点开到站点首页）。
function linePosts(lines) {
  const out = [], seen = new Set();
  for (const raw of lines || []) {
    const title = clean(raw).replace(/^(?:TOP\s*)?\d{1,2}[.、\s]+/i, '').replace(/\s+[\d.,]+[万wk]?$/i, '').trim();
    if (title.length < 6 || title.length > 120 || /排行|更多|查看全部|^\d+$/.test(title)) continue;
    const key = titleKey(title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: '', title, url: '', views: null, replies: null, likes: null, favs: null, time: null, author: '', board: '' });
  }
  return out;
}
// 用 JSON 里的同一帖子（编号或标题对上）补数字。
function enrich(posts, pool) {
  const byId = new Map(), byTitle = new Map();
  for (const p of pool) { if (p.id) byId.set(p.id, p); byTitle.set(titleKey(p.title), p); }
  return posts.map(p => {
    const m = (p.id && byId.get(p.id)) || byTitle.get(titleKey(p.title));
    if (!m) return p;
    const out = { ...p };
    for (const k of ['views', 'replies', 'likes', 'favs', 'time']) if (out[k] == null && m[k] != null) out[k] = m[k];
    for (const k of ['author', 'board']) if (!out[k] && m[k]) out[k] = m[k];
    if (!out.id && m.id) out.id = m.id;
    if (!out.url && m.url) out.url = m.url;
    return out;
  });
}

// 一个站点首页的抓取结果 → 各排行榜的帖子。
//   capture: { finalUrl, sections: [{ heading, links, lines }], links, json: [{ url, json }] }
function postsForSite(site, capture, { base = '', limit = 20 } = {}) {
  const arrays = (capture.json || []).map(r => ({ url: String(r.url || ''), arrays: postArrays(r.json) })).filter(r => r.arrays.length);
  const pool = arrays.flatMap(r => r.arrays.flat());
  const lists = [];
  for (const list of site.lists) {
    const section = (capture.sections || []).find(s => s.heading === list.heading);
    let posts = [], from = '';
    // 1. 页面上这个板块里的帖子链接
    if (section) { posts = linkPosts(section.links, site, capture.finalUrl || base); from = 'links'; }
    // 2. 截到的接口数据：先找标题就是这个榜名的卡片（心声）；再找网址像这个榜或像热榜的帖子数组
    if (posts.length < 3) {
      for (const r of [...(capture.json || [])].reverse()) { const hit = namedList(r.json, list.heading); if (hit) { posts = hit; from = 'api-card'; break; } }
    }
    if (posts.length < 3 && arrays.length) {
      // 同分时取后截到的（稼先点「热点」后才取热榜，先截到的是首页推荐）。
      const ranked = arrays.map((r, i) => ({ ...r, i })).sort((a, b) => score(b.url, list, site) - score(a.url, list, site) || b.i - a.i);
      const best = ranked[0];
      if (best && score(best.url, list, site) > 0) { posts = best.arrays[0]; from = 'api'; }
    }
    // 3. 板块里的文字行
    if (posts.length < 3 && section) { const lines = linePosts(section.lines); if (lines.length >= 3) { posts = lines; from = 'text'; } }
    // 稼先的「热点」是首页主列表：板块没认出来时，用整页的帖子链接
    if (posts.length < 3 && site.lists.length === 1) { const all = linkPosts(capture.links, site, capture.finalUrl || base); if (all.length >= 3) { posts = all; from = 'page-links'; } }
    // 接口数据常只有编号：按站点的详情页格式补链接（稼先）。
    const link = p => p.url ? absolute(p.url, capture.finalUrl || base) : (base && site.detailPath && p.id ? base + site.detailPath(p.id) : '');
    posts = enrich(posts, pool).slice(0, limit).map((p, i) => ({ ...p, rank: i + 1, url: link(p) }));
    lists.push({ key: list.key, label: list.label, from, posts });
  }
  return lists;
}
function score(url, list, site) {
  let n = 0;
  if (site.api.test(url)) n += 1;
  if (site.hotApi.test(url)) n += 2;
  if (list.api && list.api.test(url)) n += 4;
  return n;
}

// 判断是不是停在登录页：回到别的域名，或页面里是登录表单的字样。
const LOGIN_WORDS = /账号登录|扫码登录|密码登录|统一身份认证|统一认证|请输入(?:账号|密码|工号)|忘记密码|Sign in|Log in/i;
function looksLikeLogin({ finalUrl = '', text = '', textLength = 0 } = {}, base = '') {
  let host = '', want = '';
  try { host = new URL(finalUrl).host; } catch { /* 没有地址 */ }
  try { want = new URL(base).host; } catch { /* 测试里可能没给 */ }
  if (want && host && host !== want) return true;
  return LOGIN_WORDS.test(String(text).slice(0, 3000)) && textLength < 4000;
}

module.exports = { postsForSite, postArrays, postFromObject, namedList, countsFromJson, linkPosts, linePosts, looksLikeLogin, count, timeOf, titleKey, clean };
