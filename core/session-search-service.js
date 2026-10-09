'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const {
  DEFAULT_MAX_CANDIDATE_SESSIONS,
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_QUERY_DOCS,
  DEFAULT_MAX_SOURCE_CHARS,
  DEFAULT_MAX_SOURCES,
  sqlitePathForLegacyCache,
} = require('./session-search-config.js');

class SessionSearchService {
  constructor(options = {}) {
    this._fork = options.fork || fork;
    this._childPath = options.childPath || path.join(__dirname, 'session-search-child.js');
    this._prewarmEnabled = options.prewarmEnabled === true;
    this._childData = {
      cachePath: options.cachePath || null,
      databasePath: options.databasePath || sqlitePathForLegacyCache(options.cachePath),
      backgroundWriter: options.backgroundWriter !== false,
      claudeRoots: Array.isArray(options.claudeRoots) ? options.claudeRoots : [],
      codexRoots: Array.isArray(options.codexRoots) ? options.codexRoots : [],
      kimiRoots: Array.isArray(options.kimiRoots) ? options.kimiRoots : [],
      geminiRoots: Array.isArray(options.geminiRoots) ? options.geminiRoots : [],
      meetingDir: options.meetingDir || null,
      transcriptDir: options.transcriptDir || null,
      refreshTtlMs: Number(options.refreshTtlMs) || 60_000,
      maxSources: Math.max(20, Number(options.maxSources) || DEFAULT_MAX_SOURCES),
      maxFileBytes: Math.max(1024 * 1024, Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES),
      maxSourceChars: Math.max(64 * 1024, Number(options.maxSourceChars) || DEFAULT_MAX_SOURCE_CHARS),
      maxDocChars: Math.max(8 * 1024, Number(options.maxDocChars) || DEFAULT_MAX_DOC_CHARS),
      maxCandidateSessions: Math.max(50, Number(options.maxCandidateSessions) || DEFAULT_MAX_CANDIDATE_SESSIONS),
      maxQueryDocs: Math.max(1000, Number(options.maxQueryDocs) || DEFAULT_MAX_QUERY_DOCS),
    };
    this._childMemoryLimitMb = Math.max(256, Number(options.childMemoryLimitMb) || 768);
    this._requestTimeoutMs = Math.max(50, Number(options.requestTimeoutMs) || 180_000);
    // Background syncs start at most this often. Every live agent appends to
    // its transcript several times a second, and each sync walks every source
    // root and re-parses each changed transcript in full; unthrottled, the
    // child ran one sync after another and held a core plus the disk forever.
    this._syncMinIntervalMs = Math.max(0, Number(options.syncMinIntervalMs ?? 10_000));
    this._child = null;
    this._stderrTail = [];
    this._nextId = 0;
    this._pending = new Map();
    this._closed = false;
    this._watchers = new Map();
    this._queuedSources = new Set();
    this._queuedSnapshot = null;
    this._lastSyncStartedAt = 0;
    this._maintenanceTimer = null;
    this._queueTimer = null;
    this._maintenanceBusy = false;
    this._status = {
      phase: 'idle', ready: false, refreshing: false,
      index: { sessions: 0, documents: 0, terms: 0, providers: {}, storage: 'sqlite-child-process' },
    };
    this._stats = { submitted: 0, completed: 0, workerRestarts: 0, failures: 0 };
  }

