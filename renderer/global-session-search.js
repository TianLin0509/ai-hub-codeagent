'use strict';

const { recordSearch, readRecent } = require('../core/search-recent.js');
const { isOtherSearchProvider, matchesSearchProvider } = require('../core/session-search-providers');
const { buildTitleIndex, searchTitles, sameSession } = require('../core/title-index.js');
const { isBlockingModalOpen } = require('./modal-layer-guard.js');
const { sinceTimestamp } = require('../core/session-search-index');
const { projectPathKey, projectFilterFor, projectForCwd, matchesProjectFilter } = require('../core/session-search-projects');
const { AGENT_SESSION_GROUPS, agentGroupOf, getSidebarSearchEntries } = require('./session-list-renderer.js');

const FACET_STORAGE_KEY = 'hub.search.facets';
function loadSearchFacets(storage) {
  try {
    const value = JSON.parse(storage.getItem(FACET_STORAGE_KEY) || '{}');
    return { provider: Object.hasOwn(PROVIDER_META, value.provider) ? value.provider : 'all',
      agent: AGENT_SESSION_GROUPS.some(g => g.key === value.agent) ? value.agent : 'all' };
  } catch { return { provider: 'all', agent: 'all' }; }
}
function filterSearchEntries(entries, { scope = 'all', agent = 'all', providers = [], project = '', projectFilter = null, timeRange = 'all', now = Date.now() } = {}) {
  const since = sinceTimestamp(timeRange, now);
  return entries.filter(entry => (scope !== 'dormant' || entry.archived === true)
    && (scope !== 'pinned' || entry.pinned === true)
    && (agent === 'all' || (entry.agentGroup || agentGroupOf(entry)) === agent)
    && matchesSearchProvider(entry.provider, providers)
    && (!project || String(entry.projectLabel || '').toLowerCase().includes(project.toLowerCase()))
    && matchesProjectFilter(entry.cwd, projectFilter)
    && (since == null || (Number(entry.updatedAt) >= since && Number(entry.updatedAt) <= now)));
}

function filterSearchHits(hits, entries) {
  const hubIds = new Set(entries.filter(e => e.hubSessionId).map(e => e.hubSessionId));
  const meetingIds = new Set(entries.filter(e => e.meetingId).map(e => e.meetingId));
  return hits.filter(hit => hubIds.has(hit.hubSessionId) || meetingIds.has(hit.meetingId));
}

function catalogueHit(entry) {
  return { ...entry, sessionKey: entry.key, titleOnly: true, matchCount: 1,
    bestMatch: { eventId: null, scope: 'title', role: 'title', timestamp: entry.updatedAt, text: entry.title } };
}

const PROVIDER_META = Object.freeze({
  claude: { label: 'Claude', className: 'provider-claude' },
  codex: { label: 'Codex', className: 'provider-codex' },
  meeting: { label: '群聊', className: 'provider-meeting' },
  deepseek: { label: 'DeepSeek', className: 'provider-deepseek' },
  kimi: { label: 'Kimi', className: 'provider-kimi' },
  gemini: { label: 'Gemini', className: 'provider-gemini' },
  other: { label: '其他', className: 'provider-other' },
  qwen: { label: '千问', className: 'provider-other' },
  glm: { label: '智谱', className: 'provider-other' },
  all: { label: '全部', className: 'provider-all' },
});

// 这几个来源平时没几条，零命中时不占筛选栏的位置（deepseek 一直是这个待遇）
const OPTIONAL_PROVIDERS = Object.freeze(['deepseek', 'kimi', 'gemini']);

const SCOPE_LABELS = Object.freeze({
  title: '标题',
  user: '我的提问',
  assistant: 'AI 回答',
  tool: '工具 / 文件',
});

function normalizeTerms(query) {
  return String(query || '').normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
}

function appendHighlightedText(document, root, text, query) {
  const raw = String(text || '');
  const terms = normalizeTerms(query).sort((a, b) => b.length - a.length);
  if (!terms.length) {
    root.appendChild(document.createTextNode(raw));
    return;
  }
  const lower = raw.normalize('NFKC').toLocaleLowerCase();
  let cursor = 0;
  while (cursor < raw.length) {
    let next = null;
    for (const term of terms) {
      const index = lower.indexOf(term, cursor);
      if (index < 0) continue;
      if (!next || index < next.index || (index === next.index && term.length > next.term.length)) {
        next = { index, term };
      }
    }
    if (!next) {
      root.appendChild(document.createTextNode(raw.slice(cursor)));
      break;
    }
    if (next.index > cursor) root.appendChild(document.createTextNode(raw.slice(cursor, next.index)));
    const mark = document.createElement('mark');
    mark.textContent = raw.slice(next.index, next.index + next.term.length);
    root.appendChild(mark);
    cursor = next.index + next.term.length;
  }
}

