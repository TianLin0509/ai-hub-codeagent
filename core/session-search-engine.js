'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const { SqliteSessionSearchIndex } = require('./session-search-sqlite-index.js');
const { SearchSourceMetaCache } = require('./search-source-meta-cache.js');
const {
  collectSourceDescriptors,
  isMetadataOnlySignature,
  normalizePath,
  parseSourceDescriptor,
  titleOnlySourceFromDescriptor,
  titleOnlySources,
} = require('./session-search-sources.js');
const {
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_SOURCE_CHARS,
  DEFAULT_MAX_SOURCES,
  sqlitePathForLegacyCache,
} = require('./session-search-config.js');
const { transcriptMdPath, writeTranscriptMarkdown } = require('./session-transcript-md.js');

// Non-Codex adapters still materialize source text and retain conservative
// bounds. Codex uses a byte-filtered semantic stream, so its raw rollout size
// is not a proxy for memory use and must never trigger title-only degradation.

function clipSource(source, options = {}) {
  const maxSourceChars = Math.max(64 * 1024, Number(options.maxSourceChars) || DEFAULT_MAX_SOURCE_CHARS);
  const maxDocChars = Math.max(8 * 1024, Number(options.maxDocChars) || DEFAULT_MAX_DOC_CHARS);
  const preserveAll = options.preserveAll === true;
  const docs = [];
  let chars = 0;
  let truncated = false;
  for (const doc of (source && source.docs || [])) {
    const raw = String(doc && doc.text || '');
    if (!raw) continue;
    if (preserveAll) {
      const chunks = Math.max(1, Math.ceil(raw.length / maxDocChars));
      for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex += 1) {
        const text = raw.slice(chunkIndex * maxDocChars, (chunkIndex + 1) * maxDocChars);
        const suffix = chunks > 1 ? `:chunk:${chunkIndex}` : '';
        docs.push({
          ...doc,
          id: `${doc.id || doc.eventId || 'doc'}${suffix}`,
          eventId: `${doc.eventId || doc.id || 'doc'}${suffix}`,
          text,
          ordinal: Number(doc.ordinal || 0) + chunkIndex / (chunks + 1),
        });
        chars += text.length;
      }
      continue;
    }
    const remaining = maxSourceChars - chars;
    if (remaining <= 0) { truncated = true; break; }
    const limit = Math.min(maxDocChars, remaining);
    const text = raw.length > limit ? raw.slice(0, limit) : raw;
    if (text.length < raw.length) truncated = true;
    docs.push({ ...doc, text });
    chars += text.length;
  }
  return {
    source: { ...source, docs, stale: !!(source && source.stale) || truncated, truncatedByStorageGuard: truncated },
    chars,
    truncated,
  };
}

