'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID, createHash } = require('crypto');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function dataDir() { return path.resolve(process.env.AI_HUB_WEB_DATA_DIR || process.env.CLAUDE_HUB_DATA_DIR || path.join(os.homedir(), '.ai-hub-community')); }
function root() { const dir = path.join(dataDir(), 'web-roundtable'); fs.mkdirSync(dir, { recursive:true }); return dir; }
function id(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw Error('Invalid task ID'); return value; }
function file(key) { return path.join(root(), id(key) + '.json'); }
function read(key) { return JSON.parse(fs.readFileSync(file(key), 'utf8')); }
function write(key, value) { const target = file(key), tmp = target + '.' + randomUUID() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8'); fs.renameSync(tmp, target); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
// Exclusive mkdir, with owner liveness rather than an expiring lease. A slow browser
// must never lose its lock to another sender. Unpublished owner gets a grace period.
function acquire(key,lockRoot=root()) {
  fs.mkdirSync(lockRoot,{recursive:true});
  const dir = path.join(lockRoot, id(key) + '.lock'), token = randomUUID();
  try { fs.mkdirSync(dir); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Serialize stale-owner inspection as well as removal. Two stale readers
    // must not rename a third process's newly acquired live lock.
    const reap = dir + '.reap';
    let handle;try{handle=fs.openSync(reap,'wx');}catch(err){
      if(err.code!=='EEXIST')throw err;
      // An interrupted reaper cannot be safely stolen based on age alone.
      // Surface the exact marker for inspection instead of queueing forever.
      let age;try{age=Date.now()-fs.statSync(reap).mtimeMs;}catch(missing){if(missing.code!=='ENOENT')throw missing;return null;}
      if(age>30000)throw Error('Lock recovery blocked; inspect owner processes before removing '+reap);
      return null;
    }
    let dead=false;
    try {
      try { const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); dead = !alive(owner.pid); }
      catch (err) {
        if(err instanceof SyntaxError){if(Date.now()-fs.statSync(dir).mtimeMs<30000)return null;throw Error('Invalid lock owner; inspect '+dir);}
        if (err.code !== 'ENOENT') throw err; try{dead = Date.now() - fs.statSync(dir).mtimeMs > 30000;}catch(missing){if(missing.code!=='ENOENT')throw missing;dead=true;}
      }
      if (!dead) return null;
      const stale = dir + '.stale-' + token;
      try { fs.renameSync(dir, stale); fs.rmSync(stale, { recursive:true }); } catch (err) { if (err.code!=='ENOENT') throw err; }
    } finally {fs.closeSync(handle);fs.unlinkSync(reap);}
    return acquire(key,lockRoot);
  }
  fs.writeFileSync(path.join(dir, 'owner.tmp'), JSON.stringify({ pid:process.pid, token }), 'utf8');
  fs.renameSync(path.join(dir,'owner.tmp'),path.join(dir,'owner.json'));
  return () => { const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); if (owner.token !== token) throw Error('Lock ownership changed'); fs.rmSync(dir, { recursive:true }); };
}
async function locked(key, fn, timeout = 10000) { const end = Date.now() + timeout; while (true) { const release = acquire(key); if (release) { try { return await fn(); } finally { release(); } } if (Date.now() > end) throw Error('Resource busy: ' + key); await sleep(100); } }
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function taskId(kind, requestId) { return kind + '-' + digest(id(requestId)).slice(0,32); }
function cancelFile(key) { return path.join(root(), id(key) + '.cancel'); }
function cancelled(key) { return fs.existsSync(cancelFile(key)); }
function cancel(key) { read(key); fs.writeFileSync(cancelFile(key), 'cancel', 'utf8'); }
module.exports = { dataDir, root, id, file, read, write, alive, acquire, locked, digest, taskId, sleep, cancelled, cancel };