  _armRequestTimeout(id, pending) {
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (this._pending.get(id) !== pending) return;
      const error = new Error(`Session search child did not respond for ${this._requestTimeoutMs}ms (${pending.type})`);
      this._handleFailure(error, this._child);
    }, this._requestTimeoutMs);
    pending.timer.unref?.();
  }

  _touchPendingRequests() {
    for (const [id, pending] of this._pending) this._armRequestTimeout(id, pending);
  }

  _ensureChild() {
    if (this._closed) throw new Error('Session search service is closed');
    if (this._child) return this._child;
    this._stderrTail = [];
    const child = this._fork(this._childPath, [], {
      // Do not set cwd to __dirname: in packaged builds it points inside
      // app.asar, which is not a real Windows working directory.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
      execArgv: [`--max-old-space-size=${this._childMemoryLimitMb}`],
      windowsHide: true,
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const backgroundPriority = os.constants && os.constants.priority
      ? os.constants.priority.PRIORITY_BELOW_NORMAL
      : null;
    if (Number.isInteger(child.pid) && Number.isInteger(backgroundPriority)) {
      try { os.setPriority(child.pid, backgroundPriority); } catch {}
    }
    child.on('message', message => this._handleMessage(message));
    child.on('error', error => this._handleFailure(error, child));
    child.on('exit', (code, signal) => {
      if (this._child !== child) return;
      const detail = this._stderrTail.slice(-8).join('\n');
      const error = new Error(`Session search child exited (code=${code}, signal=${signal || 'none'})${detail ? `\n${detail}` : ''}`);
      this._handleFailure(error, child);
    });
    if (child.stderr) {
      child.stderr.on('data', data => {
        this._stderrTail.push(...String(data || '').split(/\r?\n/).filter(Boolean));
        if (this._stderrTail.length > 80) this._stderrTail.splice(0, this._stderrTail.length - 80);
      });
    }
    this._child = child;
    this._stats.workerRestarts += 1;
    try {
      child.send({ type: 'init', options: this._childData }, error => {
        if (error) this._handleFailure(error, child);
      });
    } catch (error) {
      this._handleFailure(error, child);
      throw error;
    }
    return child;
  }

  _handleMessage(message) {
    if (message && message.type === 'status') {
      this._status = { ...this._status, ...(message.status || {}) };
      this._touchPendingRequests();
      return;
    }
    if (message && message.type === 'fatal') {
      this._status = { ...this._status, refreshing: false, lastError: message.error || '搜索子进程异常退出' };
      return;
    }
    const pending = message && this._pending.get(message.id);
    if (!pending) return;
    this._pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error(message.error));
      return;
    }
    this._stats.completed += 1;
    if (message.result && (pending.type === 'status' || pending.type === 'refresh')) {
      this._status = { ...this._status, ...message.result };
    } else if (pending.type === 'search' && message.result && message.result.status) {
      this._status = { ...this._status, ...message.result.status };
    }
    pending.resolve(message.result);
  }

  _handleFailure(error, child) {
    if (child && this._child !== child) return;
    const failedChild = this._child;
    if (failedChild) {
      failedChild.removeAllListeners();
      try { if (failedChild.connected) failedChild.kill(); } catch {}
    }
    this._child = null;
    this._stats.failures += 1;
    this._status = { ...this._status, ready: false, refreshing: false, phase: 'child_error', lastError: error.message };
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
  }

  _request(type, payload = {}) {
    const id = ++this._nextId;
    return new Promise((resolve, reject) => {
      const pending = { type, resolve, reject, timer: null };
      this._pending.set(id, pending);
      this._armRequestTimeout(id, pending);
      try {
        const child = this._ensureChild();
        child.send({ id, type, ...payload }, error => {
          if (!error) return;
          this._handleFailure(error, child);
        });
        this._stats.submitted += 1;
      } catch (error) {
        this._pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      }
    });
  }

  search(request = {}, snapshot = {}) {
    return this._request('search', { request, snapshot });
  }

  preview(request = {}) {
    return this._request('preview', { request });
  }

  memoryCandidates(request = {}) { return this._request('memory-candidates', { request }); }
  transcriptFor(request = {}) { return this._request('transcript', { request }); }
  exportMemoryHistory(request = {}) { return this._request('memory-export', { request }); }

  refresh(snapshot = {}, options = {}) {
    return this._request('refresh', { snapshot, force: options.force === true, immediate: options.immediate === true });
  }

  // `snapshot` may be a getter: it is only called when a sync actually starts,
  // not on each of the many file events that coalesce into that sync.
  queueRefresh(snapshot = {}, source = 'reconcile') {
    if(this._closed) return;
    this._queuedSnapshot = snapshot;
    this._queuedSources.add(String(source || 'reconcile'));
    if(this._queueTimer || this._maintenanceBusy) return;
    this._scheduleQueueFlush(400);
  }

  _scheduleQueueFlush(minDelayMs) {
    const delay=Math.max(minDelayMs,this._lastSyncStartedAt+this._syncMinIntervalMs-Date.now());
    this._queueTimer=setTimeout(()=>{this._queueTimer=null;void this._flushRefreshQueue();},delay);
    this._queueTimer.unref?.();
  }

  async _flushRefreshQueue() {
    if(this._closed || this._maintenanceBusy || !this._queuedSnapshot) return;
    this._maintenanceBusy=true;
    this._lastSyncStartedAt=Date.now();
    const queued=this._queuedSnapshot;this._queuedSnapshot=null;this._queuedSources.clear();
    let snapshot=queued,retry=false;
    try {
      if(typeof queued==='function') snapshot=queued();
      const status=await this.refresh(snapshot,{immediate:true});
      retry=status?.phase==='waiting_writer';
    } catch(error) {
      retry=true;
      this._status={...this._status,phase:this._status.ready?'ready_with_errors':'error',refreshing:false,lastError:error.message};
      console.warn('[session-search] background sync failed:',error.message);
    } finally {
      this._maintenanceBusy=false;
      if(retry && !this._queuedSnapshot) this._queuedSnapshot=queued;
      if(!this._closed && this._queuedSnapshot) this._scheduleQueueFlush(retry?2000:400);
    }
  }

  startMaintenance(getSnapshot) {
    if(this._closed || this._maintenanceTimer || !this._prewarmEnabled) return;
    const reconcile=()=>{
      const roots=[...this._childData.claudeRoots,...this._childData.codexRoots,...this._childData.kimiRoots,...this._childData.geminiRoots,this._childData.meetingDir].filter(Boolean);
      for(const root of new Set(roots)) {
        if(this._watchers.has(root) || !fs.existsSync(root)) continue;
        try {
          const watcher=fs.watch(root,{recursive:true,persistent:false},(_event,file)=>{
            if(!file || /\.(jsonl|json)$/i.test(String(file))) this.queueRefresh(getSnapshot,path.join(root,String(file||'')));
          });
          watcher.on('error',error=>{
            watcher.close();this._watchers.delete(root);
            this._status={...this._status,watchError:error.message};
            console.warn('[session-search] source watcher failed; periodic reconciliation remains active:',error.message);
          });
          this._watchers.set(root,watcher);
        } catch(error) {this._status={...this._status,watchError:error.message};console.warn('[session-search] watch unavailable:',error.message);}
      }
      this.queueRefresh(getSnapshot);
    };
    this._maintenanceTimer=setInterval(reconcile,60000);this._maintenanceTimer.unref?.();
    reconcile();
  }

  status() {
    // 2026-08-28：以前这里往子进程发一次 'status' 往返。子进程是单线程的，重建索引
    // 时（本机 2400+ 个来源要几分钟）这条请求会排在整批解析后面，于是搜索弹窗顶上
    // 一直停在「正在读取本地索引…」，看起来像卡死 —— 用户就是这么反馈的。
    //
    // 但 this._status 本来就是**实时**的：子进程在 indexing 过程中会主动 push
    // {type:'status'}（见 _handleChildMessage）。直接返回缓存即可，永远不会被阻塞。
    //
    // 唯一的例外：子进程还没起来过（关了 prewarm 的隔离实例、或刚启动还没搜过），
    // 这时缓存里是初始占位值，会一直显示「未就绪 / 0 个会话」。所以**顺手异步问
    // 一次**，不 await —— 本次仍然立刻返回缓存，下一次轮询就是真实数据。
    if (!this._child) {
      this._request('status').catch(() => {});
    }
    return Promise.resolve({ ...this._status });
  }

  prewarm(snapshot = {}) {
    if (!this._prewarmEnabled) {
      this._status = { ...this._status, phase: 'deferred', ready: false, refreshing: false, lastError: null };
      return Promise.resolve({ ...this._status });
    }
    return this.refresh(snapshot, { force: false });
  }

  getStats() {
    return {
      ...this._stats,
      childRestarts: this._stats.workerRestarts,
      pending: this._pending.size,
      status: { ...this._status },
    };
  }

  async close() {
    if (this._closed && !this._closingChild) return;
    this._closed = true;
    clearInterval(this._maintenanceTimer);clearTimeout(this._queueTimer);
    for(const watcher of this._watchers.values()) watcher.close();
    this._watchers.clear();this._queuedSources.clear();this._queuedSnapshot=null;
    const error = new Error('Session search service closed');
    for (const pending of this._pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this._pending.clear();
    const child = this._closingChild || this._child;
    this._child = null;
    if (!child) return;
    this._closingChild = child;
    if (child.exitCode !== null && child.exitCode !== undefined) { this._closingChild = null; return; }
    await new Promise((resolve, reject) => {
      let settled = false;
      let exitTimer;
      const finish = () => { this._closingChild = null; if (settled) return; settled = true; clearTimeout(timer); clearTimeout(exitTimer); resolve(); };
      const terminate = () => {
        if (settled || exitTimer) return;
        // A kill request is not exit confirmation. A replacement Hub must not
        // migrate the shared search index while this writer is still alive.
        exitTimer=setTimeout(() => {
          if (settled) return;
          settled=true;clearTimeout(timer);
          reject(new Error('历史索引进程尚未确认退出，取消重启'));
        },5000);
        try { child.kill(); }
        catch(error) { settled=true;clearTimeout(timer);clearTimeout(exitTimer);reject(error); }
      };
      const timer = setTimeout(() => {
        terminate();
      }, 2000);
      timer.unref?.();
      child.once('exit', finish);
      try { child.send({ type: 'close' }, error => { if (error) terminate(); }); }
      catch { terminate(); }
    });
  }
}

module.exports = { SessionSearchService };