class SessionSearchEngine {
  constructor(options = {}, emitStatus = () => {}) {
    this.backgroundWriter = options.backgroundWriter === true;
    this.writerOptions = { ...options, backgroundWriter: false };
    this.writer = null;
    this.writerLeaseToken = options.writerLeaseToken || null;
    this.writerRequest = null;
    this.retryState = new Map();
    this._sourceMetaCache = new SearchSourceMetaCache();
    const databasePath = options.databasePath || sqlitePathForLegacyCache(options.cachePath);
    if (!databasePath) throw new Error('session search databasePath is required');
    this.options = {
      databasePath,
      cachePath: options.cachePath || null,
      claudeRoots: Array.isArray(options.claudeRoots) ? options.claudeRoots : [],
      codexRoots: Array.isArray(options.codexRoots) ? options.codexRoots : [],
      kimiRoots: Array.isArray(options.kimiRoots) ? options.kimiRoots : [],
      geminiRoots: Array.isArray(options.geminiRoots) ? options.geminiRoots : [],
      meetingDir: options.meetingDir || null,
      refreshTtlMs: Number(options.refreshTtlMs) || 60_000,
      cjkAuxBudgetMs: Math.max(50, Number(options.cjkAuxBudgetMs) || 600),
      maxSources: Math.max(20, Number(options.maxSources) || DEFAULT_MAX_SOURCES),
      maxFileBytes: Math.max(1024 * 1024, Number(options.maxFileBytes) || DEFAULT_MAX_FILE_BYTES),
      maxSourceChars: Math.max(64 * 1024, Number(options.maxSourceChars) || DEFAULT_MAX_SOURCE_CHARS),
      maxDocChars: Math.max(8 * 1024, Number(options.maxDocChars) || DEFAULT_MAX_DOC_CHARS),
      transcriptDir: options.transcriptDir || null,
    };
    this.emitStatus = emitStatus;
    this.index = new SqliteSessionSearchIndex(databasePath, options);
    // 短词（1~2 字，中文最常打的长度）要顺序扫「标题 / 我的提问 / AI 回答」三档。
    // 这几档一共十几 MB，冷缓存下第一次查要 1241ms；预热一次只要 ~75ms，之后同一个
    // 查询 65ms。放进 setImmediate：既不挡构造，也不挡第一次查询。
    setImmediate(() => { try { this.index.prewarmShortTermScopes(); } catch { /* 预热失败无所谓 */ } });
    this.refreshPromise = null;
    this.lastRefreshAt = Number(this.index.getMeta('lastRefreshAt', 0)) || 0;
    const stats = this.index.getStats();
    const staleSources = Number(stats.staleSources) || 0;
    this.statusValue = {
      phase: stats.sessions ? (staleSources ? 'ready_with_errors' : 'ready') : 'idle',
      ready: stats.sessions > 0,
      refreshing: false,
      indexedSources: this.index.getSourceSignatures().size,
      totalSources: this.index.getSourceSignatures().size,
      parsedSources: 0,
      reusedSources: 0,
      staleSources,
      lastRefreshAt: this.lastRefreshAt,
      contentUpdatedAt: Number(this.index.getMeta('contentUpdatedAt',0)) || 0,
      lastError: null,
      sourceErrors: [],
      index: stats,
      storage: 'sqlite-child-process',
    };
  }

  _emit(patch = {}) {
    this.statusValue = { ...this.statusValue, ...patch, index: patch.index || this.index.getStats() };
    try { this.emitStatus({ ...this.statusValue }); } catch {}
  }

  _dynamicOptions(snapshot = {}) {
    const codexRoots = new Set(this.options.codexRoots.map(normalizePath).filter(Boolean));
    const originalByNormalized = new Map(this.options.codexRoots.map(root => [normalizePath(root), root]));
    for (const session of (Array.isArray(snapshot.sessions) ? snapshot.sessions : [])) {
      const root = session && session.codexSessionsRoot;
      const normalized = normalizePath(root);
      if (!normalized) continue;
      codexRoots.add(normalized);
      originalByNormalized.set(normalized, root);
    }
    return {
      ...this.options,
      codexRoots: [...codexRoots].map(key => originalByNormalized.get(key) || key),
    };
  }

  _readLegacyShard(shardDir, fileName) {
    const safeName = path.basename(String(fileName || ''));
    if (!safeName || safeName !== fileName) throw new Error(`非法旧索引分片名: ${fileName}`);
    const filePath = path.join(shardDir, safeName);
    const stat = fs.statSync(filePath);
    if (stat.size > 16 * 1024 * 1024) throw new Error(`旧索引分片过大: ${safeName}`);
    const raw = zlib.gunzipSync(fs.readFileSync(filePath), { maxOutputLength: 12 * 1024 * 1024 });
    return JSON.parse(raw.toString('utf8'));
  }

