'use strict';
function format(result={}) {
  const parts=[];
  if(result.deliveredNow?.length)parts.push(`${result.deliveredNow.length} 位已确认收到`);
  if(result.queuedSids?.length)parts.push(`${result.queuedSids.length} 位已排队，当前任务结束后处理`);
  if(result.pendingSids?.length)parts.push(`${result.pendingSids.length} 位待送达，下次派工时补送`);
  if(result.uncertainSids?.length)parts.push(`${result.uncertainSids.length} 位发送未确认，请查看成员会话，不会自动重发`);
  return parts.join('；');
}
module.exports={format};
