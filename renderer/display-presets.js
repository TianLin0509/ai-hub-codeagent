'use strict';

const STORAGE_KEY = 'hub.displayPresets.v1';
const LIMITS = Object.freeze({fontSize:[10,28],terminalFontSize:[10,28],zoomLevel:[-3,5],railWidth:[36,112],sessionWidth:[152,320],uiFontSize:[11,16],inputHeight:[40,120]});
const PHONE = Object.freeze({fontSize:18,terminalFontSize:14,zoomLevel:0,railWidth:44,sessionWidth:200,uiFontSize:13,inputHeight:52});
const FIELDS = {fontSize:'卡片正文字号',terminalFontSize:'CLI 终端字号',zoomLevel:'整体缩放',railWidth:'导航栏宽',sessionWidth:'会话栏宽',uiFontSize:'界面字号',inputHeight:'输入框高度'};

function normalizeProfile(value, fallback) {
  const result = {};
  for (const [key,[min,max]] of Object.entries(LIMITS)) {
    const raw = value?.[key];
    result[key] = raw === null || raw === undefined || !Number.isFinite(Number(raw))
      ? fallback[key] : Math.max(min,Math.min(max,Math.round(Number(raw))));
  }
  return result;
}
function loadPresets(storage, legacy = {}) {
  const desktop = {fontSize:legacy.fontSize || 16,zoomLevel:legacy.zoomLevel || 0,railWidth:null,sessionWidth:null,uiFontSize:null,inputHeight:null};
  let saved;
  try { saved = JSON.parse(storage.getItem(STORAGE_KEY)); } catch (_) {}
  desktop.terminalFontSize = normalizeProfile(saved?.desktop,desktop).fontSize;
  const phone = normalizeProfile(saved?.phone,PHONE);
  // Only migrate the former default once; keep custom widths and later choices.
  if (!saved?.singleLineSidebar && phone.sessionWidth === 176) phone.sessionWidth = PHONE.sessionWidth;
  const desktopProfile = normalizeProfile(saved?.desktop,desktop);
  if (!saved?.compactRail) {
    if (desktopProfile.railWidth === 88) desktopProfile.railWidth = 44;
    if (phone.railWidth === 64) phone.railWidth = 44;
  }
  return {mode:saved?.mode === 'phone' ? 'phone' : 'desktop', singleLineSidebar: true, compactRail: true,
    desktop:desktopProfile,phone};
}

function createDisplayPresets({document,storage,fontSize,zoomLevel,applyFont,applyTerminalFont,applyZoom,onLayoutChange}) {
  const state = loadPresets(storage,{fontSize,zoomLevel});
  const root = document.documentElement;
  const switcher = document.getElementById('display-preset-switch');
  const panel = document.getElementById('display-preset-settings');
  const settings = document.getElementById('btn-display-settings');
  const save = () => storage.setItem(STORAGE_KEY,JSON.stringify(state));
  const paint = () => {
    root.dataset.displayMode = state.mode;
    const profile = state[state.mode];
    for (const [key,css] of Object.entries({railWidth:'--display-rail-width',sessionWidth:'--display-session-width',uiFontSize:'--display-ui-font',inputHeight:'--display-input-height'})) {
      if (profile[key] == null) root.style.removeProperty(css);
      else root.style.setProperty(css,profile[key]+'px');
    }
    root.style.setProperty('--display-reading-font',profile.fontSize+'px');
    root.style.setProperty('--display-cli-font',profile.terminalFontSize+'px');
    for (const button of switcher.querySelectorAll('[data-display-mode]')) button.setAttribute('aria-pressed',String(button.dataset.displayMode === state.mode));
    for (const input of panel.querySelectorAll('[data-display-field]')) {
      const key = input.dataset.displayField;
      input.value = profile[key] ?? {railWidth:44,sessionWidth:224,uiFontSize:13,inputHeight:48}[key];
      input.nextElementSibling.textContent = key === 'zoomLevel' ? Math.round(100*Math.pow(1.2,Number(input.value)))+'%' : input.value;
    }
    panel.querySelector('strong').textContent = (state.mode === 'phone' ? '手机' : '电脑')+'显示参数';
  };
  const apply = () => { paint(); applyFont(state[state.mode].fontSize); applyTerminalFont?.(state[state.mode].terminalFontSize); applyZoom(state[state.mode].zoomLevel); save(); onLayoutChange(); };
  const setMode = mode => {
    if (!['desktop','phone'].includes(mode)) return;
    state.mode = mode; apply();
  };
  const close = () => { panel.hidden = true; settings.setAttribute('aria-expanded','false'); };
  for (const button of switcher.querySelectorAll('[data-display-mode]')) button.addEventListener('click',()=>setMode(button.dataset.displayMode));
  for (const [key,label] of Object.entries(FIELDS)) {
    const row = document.createElement('label'); row.textContent = label;
    const input = document.createElement('input'); input.type='range'; input.min=LIMITS[key][0]; input.max=LIMITS[key][1]; input.step='1'; input.dataset.displayField=key; input.setAttribute('aria-label',label);
    const output = document.createElement('output');
    row.append(input,output); panel.querySelector('.display-preset-fields').appendChild(row);
    input.addEventListener('input',()=>{state[state.mode][key]=Number(input.value);apply();});
  }
  settings.addEventListener('click',()=>{panel.hidden=!panel.hidden;settings.setAttribute('aria-expanded',String(!panel.hidden));paint();});
  document.addEventListener('click',event=>{if(!panel.hidden&&!switcher.contains(event.target)&&!panel.contains(event.target))close();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
  return {init:apply,setMode,get mode(){return state.mode;},record(field,value){state[state.mode][field]=value;save();paint();}};
}
module.exports = {STORAGE_KEY,PHONE,loadPresets,normalizeProfile,createDisplayPresets};