  async _migrateLegacyCache(allowedKeys) {
    const cachePath = this.options.cachePath;
    if (!cachePath || !fs.existsSync(cachePath)) return [];
    if (Number(this.index.getMeta('legacyCacheMigrationVersion', 0)) >= 3) return [];
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch (error) {
      return [`旧索引清单读取失败: ${error.message}`];
    }
    if (!manifest || manifest.version !== 2 || !Array.isArray(manifest.entries)) return [];
    const shardDir = `${cachePath}.sources`;
    const eligibleEntries = allowedKeys instanceof Set
      ? manifest.entries.filter(entry => entry && allowedKeys.has(entry.key))
      : manifest.entries;
    const entries = eligibleEntries.slice(0, this.options.maxSources);
    const diagnostics = [];
    const existing = this.index.getSourceStates();
    let migrated = 0;
    let reused = 0;
    let processed = 0;
    this._emit({
      phase: 'migrating_legacy_cache', refreshing: true,
      totalSources: entries.length, indexedSources: 0,
    });
    for (const entry of entries) {
      if (!entry || !entry.key || !Array.isArray(entry.files) || !entry.files.length) continue;
      const previous = existing.get(entry.key);
      if (previous && previous.signature === entry.signature) {
        reused += 1;
      } else {
        try {
          const firstPart = this._readLegacyShard(shardDir, entry.files[0]);
          if (!firstPart || !firstPart.source) throw new Error('分片缺少 source 元数据');
          const { docs: _ignoredDocs, ...sourceMeta } = firstPart.source;
          const source = {
            ...sourceMeta,
            key: entry.key,
            signature: String(entry.signature || sourceMeta.signature || ''),
            stale: entry.stale === true,
          };
          let chars = 0;
          let truncated = false;
          const self = this;
          function* chunks() {
            for (let fileIndex = 0; fileIndex < entry.files.length; fileIndex += 1) {
              const part = fileIndex === 0 ? firstPart : self._readLegacyShard(shardDir, entry.files[fileIndex]);
              const clipped = [];
              for (const doc of (Array.isArray(part && part.docs) ? part.docs : [])) {
                if (doc && doc.scope === 'title') continue;
                const remaining = self.options.maxSourceChars - chars;
                if (remaining <= 0) { truncated = true; break; }
                const rawText = String(doc && doc.text || '');
                if (!rawText) continue;
                const limit = Math.min(self.options.maxDocChars, remaining);
                const text = rawText.length > limit ? rawText.slice(0, limit) : rawText;
                if (text.length < rawText.length) truncated = true;
                clipped.push({ ...doc, text });
                chars += text.length;
              }
              if (clipped.length) yield clipped;
              if (chars >= self.options.maxSourceChars) {
                if (fileIndex + 1 < entry.files.length) truncated = true;
                break;
              }
            }
          }
          this.index.replaceSourceChunks(source, chunks());
          if (truncated) this.index.markSourceStale(entry.key, source.signature);
          migrated += 1;
        } catch (error) {
          diagnostics.push(`${entry.key}: ${error.message}`);
        }
      }
      processed += 1;
      if (processed % 8 === 0 || processed === entries.length) {
        this._emit({
          phase: 'migrating_legacy_cache', refreshing: true,
          totalSources: entries.length, indexedSources: processed,
          parsedSources: migrated, reusedSources: reused,
          sourceErrors: diagnostics.slice(0, 8),
        });
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    if (eligibleEntries.length > entries.length) {
      diagnostics.push(`旧索引迁移仅处理前 ${entries.length}/${eligibleEntries.length} 个可用来源`);
    }
    this.index.setMeta('legacyCacheMigrationVersion', 3);
    this.index.setMeta('legacyCacheMigratedAt', Date.now());
    return diagnostics;
  }

  async _refreshInWorker(snapshot, options) {
    if (this.refreshPromise) return this.refreshPromise;
    if (!this.writer) {
      const leaseToken=randomUUID();
      this.writerLeaseToken=leaseToken;
      const writer = new Worker(path.join(__dirname, 'session-search-refresh-worker.js'), {workerData:{...this.writerOptions,writerLeaseToken:leaseToken}});
      this.writer = writer;
      writer.on('message', message => {
        this.index.statsCache = null;
        if(message.type === 'status') {this.statusValue={...this.statusValue,...message.status};this.emitStatus({...this.statusValue});return;}
        const pending=this.writerRequest;
        if(!pending || message.id!==pending.id) return;
        this.writerRequest=null;
        if(message.error) pending.reject(new Error(message.error));
        else {this.lastRefreshAt=message.result.lastRefreshAt||this.lastRefreshAt;this.statusValue={...this.statusValue,...message.result};pending.resolve({...this.statusValue});}
      });
      const fail=error=>{
        if(this.writer!==writer) return;
        this.writer=null;
        // A failed thread leaves its parent PID alive. Release only this
        // thread's token, otherwise the next writer would wait forever.
        try {this.index.releaseWriterLease(leaseToken);} catch(leaseError) {console.warn('[session-search] failed writer lease cleanup:',leaseError.message);}
        this._emit({phase:this.statusValue.ready?'ready_with_errors':'error',refreshing:false,lastError:error.message});
        if(this.writerRequest) {this.writerRequest.reject(error);this.writerRequest=null;}
      };
      writer.on('error',fail);
      writer.on('exit',code=>{if(this.writer===writer) fail(new Error(`后台索引线程退出 (${code})`));});
    }
    this.refreshPromise=new Promise((resolve,reject)=>{
      const id=Date.now()+Math.random();this.writerRequest={id,resolve,reject};
      this.writer.postMessage({id,type:'refresh',snapshot,options});
    }).finally(()=>{this.refreshPromise=null;});
    return this.refreshPromise;
  }

  async refresh(snapshot = {}, { force = false, immediate = false } = {}) {
    if(this.backgroundWriter) return this._refreshInWorker(snapshot,{force,immediate});
    if (this.refreshPromise) return this.refreshPromise;
    if (!force && !immediate && this.statusValue.ready && Date.now() - this.lastRefreshAt < this.options.refreshTtlMs) {
      return { ...this.statusValue };
    }
    // 已经有可用索引时，这一趟本质是「增量体检」：绝大多数来源的 signature 没变，
    //   会被原样复用，用户的检索能力一秒都没缺失。此时**不要**先把状态翻成
    //   refreshing —— 前端一看见 refreshing 就显示「正在建立本地索引 · 0/N」并禁用按钮。
    //   TTL 只有 10s，于是用户每次打开搜索面板都撞见这句话，得出「每次打开都要索引半天」
    //   的结论，而实际上索引是持久化且增量的，真正要重建的往往是 0 个来源。
    //   真有活要干时，下面统计出待解析数量再翻状态，那时候的进度条才是诚实的。
    const silentRescan = !force && this.statusValue.ready === true;
    this.refreshPromise = (async () => {
      const lease=this.index.acquireWriterLease(this.writerLeaseToken || undefined);
      if(!lease) {this._emit({phase:'waiting_writer',refreshing:false,lastError:null});return {...this.statusValue};}
      try {
      const previousStats=this.index.getStats();
      this._emit(silentRescan
        ? { phase: 'rescanning', lastError: null, sourceErrors: [] }
        : { phase: 'discovering', refreshing: true, lastError: null, sourceErrors: [] });
      if (force) this._sourceMetaCache.clear();
      const collected = collectSourceDescriptors(this._dynamicOptions(snapshot), snapshot, this._sourceMetaCache);
      const descriptors = [...(collected.descriptors || [])]
        .sort((left, right) => Number(right && right.mtime || 0) - Number(left && left.mtime || 0))
        .slice(0, this.options.maxSources);
      const migrationDiagnostics = await this._migrateLegacyCache(new Set(descriptors.map(descriptor => descriptor.key)));
      const diagnostics = [...migrationDiagnostics, ...(collected.diagnostics || [])];
      if ((collected.descriptors || []).length > descriptors.length) {
        diagnostics.push(`仅索引最近 ${descriptors.length}/${collected.descriptors.length} 个 transcript source`);
      }
      const sourceStates = this.index.getSourceStates();
      const activeKeys = new Set();
      let parsedSources = 0;
      let reusedSources = 0;
      let staleSources = diagnostics.length;
      let indexedChars = 0;
      let completed = 0;
      let processedChanges = 0;
      const reusable = (descriptor, previous) => {
        const retry=this.retryState.get(descriptor.key);
        if(!force && retry?.signature===descriptor.signature && retry.nextAt>Date.now()) return true;
        return !force && previous && previous.signature===descriptor.signature && !(descriptor.type==='codex' && previous.stale)
          // A missing chat log is regenerated; stale fallbacks never had one.
          && (previous.stale || this._transcriptPresent(descriptor.key));
      };
      // 先数清楚这一趟到底有多少来源真的要重新解析（signature 变了或之前失败过）。
      //   进度条按「要干的活」算，而不是按「扫过的目录数」算 —— 后者永远是 4000+，
      //   看上去像在从零重建，实际上可能一个都不用动。
      const pendingSources = descriptors.reduce((count, descriptor) => {
        const previous = sourceStates.get(descriptor.key) || null;
        return reusable(descriptor,previous) ? count : count + 1;
      }, 0);
      const announceProgress = !(silentRescan && pendingSources === 0);
      const progressTotal = pendingSources;
      if (!announceProgress) {
        // 纯体检：没有任何来源需要重解析。全程不打扰用户，状态保持 ready。
        this._emit({ phase: 'ready', totalSources: descriptors.length, indexedSources: descriptors.length });
      } else {
        this._emit({ refreshing: true, totalSources: progressTotal, indexedSources: 0, sourcesDiscovered:descriptors.length, sourcesPending:pendingSources, sourcesProcessed:0 });
      }

      for (const descriptor of descriptors) {
        const previous = sourceStates.get(descriptor.key) || null;
        if (reusable(descriptor,previous)) {
          activeKeys.add(descriptor.key);
          reusedSources += 1;
          if (previous.stale) staleSources += 1;
        } else {
          processedChanges += 1;
          try {
            const stat = fs.statSync(descriptor.filePath);
            // Codex and Claude are streamed and skip binary/tool-output rows, so
            // file size does not bound their memory; keep their full dialogue.
            const streamed = descriptor.type === 'codex' || descriptor.type === 'claude';
            if (!streamed && stat.size > this.options.maxFileBytes) {
              diagnostics.push(`${descriptor.filePath}: 文件过大，保留标题但跳过全文`);
              staleSources += 1;
              if (previous) this.index.markSourceStale(descriptor.key, descriptor.signature);
              else this.index.replaceSource(titleOnlySourceFromDescriptor(descriptor, { stale: true }));
              activeKeys.add(descriptor.key);
            } else {
              const parsed = parseSourceDescriptor(descriptor, collected.maps);
              const limited = clipSource(parsed, {
                ...this.options,
                preserveAll: streamed,
              });
              this.index.replaceSource(limited.source);
              this._writeTranscript(parsed, diagnostics);
              activeKeys.add(descriptor.key);
              parsedSources += 1;
              indexedChars += limited.chars;
              if (limited.truncated) staleSources += 1;
              this.retryState.delete(descriptor.key);
            }
          } catch (error) {
            staleSources += 1;
            diagnostics.push(`${descriptor.filePath || descriptor.key}: ${error.message}`);
            const retrySignature = `parse-error:${descriptor.signature}`;
            if (previous) this.index.markSourceStale(descriptor.key, retrySignature);
            else this.index.replaceSource(titleOnlySourceFromDescriptor(descriptor, { signature: retrySignature, stale: true }));
            activeKeys.add(descriptor.key);
            const attempts=(this.retryState.get(descriptor.key)?.attempts||0)+1;
            this.retryState.set(descriptor.key,{signature:descriptor.signature,attempts,nextAt:Date.now()+Math.min(300000,2000*2**Math.min(attempts,7))});
          }
        }
        completed += 1;
        // 状态推送仍然按 4 个一批（别把 IPC 刷爆），但**每一个来源都要让出事件循环**。
        // 以前 4 个才让一次：子进程是单线程的，一次搜索/状态请求最坏要等 4 个来源
        // 解析完，而大 Codex rollout 单个就要几百毫秒 —— 这就是重建索引时弹窗
        // 「卡顿」的直接原因。让出一次的成本是一个宏任务，2400 个来源可以忽略。
        // 静默体检（没有任何来源要重解析）时一个进度都不推：推了前端就会画进度条，
        // 又变回「看起来在重建索引」。有真活干时照常推。
        if (announceProgress && (completed % 4 === 0 || completed === descriptors.length)) {
          this._emit({
            phase: 'indexing', totalSources: progressTotal, indexedSources: processedChanges,
            sourcesDiscovered:descriptors.length, sourcesPending:Math.max(0,pendingSources-processedChanges), sourcesProcessed:processedChanges,
            parsedSources, reusedSources, staleSources, sourceErrors: diagnostics.slice(0, 8),
          });
        }
        await new Promise(resolve => setImmediate(resolve));
      }

      // Plan transcript representation without deleting fallback titles first.
      // Pruning here used to delete/reinsert every unchanged Hub title on each
      // refresh; simply removing that prune would let a fallback hide itself.
      const persistedPaths=this.index.db.prepare('SELECT transcript_path FROM sessions WHERE transcript_path IS NOT NULL').all().map(row=>normalizePath(row.transcript_path));
      const discoveryOptions=this._dynamicOptions(snapshot);
      const missingRoots=[...discoveryOptions.claudeRoots,...discoveryOptions.codexRoots,...discoveryOptions.kimiRoots,...discoveryOptions.geminiRoots,discoveryOptions.meetingDir]
        .filter(root=>root && !fs.existsSync(root) && persistedPaths.some(file=>file.startsWith(normalizePath(root).replace(/\/+$/,'')+'/')));
      if(missingRoots.length) {diagnostics.push(`来源目录暂不可达，保留已有记录：${missingRoots.join(', ')}`);staleSources+=missingRoots.length;}
      const discoveryComplete=!diagnostics.length && (collected.descriptors||[]).length===descriptors.length;
      const representedSourceKeys = new Set(activeKeys);
      if (!discoveryComplete) {
        for (const [key, previous] of sourceStates) {
          activeKeys.add(key);
          if (!isMetadataOnlySignature(previous.signature)) representedSourceKeys.add(key);
        }
      }
      const represented = this.index.getRepresentedIds(representedSourceKeys);
      const currentSignatures = this.index.getSourceSignatures();
      let metadataChanges=0;
      for (const source of titleOnlySources(collected.maps, represented.hubIds, represented.meetingIds)) {
        const limited = clipSource(source, this.options);
        if (force || currentSignatures.get(source.key) !== source.signature) {this.index.replaceSource(limited.source);metadataChanges++;}
        activeKeys.add(source.key);
      }
      this.index.pruneSources(activeKeys);
      // CJK 短词辅助索引的回填（2026-09-05）：每轮 refresh 后推进一段。
      //   刻意不一次性跑完 —— 子进程是单线程的，10 万行一口气回填会把搜索卡住几十秒。
      //   给固定预算、游标存库，下一轮接着跑；跑完置位后 1~2 字中文查询才切到索引。
      try {
        const step = this.index.backfillCjkAux({ budgetMs: this.options.cjkAuxBudgetMs });
        if (step && step.processed) {
          this._emit({ cjkAuxReady: this.index.cjkAuxReady(), cjkAuxCursor: step.cursor });
        }
      } catch (error) {
        // 辅助索引是纯加速能力，失败只是回到顺序扫描，绝不该让 refresh 整体失败
        console.warn('[session-search] CJK aux backfill failed:', error && error.message);
      }
      this.lastRefreshAt = Date.now();
      this.index.setMeta('lastRefreshAt', this.lastRefreshAt);
      // 刚重写过大量页，缓存被冲掉了，重新预热短词档
      setImmediate(() => { try { this.index.prewarmShortTermScopes(); } catch { /* 同上 */ } });
      const stats = this.index.getStats();
      if(parsedSources || metadataChanges || stats.sessions!==previousStats.sessions || stats.documents!==previousStats.documents) this.index.setMeta('contentUpdatedAt',Date.now());
      staleSources = Math.max(staleSources, Number(stats.staleSources) || 0);
      this._emit({
        phase: staleSources ? 'ready_with_errors' : 'ready',
        ready: true, refreshing: false,
        totalSources: activeKeys.size, indexedSources: activeKeys.size,
        parsedSources, reusedSources, staleSources,
        sourcesDiscovered:descriptors.length, sourcesPending:0, sourcesProcessed:processedChanges,
        indexedTextChars: indexedChars,
        lastRefreshAt: this.lastRefreshAt,
        contentUpdatedAt:Number(this.index.getMeta('contentUpdatedAt',0)) || 0,
        lastError: diagnostics[0] || null,
        sourceErrors: diagnostics.slice(0, 8),
        index: stats,
      });
      return { ...this.statusValue };
      } finally {this.index.releaseWriterLease(lease);}
    })().catch(error => {
      this._emit({ phase: this.statusValue.ready ? 'ready_with_errors' : 'error', refreshing: false, lastError: error.message });
      throw error;
    }).finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async search(request = {}, snapshot = {}) {
    if (!this.statusValue.ready) {
      // 冷启动：原来这里是 `await this.refresh(...)`，也就是**第一次搜索要等整个索引
      // 建完**（本机 2429 个来源、1.8GB，要几分钟）。用户明确要求「建索引放到后台冷加载，
      // 别让我在搜索时感觉很慢」。
      //
      // 现在改成：立刻用手上已有的索引回答（可能是空的、可能是上次的一部分），
      // 同时在后台把 refresh 踢起来，并用 indexing:true 告诉前端「全文还在建」。
      // 前端此时已经有标题层的即时结果可显示（core/title-index.js）。
      if (!this.refreshPromise) {
        setImmediate(() => { this.refresh(snapshot, { force: false }).catch(() => {}); });
      }
      return {
        ...this.index.search(request),
        refreshing: true,
        indexing: true,
        status: { ...this.statusValue },
      };
    }
    if (Date.now() - this.lastRefreshAt >= this.options.refreshTtlMs && !this.refreshPromise) {
      // 曾经是 `void this.refresh(...)`。看着像后台刷新，其实不是：refresh() 的函数体
      // 在第一个 await 之前是同步执行的，而那一段正是 collectSourceDescriptors()——
      // 要 readdir/stat 近 2000 个 transcript 并读每个 Codex rollout 的头部，实测 326ms。
      // TTL 只有 10s，所以弹窗闲置一会儿再搜必然先吃这一刀。挪到下一个事件循环，
      // 让本次查询先返回。
      setImmediate(() => { this.refresh(snapshot, { force: false }).catch(() => {}); });
    }
    return { ...this.index.search(request), refreshing: !!this.refreshPromise, status: { ...this.statusValue } };
  }

  preview(request = {}) {
    return this.index.preview(request);
  }

  _transcriptPresent(key) {
    if (!this.options.transcriptDir) return true;
    return fs.existsSync(transcriptMdPath(this.options.transcriptDir, key));
  }

  // The chat log is a derived export: a write failure is reported but never
  // blocks indexing.
  _writeTranscript(source, diagnostics) {
    if (!this.options.transcriptDir) return;
    try { writeTranscriptMarkdown(this.options.transcriptDir, source); }
    catch (error) { diagnostics.push(`${source.key}: 聊天记录 md 写入失败：${error.message}`); }
  }

  transcriptFor(request = {}) {
    if (!this.options.transcriptDir) return null;
    const row = request.key
      ? this.index.db.prepare('SELECT key,source_key,title FROM sessions WHERE key=?').get(String(request.key))
      : this.index.db.prepare('SELECT key,source_key,title FROM sessions WHERE hub_session_id=? ORDER BY updated_at DESC LIMIT 1').get(String(request.hubSessionId || ''));
    if (!row) return null;
    const file = transcriptMdPath(this.options.transcriptDir, row.source_key);
    return { key: row.key, title: row.title, path: file, exists: fs.existsSync(file) };
  }

  status() {
    return { ...this.statusValue };
  }

  close() {
    const writer=this.writer;
    if(writer) {
      return Promise.resolve(this.refreshPromise).catch(error => {
        this._emit({refreshing:false,lastError:error.message});
      }).then(() => {
        if(writer.threadId===-1) return;
        return new Promise((resolve,reject) => {
        this.writer=null;
        writer.once('exit',code => code===0?resolve():reject(new Error(`后台索引关闭失败 (${code})`)));
        writer.once('error',reject);
        writer.postMessage({type:'close'});
        });
      }).finally(() => { this._sourceMetaCache.clear(); this.index.close(); });
    }
    this._sourceMetaCache.clear();
    this.index.close();
  }
}

module.exports = {
  DEFAULT_MAX_DOC_CHARS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_SOURCE_CHARS,
  DEFAULT_MAX_SOURCES,
  SessionSearchEngine,
  clipSource,
  sqlitePathForLegacyCache,
};
