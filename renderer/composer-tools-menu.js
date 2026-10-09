'use strict';

// Move existing secondary controls rather than copying their event handlers.
function mountComposerToolsMenu({ composer, tuningControls, bridgeToolbar }) {
  const doc=composer.ownerDocument;
  const actions=[...bridgeToolbar.querySelectorAll('.fi-bridge-pull,.fi-bridge-fork')];
  if(!actions.length)return {dispose(){}};
  const toggle=doc.createElement('button'); toggle.type='button';
  toggle.className='composer-chip composer-tools-toggle'; toggle.textContent='工具';
  toggle.setAttribute('aria-expanded','false'); toggle.title='会话工具：公司拉取与分支';
  const menu=doc.createElement('div');menu.className='composer-tools-popover';menu.hidden=true;
  menu.setAttribute('role','group');menu.setAttribute('aria-label','会话工具');menu.append(...actions);
  composer.append(menu);tuningControls.prepend(toggle);
  const close=()=>{menu.hidden=true;toggle.setAttribute('aria-expanded','false');};
  toggle.addEventListener('click',()=>{const open=menu.hidden;menu.hidden=!open;toggle.setAttribute('aria-expanded',String(open));});
  // 点了菜单里的动作（拉取 / 分支）就收起，免得弹层盖住刚拉进输入框的文字开头。
  // 用捕获阶段：这些按钮自己的 click 处理会 stopPropagation，冒泡阶段收不到。
  menu.addEventListener('click',e=>{if(e.target.closest('button:not(:disabled)'))close();},true);
  const outside=e=>{if(!menu.hidden&&!menu.contains(e.target)&&!toggle.contains(e.target))close();};
  const key=e=>{if(!menu.hidden&&e.key==='Escape'){e.preventDefault();e.stopPropagation();close();toggle.focus();}};
  doc.addEventListener('pointerdown',outside,true);composer.addEventListener('keydown',key);
  return {dispose(){doc.removeEventListener('pointerdown',outside,true);composer.removeEventListener('keydown',key);}};
}
module.exports={mountComposerToolsMenu};
