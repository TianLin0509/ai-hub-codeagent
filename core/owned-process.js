'use strict';
const {execFileSync} = require('child_process');
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid,0); return true; }
  catch(error) {if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error;}
}
// 这一步在 Windows 上只能靠同步 spawn 一次 powershell（wmic 在 Win11 26200 已被
// 移除，实测 ENOENT），2026-09-22 实测 342~688 ms —— 而且它跑在 Electron 主进程
// 上，这段时间整个界面不响应。
//
// 一次「打开被中断的原生会话」最坏会对同一批 PID 问六次：claude 的 _start 两次
// （ownerPid / childPid）、claimThread 两次（hub_pid / server_pid）、
// session-open-ownership 两次（pid / server_pid），而且后两处还在 SQLite 的
// BEGIN IMMEDIATE 事务里。进程的启动时间是不会变的，所以这里按 PID 记住刚问到
// 的结果，把那六次压回两次。
//
// TTL 只为一件事存在：不跨越 PID 回收。Windows 会重用 PID 号，缓存太久可能把新
// 进程的身份当成旧的。真撞上时结论偏向「旧 writer 还活着」→ 拒绝接管，这是安全
// 的方向（宁可让人手动确认，也不抢别人的写入权）。注入 readStartedAt 的调用方
// （测试）不经过这里，所以不会被缓存影响。
const BIRTH_TTL_MS = 3000;
const births = new Map();
function probeStartedAt(pid) {
  if(process.platform==='win32') {
    const script=`$ErrorActionPreference='Stop'; try { $p=Get-Process -Id ${pid}; [DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() } catch { exit 2 }`;
    return Number(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:5000}).trim());
  }
  return Date.parse(execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:5000}).trim());
}
function startedAt(pid) {
  if (pid === process.pid) return Date.now() - process.uptime()*1000;
  const now = Date.now();
  const cached = births.get(pid);
  if (cached && now - cached.at < BIRTH_TTL_MS) return cached.birth;
  const birth = probeStartedAt(pid);
  // 探测失败（NaN / 抛错）不进缓存：把一次失败记住只会让后面的判断跟着错。
  if (Number.isFinite(birth) && birth > 0) {
    births.set(pid, { birth, at: now });
    if (births.size > 64) {
      for (const [key, value] of births) if (now - value.at >= BIRTH_TTL_MS) births.delete(key);
      // 3 秒内问过 64 个不同 PID 只可能是哪里出了别的问题；宁可丢掉缓存重新探，
      // 也不留一个会一直长大的 Map。
      if (births.size > 64) births.clear();
    }
  }
  return birth;
}
// Called only on an ownership conflict/recovery, never on a polling timer.
// A live PID whose process was born after we recorded it is a reused number.
function matches(pid, observedAt, readStartedAt=startedAt) {
  if(!alive(pid))return false;
  if(!observedAt)return true; // Old records lack proof; do not steal their writer.
  let birth;
  try {birth=readStartedAt(pid);} catch(error) {if(!alive(pid))return false;throw Error('无法核对会话占用进程身份：'+error.message);}
  if(!Number.isFinite(birth) || birth<=0)throw Error('无法核对会话占用进程的启动时间');
  return birth<=observedAt;
}
module.exports={alive,startedAt,matches};
