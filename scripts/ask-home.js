#!/usr/bin/env node
'use strict';
// 「问家里」命令行入口（2026-10-15）：和 ask_home MCP 做同一件事，供 MCP 没挂上的 CodeAgent 会话在 shell 里调用。
// 公司版是打包的，用 Hub 写好的启动文件运行（路径在环境变量 HUB_ASK_HOME_CMD 里）：
//   & $env:HUB_ASK_HOME_CMD ask --file 求助.md [--title 标题]
//   & $env:HUB_ASK_HOME_CMD followup --thread H-1015-01 --file 追问.md
//   & $env:HUB_ASK_HOME_CMD show [--thread H-1015-01]
//   & $env:HUB_ASK_HOME_CMD image --thread H-1017-01 --path D:\test.png [--allow-resize]
//   & $env:HUB_ASK_HOME_CMD images [--thread H-1017-01]
// 会话身份与通行证取 Hub 注入的 HUB_HOME_LINK_SESSION_ID / HUB_HOME_LINK_PASS，回复到了 Hub 会作为新消息发回这个会话。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function arg(name) { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; }
function text() {
  const file = arg('file');
  if (file) return fs.readFileSync(file, 'utf8');
  if (arg('text')) return arg('text');
  throw new Error('用 --file <Markdown 文件> 或 --text <文字> 给出内容');
}
async function main() {
  const command = process.argv[2];
  const tool = { ask: 'ask_home', followup: 'followup_home', show: 'home_thread', image: 'send_image_home', images: 'home_images' }[command];
  if (!tool) throw new Error('用法：ask --file q.md [--title t] | followup --thread H-xxxx --file f.md | show [--thread H-xxxx] | image --thread Q/H-xxxx --path <本机图片> [--allow-resize] | images [--thread Q/H-xxxx]');
  const session = process.env.HUB_HOME_LINK_SESSION_ID, pass = process.env.HUB_HOME_LINK_PASS;
  if (!session || !pass) throw new Error('这个会话没有「问家里」的通行证：请在公司和家里配对之后、由 AI Hub 新开（或重开）的 CodeAgent 会话里使用');
  const dataDir = process.env.CLAUDE_HUB_DATA_DIR || path.join(os.homedir(), '.ai-hub-community');
  const endpointFile = process.env.HUB_HOME_LINK_ENDPOINT_FILE || path.join(dataDir, 'company-bridge', 'ask-home-endpoint.json');
  let endpoint;
  try { endpoint = JSON.parse(fs.readFileSync(endpointFile, 'utf8')); } catch { throw new Error('找不到 Hub 的「问家里」入口（Hub 没开着，或版本太旧）：' + endpointFile); }
  const args = command === 'ask' ? { question: text(), ...(arg('title') ? { title: arg('title') } : {}) }
    : command === 'followup' ? { thread: arg('thread'), question: text() }
    : command === 'image' ? { thread: arg('thread'), path: arg('path'), caption: arg('caption') || '', allow_resize: process.argv.includes('--allow-resize'), ...(arg('round') ? { round: Number(arg('round')) } : {}) }
    : (arg('thread') ? { thread: arg('thread') } : {});
  const response = await fetch(endpoint.url, { method: 'POST', headers: { Authorization: 'Bearer ' + pass, 'Content-Type': 'application/json', 'X-Hub-Home-Link-Session': session },
    body: JSON.stringify({ name: tool, arguments: args }), signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  process.stdout.write(JSON.stringify(data.ok ? { ok: true, ...data.result } : { ok: false, error: data.error }, null, 1) + '\n');
  if (!data.ok) process.exitCode = 1;
}
main().catch(error => { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1; });
