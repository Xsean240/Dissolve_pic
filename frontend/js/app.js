// 界面主逻辑：上传流程、参数绑定、手动修图工具、光影面板、预设、导出
import { fetchHealth, segmentImage } from './api.js';
import {
  loadBitmap, bitmapToCanvas, hasAlpha, computeStats, buildMatchLuts,
  computeSceneLighting,
} from './imageops.js';
import { Compositor } from './editor.js';

const $ = (id) => document.getElementById(id);

const editor = new Compositor($('stageCanvas'));
editor.attachInteraction();

let sceneStats = null;
let charStats = null;
let sceneImg = null;
let scope = 'char';
let brushMode = null; // null = 拖动；erase / restore / wand
let healthOk = false;

// ── 工具 ──────────────────────────────
function toast(msg, type = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toastBox').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function showSpinner(text) {
  $('spinnerText').textContent = text;
  $('spinner').classList.remove('hidden');
}

function hideSpinner() {
  $('spinner').classList.add('hidden');
}

function drawThumb(el, canvas) {
  const r = Math.min(1, 220 / Math.max(canvas.width, canvas.height));
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(canvas.width * r));
  t.height = Math.max(1, Math.round(canvas.height * r));
  t.getContext('2d').drawImage(canvas, 0, 0, t.width, t.height);
  t.style.maxWidth = '100%';
  t.style.maxHeight = '100%';
  el.innerHTML = '';
  el.appendChild(t);
}

function clearThumb(el) {
  el.innerHTML = '<span>点击 / 拖入图片</span>';
}

const COMPASS = ['正上', '右上', '正右', '右下', '正下', '左下', '正左', '左上'];

function compassLabel(angle) {
  return COMPASS[Math.round((angle % 360) / 45) % 8];
}

function updateStageUI() {
  const hasAny = !!(editor.scene || editor.charWork);
  const hasChar = !!editor.charWork;
  $('stageEmpty').classList.toggle('hidden', hasAny);
  $('stageHint').classList.toggle('hidden', !hasChar);
  $('btnExportPng').disabled = !hasAny;
  $('btnExportJpg').disabled = !hasAny;
  for (const id of ['charControls', 'lightControls']) {
    $(id).style.opacity = hasChar ? '' : '.45';
    $(id).style.pointerEvents = hasChar ? '' : 'none';
  }
}

// ── 后端状态 ──────────────────────────
async function pollHealth() {
  const el = $('backendStatus');
  try {
    const j = await fetchHealth();
    const m = j.models['isnet-anime'];
    if (m.loaded) {
      healthOk = true;
      el.className = 'status-pill ok';
      el.innerHTML = '<span class="dot"></span>服务正常 · 模型就绪';
    } else if (m.loading) {
      el.className = 'status-pill busy';
      el.innerHTML = '<span class="dot"></span>模型加载/下载中（首次约 176MB，请稍候）';
    } else if (m.error) {
      el.className = 'status-pill err';
      el.innerHTML = '<span class="dot"></span>模型下载失败，抠图时将自动重试';
    } else {
      el.className = 'status-pill busy';
      el.innerHTML = '<span class="dot"></span>服务正常 · 模型未加载';
    }
  } catch {
    healthOk = false;
    el.className = 'status-pill err';
    el.innerHTML = '<span class="dot"></span>后端未启动：python -m uvicorn backend.app.main:app --port 8000';
  }
}
setInterval(pollHealth, 4000);
pollHealth();

// ── 上传：场景 ────────────────────────
async function setSceneFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    toast('请选择图片文件', 'error');
    return;
  }
  try {
    const canvas = bitmapToCanvas(await loadBitmap(file), 2048);
    sceneImg = canvas;
    sceneStats = computeStats(canvas);
    editor.setScene(canvas);
    refreshMatch();
    drawThumb($('sceneThumb'), canvas);
    updateStageUI();
    toast('场景已加载', 'success');
  } catch (e) {
    toast('场景图加载失败：' + e.message, 'error');
  }
}

// ── 上传：角色（自动抠图） ────────────
async function setCharFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    toast('请选择图片文件', 'error');
    return;
  }
  try {
    const pre = bitmapToCanvas(await loadBitmap(file), 2048);
    let src;
    if ($('skipSegment').checked || hasAlpha(pre)) {
      src = pre;
      if (!hasAlpha(pre)) {
        toast('图片不含透明区域，已整张贴入，可用橡皮擦修边', 'info', 5000);
      }
    } else {
      showSpinner('正在抠图…（首次使用需下载模型，可能耗时数分钟）');
      try {
        const blob = await segmentImage(
          file, $('modelSelect').value, $('cleanupCheck').checked,
        );
        src = bitmapToCanvas(await loadBitmap(blob), 2048);
      } finally {
        hideSpinner();
      }
    }
    charStats = computeStats(src);
    editor.setChar(src);
    refreshMatch();
    drawThumb($('charThumb'), src);
    syncCharSliders();
    syncAdjSliders();
    updateStageUI();
    toast('角色已就位', 'success');
  } catch (e) {
    toast('角色处理失败：' + e.message, 'error', 6000);
  }
}

