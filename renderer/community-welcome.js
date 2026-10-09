'use strict';
// Community edition first-run panel on the home page: shows which AI CLIs are
// installed and routes to the account center for official sign-in.
(() => {
  if (!require('../core/distribution').community) return;
  const { ipcRenderer, shell } = require('electron');
  const GUIDE = 'https://github.com/TianLin0509/ai-hub-codeagent/blob/main/INSTALL.md';
  function init() {
    // Own stylesheet goes before the controls layer, which must stay last.
    if (!document.getElementById('community-style')) {
      const link = Object.assign(document.createElement('link'), { id: 'community-style', rel: 'stylesheet', href: 'community.css' });
      const controls = document.getElementById('controls-layer');
      if (controls) controls.before(link); else document.head.append(link);
    }
    // Sits under the two "new session / new group" cards on the home page.
    // tests/unit-community-export.test.js checks this anchor exists in the exported page.
    const host = document.querySelector('.home-welcome-body');
    if (!host || document.getElementById('community-setup')) return;
    const section = document.createElement('section');
    section.id = 'community-setup';
    section.setAttribute('aria-label', '快速开始');
    section.innerHTML = '<div class="community-setup-text"><h2>连接你的 AI</h2>'
      + '<p>使用这台电脑上你自己的账号，已有的 CLI 登录可直接复用。</p></div>'
      + '<div id="community-providers" role="status">正在检查安装情况…</div>'
      + '<div class="community-setup-actions"><button id="community-accounts" type="button">登录 / 检查账号</button>'
      + '<button id="community-refresh" type="button">重新检测</button>'
      + '<button id="community-guide" type="button">安装说明</button></div>'
      + '<p id="community-advisory" class="community-setup-note" hidden></p>';
    host.append(section);
    section.querySelector('#community-accounts').onclick = () => document.getElementById('btn-rail-accounts')?.click();
    section.querySelector('#community-guide').onclick = () => shell.openExternal(GUIDE);
    async function refresh() {
      const target = section.querySelector('#community-providers');
      const advisory = section.querySelector('#community-advisory');
      const button = section.querySelector('#community-refresh');
      button.disabled = true;
      try {
        const result = await ipcRenderer.invoke('community:setup');
        target.replaceChildren();
        for (const provider of result.providers) {
          const item = document.createElement('span');
          item.className = 'community-provider';
          item.dataset.provider = provider.id;
          item.dataset.installed = provider.installed ? '1' : '0';
          item.textContent = provider.name + (provider.installed ? ' · 已安装' : ' · 未安装');
          if (!provider.installed) {
            const install = document.createElement('button');
            install.type = 'button';
            install.textContent = '安装';
            install.setAttribute('aria-label', '安装 ' + provider.name);
            install.onclick = () => shell.openExternal(provider.docs);
            item.append(' ', install);
          }
          target.append(item);
        }
        const notes = Array.isArray(result.advisories) ? result.advisories : [];
        advisory.textContent = notes.join(' ');
        advisory.hidden = !notes.length;
      } catch (error) { target.textContent = '检测失败：' + error.message; }
      finally { button.disabled = false; }
    }
    section.querySelector('#community-refresh').onclick = refresh;
    void refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
