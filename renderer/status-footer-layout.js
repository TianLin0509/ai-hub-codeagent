'use strict';

// Fit the actual readings, including long reset/status text, instead of assuming a viewport width.
function installStatusFooterLayout(doc = globalThis.document) {
  const footer = doc?.getElementById('hub-system-footer');
  if (!footer || footer.dataset.fitInstalled) return;
  footer.dataset.fitInstalled = 'true';
  const win = doc.defaultView;
  const summary = doc.createElement('button');
  summary.type = 'button'; summary.className = 'footer-quota-summary';
  const more = doc.createElement('button');
  more.type = 'button'; more.id = 'footer-status-details'; more.textContent = '⋯';
  more.setAttribute('aria-label', '查看全部硬件、余量和网络状态');
  more.setAttribute('aria-expanded', 'false'); more.setAttribute('aria-controls', 'footer-status-popover');
  more.setAttribute('aria-haspopup', 'dialog');
  footer.append(more);
  const popover = doc.createElement('section');
  popover.id = 'footer-status-popover'; popover.hidden = true;
  popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-label', '全部底栏状态');
  doc.body.append(popover);
  let scheduled = false;
  const refreshDetails = () => {
    if (popover.hidden) return;
    const activeProvider = doc.activeElement?.dataset?.refreshProvider;
    popover.replaceChildren();
    const heading = doc.createElement('strong'); heading.textContent = '全部状态'; popover.append(heading);
    for (const node of footer.querySelectorAll('.strip-resource')) {
      const line = doc.createElement('p'); line.textContent = (node.classList.contains('strip-disk') ? '硬盘 ' : '')
        + (node.getAttribute('aria-label')?.split('，')[0] || node.textContent);
      if (node.classList.contains('strip-resource-critical')) line.dataset.level = 'danger';
      else if (node.classList.contains('strip-resource-high')) line.dataset.level = 'warn';
      popover.append(line);
    }
    for (const node of footer.querySelectorAll('.sidebar-quota-provider')) {
      const button = doc.createElement('button'); button.type = 'button';
      button.dataset.refreshProvider = node.dataset.provider;
      button.textContent = node.getAttribute('aria-label');
      button.title = node.title;
      const levels = [...node.querySelectorAll('.sidebar-quota-metric')].map(el => el.dataset.level);
      button.dataset.level = levels.includes('danger') ? 'danger' : levels.includes('warn') ? 'warn' : 'normal';
      button.addEventListener('click', () => node.click()); popover.append(button);
    }
    for (const node of footer.querySelectorAll('.strip-route-foreign,.strip-route-domestic,.strip-transfer')) {
      const line = doc.createElement(node.tagName === 'BUTTON' ? 'button' : 'p');
      line.textContent = node.textContent; line.title = node.title;
      if (line.tagName === 'BUTTON') { line.type = 'button'; line.addEventListener('click', () => node.click()); }
      popover.append(line);
    }
    if (activeProvider) popover.querySelector(`[data-refresh-provider="${activeProvider}"]`)?.focus({ preventScroll:true });
  };
  const setOpen = open => {
    popover.hidden = !open;
    more.setAttribute('aria-expanded', String(open)); summary.setAttribute('aria-expanded', String(open));
    refreshDetails();
  };
  summary.setAttribute('aria-haspopup', 'dialog'); summary.setAttribute('aria-controls', popover.id);
  summary.addEventListener('click', () => setOpen(popover.hidden));
  more.addEventListener('click', () => setOpen(popover.hidden));
  doc.addEventListener('pointerdown', event => {
    if (!popover.contains(event.target) && !more.contains(event.target) && !summary.contains(event.target)) setOpen(false);
  });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !popover.hidden) { event.preventDefault(); setOpen(false); more.focus({ preventScroll:true }); }
  });
  const sync = () => {
    scheduled = false;
    const quota = footer.querySelector('.sidebar-quota');
    if (quota && !summary.parentElement) quota.append(summary);
    const cells = [...footer.querySelectorAll('.sidebar-quota-metric')];
    const known = cells.filter(el => /%$/.test(el.querySelector('.sidebar-quota-value')?.textContent || ''));
    const tightest = known.sort((a,b) => parseFloat(a.querySelector('.sidebar-quota-value').textContent) - parseFloat(b.querySelector('.sidebar-quota-value').textContent))[0];
    const provider = tightest?.closest('.sidebar-quota-provider');
    summary.textContent = tightest ? provider.querySelector('.sidebar-quota-name').textContent + ' '
      + tightest.querySelector('.sidebar-quota-value').textContent + ' ' + tightest.querySelector('.sidebar-quota-period').textContent : '余量详情';
    summary.dataset.level = tightest?.dataset.level || 'normal';
    summary.setAttribute('aria-label', summary.textContent + '；当前最紧张窗口，点击查看所有提供商');
    summary.title = summary.getAttribute('aria-label');
    // Read bounding boxes rather than scrollWidth: overflow is disabled in every mode.
    for (const mode of ['full','compact','minimal','summary']) {
      footer.dataset.density = mode;
      const right = footer.getBoundingClientRect().right - 4;
      if ([...footer.querySelectorAll('.strip-resource,.sidebar-quota-provider,.strip-route-row,.strip-transfer,.footer-quota-summary,#footer-status-details')]
        .every(el => !el.getBoundingClientRect().width || el.getBoundingClientRect().right <= right + .5)) break;
    }
    refreshDetails();
  };
  const schedule = () => { if (!scheduled) { scheduled = true; win.requestAnimationFrame(sync); } };
  // Never watch our own density/summary writes; quota and telemetry keep their current owners.
  const observer = new win.MutationObserver(records => {
    if (records.some(r => !summary.contains(r.target) && r.target !== footer)) schedule();
  });
  observer.observe(footer, { subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['data-level','aria-label'] });
  new win.ResizeObserver(schedule).observe(footer);
  new win.MutationObserver(schedule).observe(doc.documentElement, { attributes:true, attributeFilter:['data-theme','data-display-mode'] });
  schedule();
}

module.exports = { installStatusFooterLayout };