// ── 自动色调匹配 ──────────────────────
function refreshMatch() {
  const on = $('matchToggle').checked && charStats && sceneStats;
  const strength = Number($('matchStrength').value) / 100;
  const luts = on ? buildMatchLuts(charStats, sceneStats, strength) : null;
  editor.setAutoMatch({ enabled: !!on, strength, luts });
}

// ── 角色滑杆 ──────────────────────────
function syncCharSliders() {
  $('scaleRange').value = Math.round(editor.char.scale * 100);
  $('valScale').textContent = `${Math.round(editor.char.scale * 100)}%`;
  $('rotationRange').value = Math.round(editor.char.rotation);
  $('valRotation').textContent = `${Math.round(editor.char.rotation)}°`;
  $('opacityRange').value = Math.round(editor.char.opacity * 100);
  $('valOpacity').textContent = `${Math.round(editor.char.opacity * 100)}%`;
}
editor.addEventListener('transform', syncCharSliders);

$('scaleRange').addEventListener('input', (e) => {
  editor.char.scale = Number(e.target.value) / 100;
  $('valScale').textContent = `${e.target.value}%`;
  editor.scheduleRender();
});
$('rotationRange').addEventListener('input', (e) => {
  editor.char.rotation = Number(e.target.value);
  $('valRotation').textContent = `${e.target.value}°`;
  editor.scheduleRender();
});
$('opacityRange').addEventListener('input', (e) => {
  editor.char.opacity = Number(e.target.value) / 100;
  $('valOpacity').textContent = `${e.target.value}%`;
  editor.scheduleRender();
});
$('featherRange').addEventListener('input', (e) => {
  editor.setFeather(Number(e.target.value));
  $('valFeather').textContent = e.target.value;
});
$('btnFlip').addEventListener('click', () => {
  editor.char.flipX = !editor.char.flipX;
  editor.scheduleRender();
});
$('btnResetChar').addEventListener('click', () => {
  editor.resetCharTransform();
  syncCharSliders();
});

// ── 手动修图工具（擦除 / 还原 / 魔棒） ──
const TOOL_HINT = {
  erase: '擦除笔刷：按住拖动抹掉残留 · 再点一次返回拖动',
  restore: '还原笔刷：按住拖动找回误删区域 · 再点一次返回拖动',
  wand: '魔棒：点击残留背景自动清除相似色区域 · 再点一次返回拖动',
};

function setBrushMode(mode) {
  brushMode = mode;
  editor.brush = mode
    ? {
        tool: mode,
        radius: Number($('brushRange').value) / 2 + 5,
        tolerance: Number($('toleranceRange').value),
      }
    : null;
  for (const btn of document.querySelectorAll('.tool-row .toggle')) {
    btn.classList.toggle('active', btn.dataset.tool === mode);
  }
  $('stageCanvas').classList.toggle('brushing', !!mode);
  if (mode) $('stageHint').textContent = TOOL_HINT[mode];
  else {
    $('stageHint').textContent = '拖动移动角色 · 滚轮缩放 · 方向键微调（Shift 加速）';
    $('brushRing').classList.add('hidden');
  }
}
for (const btn of document.querySelectorAll('.tool-row .toggle')) {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;
    setBrushMode(brushMode === tool ? null : tool);
  });
}
$('brushRange').addEventListener('input', (e) => {
  $('valBrush').textContent = e.target.value;
  if (editor.brush) editor.brush.radius = Number(e.target.value) / 2 + 5;
});
$('toleranceRange').addEventListener('input', (e) => {
  $('valTolerance').textContent = e.target.value;
  if (editor.brush) editor.brush.tolerance = Number(e.target.value);
});
setBrushMode(null);

// 笔刷圈预览（跟随指针，仅笔刷类工具）
const ring = $('brushRing');
const stage = $('stage');
stage.addEventListener('pointermove', (e) => {
  if (!editor.brush || editor.brush.tool === 'wand' || !editor.charWork) {
    ring.classList.add('hidden');
    return;
  }
  const cv = $('stageCanvas');
  const rect = cv.getBoundingClientRect();
  const rCss = (editor.brush.radius * rect.width) / cv.width;
  const sRect = stage.getBoundingClientRect();
  ring.classList.remove('hidden');
  ring.style.width = `${rCss * 2}px`;
  ring.style.height = `${rCss * 2}px`;
  ring.style.left = `${e.clientX - sRect.left - rCss}px`;
  ring.style.top = `${e.clientY - sRect.top - rCss}px`;
});
stage.addEventListener('pointerleave', () => ring.classList.add('hidden'));

