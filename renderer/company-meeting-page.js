'use strict';
const { MeetingCapture } = require('./meeting-capture');
function createCompanyMeetingPage({ document, window, call, markdown }) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const time = ms => `${String(Math.floor((ms || 0) / 60000)).padStart(2, '0')}:${String(Math.floor((ms || 0) / 1000) % 60).padStart(2, '0')}`;
  let root, id = null, capture, state, poll, sourceList = [], playback = null, playRequest = 0;
  function message(s) { if (root) root.querySelector('[data-m="message"]').textContent = s; }
  function citations(element) {
    const walker = document.createTreeWalker(element, window.NodeFilter.SHOW_TEXT), nodes = []; let node;
    while ((node = walker.nextNode())) if (!node.parentElement.closest('a,button,code,pre') && /\[(?:事件\s*\d+|画面\s*\d+:\d{2})\]/.test(node.textContent)) nodes.push(node);
    for (const node of nodes) {
      const fragment = document.createDocumentFragment(), text = node.textContent; let last = 0;
      for (const match of text.matchAll(/\[(?:事件\s*(\d+)|画面\s*(\d+):(\d{2}))\]/g)) { fragment.append(document.createTextNode(text.slice(last, match.index))); const button = document.createElement('button'); button.className = 'ca-link'; if(match[1])button.dataset.event = match[1];else button.dataset.playAt=String((Number(match[2])*60+Number(match[3]))*1000); button.textContent = match[0]; fragment.append(button); last = match.index + match[0].length; }
      fragment.append(document.createTextNode(text.slice(last))); node.replaceWith(fragment);
    }
  }
  async function refresh() {
    if (!root?.isConnected) return;
    state = await call('meeting-status', { id });
    const m = state.meeting;
    root.querySelector('[data-m="history"]').innerHTML = '<option value="">选择已保存会议</option>' + state.meetings.map(x => `<option value="${x.id}" ${x.id === id ? 'selected' : ''}>${esc(x.title)} · ${new Date(x.startedAt).toLocaleString()}</option>`).join('');
    const asr = state.asr; root.querySelector('[data-m="asr"]').textContent = asr.phase || asr.error || (asr.ready ? '本地转写已就绪 · CPU 模式' : '首次使用：安装本地语音组件（自动准备独立运行时，约 500 MB 模型）；未安装也可采集，稍后补转写。');
    root.querySelector('[data-m="progress"]').textContent = m ? `${({ recording: '采集中', paused: '已暂停', ended: '已结束', interrupted: '上次采集已中断' })[m.state]} · 已采集 ${time(m.capturedMs)} · 已转写 ${time(m.transcribedMs)} · 理解覆盖 ${time(m.understoodMs)} · 第 ${m.revision} 版${m.job ? ' · ' + (m.job.state === 'error' ? '理解待重试' : 'CodeAgent 正在整理') : ''}` : '选择会议共享窗口与音频来源，开始后持续保存到本机。';
    root.querySelector('[data-m="levels"]').textContent = capture?.running ? `系统声音 ${Math.round((capture.levels.system || 0) * 100)} · 麦克风 ${Math.round((capture.levels.mic || 0) * 100)}（持续为 0 时请检查音源）` : '';
    for (const name of ['pause', 'stop', 'mark', 'snap']) root.querySelector(`[data-act="${name}"]`).disabled = !capture?.running;
    for (const name of ['mark', 'snap']) root.querySelector(`[data-act="${name}"]`).disabled = !capture?.running || capture.paused;
    root.querySelector('[data-act="start"]').disabled = !!capture?.running;
    root.querySelector('[data-act="pause"]').textContent = capture?.paused ? '继续' : '暂停';
    root.querySelector('[data-m="history"]').disabled = !!capture?.running;
    if (!m) return;
    const rec=m.recording, ready=rec?.segments.filter(s=>s.status==='ready')||[];
    root.querySelector('[data-m="recording-status"]').textContent=rec ? `录像已落盘至 ${time(rec.savedThrough)} · ${(rec.bytes/1024/1024).toFixed(1)} MB · ${ready.length} 个可回放片段${rec.segments.some(s=>s.status==='writing')?' · 当前片段保存中':''}` : '此会议没有录像（旧会议仍可查看截图和原音频）。';
    root.querySelector('[data-m="gaps"]').textContent=[...(rec?.gaps||[]), ...(rec?.openGap ? [{...rec.openGap,end:null}] : [])].map(g=>`${time(g.at)}—${g.end==null||g.open?'未恢复':time(g.end)} ${g.reason}`).join('；');
    root.querySelector('[data-m="seek"]').max=String(Math.max(0,m.capturedMs/1000));
    for(const op of ['play','extract'])root.querySelector(`[data-act="${op}"]`).disabled=!ready.length;
    if (m.audio.length && !asr.ready && !asr.phase && !m.error && !m.asrError) message('录音已保存；本地转写尚未就绪。请打开“截图区域与本地语音设置”，点击安装本地转写。');
    if (m.error || m.asrError) message(m.error || m.asrError);
    const timeline = m.events.filter(e => ['slide', 'transcript', 'mark'].includes(e.kind)).sort((a, b) => a.at - b.at || a.seq - b.seq);
    const list = root.querySelector('[data-m="timeline"]'); const stamp = m.events.length + ':' + timeline.length;
    if (list.dataset.stamp !== stamp) { list.dataset.stamp = stamp; list.innerHTML = timeline.map(e => `<button class="meeting-event" data-event="${e.seq}"><span>${time(e.at)} · ${e.kind === 'slide' ? '页面' : e.kind === 'mark' ? '★ 重点' : e.track === 'mic' ? '麦克风' : '系统声音'} · 事件 ${e.seq}</span><div>${esc(e.text || (e.revisit ? '再次展示前页' : '点击查看截图'))}</div></button>`).join('') || '<p>开始后，页面和发言会出现在这里。</p>'; }
    const summary = root.querySelector('[data-m="summary"]'); const html = markdown(m.summary || '会议理解尚未生成。采集与本地转写独立进行，CodeAgent 可稍后补整理。'); if (summary.dataset.html !== html) { summary.innerHTML = html; citations(summary); summary.dataset.html = html; }
    root.querySelector('[data-m="answers"]').innerHTML = m.answers.map(q => `<details><summary>${esc(q.q)} · ${{ queued: '排队中', running: '理解中', done: '已回答' }[q.state] || q.state}</summary>${markdown(q.answer || '等待 CodeAgent 回答')}</details>`).join('');
    citations(root.querySelector('[data-m="answers"]'));
  }
  async function action(op) {
    if (op === 'sources') { const r = await call('meeting-sources'); sourceList = r.sources; root.querySelector('[data-m="source"]').innerHTML = sourceList.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(''); preview(); return; }
    if (op === 'install') { await call('meeting-asr-install'); await refresh(); return; }
    if (op === 'start') {
      const selected = root.querySelector('[data-m="source"]').value; if (!selected) throw new Error('先刷新并选择共享窗口');
      const crop = {}; for (const k of ['x', 'y', 'w', 'h']) crop[k] = Number(root.querySelector(`[data-crop="${k}"]`).value) / 100;
      if (Object.values(crop).some(v => !Number.isFinite(v)) || crop.x < 0 || crop.y < 0 || crop.w <= 0 || crop.h <= 0 || crop.x + crop.w > 1 || crop.y + crop.h > 1) throw new Error('截图区域应在画面范围内');
      const audio = { system: root.querySelector('[data-m="system"]').checked, mic: root.querySelector('[data-m="mic"]').checked };
      const next = new MeetingCapture({ document, window, save: r => call('meeting-capture', { id, ...r }), status: message });
      await next.open(selected, audio);
      try { const r = await call('meeting-start', { title: root.querySelector('[data-m="title"]').value, sourceName: sourceList.find(s => s.id === selected)?.name, audio: Object.keys(audio).filter(k => audio[k]) }); id = r.meeting.id; resetPlayer(); capture = next; capture.start(crop); message('已开始连续录屏。原始画面和声音本地留底，CodeAgent 默认只读取提炼图文；截图区域不裁掉原始录像。'); }
      catch (e) { next.running = false; try { await next.dispose(); } catch (_) {} if (capture === next) { capture = null; await call('meeting-control', { id, op: 'stop' }).catch(() => {}); } throw e; }
    } else if (op === 'retry-save') { await capture?.retry(); message('已重试保存，点击继续恢复采集。'); }
    else if (op === 'pause') { if (capture.paused) { await call('meeting-control', { id, op: state.meeting.state === 'paused' ? 'resume' : 'auto', value: state.meeting.autoUnderstand }); capture.resume(); } else { await capture.pause(); await call('meeting-control', { id, op: 'pause' }); } }
    else if (op === 'stop') { await capture.stop(); await call('meeting-control', { id, op: 'stop' }); message('采集已结束，剩余转写和会后复核继续处理。'); }
    else if (op === 'snap') await capture.frame(true);
    else if (op === 'mark') { if (capture.paused) throw new Error('请先继续采集'); capture.enqueue({ kind: 'mark', at: capture.elapsed(), text: root.querySelector('[data-m="note"]').value || '重点' }); root.querySelector('[data-m="note"]').value = ''; await capture.frame(true); }
    else if (op === 'export') { if (!id) throw new Error('先选择会议'); await call('meeting-export', { id }); }
    else if (op === 'play') { const first=state.meeting?.recording?.segments.find(s=>s.status==='ready'); await playAt(Number(root.querySelector('[data-m="seek-seconds"]').value)*1000 || first?.at || 0,true); }
    else if (op === 'extract') { const at=playback ? playback.segment.at+root.querySelector('[data-m="player"]').currentTime*1000 : Number(root.querySelector('[data-m="seek-seconds"]').value)*1000; const result=await call('meeting-frames',{id,timesMs:[Math.round(at)]}); const frame=result.frames[0]; root.querySelector('[data-m="evidence"]').innerHTML=`<p>录像回查 · ${time(frame.at)}</p><img class="meeting-slide" src="data:image/jpeg;base64,${frame.data}" alt="从录像提取的画面">`; }
    else if (op === 'ask') { const input = root.querySelector('[data-m="question"]'); if (!id) throw new Error('先选择会议'); await call('meeting-control', { id, op: 'ask', value: input.value }); input.value = ''; }
    else { if (!id) throw new Error('先选择会议'); await call('meeting-control', { id, op }); }
    await refresh();
  }
  function preview() { const s = sourceList.find(s => s.id === root.querySelector('[data-m="source"]').value); root.querySelector('[data-m="preview"]').src = s?.thumbnail || ''; }
  async function open(parent) {
    if (!root) {
      root = document.createElement('section'); root.className = 'company-meeting'; root.innerHTML = `<header><div><h2>会议伴侣 <small>4.1.0</small></h2><p data-m="progress"></p></div><button class="ca-btn" data-act="export">导出纪要</button><button class="ca-btn" data-close>返回助理</button></header>
        <div class="meeting-setup"><input data-m="title" aria-label="会议名称" placeholder="会议名称"><select data-m="source" aria-label="共享窗口"></select><button class="ca-btn" data-act="sources">刷新窗口</button><label><input type="checkbox" data-m="system" checked>系统声音</label><label><input type="checkbox" data-m="mic" checked>麦克风</label><button class="ca-btn primary" data-act="start">开始会议</button><button class="ca-btn" data-act="pause" disabled>暂停</button><button class="ca-btn" data-act="stop" disabled>结束会议</button></div>
        <details class="meeting-region"><summary>截图区域与本地语音设置</summary><div class="meeting-region-row"><img data-m="preview" alt="所选窗口预览"><div><p>只保留 PPT 区域：填写占画面的百分比；默认保存完整共享窗口。</p>${[['x', '左', 0], ['y', '上', 0], ['w', '宽', 100], ['h', '高', 100]].map(([k, label, v]) => `<label>${label}<input type="number" min="0" max="100" value="${v}" data-crop="${k}">%</label>`).join('')}<p data-m="asr"></p><button class="ca-btn" data-act="install">安装 / 修复本地转写</button><button class="ca-btn" data-act="retry-asr">重试失败转写</button></div></div></details>
        <div class="meeting-tools"><select data-m="history" aria-label="会议历史"></select><input data-m="note" placeholder="重点备注（可选）"><button class="ca-btn" data-act="mark" disabled>★ 记重点</button><button class="ca-btn" data-act="snap" disabled>补截图</button><button class="ca-btn" data-act="understand">更新理解</button><button class="ca-btn" data-act="retry-save">重试保存</button><span data-m="levels"></span></div><p class="meeting-message" role="status" data-m="message"></p>
        <div class="meeting-columns"><aside data-m="timeline"></aside><main><section class="meeting-replay"><h3>会议回放</h3><p data-m="recording-status"></p><p data-m="gaps" class="meeting-message"></p><video data-m="player" controls preload="metadata" aria-label="会议录像回放"></video><div class="meeting-tools"><button class="ca-btn" data-act="play">播放 / 跳转</button><input data-m="seek-seconds" type="number" min="0" value="0" step="1" aria-label="跳转到会议秒数"><span>秒</span><span data-m="play-time">00:00</span><button class="ca-btn" data-act="extract">截取当前画面</button></div><input data-m="seek" type="range" min="0" max="0" value="0" step="0.1" aria-label="会议时间轴"></section><div data-m="evidence"></div><article data-m="summary"></article></main><aside class="meeting-chat"><h3>问这场会议</h3><p>例如：回看 5 分钟附近的图，为什么改变方案？</p><textarea data-m="question" rows="4" aria-label="会议问题"></textarea><button class="ca-btn primary" data-act="ask">问 CodeAgent</button><div data-m="answers"></div></aside></div>`;
      root.addEventListener('click', e => {
        const button = e.target.closest('[data-act]'); if (button && !button.disabled) { button.disabled = true; void action(button.dataset.act).catch(e => message(e.message)).finally(() => { button.disabled = false; void refresh().catch(e => message(e.message)); }); }
        if (e.target.closest('[data-close]')) root.hidden = true;
        const event = e.target.closest('[data-event]'); if (event) void showEvidence(Number(event.dataset.event)).catch(e => message(e.message));
        const frame=e.target.closest('[data-play-at]');if(frame)void playAt(Number(frame.dataset.playAt),true).catch(e=>message(e.message));
      });
      root.querySelector('[data-m="source"]').addEventListener('change', preview);
      root.querySelector('[data-m="history"]').addEventListener('change', e => { id = e.target.value || null; resetPlayer(); root.querySelector('[data-m="timeline"]').dataset.stamp = ''; root.querySelector('[data-m="evidence"]').innerHTML = ''; void refresh().catch(e => message(e.message)); });
      root.querySelector('[data-m="seek"]').addEventListener('change',e=>{root.querySelector('[data-m="seek-seconds"]').value=e.target.value;void playAt(Number(e.target.value)*1000,false).catch(e=>message(e.message));});
      const player=root.querySelector('[data-m="player"]');
      player.addEventListener('timeupdate',()=>{if(!playback)return;const at=playback.segment.at+player.currentTime*1000;root.querySelector('[data-m="seek"]').value=String(at/1000);root.querySelector('[data-m="play-time"]').textContent=time(at);root.querySelector('[data-m="seek-seconds"]').value=(at/1000).toFixed(1);});
      player.addEventListener('ended',()=>{if(!playback)return;const next=state.meeting?.recording?.segments.find(s=>s.status==='ready'&&s.at>playback.segment.at);if(next){if(next.at>playback.segment.end+1000)message(`跳过未录制时段 ${time(playback.segment.end)}—${time(next.at)}`);void playAt(Math.max(next.at,playback.segment.end),true).catch(e=>message(e.message));}});
      poll = setInterval(() => { if (!root.hidden || capture?.running) void refresh().catch(e => message(e.message)); }, 2500);
    }
    if (!root.isConnected) parent.append(root); root.hidden = false; await refresh(); if (!sourceList.length) await action('sources');
  }
  async function showEvidence(seq) {
    const e = state.meeting?.events.find(e => e.seq === seq); if (!e) return;
    const target = root.querySelector('[data-m="evidence"]');
    if (e.kind === 'slide') { const r = await call('meeting-asset', { id, seq }); target.innerHTML = `<p>事件 ${seq} · ${time(e.at)}</p><img class="meeting-slide" src="data:image/jpeg;base64,${r.data}" alt="会议页面">`; }
    else if (e.audioSeq) { const r = await call('meeting-asset', { id, seq: e.audioSeq }), audio = state.meeting.events.find(x => x.seq === e.audioSeq); target.innerHTML = `<p>${esc(e.text)}</p><audio controls src="data:audio/wav;base64,${r.data}"></audio>`; target.querySelector('audio').currentTime = Math.max(0, (e.at - audio.at) / 1000); }
    else target.innerHTML = `<p>${esc(e.text)}</p>`;
    if(state.meeting?.recording?.segments.some(s=>s.status==='ready'&&s.at<=e.at&&s.end>e.at)){const b=document.createElement('button');b.className='ca-btn';b.dataset.playAt=String(e.at);b.textContent='回放此处';target.append(b);}
  }
  function resetPlayer(){playRequest++;playback=null;const p=root.querySelector('[data-m="player"]');p.pause();p.removeAttribute('src');p.load();root.querySelector('[data-m="seek-seconds"]').value='0';root.querySelector('[data-m="seek"]').value='0';}
  async function playAt(at,autoplay){
    if(!id)throw new Error('先选择会议');const request=++playRequest,meetingId=id;
    const r=await call('meeting-playback',{id,at:Math.round(at)});if(request!==playRequest||meetingId!==id)return;
    const video=root.querySelector('[data-m="player"]');video.pause();
    if(playback?.segment.key!==r.segment.key){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>done(new Error('回放加载超时')),15000);const ok=()=>done();const bad=()=>done(new Error('录像无法播放'));function done(e){clearTimeout(timer);video.removeEventListener('loadeddata',ok);video.removeEventListener('error',bad);e?reject(e):resolve();}video.addEventListener('loadeddata',ok,{once:true});video.addEventListener('error',bad,{once:true});video.src=r.url;video.load();});}
    if(request!==playRequest||meetingId!==id)return;playback=r;video.currentTime=r.offsetMs/1000;root.querySelector('[data-m="play-time"]').textContent=time(at);if(autoplay)await video.play();
  }
  window.addEventListener('beforeunload', e => { if (capture?.running || capture?.queue.length) { e.preventDefault(); e.returnValue = false; } });
  return { open, close: () => { if (root) root.hidden = true; }, dispose: () => { clearInterval(poll); void capture?.dispose(); } };
}
module.exports = { createCompanyMeetingPage };
