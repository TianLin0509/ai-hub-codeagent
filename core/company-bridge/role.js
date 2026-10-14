'use strict';
// 这台 Hub 在家里联动里扮演哪一端：自用版是家里（提问方），公司版是公司（读代码作答方），其余发行版不启用。
// 隔离测试可用 CLAUDE_HUB_BRIDGE_ROLE 指定（必须同时有隔离数据目录，生产实例改不了）。
function bridgeRole(env = process.env, distribution = require('../distribution')) {
  const override = env.CLAUDE_HUB_BRIDGE_ROLE;
  if (override && env.CLAUDE_HUB_DATA_DIR) return ['home', 'company', 'off'].includes(override) ? override : 'off';
  if (!distribution.community) return 'home';
  if (distribution.target === 'company' && distribution.featureEnabled('homeLink')) return 'company';
  return 'off';
}
module.exports = { bridgeRole };
