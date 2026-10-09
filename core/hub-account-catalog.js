'use strict';
// One company owns one website entry; browser profiles are storage, not global people.
const COMPANIES = [
  { site: 'chatgpt', company: 'OpenAI', product: 'ChatGPT', mark: 'O', color: '#82cbb5' },
  { site: 'claude', company: 'Anthropic', product: 'Claude', mark: 'A', color: '#dca58d' },
  { site: 'google', company: 'Google', product: 'Gemini', mark: 'G', color: '#9ab8ef' },
  { site: 'doubao', company: '字节跳动', product: '豆包', mark: '豆', color: '#9ec3ed' },
  { site: 'deepseek', company: 'DeepSeek', product: 'DeepSeek', mark: 'D', color: '#99a9f5' },
  { site: 'kimi', company: '月之暗面', product: 'Kimi', mark: 'K', color: '#b9cba2' },
  { site: 'qwen', company: '阿里巴巴', product: '千问', mark: 'Q', color: '#c4a9ed' },
];
function companyFor(site) { return COMPANIES.find(c => c.site === site); }
module.exports = { COMPANIES, companyFor };