// ── 光影融合 ──────────────────────────
function syncLightSliders() {
  const L = editor.light;
  $('angleRange').value = L.angle;
  $('valAngle').textContent = `${L.angle}°（${compassLabel(L.angle)}）`;
  $('lightRange').value = L.strength;
  $('valLight').textContent = `${L.strength}%`;
  $('rimRange').value = L.rim;
  $('valRim').textContent = `${L.rim}%`;
  $('shadowRange').value = L.shadowStrength;
  $('valShadow').textContent = `${L.shadowStrength}%`;
  $('shadowLenRange').value = L.shadowLength;
  $('valShadowLen').textContent = `${L.shadowLength}%`;
}

$('angleRange').addEventListener('input', (e) => {
  editor.light.angle = Number(e.target.value);
  $('valAngle').textContent = `${e.target.value}°（${compassLabel(Number(e.target.value))}）`;
  editor.scheduleRender();
});
$('lightRange').addEventListener('input', (e) => {
  editor.light.strength = Number(e.target.value);
  $('valLight').textContent = `${e.target.value}%`;
  editor.scheduleRender();
});
$('rimRange').addEventListener('input', (e) => {
  editor.light.rim = Number(e.target.value);
  $('valRim').textContent = `${e.target.value}%`;
  editor.scheduleRender();
});
$('shadowRange').addEventListener('input', (e) => {
  editor.light.shadowStrength = Number(e.target.value);
  $('valShadow').textContent = `${e.target.value}%`;
  editor.scheduleRender();
});
$('shadowLenRange').addEventListener('input', (e) => {
  editor.light.shadowLength = Number(e.target.value);
  $('valShadowLen').textContent = `${e.target.value}%`;
  editor.scheduleRender();
});
$('btnEstimateLight').addEventListener('click', () => {
  if (!sceneImg) {
    toast('请先上传场景图', 'error');
    return;
  }
  const est = computeSceneLighting(sceneImg);
  editor.light.angle = est.angle;
  editor.light.lightColor = est.lightColor;
  editor.light.shadowColor = est.shadowColor;
  syncLightSliders();
  editor.scheduleRender();
  toast(`已按场景估计光源：${est.angle}°（${compassLabel(est.angle)}）`, 'success');
});

// ── 色彩调整 ──────────────────────────
const ADJ_KEYS = ['exposure', 'contrast', 'saturation', 'temperature', 'hue'];

function applyAdj(key, v) {
  if (scope === 'both') {
    editor.adj.char[key] = v;
    editor.adj.scene[key] = v;
  } else {
    editor.adj[scope][key] = v;
  }
  editor.scheduleRender();
  updateAdjLabels();
}

function updateAdjLabels() {
  for (const key of ADJ_KEYS) {
    const el = document.querySelector(`[data-val="${key}"]`);
    const v = editor.adj[scope][key];
    el.textContent = v > 0 ? `+${v}` : String(v);
  }
}

function syncAdjSliders() {
  for (const input of document.querySelectorAll('[data-adj]')) {
    input.value = editor.adj[scope][input.dataset.adj];
  }
  updateAdjLabels();
}

for (const input of document.querySelectorAll('[data-adj]')) {
  input.addEventListener('input', () => applyAdj(input.dataset.adj, Number(input.value)));
}

for (const btn of document.querySelectorAll('#scopeSwitch button')) {
  btn.addEventListener('click', () => {
    scope = btn.dataset.scope;
    for (const b of document.querySelectorAll('#scopeSwitch button')) {
      b.classList.toggle('active', b === btn);
    }
    syncAdjSliders();
  });
}

$('btnResetAdj').addEventListener('click', () => {
  if (scope === 'both') {
    for (const k of ADJ_KEYS) {
      editor.adj.char[k] = 0;
      editor.adj.scene[k] = 0;
    }
  } else {
    for (const k of ADJ_KEYS) editor.adj[scope][k] = 0;
  }
  editor.scheduleRender();
  syncAdjSliders();
});

// ── 自动匹配控件 ──────────────────────
$('matchToggle').addEventListener('change', refreshMatch);
$('matchStrength').addEventListener('input', (e) => {
  $('valMatch').textContent = `${e.target.value}%`;
  refreshMatch();
});

