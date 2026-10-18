'use strict';
// 「论坛」页同步的两个公司内部社区（2026-10-18，公司真机回执 Q-1018-01 两轮）：
//   稼先社区：首页「热点」tab（/?menuKey=hot），数据 GET /jxService/v1/jxhome/homeHotResources?type=hotRecommend_1Week（本周热榜，
//            result.dataList 20 条：resourceId、title、url、browseCount、commentCount、favoriteCount、upvoteCount、createTime、submitUsers）；
//            同页还有推荐流 djx/home/recommendations/query、热门话题 jxhome/hot/topics/list，不是热榜。
//            帖子详情 /community/comgroup/postsDetails?postId=<id>&noTop=true&type=freePost（正文接口 /jxService/v1/post/query/<id>）。
//   心声社区：首页 /next/index/#/home 的「24小时点击排行」「24小时回复排行」，在 GET /xsrecommend/user/v1/cards/recommends/home/right
//            的卡片里（data[4]、data[5]，cardType=HOT_LIST），每张 list 10 条，只有 postId、title、link；
//            阅读、回复数在详情接口（/xsapi/user/posts/<id>）里。详情页 /next/detail/#/index?uuid=<id>&uniqueType=homeRanking。
// 两站都是前端渲染的单页应用，内网单点登录记在浏览器里：直接请求只拿到空壳、接口回「未登录」，所以由 Hub 自己的浏览器窗口去打开。
// 公司电脑上全新的浏览器也会经安全终端（SPES）免密自动登录（回执第 2 轮实测），一般不需要用户登录；「登录」按钮只是兜底。
// 站点地址不写死：公司内网站点都在公司邮箱的域名下（jx.<域名>、xinsheng.<域名>），域名取自本人公司邮箱（助理已从 WeLink 账号读到），
// 设置里也能直接填。
const SITES = Object.freeze([
  Object.freeze({
    id: 'jx', name: '稼先社区', short: '稼先', sub: 'jx', home: '/?menuKey=hot',
    // 直接打开热点页；没截到热榜接口时再点一下「热点」tab。
    clickText: '热点', clickUnless: /homeHotResources/i,
    lists: Object.freeze([{ key: 'hot', label: '热点', heading: '热点', api: /homeHotResources/i }]),
    api: /\/jxService\/v1\//i,
    hotApi: /hot|recommend/i,
    postLink: /postsDetails\?[^#]*\bpostId=([\w-]+)/i,
    detailPath: id => `/community/comgroup/postsDetails?postId=${encodeURIComponent(id)}&noTop=true&type=freePost`,
  }),
  Object.freeze({
    id: 'xinsheng', name: '心声社区', short: '心声', sub: 'xinsheng', home: '/next/index/#/home',
    clickText: '',
    lists: Object.freeze([
      { key: 'click', label: '24小时点击', heading: '24小时点击排行', api: /click|view|read|hot/i },
      { key: 'reply', label: '24小时回复', heading: '24小时回复排行', api: /reply|comment/i },
    ]),
    api: /\/(?:xsapi|xsrecommend)\//i,
    hotApi: /hot|rank|top|click|reply/i,
    postLink: /[?&#/](?:uuid|tid|postId|topicId|articleId|id)[=/]([\w-]{3,})/i,
    detailPath: id => `/next/detail/#/index?uuid=${encodeURIComponent(id)}&uniqueType=homeRanking`,
  }),
]);

// 本人邮箱 → 域名（user@corp.example → corp.example）。
function domainFromEmail(email) {
  const m = /^[^\s@]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(String(email || '').trim());
  return m ? m[1].toLowerCase() : '';
}
function normalizeDomain(v) {
  const s = String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\.+|\.+$/g, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}

// 每个站点的根地址。测试可用 CLAUDE_HUB_FORUM_SITES（JSON：{"jx":"http://127.0.0.1:port", ...}）指到本机假站点，
// 必须同时有隔离数据目录，生产实例改不了。
function siteBases(domain, env = process.env) {
  const out = {};
  let override = null;
  if (env.CLAUDE_HUB_FORUM_SITES && env.CLAUDE_HUB_DATA_DIR) { try { override = JSON.parse(env.CLAUDE_HUB_FORUM_SITES); } catch { override = null; } }
  for (const site of SITES) {
    if (override && override[site.id]) out[site.id] = String(override[site.id]).replace(/\/+$/, '');
    else if (domain) out[site.id] = `https://${site.sub}.${domain}`;
  }
  return out;
}
function siteById(id) { return SITES.find(s => s.id === id) || null; }
function homeUrl(site, base) { return base ? base + site.home : ''; }
function detailUrl(site, base, id) { return base && site.detailPath && id ? base + site.detailPath(id) : ''; }

module.exports = { SITES, domainFromEmail, normalizeDomain, siteBases, siteById, homeUrl, detailUrl };
