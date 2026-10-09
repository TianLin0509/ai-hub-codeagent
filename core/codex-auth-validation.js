'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Check only whether an API credential can be an HTTP bearer token. Do not
// infer account availability or require a provider-specific key prefix.
function invalidApiCredential(auth) {
  if (!auth || auth.auth_mode === 'chatgpt') return false;
  const key = auth.OPENAI_API_KEY;
  return key != null && (typeof key !== 'string' || !/^[\x21-\x7e]+$/.test(key));
}
function assertUsableCredential(home) {
  let auth;
  try { auth = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return; throw new Error('Codex 授权记录不可读，请在账号中心重新授权'); }
  if (invalidApiCredential(auth)) throw new Error('Codex API Key 格式无效，请在账号中心为该账号重新授权；未发送请求');
}
module.exports = { invalidApiCredential, assertUsableCredential };
