'use strict';
// 家里 Hub ↔ 公司 Hub 任务通道的加密（2026-10-15）。
// 两端共享一把配对密钥：用它派生出通道编号（服务器上的目录名）和加密密钥。
// 服务器只存取密文，不知道密钥就既找不到通道、也读不出内容、也伪造不了消息（AES-256-GCM 自带校验）。
const crypto = require('node:crypto');

const PAIRING_PREFIX = 'AIHUB-LINK-1.';
const b64url = buf => Buffer.from(buf).toString('base64url');

function newSecret() { return b64url(crypto.randomBytes(32)); }

function derive(secret) {
  const raw = Buffer.from(String(secret || ''), 'base64url');
  if (raw.length !== 32) throw new Error('配对密钥无效');
  const salt = Buffer.from('ai-hub-company-bridge-v1');
  const channel = Buffer.from(crypto.hkdfSync('sha256', raw, salt, Buffer.from('channel'), 16)).toString('hex');
  const key = Buffer.from(crypto.hkdfSync('sha256', raw, salt, Buffer.from('message-key'), 32));
  return { channel, key };
}

// to 写进附加认证数据：发给家里的消息不能被挪去冒充发给公司的。
function seal(link, to, message) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', link.key, iv);
  cipher.setAAD(Buffer.from(link.channel + ':' + to));
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(message), 'utf8')), cipher.final()]);
  return b64url(Buffer.concat([iv, body, cipher.getAuthTag()]));
}

function open(link, to, blob) {
  if (typeof blob === 'string' && blob.startsWith(require('./image-message').PREFIX)) return require('./image-message').openImage(link, to, blob);
  const raw = Buffer.from(String(blob || ''), 'base64url');
  if (raw.length < 12 + 16 + 2) throw new Error('消息太短');
  const decipher = crypto.createDecipheriv('aes-256-gcm', link.key, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from(link.channel + ':' + to));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const text = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
  const message = JSON.parse(text);
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('消息格式无效');
  return message;
}

function checkBaseUrl(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { throw new Error('通道地址无效'); }
  const local = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !local) throw new Error('通道地址必须是 https');
  return parsed.toString().replace(/\/+$/, '');
}

// 配对码：一段文字里带上通道地址、初始密钥和家里的公钥，家里生成，公司粘贴。
function makePairingCode(baseUrl, secret, homePublicKey) {
  return PAIRING_PREFIX + b64url(Buffer.from(JSON.stringify({ u: checkBaseUrl(baseUrl), k: secret, ...(homePublicKey ? { h: homePublicKey } : {}) }), 'utf8'));
}
function parsePairingCode(text) {
  const match = String(text || '').match(/AIHUB-LINK-1\.([A-Za-z0-9_-]{20,})/);
  if (!match) throw new Error('没找到配对码：应以 AIHUB-LINK-1. 开头');
  let value;
  try { value = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')); } catch { throw new Error('配对码不完整，请整段复制'); }
  const baseUrl = checkBaseUrl(value && value.u);
  derive(value.k);
  return { baseUrl, secret: value.k, ...(value.h ? { homePublicKey: String(value.h) } : {}) };
}

// 换钥：两端各生成一对 X25519 临时密钥，只交换公钥（hello / welcome 用初始密钥加密，防篡改）。
// 正式密钥 = HKDF(共享秘密, 初始密钥)。看到配对码的人能解开 hello / welcome，但只拿到公钥，算不出正式密钥。
function newKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  return { publicKey: b64url(publicKey.export({ format: 'der', type: 'spki' })), privateKey: b64url(privateKey.export({ format: 'der', type: 'pkcs8' })) };
}
function agree(privateKey, peerPublicKey, initialSecret) {
  const priv = crypto.createPrivateKey({ key: Buffer.from(String(privateKey), 'base64url'), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey({ key: Buffer.from(String(peerPublicKey || ''), 'base64url'), format: 'der', type: 'spki' });
  if (pub.asymmetricKeyType !== 'x25519') throw new Error('对端公钥类型不对');
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
  return b64url(Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from(String(initialSecret), 'base64url'), Buffer.from('final-secret-v1'), 32)));
}

// 握手证明：只有算出同一把正式密钥的一方才能给出。
function proof(secret, label) { return crypto.createHmac('sha256', Buffer.from(String(secret), 'base64url')).update('handshake:' + label).digest('base64url'); }

module.exports = { newSecret, derive, seal, open, makePairingCode, parsePairingCode, checkBaseUrl, newKeyPair, agree, proof, PAIRING_PREFIX };
