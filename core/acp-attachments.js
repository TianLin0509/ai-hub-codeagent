'use strict';
const fs=require('node:fs');
function imagePaths(text) {
  // Hub paste/drop inserts quoted paths when they contain spaces.
  const pattern=/"([A-Za-z]:[\\/][^"\r\n]+\.(?:png|jpe?g|webp|gif))"|([A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.(?:png|jpe?g|webp|gif))(?![A-Za-z0-9])/gi;
  return [...new Set([...String(text).matchAll(pattern)].map(m=>m[1] || m[2]))]
    .filter(file=>fs.existsSync(file)).map(file=>({type:'localImage',path:file}));
}
function validateImages(files,model,capabilities) {
  if(!files.length)return;
  if(!capabilities?.promptCapabilities?.image || /^(deepseek-v4|glm-5\.2|qwen3\.7-max)/.test(model || ''))
    throw new Error('当前模型或 Harness 不支持图片，请移除图片或切换支持图片的模型');
  const maximum=capabilities?._meta?.imageCapability?.maxImagesPerTurn || 4;
  if(files.length>maximum)throw new Error('当前 Harness 一次最多接收 '+maximum+' 张图片');
  const bytes=files.reduce((n,file)=>n+(file.type==='localImage'?fs.statSync(file.path).size:Buffer.byteLength(file.url || '')*0.75),0);
  if(bytes>10*1024*1024)throw new Error('图片合计超过 10 MB，请压缩后发送');
}
module.exports={imagePaths,validateImages};
