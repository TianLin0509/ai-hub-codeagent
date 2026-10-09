'use strict';
const { stripVTControlCharacters } = require('util');

function parseFastConfirmation(output, enabled) {
  const text = stripVTControlCharacters(output);
  const command = `/fast ${enabled ? 'on' : 'off'}`;
  const index = text.lastIndexOf(command);
  if (index < 0) return null;
  const reply = text.slice(index + command.length);
  if (/Fast mode (?:unavailable|is not available|disabled)|credits (?:exhausted|not available)|usage (?:limit|credit limit) reached/i.test(reply)) {
    return {ok:false,message:'Claude 未启用 Fast，请查看终端中的额度或可用性提示'};
  }
  if (new RegExp(`(?:Kept )?Fast mode ${enabled ? 'ON' : 'OFF'}\\b`).test(reply)) return {ok:true};
  return null;
}

function observeClaudeFastCommand(manager, sid, enabled) {
  let output = '', result = null;
  const listener = event => {
    if (event.sessionId !== sid) return;
    output = (output + event.data).slice(-32768);
    result = parseFastConfirmation(output, enabled) || result;
  };
  manager.on('output', listener);
  return {
    async wait(timeoutMs = 12000) {
      const deadline = Date.now() + timeoutMs;
      while (!result && Date.now() < deadline) await new Promise(resolve=>setTimeout(resolve,60));
      return result || {ok:false,message:'未收到 Claude 的 Fast 确认，请检查终端；按钮未改为成功'};
    },
    dispose() { manager.removeListener('output',listener); },
  };
}
module.exports = {parseFastConfirmation,observeClaudeFastCommand};