function formatSearchTime(timestamp, now = Date.now()) {
  const at = Number(timestamp) || 0;
  if (!at) return '';
  const diff = Math.max(0, now - at);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';
  const parts = value => {const d=new Date(value);return {year:d.getFullYear(),month:d.getMonth()+1,day:d.getDate()};};
  const date = parts(at);
  const current = parts(now);
  const year = date.year === current.year ? '' : `${date.year}-`;
  return `${year}${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function formatAbsolute(timestamp) {
  if (!timestamp) return '';
  try { return new Date(timestamp).toLocaleString('zh-CN'); }
  catch { return ''; }
}

function providerMeta(provider) {
  return PROVIDER_META[provider] || { label: provider || 'AI', className: 'provider-all' };
}

function indexProgressModel(status = {}) {
  const visible = status.refreshing === true;
  const done = Math.max(0, Number(status.indexedSources) || 0);
  const total = Math.max(0, Number(status.totalSources) || 0);
  const determinate = visible && total > 0;
  const percent = determinate ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : null;
  const phaseLabel = {
    discovering: '正在发现会话',
    migrating_legacy_cache: '正在迁移旧索引',
    indexing: '正在解析会话',
  }[status.phase] || '正在建立本地索引';
  return {
    visible,
    determinate,
    done,
    total,
    percent,
    percentText: determinate ? `${percent}%` : '准备中',
    detail: determinate
      ? `${phaseLabel} · ${done}/${total} 个来源 · 可继续使用 AI Hub`
      : `${phaseLabel} · 可继续使用 AI Hub`,
    valueText: determinate ? `${phaseLabel}，已完成 ${done}/${total}，${percent}%` : phaseLabel,
  };
}

function createStaticEmpty(document, { title, detail, className = '', busy = false } = {}) {
  const empty = document.createElement('div');
  empty.className = `session-search-empty ${className || ''}${busy ? ' busy' : ''}`.trim();
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '1.5');
  icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', busy ? 'M12 3a9 9 0 1 0 9 9' : 'M5 5l14 14M8.5 8.5A6 6 0 0 0 17 17');
  icon.appendChild(path);
  const strong = document.createElement('strong');
  strong.textContent = title || '';
  const span = document.createElement('span');
  span.textContent = detail || '';
  empty.append(icon, strong, span);
  return empty;
}

function createGlobalSessionSearch(options) {
  const {
    document,
    window,
    ipcRenderer,
    clipboard,
    openHit = async () => {},
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    // 侧栏那 682 个标题（会话 + 群聊）。它们本来就在渲染进程的内存里，
    // 加起来只有 10KB —— 标题检索不该走 IPC，也不该等全文索引建好。
    getLocalTitles = null,
    cardRenderer = null,
    openPath = null,
  } = options;
  const overlay = document.getElementById('search-modal');
  const queryInput = document.getElementById('search-query');
  const closeButton = document.getElementById('search-modal-close');
  const launchButton = document.getElementById('btn-global-search');
  const resultsRoot = document.getElementById('search-results');
  const previewRoot = document.getElementById('session-search-preview');
  const summaryRoot = document.getElementById('session-search-result-summary');
  const providerRoot = document.getElementById('session-search-command');
  const home = document.getElementById('session-search-home');
  const reader = document.getElementById('session-search-reader');
  const readerClose = document.getElementById('session-search-reader-close');
  const advanced = document.getElementById('session-search-advanced');
  const filterToggle = document.getElementById('session-search-filter-toggle');
  const suggestions = document.getElementById('session-search-suggestions');
  const scopeRoot = document.getElementById('session-search-scope-tabs');
  const timeSelect = document.getElementById('session-search-time');
  const projectSelect = document.getElementById('session-search-project');
  const sortSelect = document.getElementById('session-search-sort');
  const timeField = document.getElementById('session-search-time-field');
  const conditions = document.getElementById('session-search-conditions');
  const projectRail = document.getElementById('session-search-project-rail');
  const indexDetails = document.getElementById('session-search-index-details');
  const statusButton = document.getElementById('session-search-index-status');
  const statusText = document.getElementById('session-search-status-text');
  const progressRoot = document.getElementById('session-search-progress');
  const progressTrack = document.getElementById('session-search-progress-track');
  const progressFill = document.getElementById('session-search-progress-fill');
  const progressPercent = document.getElementById('session-search-progress-percent');
  const progressDetail = document.getElementById('session-search-progress-detail');
  const liveRegion = document.getElementById('session-search-live');

  const savedFacets = loadSearchFacets(window.localStorage);
  let activeProvider = savedFacets.provider;
  let activeAgent = savedFacets.agent;
  let activeScope = 'dialogue';
  let results = [];
  let activeIndex = -1;
  let activePreview = null;
  let searchTimer = null;
  let statusTimer = null;
  let searchSequence = 0;
  let previewSequence = 0;
  let lastResponse = null;
  let statusWasRefreshing = false;
  let returnFocusElement = null;
  let titleIndex = [];
  let lastTitleHits = [];
  let lastStatus = null;
  let lastRequest = null;
  let lastRecordedQueryId = null;
  let previewMode = 'overview';
  let previewPage = {};
  let projectLibrary = [];
  let projectLoadSequence = 0;
  let projectLoadError = '';
  const projectNote = document.getElementById('session-search-project-note');
  try { sortSelect.value = window.localStorage.getItem('hub.search.sort') || 'relevance'; } catch { /* Optional UI preference. */ }
  if (!sortSelect.value) sortSelect.value='relevance';
  const directionSelect=document.createElement('select');directionSelect.id='session-search-direction';directionSelect.setAttribute('aria-label','排序方向');
  for(const [value,text] of [['desc','降序'],['asc','升序']]) {const option=document.createElement('option');option.value=value;option.textContent=text;directionSelect.append(option);}
  sortSelect.after(directionSelect);
  directionSelect.disabled=sortSelect.value==='relevance';
  directionSelect.value=sortSelect.value==='title'?'asc':'desc';
  let lastQuerySort=sortSelect.value,lastQueryDirection=directionSelect.value,queryWasEmpty=false;
  function syncSortChoice(query) {
    const empty=!query;
    if(empty && !queryWasEmpty) {lastQuerySort=sortSelect.value;lastQueryDirection=directionSelect.value;if(sortSelect.value==='relevance') sortSelect.value='conversationTime';}
    else if(!empty && queryWasEmpty) {sortSelect.value=lastQuerySort;directionSelect.value=lastQueryDirection;}
    queryWasEmpty=empty;
    const relevance=sortSelect.querySelector('option[value="relevance"]');
    relevance.disabled=empty;relevance.textContent=empty?'相关度（需关键词）':'相关度';
    sortSelect.title=empty?'未输入关键词，按字段浏览；输入后恢复上次搜索排序。':'';
    directionSelect.disabled=sortSelect.value==='relevance';
  }
  const newResults = document.createElement('button');
  newResults.type='button';newResults.className='session-search-new-results';newResults.hidden=true;
  newResults.textContent='内容已更新 · 刷新结果';
  newResults.addEventListener('click',()=>{newResults.hidden=true;void performSearch({immediate:true});});
  summaryRoot.after(newResults);

  const agentRoot = document.createElement('div');
  agentRoot.id = 'session-search-agent-filters';
  agentRoot.className = 'session-search-agent-filters';
  agentRoot.setAttribute('role', 'group');
  agentRoot.setAttribute('aria-label', '按 Agent 筛选');
  const agentLabel = document.createElement('span');
  agentLabel.textContent = 'Agent';
  agentRoot.appendChild(agentLabel);
  for (const group of [{ key: 'all', label: '全部' }, ...AGENT_SESSION_GROUPS]) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'session-search-chip';
    button.dataset.agent = group.key; button.textContent = group.label;
    agentRoot.appendChild(button);
  }
  document.getElementById('session-search-agent-slot').append(agentRoot);
  for (const [key, label] of [['dormant', '归档'], ['pinned', '置顶管理']]) {
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.scope = key; button.textContent = label;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', 'false');
    scopeRoot.appendChild(button);
  }
  function persistFacets() {
    try { window.localStorage.setItem(FACET_STORAGE_KEY, JSON.stringify({ provider: activeProvider, agent: activeAgent })); }
    catch (error) { console.warn('[session-search] facet preferences were not saved:', error); }
  }
  function setAgent(agent) {
    activeAgent = AGENT_SESSION_GROUPS.some(g => g.key === agent) ? agent : 'all';
    for (const button of agentRoot.querySelectorAll('[data-agent]')) {
      const selected = button.dataset.agent === activeAgent;
      button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected));
    }
    persistFacets();
  }
  function catalogueFilter(request = searchRequest()) {
    return filterSearchEntries(titleIndex, { scope: activeScope, agent: activeAgent, ...request });
  }
  const browsingCatalogue = () => activeScope === 'dormant' || activeScope === 'pinned' || activeAgent !== 'all';

  /** 打开弹窗时重建一次即时标题索引。682 条 / 10KB，实测亚毫秒。 */
  function refreshTitleIndex() {
    try {
      const live = getSidebarSearchEntries(document);
      titleIndex = buildTitleIndex(live.length ? live : (typeof getLocalTitles === 'function' ? getLocalTitles() : []) || []);
    } catch {
      titleIndex = [];   // 即时层是加分项，坏掉也不能拖垮全文检索
    }
  }

  function localTitleHits(request) {
    if (!titleIndex.length) return [];
    // Live catalogue metadata cannot prove message timestamps. Timed title
    // hits and all final ordering therefore come from the same SQLite snapshot.
    if (request.timeRange !== 'all' || !request.scopes.includes('title')) return [];
    try {
      return searchTitles(catalogueFilter(request), request.query, {
        limit: request.limit || 50,
        providers: request.providers,
        since: request.since,
        sort: request.sort,
        direction: request.direction,
      });
    } catch {
      return [];
    }
  }

  const isOpen = () => overlay && overlay.style.display === 'flex';

  function announce(text) {
    if (liveRegion) liveRegion.textContent = String(text || '');
  }

  function statusDescription(status) {
    const stats = status && status.index || {};
    if (status && status.lastError && !status.ready) return status.lastError;
    if (status && status.refreshing) {
      const done = Number(status.indexedSources) || 0;
      const total = Number(status.totalSources) || 0;
      return status.ready ? `后台更新 · ${done}/${total} 个变化来源` : total ? `首次整理 · ${done}/${total}` : '正在发现历史记录…';
    }
    if (status && status.ready) {
      const suffix = status.phase === 'ready_with_errors' && status.staleSources
        ? ` · ${status.staleSources} 个来源仅保留旧索引或标题`
        : '';
      return `已同步 · ${Number(stats.sessions) || 0} 个会话${suffix}`;
    }
    return '正在读取本地索引…';
  }

  function renderStatus(status) {
    lastStatus = status || null;
    if (!statusButton || !statusText) return;
    const progress = indexProgressModel(status);
    statusButton.classList.remove('ready', 'busy', 'error');
    if (status && status.ready && !status.refreshing) statusButton.classList.add('ready');
    else if (status && status.lastError && !status.ready) statusButton.classList.add('error');
    else statusButton.classList.add('busy');
    statusText.textContent = statusDescription(status);
    statusButton.disabled = false;
    statusButton.title = '查看同步详情';
    if (progressRoot && progressTrack && progressFill && progressPercent && progressDetail) {
      progressRoot.hidden = !progress.visible || !!(status && status.ready);
      progressTrack.classList.toggle('indeterminate', progress.visible && !progress.determinate);
      progressFill.style.width = progress.determinate ? `${progress.percent}%` : '34%';
      progressPercent.textContent = progress.percentText;
      progressDetail.textContent = progress.detail;
      progressTrack.setAttribute('aria-valuetext', progress.valueText);
      if (progress.determinate) progressTrack.setAttribute('aria-valuenow', String(progress.percent));
      else progressTrack.removeAttribute('aria-valuenow');
    }
  }

  async function refreshStatus({ repeat = true } = {}) {
    try {
      const status = await ipcRenderer.invoke('get-session-search-status');
      const contentChanged=lastStatus && status?.contentUpdatedAt>(lastStatus.contentUpdatedAt||0);
      renderStatus(status);
      const refreshJustCompleted = (statusWasRefreshing || contentChanged) && status && status.ready && !status.refreshing;
      statusWasRefreshing = !!(status && status.refreshing);
      if (refreshJustCompleted && isOpen()) {
        if(!results.length) void performSearch({ immediate: true });
        else newResults.hidden=false;
      }
      if (repeat && isOpen()) {
        if (statusTimer) clearTimeoutFn(statusTimer);
        statusTimer = setTimeoutFn(() => refreshStatus({ repeat: true }), status?.refreshing?450:3000);
      }
      return status;
    } catch (error) {
      renderStatus({ ready: false, lastError: error.message });
      return null;
    }
  }

  function searchRequest() {
    const query = queryInput.value.trim();
    syncSortChoice(query);
    const now = Date.now();
    const since = sinceTimestamp(timeSelect.value, now);
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      query,
      providers: activeProvider === 'all' ? [] : [activeProvider],
      scopes: activeScope === 'all' ? ['title','user','assistant']
        : ['dialogue','dormant','pinned'].includes(activeScope) ? ['title','user','assistant'] : [activeScope],
      timeRange: timeSelect.value || 'all',
      projectFilter: projectFilterFor(projectLibrary, projectSelect.value),
      projectName: projectLibrary.find(item => projectPathKey(item.path) === projectPathKey(projectSelect.value))?.name || '',
      time: {field:timeField?.value || 'eventTime',from:since,to:since == null ? null : now,timeZone},
      sort: !query && sortSelect.value === 'relevance' ? 'conversationTime' : sortSelect.value || 'relevance',
      direction: directionSelect.value,
      limit: 50,
    };
  }

  function setProvider(provider) {
    activeProvider = provider || 'all';
    for (const button of providerRoot.querySelectorAll('[data-provider]')) {
      const active = button.dataset.provider === activeProvider;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    persistFacets();
  }

  function setScope(scope) {
    activeScope = ['all', 'dialogue', 'title', 'user', 'assistant', 'dormant', 'pinned'].includes(scope) ? scope : 'dialogue';
    for (const button of scopeRoot.querySelectorAll('[data-scope]')) {
      const active = button.dataset.scope === activeScope;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
  }

  function updateFacets(response) {
    const providerCounts = response && response.facets && response.facets.providers || {};
    const allCount = Object.values(providerCounts).reduce((sum, value) => sum + (Number(value) || 0), 0);
    for (const button of providerRoot.querySelectorAll('[data-provider]')) {
      const provider = button.dataset.provider;
      const count = provider === 'all' ? allCount : provider === 'other'
        ? Object.entries(providerCounts).reduce((sum, [key, value]) => sum + (isOtherSearchProvider(key) ? Number(value) || 0 : 0), 0)
        : (Number(providerCounts[provider]) || 0);
      const countNode = button.querySelector('b');
      if (countNode) countNode.textContent = String(count);
      if (OPTIONAL_PROVIDERS.includes(provider)) button.hidden = count === 0 && activeProvider !== provider;
    }

  }

  function renderProjectLibrary() {
    const currentProject = projectLibrary.find(item => projectPathKey(item.path) === projectPathKey(projectSelect.value));
    const selected = currentProject?.path || projectSelect.value;
    const stale = !!selected && !currentProject;
    const createOption = (label, value) => {
      const option = document.createElement('option'); option.value = value; option.textContent = label; return option;
    };
    const options = [createOption('全部会话', ''), ...projectLibrary.map(item => createOption(item.name, item.path))];
    if (stale) {
      const stale = createOption('项目已移出项目库，请重新选择', selected); stale.disabled = true; options.push(stale);
    }
    projectSelect.replaceChildren(...options); projectSelect.value = selected;
    const warning = projectLibrary.some(item => item.searchWarnings?.length);
    projectNote.textContent = projectLoadError || (stale ? '所选项目已移出项目库，请重新选择；当前不会扩大搜索范围。'
      : (warning ? '部分 worktree 的项目归属暂时无法读取，对应记录仍可在“全部会话”搜索。' : ''));
    projectNote.hidden = !projectNote.textContent;
    if (projectRail) {
      projectRail.replaceChildren();
      const caption=document.createElement('strong');caption.textContent='项目库';projectRail.append(caption);
      const subtitle=document.createElement('small');subtitle.textContent='与 AI 群聊保持一致';projectRail.append(subtitle);
      for (const [value,label] of [['','全部会话'], ...projectLibrary.map(item => [item.path, item.name])]) {
        const button=document.createElement('button');button.type='button';button.textContent=label;button.title=label;
        button.className=value===selected?'active':'';button.dataset.project=value;
        button.setAttribute('aria-pressed', String(value === selected));
        button.addEventListener('click',()=>{projectSelect.value=value;renderProjectLibrary();scheduleSearch();});
        projectRail.append(button);
      }
      if (!projectLibrary.length) {
        const empty=document.createElement('p');empty.textContent='项目库暂无项目，仍可搜索全部会话。';projectRail.append(empty);
      }
    }
  }

  async function loadProjectLibrary() {
    const sequence = ++projectLoadSequence;
    projectSelect.setAttribute('aria-busy', 'true');
    try {
      const response = await ipcRenderer.invoke('workspace:prepared-projects', { searchRoots: true });
      if (sequence !== projectLoadSequence || !isOpen()) return;
      if (!Array.isArray(response?.items)) throw new Error('项目库返回格式无效');
      projectLibrary = response.items.filter(item => item && projectPathKey(item.path) && typeof item.name === 'string');
      projectLoadError = '';
      renderProjectLibrary();
      // Membership may change when projects/worktrees were added between opens.
      if(reader.hidden) scheduleSearch();
      else newResults.hidden=false;
    } catch (error) {
      if (sequence !== projectLoadSequence || !isOpen()) return;
      projectLibrary = [];
      projectLoadError = `项目库读取失败：${error.message}。重新打开可重试。`;
      if(reader.hidden) scheduleSearch();
      else newResults.hidden=false;
      renderProjectLibrary();
      announce(projectNote.textContent);
    } finally {
      if (sequence === projectLoadSequence) projectSelect.removeAttribute('aria-busy');
    }
  }

  function resultScopeLabel(scope) {
    return SCOPE_LABELS[scope] || scope || '内容';
  }

  function createResultRow(hit, index) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'session-search-result';
    button.dataset.resultIndex = String(index);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(index === activeIndex));
    const line = document.createElement('div');
    line.className = 'session-search-result-line';
    const provider = document.createElement('span');
    const meta = providerMeta(hit.provider);
    provider.className = `session-search-result-provider ${meta.className}`;
    const dot = document.createElement('span');
    dot.className = 'provider-dot';
    provider.append(dot, document.createTextNode(meta.label));
    const time = document.createElement('time');
    time.className = 'session-search-result-time';
    const timestamp=lastRequest?.sort==='conversationTime'?hit.lastConversationAt:hit.newestMatchedEventAt;
    time.textContent = timestamp ? formatSearchTime(timestamp) : '标题记录';
    time.title = timestamp ? new Date(timestamp).toLocaleString('zh-CN') : '标题没有命中消息时间';
    line.append(provider, time);

    const title = document.createElement('div');
    title.className = 'session-search-result-title';
    appendHighlightedText(document, title, hit.title || '未命名会话', queryInput.value);
    const snippet = document.createElement('div');
    snippet.className = 'session-search-result-snippet';
    appendHighlightedText(document, snippet, hit.bestMatch && hit.bestMatch.text || '', queryInput.value);
    const question=document.createElement('div');question.className='session-search-result-question';
    const project=projectForCwd(projectLibrary, hit.cwd)?.name || hit.cwd?.split(/[\\/]/).filter(Boolean).pop();
    if(project) {const tag=document.createElement('span');tag.className='session-search-result-project';tag.textContent=project+' · ';question.append(tag);}
    appendHighlightedText(document,question,hit.questionExcerpt || hit.bestMatch?.text || '打开阅读完整对话',queryInput.value);
    if(hit.answerExcerpt) {snippet.replaceChildren();appendHighlightedText(document,snippet,'答：'+hit.answerExcerpt,queryInput.value);}
    const metaRow = document.createElement('div');
    metaRow.className = 'session-search-result-meta';
    for (const text of [
      ...(hit.matchReasons || [resultScopeLabel(hit.bestMatch && hit.bestMatch.scope)]),
      projectForCwd(projectLibrary, hit.cwd)?.name || null,
      `${Number(hit.matchCount) || 1} 处命中`,
      hit.turnCount ? `${hit.turnCount} 条记录` : null,
    ].filter(Boolean)) {
      const chip = document.createElement('span');
      chip.className = 'session-search-meta-chip';
      chip.textContent = text;
      chip.title = text;
      metaRow.appendChild(chip);
    }
    const icon=document.createElement('span');icon.className='session-search-result-icon';icon.setAttribute('aria-hidden','true');
    icon.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h4"/></svg>';
    const body=document.createElement('div');body.className='session-search-result-body';body.append(title,question);
    if(hit.answerExcerpt && queryInput.value.trim()) body.append(snippet);
    const enter=document.createElement('span');enter.className='session-search-result-enter';enter.textContent='↵';enter.setAttribute('aria-hidden','true');
    button.title=[hit.title, ...[...metaRow.children].map(el=>el.textContent)].filter(Boolean).join(' · ');
    button.append(icon,body,line,enter);
    button.addEventListener('click', () => {void selectResult(index, { read: true });});
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const next = (index + direction + results.length) % results.length;
        void selectResult(next, { focusRow: true });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) {void selectResult(index);void openSelectedHit({ focus: true });}
        else void selectResult(index, { read: true });
      }
    });
    return button;
  }

  function renderResults(response) {
    const selected=results[activeIndex], previousPreview=activePreview;
    lastResponse=response;
    updateFacets(response);
    // Only the provisional layer uses local titles. The final snapshot includes
    // indexed titles itself, under exactly the same scope/time/ranking contract.
    const indexedResults=Array.isArray(response.results)?response.results:[];
    const preliminary=response.pendingFullText || (response.indexing && !indexedResults.length);
    results=preliminary?lastTitleHits.slice():indexedResults;
    const total=Number(response.totalSessions)||results.length;
    const partial=response.state==='partial'||response.pendingFullText||response.indexing;
    summaryRoot.firstElementChild.textContent=`${queryInput.value.trim()?'搜索结果':'最近的对话'} · ${partial?'至少 ':''}${total}${partial?' · 继续检索中':''}`;
    summaryRoot.lastElementChild.textContent=preliminary?'标题预备结果':'';
    summaryRoot.title=`${Number(response.queryMs)||0} ms · ${preliminary?'标题预备结果':'条件已生效'}`;
    if(conditions && lastRequest) {
      const r=lastRequest;
      const date=r.time.from==null?'不限时间':`${new Date(r.time.from).toLocaleString('zh-CN')} — ${new Date(r.time.to).toLocaleString('zh-CN')}`;
      conditions.textContent=`${r.time.field==='conversationTime'?'会话活动':'消息发生'}：${date} · ${r.time.timeZone} · ${r.scopes.map(x=>SCOPE_LABELS[x]).join(' / ')}${r.projectName?' · '+r.projectName:''}`;
      if(r.time.from!=null && response.coverage?.unknownTimeSources) conditions.textContent+=` · ${response.coverage.unknownTimeSources} 个来源时间未知`;
    }
    if(!partial && response.queryId && response.queryId!==lastRecordedQueryId) {
      lastRecordedQueryId=response.queryId;
      try { recordSearch(window.localStorage,{query:queryInput.value,sessions:total,matches:response.totalMatches||0}); } catch { /* Optional recent-search history. */ }
    }
    if(!results.length) {
      activeIndex=-1;activePreview=null;
      resultsRoot.replaceChildren(createStaticEmpty(document,{title:partial?'正在检索其余记录':'当前条件下没有匹配',detail:partial?'已找到的结果会陆续出现。':'试试明确的关键词、项目名或标题；时间和内容范围已应用。',busy:partial}));
      previewRoot.replaceChildren(createStaticEmpty(document,{title:'选中会话，查看相关问答',detail:'问题、答复、命中位置和产物会在这里显示。'}));
      return;
    }
    activeIndex=selected?results.findIndex(hit=>sameSession(hit,selected)):-1;
    const fragment=document.createDocumentFragment();
    results.forEach((hit,index)=>fragment.append(createResultRow(hit,index)));
    if(response.nextPageCursor) {
      const more=document.createElement('button');more.type='button';more.className='session-search-load-more';more.textContent='加载更多会话';
      let restart=false;
      more.addEventListener('click',async()=>{
        if(restart) {void performSearch({immediate:true});return;}
        const seq=searchSequence;more.disabled=true;
        try {
          const next=await ipcRenderer.invoke('search-past-sessions',{...lastRequest,cursor:response.nextPageCursor});
          if(seq!==searchSequence || !isOpen()) return;
          if(next.error) throw new Error(next.error);
          renderResults({...next,results:[...results,...next.results]});
        } catch(error) { if(seq===searchSequence) {restart=true;more.disabled=false;more.textContent=error.message+' · 重新搜索';} }
      });
      fragment.append(more);
    }
    resultsRoot.replaceChildren(fragment);
    if(activeIndex>=0 && previousPreview) {
      activePreview=previousPreview;
      resultsRoot.querySelector(`[data-result-index="${activeIndex}"]`)?.classList.add('active');
      const current=results[activeIndex];
      if((!selected.indexed && current.indexed) || selected.bestMatch?.eventId!==current.bestMatch?.eventId) void loadPreview(current);
    } else void selectResult(activeIndex<0?0:activeIndex);
    announce(`${partial?'至少':''}${total} 个会话，条件已生效`);
  }

  function renderSearchError(error) {
    summaryRoot.firstElementChild.textContent = '搜索失败';
    summaryRoot.lastElementChild.textContent = '';
    resultsRoot.replaceChildren(createStaticEmpty(document, {
      title: '本地索引暂时不可用',
      detail: error && error.message ? error.message : String(error || '未知错误'),
      className: 'error',
    }));
    announce('搜索失败');
  }

  async function performSearch({ immediate = false } = {}) {
    if(searchTimer) {clearTimeoutFn(searchTimer);searchTimer=null;}
    const request={...searchRequest()};
    const seq=++searchSequence;request.requestId=String(seq);
    if(browsingCatalogue()) refreshTitleIndex();
    // Catalogue facets select sessions only. Their metadata timestamps must not
    // pre-filter the backend's message-time query.
    const entries=browsingCatalogue()?catalogueFilter({...request,timeRange:'all'}):null;
    if(entries) request.sessionFilter={hubSessionIds:entries.map(e=>e.hubSessionId).filter(Boolean),meetingIds:entries.map(e=>e.meetingId).filter(Boolean)};
    lastRequest=request;
    lastTitleHits=request.query?localTitleHits(request):[];
    if(!request.query && browsingCatalogue() && !lastStatus?.ready) lastTitleHits=entries.map(catalogueHit);
    if(!immediate) {
      renderResults({results:[],totalSessions:0,pendingFullText:true});
      searchTimer=setTimeoutFn(()=>performSearch({immediate:true}),160);return;
    }
    try {
      let cursor=null;
      do {
        const response=await ipcRenderer.invoke('search-past-sessions',{...request,...(cursor?{cursor}:{})});
        if(seq!==searchSequence || !isOpen()) return;
        if(response?.error) throw new Error(response.error);
        renderResults(response||{});
        if(response?.status) renderStatus(response.status);
        if(response?.refreshing) void refreshStatus({repeat:true});
        cursor=response?.continuationCursor;
        if(cursor) await new Promise(resolve=>setTimeoutFn(resolve,25));
      } while(cursor && seq===searchSequence && isOpen());
    } catch(error) {if(seq===searchSequence && isOpen()) renderSearchError(error);}
  }

  function previewLabel(item) {
    if (item.role === 'user') return '我的提问';
    if (item.role === 'assistant') return item.speaker || 'AI 回答';
    if (item.role === 'tool') return '工具 / 文件';
    return resultScopeLabel(item.scope);
  }

  async function openReaderPath(filePath, cwd) {
    if(typeof openPath!=='function') throw new Error('文件打开功能尚未就绪');
    const sequence=previewSequence;
    const result=await openPath(filePath,{cwd});
    if(result?.ok===false) throw new Error(result.error || '无法打开文件');
    // Hub previews and file manager live underneath this modal. Reveal them
    // only after a successful navigation; a failed open keeps the reader here.
    if(sequence===previewSequence && isOpen() && ['preview','file-manager'].includes(result?.type)) {
      // Search can now be entered from the full-width writing workspace.
      // Reveal the existing preview only after its navigation succeeds.
      window.__writingHide?.();
      close({restoreFocus:false});
    }
  }

  function renderPreview(hit, preview) {
    if(!preview?.session || preview.error) {
      previewRoot.replaceChildren(createStaticEmpty(document,{title:'暂时无法读取原文',detail:preview?.error || '原始记录可能正在写入或已被移动。',className:'error'}));return;
    }
    activePreview=preview;
    const header=document.createElement('header');header.className='session-search-preview-header';
    const heading=document.createElement('div');heading.className='session-search-preview-heading';
    const title=document.createElement('h3');title.textContent=preview.session.title||hit.title;
    const meta=document.createElement('p');meta.textContent=[providerMeta(hit.provider).label,projectForCwd(projectLibrary, preview.session.cwd || hit.cwd)?.name || preview.session.cwd,`${preview.totalRecords||0} 条原始记录`].filter(Boolean).join(' · ');
    heading.append(title,meta);
    const actions=document.createElement('div');actions.className='session-search-preview-actions';
    const action=(text,fn,primary=false)=>{const b=document.createElement('button');b.type='button';b.className='session-search-action'+(primary?' primary':'');b.textContent=text;b.addEventListener('click',fn);return b;};
    const copy=action('复制引用',()=>copyReference(hit,preview,copy));
    const open=action(hit.provider==='meeting'?'打开群聊':'继续会话',()=>openSelectedHit({focus:true}),true);open.dataset.searchAction='open';
    actions.append(copy,open);header.append(heading,actions);
    const tabs=document.createElement('nav');tabs.className='session-search-preview-tabs';
    for(const [mode,label] of [['overview','会话概览'],['hits','命中位置'],['conversation','原始对话'],['artifacts','产物']]) {
      const button=action(label,()=>{previewMode=mode;previewPage={};void loadPreview(hit);});button.dataset.previewMode=mode;button.classList.toggle('active',previewMode===mode);tabs.append(button);
    }
    const context=document.createElement('div');context.className='session-search-preview-context';
    if(preview.sourceAvailability==='missing') {const note=document.createElement('p');note.className='session-search-notice';note.textContent='原始文件已移动或不存在，当前显示保存的历史索引。';context.append(note);}
    if(previewMode==='artifacts') {
      if(!preview.artifacts?.length) context.append(createStaticEmpty(document,{title:'这段问答未发现可打开的产物',detail:'原文中的历史路径仍可在“原始对话”里查看。'}));
      for(const artifact of preview.artifacts||[]) {
        const button=action(artifact.name||artifact.path,async()=>{try {await openReaderPath(artifact.path,preview.session.cwd);} catch(e) {announce(e.message);button.textContent='无法打开：'+e.message;}});
        button.classList.add('session-search-artifact');button.title=artifact.path;context.append(button);
      }
    } else {
      if(preview.beforeCursor) context.append(action('加载前面的原文',()=>loadPreview(hit,{beforeEventId:preview.beforeCursor})));
      for(const item of preview.context||[]) {
        const turn=document.createElement(item.scope==='tool'?'details':'article');
        turn.className=`session-search-preview-turn ${item.role==='user'?'user':''} ${item.isMatch?'match':''}`;
        if(item.isMatch) turn.dataset.searchMatch='1';
        const label=document.createElement(item.scope==='tool'?'summary':'div');label.className='session-search-preview-meta';
        label.textContent=`${previewLabel(item)} · ${item.isMatch?'命中原文':'相关原文'}${item.timestamp?' · '+new Date(item.timestamp).toLocaleString('zh-CN'):''}`;
        turn.append(label);
        if(cardRenderer && item.scope!=='tool' && item.scope!=='title') {
          const rendered=cardRenderer.renderReadOnlyCard({id:item.eventId,role:item.role,text:item.text,ts:item.timestamp,kind:hit.provider,model:item.speaker});
          rendered.classList.add('session-search-native-card');turn.append(rendered);
          rendered.addEventListener('click',async event=>{const link=event.target.closest('a');if(!link) return;event.preventDefault();event.stopPropagation();try {await openReaderPath(link.getAttribute('href'),preview.session.cwd);} catch(error) {announce(error.message);const note=document.createElement('p');note.className='session-search-notice';note.textContent='无法打开：'+error.message;rendered.append(note);}});
        } else {
          const text=document.createElement('div');text.className='session-search-preview-text';appendHighlightedText(document,text,item.text||'',queryInput.value);turn.append(text);
        }
        if(item.truncated && !item.expanded) turn.append(action(`展开这条原文（共 ${item.fullLength} 字符）`,()=>loadPreview(hit,{expandEventId:item.eventId,textOffset:0})));
        if(item.expanded && item.nextTextOffset) turn.append(action('读取下一段原文',()=>loadPreview(hit,{expandEventId:item.eventId,textOffset:item.nextTextOffset})));
        context.append(turn);
      }
      if(preview.omittedRecords) context.append(action(`本轮另有 ${preview.omittedRecords} 条记录 · 查看全部`,()=>{previewMode='conversation';void loadPreview(hit);}));
      if(preview.afterCursor) context.append(action('加载后面的原文',()=>loadPreview(hit,{afterEventId:preview.afterCursor})));
    }
    previewRoot.replaceChildren(header,tabs,context);
  }

  async function loadPreview(hit,extra={}) {
    const seq=++previewSequence;
    if(extra.afterEventId || extra.beforeEventId) previewPage={...(extra.afterEventId?{afterEventId:extra.afterEventId}:{beforeEventId:extra.beforeEventId})};
    try {
      const preview=hit.titleOnly && !hit.indexed?{session:hit,context:[{role:'title',scope:'title',text:hit.title,isMatch:true}],sourceAvailability:'metadata-only'}:
        await ipcRenderer.invoke('get-session-search-preview',{sessionKey:hit.sessionKey,eventId:hit.bestMatch?.eventId,query:queryInput.value.trim(),filters:{scopes:lastRequest?.scopes,time:lastRequest?.time},mode:previewMode==='artifacts'?'overview':previewMode,...previewPage,...extra});
      if(seq===previewSequence && isOpen() && sameSession(results[activeIndex],hit)) renderPreview(hit,preview);
    } catch(error) {if(seq===previewSequence && isOpen()) renderPreview(hit,{error:error.message});}
  }

  async function selectResult(index, { focusRow = false, read = false } = {}) {
    if(!Number.isInteger(index) || index<0 || index>=results.length) return;
    activeIndex=index;activePreview=null;previewMode='overview';previewPage={};
    for(const row of resultsRoot.querySelectorAll('.session-search-result')) {
      const active=Number(row.dataset.resultIndex)===index;
      row.classList.toggle('active',active);row.setAttribute('aria-selected',String(active));
      if(active) {row.scrollIntoView({block:'nearest'});if(focusRow) row.focus();}
    }
    if(read) {
      reader.hidden=false;
      overlay.classList.add('reading');
      readerClose.focus();
      home.inert=true;
      previewRoot.replaceChildren(createStaticEmpty(document,{title:'正在读取对话',detail:'读取已保存的历史记录…',busy:true}));
      await loadPreview(results[index]);
    }
  }

  function closeReader({ restoreFocus = true } = {}) {
    previewSequence += 1;
    reader.hidden=true;
    home.inert=false;
    overlay.classList.remove('reading');
    activePreview=null;
    previewRoot.replaceChildren();
    if(restoreFocus) queryInput.focus();
  }

  function updateAdvancedFilters() {
    const count=Number(activeAgent!=='all')+Number(activeScope!=='dialogue')+Number(timeField.value!=='eventTime')+
      Number(sortSelect.value!==(queryInput.value.trim()?'relevance':'conversationTime'))+
      Number(OPTIONAL_PROVIDERS.includes(activeProvider));
    filterToggle.textContent=count?`筛选 · ${count}`:'筛选';
    filterToggle.classList.toggle('active',count>0);
  }

  function renderRecentSearches() {
    suggestions.replaceChildren();
    const recent=readRecent(window.localStorage).slice(0,4);
    suggestions.hidden=!recent.length;
    if(!recent.length) return;
    const label=document.createElement('span');label.textContent='最近找过';suggestions.append(label);
    for(const entry of recent) {
      const button=document.createElement('button');button.type='button';button.textContent=entry.query;
      button.title=entry.query;button.addEventListener('click',()=>{queryInput.value=entry.query;scheduleSearch();queryInput.focus();});
      suggestions.append(button);
    }
  }

  async function copyReference(hit, preview, button) {
    const match = (preview.context || []).find(item => item.isMatch) || preview.context[0] || {};
    const text = [
      `【昨日之我 · ${providerMeta(hit.provider).label}】${hit.title || '未命名会话'}`,
      match.timestamp ? formatAbsolute(match.timestamp) : '',
      match.text || hit.bestMatch && hit.bestMatch.text || '',
    ].filter(Boolean).join('\n');
    try {
      if (clipboard && typeof clipboard.writeText === 'function') clipboard.writeText(text);
      else if (window.navigator.clipboard) await window.navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = '已复制';
      setTimeoutFn(() => { if (button.isConnected) button.textContent = original; }, 900);
    } catch (error) {
      announce(`复制失败：${error.message}`);
    }
  }

  async function openSelectedHit({ focus }) {
    const hit = results[activeIndex];
    if (!hit) return;
    const preview = activePreview;
    close({ restoreFocus: false });
    try {
      await openHit(hit, { focus: !!focus, preview });
    } catch (error) {
      console.warn('[session-search] open hit failed:', error);
      require('./ui-feedback').showHubAlert(`打开历史会话失败：${error && error.message ? error.message : String(error)}`);
    }
  }

  function scheduleSearch() {
    closeReader({restoreFocus:false});
    // A previous IPC response may already be in flight when the user changes
    // provider/scope/query. Invalidate it immediately, not 160 ms later when
    // the debounced replacement request starts, or stale Codex results can
    // briefly render under an already-active “群聊” filter.
    searchSequence += 1;
    previewSequence += 1;
    results = [];
    activeIndex = -1;
    activePreview = null;
    lastResponse = null;
    // 以前这里会先铺一屏「正在搜索」转圈，等 160ms 防抖 + IPC 回来才有内容。
    // 现在 performSearch 会**同步**先把标题层结果画出来，再去跑全文，
    // 所以不需要这个中间态 —— 转圈本身就是用户抱怨的「感觉很慢」。
    void performSearch({ immediate: false });
    updateAdvancedFilters();
  }

  function showIndexDetails() {
    if(!indexDetails) return;
    indexDetails.hidden=!indexDetails.hidden;
    statusButton.setAttribute('aria-expanded',String(!indexDetails.hidden));
    if(indexDetails.hidden) return;
    const status=lastStatus||{};indexDetails.replaceChildren();
    const p=document.createElement('p');p.textContent=`${status.index?.sessions||0} 个会话 · ${status.index?.documents||0} 条记录。上次同步：${status.lastRefreshAt?new Date(status.lastRefreshAt).toLocaleString('zh-CN'):'首次整理中'}。${status.lastError||''}`;indexDetails.append(p);
    const sync=document.createElement('button');sync.type='button';sync.textContent='同步变化内容';sync.addEventListener('click',()=>forceRefresh(false));indexDetails.append(sync);
    const advanced=document.createElement('details');const summary=document.createElement('summary');summary.textContent='高级诊断';advanced.append(summary);
    const note=document.createElement('p');note.textContent='仅在索引损坏或解析规则变化时重新构建；常规保存会自动同步。';advanced.append(note);
    const rebuild=document.createElement('button');rebuild.type='button';rebuild.textContent='重新构建全部索引';rebuild.addEventListener('click',async()=>{if(await require('./ui-feedback').confirmHubAction('重新解析全部历史来源？现有索引会保持可用。')) void forceRefresh(true);});advanced.append(rebuild);indexDetails.append(advanced);
  }
  async function forceRefresh(force=false) {
    try {
      const status=await ipcRenderer.invoke('refresh-session-search',{force,immediate:true});
      renderStatus(status);if(status?.lastError && !status.ready) throw new Error(status.lastError);
      await performSearch({immediate:true});
    } catch(error) {announce(`同步失败：${error.message}`);renderStatus({...lastStatus,lastError:error.message,refreshing:false});}
  }

  // 2026-08-27：允许带查询词打开——工作台的「常用搜索」点一下要直接搜，
  // 不能只把面板弹出来让人重敲一遍。
  function open({ query, scope, embedded = false } = {}) {
    if (!embedded && window.hubWorkspaces) return window.hubWorkspaces.open('review', 'history', { query, scope });
    if (!overlay) return;
    searchSequence += 1;
    previewSequence += 1;
    if (searchTimer) { clearTimeoutFn(searchTimer); searchTimer = null; }
    setScope(scope || 'dialogue');
    if (scope === 'dormant' || scope === 'pinned') {
      queryInput.value = ''; setProvider('all'); setAgent('all');
      timeSelect.value = 'all'; projectSelect.value = '';
    }
    if (typeof query === 'string' && query.trim()) queryInput.value = query.trim();
    returnFocusElement = document.activeElement && typeof document.activeElement.focus === 'function'
      ? document.activeElement
      : launchButton;
    overlay.style.display = 'flex';
    closeReader({restoreFocus:false});newResults.hidden=true;
    advanced.hidden=!(scope==='dormant' || scope==='pinned');
    filterToggle.setAttribute('aria-expanded',String(!advanced.hidden));
    renderRecentSearches();
    // 每次打开重建一次即时标题索引：期间可能新建/改名/关闭过会话。
    // 682 条实测亚毫秒，放在同步路径上不影响弹窗打开。
    refreshTitleIndex();
    renderProjectLibrary();
    void loadProjectLibrary();
    void refreshStatus({ repeat: true });
    void performSearch({ immediate: true });
    updateAdvancedFilters();
    window.requestAnimationFrame(() => {
      queryInput.focus();
      queryInput.select();
    });
  }

  function close({ restoreFocus = true } = {}) {
    if (!overlay) return;
    closeReader({restoreFocus:false});
    overlay.style.display = 'none';
    projectLoadSequence += 1;
    searchSequence += 1;
    previewSequence += 1;
    if (searchTimer) { clearTimeoutFn(searchTimer); searchTimer = null; }
    if (statusTimer) { clearTimeoutFn(statusTimer); statusTimer = null; }
    if (restoreFocus && returnFocusElement && returnFocusElement.isConnected) {
      const focusTarget = returnFocusElement;
      window.requestAnimationFrame(() => focusTarget.focus());
    }
    returnFocusElement = null;
    window.hubWorkspaces?.panelClosed('search');
  }

  queryInput.addEventListener('input', scheduleSearch);
  queryInput.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const next = activeIndex < 0 ? 0 : (activeIndex + direction + results.length) % results.length;
      void selectResult(next, { focusRow: false });
      return;
    }
    if (event.key === 'Enter' && results.length) {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) void openSelectedHit({ focus: true });
      else void selectResult(activeIndex < 0 ? 0 : activeIndex, { read: true });
    }
  });
  providerRoot.addEventListener('click', (event) => {
    const button = event.target.closest('[data-provider]');
    if (!button) return;
    setProvider(button.dataset.provider);
    scheduleSearch();
  });
  agentRoot.addEventListener('click', event => {
    const button = event.target.closest('[data-agent]');
    if (!button) return;
    setAgent(button.dataset.agent); scheduleSearch();
  });
  document.addEventListener('sidebar:open-search', event => open(event.detail || {}));
  setProvider(activeProvider);
  setAgent(activeAgent);
  scopeRoot.addEventListener('click', (event) => {
    const button = event.target.closest('[data-scope]');
    if (!button) return;
    setScope(button.dataset.scope);
    scheduleSearch();
  });
  for (const select of [timeSelect, projectSelect, sortSelect, timeField].filter(Boolean)) select.addEventListener('change', () => { if(queryInput.value.trim()) {try { window.localStorage.setItem('hub.search.sort',sortSelect.value); } catch {}} scheduleSearch(); });
  projectSelect.addEventListener('change', renderProjectLibrary);
  sortSelect.addEventListener('change',()=>{directionSelect.value=sortSelect.value==='title'?'asc':'desc';directionSelect.disabled=sortSelect.value==='relevance';});
  directionSelect.addEventListener('change',()=>scheduleSearch());
  closeButton.addEventListener('click', close);
  if (launchButton) launchButton.addEventListener('click', open);
  statusButton.addEventListener('click', showIndexDetails);
  readerClose.addEventListener('click',()=>closeReader());
  document.getElementById('session-search-reader-scrim').addEventListener('click',()=>closeReader());
  filterToggle.addEventListener('click',()=>{
    advanced.hidden=!advanced.hidden;
    filterToggle.setAttribute('aria-expanded',String(!advanced.hidden));
  });
  overlay.addEventListener('mousedown', event => { if (event.target === overlay) close(); });
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && String(event.key).toLowerCase() === 'f') {
      if (isBlockingModalOpen(document, { exceptIds: ['search-modal'] })) return;
      event.preventDefault();
      event.stopImmediatePropagation?.();
      open();
      return;
    }
    if (event.key === 'Escape' && isOpen()) {
      event.preventDefault();
      event.stopImmediatePropagation?.();
      if(!reader.hidden) closeReader();
      else close();
      return;
    }
    if (event.key === 'Tab' && isOpen() && (!overlay.classList.contains('hw-embedded') || !reader.hidden)) {
      const focusable = [...(reader.hidden?overlay:reader).querySelectorAll(
        'button:not([disabled]):not([hidden]), input:not([disabled]), select:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
      )].filter(element => element.offsetParent !== null && element.tabIndex >= 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  if (process && process.env && process.env.CLAUDE_HUB_E2E === '1') {
    window.__hubE2E = window.__hubE2E || {};
    window.__hubE2E.globalSessionSearch = {
      open,
      close,
      search: () => performSearch({ immediate: true }),
      renderStatus,
      state: () => ({
        open: isOpen(),
        query: queryInput.value,
        activeProvider,
        activeAgent,
        activeScope,
        state:lastResponse?.state,
        appliedFilters:lastResponse?.appliedFilters,
        selectedSessionKey:results[activeIndex]?.sessionKey,
        resultCount: results.length,
        activeIndex,
        reading:!reader.hidden,
        totalSessions: lastResponse && lastResponse.totalSessions || 0,
        totalMatches: lastResponse && lastResponse.totalMatches || 0,
        previewTitle: previewRoot.querySelector('h3')?.textContent || '',
      }),
    };
  }

  return { open, close, performSearch, selectResult, isOpen };
}

module.exports = {
  filterSearchEntries,
  filterSearchHits,
  loadSearchFacets,
  FACET_STORAGE_KEY,
  PROVIDER_META,
  SCOPE_LABELS,
  appendHighlightedText,
  createGlobalSessionSearch,
  formatSearchTime,
  indexProgressModel,
  normalizeTerms,
};
