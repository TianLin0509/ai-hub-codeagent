'use strict';
// A separate append-only channel: never append to the CLI's own output file.
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    if (!process.env.AI_HUB_PROVIDER_HOOK_LOG) throw new Error('Missing hook log');
    fs.appendFileSync(process.env.AI_HUB_PROVIDER_HOOK_LOG, JSON.stringify(event) + '\n', {mode:0o600});
  } catch (error) { console.error('[hub-cli-hook]', error.message); process.exitCode = 1; }
});