// ── 风格预设 ──────────────────────────
const PRESETS = {
  natural: {
    label: '自然融合',
    char: { exposure: -2, contrast: 0, saturation: -2, temperature: 2, hue: 0 },
    scene: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, hue: 0 },
    match: true, strength: 80, shadow: 35, light: 30, rim: 15,
  },
  morning: {
    label: '清晨柔光',
    char: { exposure: 4, contrast: -4, saturation: -4, temperature: 6, hue: 0 },
    scene: { exposure: 6, contrast: -6, saturation: -5, temperature: 12, hue: 0 },
    match: true, strength: 70, shadow: 22, light: 35, rim: 20,
  },
  sunset: {
    label: '黄昏暖调',
    char: { exposure: -2, contrast: 2, saturation: 4, temperature: 10, hue: 0 },
    scene: { exposure: -4, contrast: 8, saturation: 6, temperature: 20, hue: 0 },
    match: true, strength: 75, shadow: 45, light: 45, rim: 30,
  },
  cinema: {
    label: '电影冷调',
    char: { exposure: 0, contrast: 6, saturation: -5, temperature: -8, hue: 0 },
    scene: { exposure: -2, contrast: 12, saturation: -8, temperature: -14, hue: 0 },
    match: true, strength: 80, shadow: 55, light: 40, rim: 25,
  },
  vivid: {
    label: '动漫鲜艳',
    char: { exposure: 2, contrast: 6, saturation: 12, temperature: 0, hue: 0 },
    scene: { exposure: 4, contrast: 8, saturation: 18, temperature: 0, hue: 0 },
    match: false, strength: 70, shadow: 30, light: 20, rim: 10,
  },
  none: null,
};

function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) {
    for (const k of ADJ_KEYS) {
      editor.adj.char[k] = 0;
      editor.adj.scene[k] = 0;
    }
    editor.light.shadowStrength = 35;
    editor.light.strength = 0;
    editor.light.rim = 0;
    $('matchToggle').checked = false;
    toast('已还原所有调整');
  } else {
    Object.assign(editor.adj.char, p.char);
    Object.assign(editor.adj.scene, p.scene);
    editor.light.shadowStrength = p.shadow;
    editor.light.strength = p.light;
    editor.light.rim = p.rim;
    $('matchToggle').checked = p.match;
    $('matchStrength').value = p.strength;
    $('valMatch').textContent = `${p.strength}%`;
    refreshMatch();
    toast(`已套用预设：${p.label}（光影参数已联动）`, 'success');
  }
  editor.scheduleRender();
  syncAdjSliders();
  syncCharSliders();
  syncLightSliders();
}

for (const btn of document.querySelectorAll('.preset')) {
  btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
}

// ── 导出 / 清空 ───────────────────────
async function doExport(type) {
  if (!editor.scene && !editor.charWork) return;
  try {
    const blob = await editor.exportBlob(type);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dissolve-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${type === 'image/png' ? 'png' : 'jpg'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('已导出到下载目录', 'success');
  } catch (e) {
    toast('导出失败：' + e.message, 'error');
  }
}
$('btnExportPng').addEventListener('click', () => doExport('image/png'));
$('btnExportJpg').addEventListener('click', () => doExport('image/jpeg'));

function resetAll() {
  editor.reset();
  sceneStats = null;
  charStats = null;
  sceneImg = null;
  $('matchToggle').checked = false;
  clearThumb($('sceneThumb'));
  clearThumb($('charThumb'));
  setBrushMode(null);
  syncCharSliders();
  syncAdjSliders();
  syncLightSliders();
  updateStageUI();
  toast('画布已清空');
}
$('btnResetAll').addEventListener('click', resetAll);

// ── 上传控件绑定 ──────────────────────
function bindUpload(cardId, inputId, handler, clearBtnId, onClear) {
  const card = $(cardId);
  const input = $(inputId);
  card.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    input.click();
  });
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.click();
  });
  input.addEventListener('change', () => {
    if (input.files[0]) handler(input.files[0]);
    input.value = '';
  });
  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    card.classList.add('dragover');
  });
  card.addEventListener('dragleave', () => card.classList.remove('dragover'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('dragover');
    if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]);
  });
  $(clearBtnId).addEventListener('click', onClear);
}

bindUpload('sceneCard', 'sceneInput', setSceneFile, 'sceneClear', () => {
  editor.clearScene();
  sceneStats = null;
  sceneImg = null;
  refreshMatch();
  clearThumb($('sceneThumb'));
  updateStageUI();
});
bindUpload('charCard', 'charInput', setCharFile, 'charClear', () => {
  editor.clearChar();
  charStats = null;
  refreshMatch();
  clearThumb($('charThumb'));
  setBrushMode(null);
  updateStageUI();
});

// 把图片直接拖到画布上：没场景先当场景，否则当角色
stage.addEventListener('dragover', (e) => e.preventDefault());
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (editor.scene) setCharFile(f);
  else setSceneFile(f);
});

$('btnHelp').addEventListener('click', () => $('helpDialog').showModal());

updateStageUI();
syncLightSliders();

// 调试钩子：控制台可用 __editor 检查/操作合成器状态
window.__editor = editor;
