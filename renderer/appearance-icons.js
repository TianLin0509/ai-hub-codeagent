'use strict';
// Keep established brand glyphs; decorate the SVG itself so runtime rings remain unchanged.
const fs = require('fs'), path = require('path');
const cache = new Map();
function iconSource(key, style = 'brand') {
  if (!/^(claude|codex|gemini|deepseek|kimi|qwen|glm|codeagent|minimax)$/.test(key)) return '';
  const file = `assets/ai-logos/${key}.svg`;
  if (style === 'brand' || style === 'portrait') return file;
  const id = `${key}:${style}`;
  if (cache.has(id)) return cache.get(id);
  const base = 'data:image/svg+xml;base64,' + fs.readFileSync(path.join(__dirname, file)).toString('base64');
  const shape = style === 'round' ? '<circle cx="12" cy="12" r="11.5" fill="#fff" stroke="#c9d3e0"/>'
    : style === 'tile' ? '<rect x="1" y="2" width="22" height="21" rx="5" fill="#b8c3d0"/><rect x="1" y="1" width="22" height="20" rx="5" fill="#edf2f8" stroke="#d0d9e6"/>'
      : style === 'night' ? '<rect x=".5" y=".5" width="23" height="23" rx="5" fill="#172638" stroke="#a5b6cc"/>' : '';
  const margin = shape ? 3 : 0;
  const filter = style === 'mono' ? '<filter id="gray"><feColorMatrix type="saturate" values="0"/></filter>' : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">${filter}${shape}<image href="${base}" x="${margin}" y="${margin}" width="${24 - margin * 2}" height="${24 - margin * 2}"${filter ? ' filter="url(#gray)"' : ''}/></svg>`;
  const result = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  cache.set(id, result);
  return result;
}
module.exports = { iconSource };
