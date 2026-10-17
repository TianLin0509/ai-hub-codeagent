'use strict';
// 家里 ⇄ 公司通道送进会话的消息（2026-10-16）：它们在原生记录里是「用户消息」，但不是人提的问题——
// 回执、求助回复由 Hub 代发；公司 CodeAgent 收到的提问、改写请求也是 Hub 发的。问题目录、通道串等界面据此区分。
// 只认 Hub 自己写的固定开头（core/company-bridge/home.js、ask-home.js、company.js、home-consult.js），认不出就当普通消息。
// Claude 会把长粘贴包成 <pasted_content>，CodeAgent 粘贴时可能在前面插 [Image #N]：先剥掉再认。
const { unwrapClaudePasteEnvelope } = require('./prompt-submission-receipts');

const ID = '([A-Z]-\\d{4}-\\d{2,})';
const RECEIPT = new RegExp(`^【公司回执 ${ID} · 第 (\\d+) 轮(?: · 没答上)?】`);
const HOME_REPLY = new RegExp(`^【家里回复 ${ID} · 第 (\\d+) 轮(?: · [^】]*)?】`);
const REWRITE = new RegExp(`^（编号 ${ID}，第 (\\d+) 轮）你上一条回答里有成段的源码`);
const REQUEST_LINE = new RegExp(`^## (?:成员请求|成员追问|家里的问题|家里的追问|公司 CodeAgent 的求助|公司 CodeAgent 的追问)（编号 ${ID}(?:，第 (\\d+) 轮)?）`, 'm');

function bridgeText(text) {
  let s = String(text || '');
  s = unwrapClaudePasteEnvelope(s.trim());
  return String(s).replace(/^(?:\s*\[Image #\d+\])+\s*/, '').trimStart();
}

// 返回 { kind, thread, round } 或 null。kind：company-receipt（家里收到的公司回执）、home-reply（公司收到的家里回复）、
// channel-request（公司或家里会话收到的通道提问）、channel-rewrite（公司收到的改写请求）。
function bridgeMessageKind(text) {
  const s = bridgeText(text);
  let m;
  if ((m = s.match(RECEIPT))) return { kind: 'company-receipt', thread: m[1], round: Number(m[2]) };
  if ((m = s.match(HOME_REPLY))) return { kind: 'home-reply', thread: m[1], round: Number(m[2]) };
  if ((m = s.match(REWRITE))) return { kind: 'channel-rewrite', thread: m[1], round: Number(m[2]) };
  if ((m = s.match(REQUEST_LINE))) return { kind: 'channel-request', thread: m[1], round: Number(m[2] || 1) };
  return null;
}

module.exports = { bridgeMessageKind, bridgeText };
