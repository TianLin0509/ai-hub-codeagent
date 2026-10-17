'use strict';
// 图片专用帧：UTF-8 元信息 + 原始压缩图片字节一起加密，仅对密文做一次 Base64url。
// 上限是实际 POST JSON 正文字节数，包含 to / mid / blob，不是文件大小。
const crypto = require('node:crypto');
const MAX_TEXT_BYTES = 60000;
// '=' is accepted by the existing relay, and never occurs inside its legacy Base64url frames.
const PREFIX = 'IMG1=';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const envelopeSize = (to, mid, blob) => Buffer.byteLength(JSON.stringify({ to, mid, blob }), 'utf8');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');

function validateMeta(m) {
  if (!m || m.type !== 'image' || !UUID.test(m.mid || '')) throw new Error('图片消息编号无效');
  if (typeof m.gen !== 'string' || !m.gen || m.gen.length > 80 || !/^[QH]-\d{4}-\d{2,}$/.test(m.thread || '')) throw new Error('图片所属线程无效');
  if (!Number.isSafeInteger(m.round) || m.round < 1) throw new Error('图片轮次无效');
  if (!['png', 'jpeg', 'webp'].includes(m.format) || !/^[a-f0-9]{64}$/.test(m.sha256 || '')) throw new Error('图片格式或校验值无效');
  if (m.caption != null && (typeof m.caption !== 'string' || Buffer.byteLength(m.caption, 'utf8') > 1200)) throw new Error('图片说明超过 1200 字节');
  if (Object.hasOwn(m, 'data')) throw new Error('元信息不能包含图片数据');
}
function aad(link, to) { return Buffer.from(link.channel + ':' + to + ':image-v1'); }
function maxDataBytes(to, message) {
  validateMeta(message);
  const headerBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
  const chars = MAX_TEXT_BYTES - 1 - envelopeSize(to, message.mid, '') - PREFIX.length;
  return Math.floor(chars * 3 / 4) - 28 - 4 - headerBytes;
}
function sealImage(link, to, message, data) {
  validateMeta(message);
  if (!Buffer.isBuffer(data) || !data.length || hash(data) !== message.sha256) throw new Error('图片校验失败');
  const header = Buffer.from(JSON.stringify(message), 'utf8');
  if (header.length > 8192) throw new Error('图片元信息过长');
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', link.key, iv);
  cipher.setAAD(aad(link, to));
  const body = Buffer.concat([cipher.update(Buffer.concat([length, header, data])), cipher.final()]);
  const blob = PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
  if (envelopeSize(to, message.mid, blob) >= MAX_TEXT_BYTES) throw new Error('图片消息必须小于 60000 字节（包含加密编码和说明）');
  return blob;
}
function openImage(link, to, blob) {
  if (typeof blob !== 'string' || !blob.startsWith(PREFIX) || blob.length >= MAX_TEXT_BYTES) throw new Error('图片消息超过 60000 字节或格式无效');
  const encoded = blob.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('图片文字编码无效');
  const raw = Buffer.from(encoded, 'base64url');
  if (raw.length < 33 || raw.toString('base64url') !== encoded) throw new Error('图片文字编码不完整');
  const decipher = crypto.createDecipheriv('aes-256-gcm', link.key, raw.subarray(0, 12));
  decipher.setAAD(aad(link, to)); decipher.setAuthTag(raw.subarray(-16));
  const plain = Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]);
  const n = plain.readUInt32BE(0);
  if (n > 8192 || n < 2 || n + 4 >= plain.length) throw new Error('图片元信息不完整');
  const message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain.subarray(4, n + 4)));
  validateMeta(message);
  if (envelopeSize(to, message.mid, blob) >= MAX_TEXT_BYTES) throw new Error('图片消息必须小于 60000 字节');
  const data = plain.subarray(n + 4);
  if (hash(data) !== message.sha256) throw new Error('图片校验失败');
  return { ...message, data, textBytes: envelopeSize(to, message.mid, blob) };
}
module.exports = { MAX_TEXT_BYTES, PREFIX, UUID, hash, envelopeSize, maxDataBytes, sealImage, openImage };
