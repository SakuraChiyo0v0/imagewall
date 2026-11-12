import { $, esc, fmtBytes, fmtCount, toast, showLayer } from './util.js';
import { api } from './api.js';
import * as settings from './settings.js';
import { Wall } from './wall.js';
import { Lightbox } from './lightbox.js';

const S = settings.load();
const state = { path: '', images: [], roots: [], webp: false, seed: 0, loadToken: 0 };

const VIEW_KEY = 'wall.view.v1';

// ------------------------------------------------------------ 画布

let movingTimer = 0;
const wall = new Wall($('stage'), $('plane'), {
  onOpen: (rec) => lightbox.open(rec.im, rec),
  onInteract: () => {
    hideHint();
    document.body.classList.add('moving');
    clearTimeout(movingTimer);
    movingTimer = setTimeout(() => document.body.classList.remove('moving'), 700);
  },
  onView: () => {
    $('zoomText').textContent = Math.round(wall.z * 100) + '%';
    saveViewSoon();
  },
});

function fmtOf() {
  if (S.fmt === 'webp') return state.webp ? 'webp' : 'jpeg';
  if (S.fmt === 'jpeg') return 'jpeg';
  return state.webp ? 'webp' : 'jpeg';
}

function applySettings() {
  document.documentElement.classList.toggle('calm', !S.motion);
  document.body.classList.toggle('names', S.names);
  document.documentElement.style.setProperty('--r', S.gap ? '6px' : '0px');
  wall.setMotion(S.motion);
  wall.setLayout(S.cell, S.gap);
  wall.setThumbOptions({
    q: S.q,
    fmt: fmtOf(),
    cap: settings.DETAIL[S.detail].cap,
    dpr: Math.min(2, window.devicePixelRatio || 1),
  });
}

// 视图位置按文件夹记住：刷新 / 回来时还在原处（布局是确定的，所以位置有意义）
let viewTimer = 0;
function saveViewSoon() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    if (!state.path) return;
    try {
      const all = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
      all[state.path] = { ...wall.view(), seed: state.seed, cell: S.cell, at: Date.now() };
      const keys = Object.keys(all);
      if (keys.length > 40) {
        keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 40).forEach((k) => delete all[k]);
      }
      localStorage.setItem(VIEW_KEY, JSON.stringify(all));
    } catch (_) { /* noop */ }
  }, 400);
}

function loadView(path) {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}')[path];
    if (v && v.cell === S.cell) return v;
  } catch (_) { /* noop */ }
  return null;
}

// ------------------------------------------------------------ 大图

const lightbox = new Lightbox({
  getList: () => state.images,
  getOpt: () => ({ q: S.q, fmt: fmtOf() }),
  rectFor: (im) => {
    const rec = wall.findRec(im);
    return rec ? wall.rectOf(rec) : null;
  },
});

// ------------------------------------------------------------ 文件夹

function setCrumb(path) {
  const el = $('pathText');
  if (!path) { el.textContent = '选择文件夹'; return; }
  // 方向 rtl 让过长路径从左边省略，末级目录名总能看见
  el.innerHTML = '<bdi>' + esc(path.split('/').join('  /  ')) + '</bdi>';
  el.title = path;
}

async function loadFolder(path, { refresh = false, keepView = false } = {}) {
  const token = ++state.loadToken;
  const plane = $('plane');
  state.path = path;
  setCrumb(path);
  $('countText').textContent = '';
  $('empty').hidden = true;
  history.replaceState(null, '', '?dir=' + encodeURIComponent(path));

  const loaderT = setTimeout(() => { if (token === state.loadToken) $('loader').hidden = false; }, 250);
  if (!keepView && state.images.length && S.motion) plane.classList.add('leave');

  let data;
  try {
    data = await api.images(path, { refresh });
  } catch (e) {
    if (token !== state.loadToken) return;
    clearTimeout(loaderT);
    $('loader').hidden = true;
    plane.classList.remove('leave');
    $('countText').textContent = '加载失败';
    toast('加载失败：' + e.message);
    return;
  }
  if (token !== state.loadToken) return;
  clearTimeout(loaderT);
  $('loader').hidden = true;

  state.images = data.images;
  $('countText').textContent = fmtCount(state.images.length) + ' 张';
  $('empty').hidden = state.images.length > 0;

  if (!keepView) {
    const v = loadView(path);
    state.seed = v ? v.seed || 0 : 0;
    wall.setImages(state.images, state.seed);
    if (v) wall.setView(v);
    else wall.setView({ tx: Math.round(innerWidth * 0.04), ty: 72, z: 1 });
    plane.classList.remove('leave');
    if (S.motion) {
      plane.classList.add('enter');
      setTimeout(() => plane.classList.remove('enter'), 900);
    }
  } else {
    wall.setImages(state.images, state.seed);
  }
  maybeAutoWarm();
}

const fs = { path: '', dirs: [], parent: '', kb: -1 };
const FOLDER_I = '<svg class="i" viewBox="0 0 24 24"><path d="M3 7.2A2.2 2.2 0 0 1 5.2 5h3.6c.6 0 1.1.3 1.5.7l1 1.3h7.5A2.2 2.2 0 0 1 21 9.2v8.6a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8z"/></svg>';
const GO_I = '<svg class="i go" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>';
const UP_I = '<svg class="i" viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>';

function crumbsHtml(path) {
  const out = ['<a data-p="">根目录</a>'];
  if (path) {
    let acc = '';
    for (const p of path.split('/')) {
      acc = acc ? acc + '/' + p : p;
      out.push(`<span class="s">/</span><a data-p="${esc(acc)}">${esc(p)}</a>`);
    }
  }
  return out.join('');
}

async function browse(path) {
  fs.path = path;
  $('fCrumbs').innerHTML = crumbsHtml(path);
  $('fFilter').value = '';
  if (!path) {
    fs.dirs = state.roots.map((r) => ({ name: r.name, path: r.path }));
    fs.parent = null;
    $('fInfo').textContent = '';
  } else {
    try {
      const d = await api.folders(path);
      if (fs.path !== path) return;
      fs.dirs = d.dirs;
      fs.parent = d.parent;
      $('fInfo').textContent = d.count !== undefined ? fmtCount(d.count) + ' 张（含子文件夹）' : '';
    } catch (e) {
      toast('读取失败：' + e.message);
      return;
    }
  }
  renderDirs();
}

function renderDirs() {
  const f = $('fFilter').value.trim().toLowerCase();
  const list = $('fList');
  const rows = [];
  if (fs.path && !f) {
    rows.push(`<div class="item up" data-up="1">${UP_I}<span class="n">上一层</span></div>`);
  }
  const dirs = f ? fs.dirs.filter((d) => d.name.toLowerCase().includes(f)) : fs.dirs;
  dirs.forEach((d, i) => {
    const c = d.count !== undefined ? `<span class="c mono">${fmtCount(d.count)}</span>` : '';
    rows.push(
      `<div class="item" data-p="${esc(d.path)}" style="animation-delay:${Math.min(i, 14) * 14}ms">${FOLDER_I}<span class="n">${esc(d.name)}</span>${c}${GO_I}</div>`,
    );
  });
  if (!dirs.length) rows.push(`<div class="none">${f ? '没有匹配的文件夹' : '没有子文件夹'}</div>`);
  list.innerHTML = rows.join('');
  list.scrollTop = 0;
  fs.kb = -1;
}

$('fList').addEventListener('click', (e) => {
  const it = e.target.closest('.item');
  if (!it) return;
  if (it.dataset.up) browse(fs.parent || '');
  else browse(it.dataset.p);
});
$('fList').addEventListener('dblclick', (e) => {
  const it = e.target.closest('.item');
  if (it && it.dataset.p) openFolder(it.dataset.p);
});
$('fCrumbs').addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (a) browse(a.dataset.p);
});
$('fFilter').addEventListener('input', renderDirs);
$('fFilter').addEventListener('keydown', (e) => {
  const items = [...$('fList').querySelectorAll('.item')];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    fs.kb = Math.max(0, Math.min(items.length - 1, fs.kb + (e.key === 'ArrowDown' ? 1 : -1)));
    items.forEach((el, i) => el.classList.toggle('kb', i === fs.kb));
    items[fs.kb] && items[fs.kb].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter') {
    const it = items[fs.kb] || (items.length === 1 ? items[0] : null);
    if (it) it.click();
    else if (fs.path) openFolder(fs.path);
  }
});

function openFolder(path) {
  closeSheets();
  if (path !== state.path) loadFolder(path);
}

$('fOpen').onclick = () => {
  if (!fs.path) return toast('先选一个文件夹');
  openFolder(fs.path);
};

// ------------------------------------------------------------ 面板

function closeSheets() {
  document.querySelectorAll('.sheet').forEach((s) => showLayer(s, false));
  $('scrim').hidden = true;
  document.body.classList.remove('f-open');
}

function toggleSheet(id) {
  const sheet = $(id);
  const willOpen = sheet.hidden || !sheet.classList.contains('open');
  closeSheets();
  if (!willOpen) return false;
  showLayer(sheet, true);
  $('scrim').hidden = false;
  return true;
}

$('scrim').addEventListener('pointerdown', closeSheets);
document.querySelectorAll('.sheet [data-close]').forEach((b) => (b.onclick = closeSheets));

$('btnFolder').onclick = () => {
  if (!toggleSheet('folderSheet')) return;
  document.body.classList.add('f-open');
  browse(state.path || fs.path || '');
  if (matchMedia('(hover: hover)').matches) setTimeout(() => $('fFilter').focus(), 60);
};

$('btnSettings').onclick = () => {
  if (toggleSheet('settingsSheet')) {
    paintAll();
    loadCacheStats();
  }
};

// ------------------------------------------------------------ 设置

function paintSeg(id, val) {
  const seg = $(id);
  let on = null;
  seg.querySelectorAll('button').forEach((b) => {
    const hit = String(val) === b.dataset.v;
    b.classList.toggle('on', hit);
    if (hit) on = b;
  });
  let pill = seg.querySelector('.pill');
  if (!pill) { pill = document.createElement('i'); pill.className = 'pill'; seg.prepend(pill); }
  if (on) {
    pill.style.width = on.offsetWidth + 'px';
    pill.style.transform = `translateX(${on.offsetLeft}px)`;
  }
}

function paintAll() {
  paintSeg('segDetail', S.detail);
  paintSeg('segQ', S.q);
  paintSeg('segFmt', S.fmt);
  paintSeg('segCell', S.cell);
  paintSeg('segGap', S.gap);
  $('tgNames').classList.toggle('on', S.names);
  $('tgMotion').classList.toggle('on', S.motion);
  $('segFmt').querySelector('[data-v="webp"]').disabled = !state.webp;
}

function bindSeg(id, key, cast) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    S[key] = cast(b.dataset.v);
    settings.save(S);
    paintSeg(id, S[key]);
    applySettings();
  });
}
bindSeg('segDetail', 'detail', String);
bindSeg('segQ', 'q', Number);
bindSeg('segFmt', 'fmt', String);
bindSeg('segCell', 'cell', Number);
bindSeg('segGap', 'gap', Number);

$('tgNames').onclick = () => { S.names = !S.names; settings.save(S); paintAll(); applySettings(); };
$('tgMotion').onclick = () => { S.motion = !S.motion; settings.save(S); paintAll(); applySettings(); };
$('btnReload').onclick = () => { if (state.path) loadFolder(state.path, { refresh: true, keepView: true }); closeSheets(); };

async function loadCacheStats() {
  try {
    const d = await api.cacheStats();
    const cap = d.max ? ' / 上限 ' + fmtBytes(d.max) : '';
    $('cacheText').textContent = `缓存 ${d.count} 张 · ${fmtBytes(d.bytes)}${cap}`;
  } catch (_) { /* noop */ }
}

// 预生成：拼贴格常用的两档短边 + 大图预览一档
function warmSizes() {
  const cap = settings.DETAIL[S.detail].cap;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const BUCKETS = [160, 240, 320, 480, 640, 800, 1200, 1600, 2400];
  const snap = (px) => BUCKETS.find((b) => b >= px) || 2400;
  const one = snap(Math.min(cap, S.cell * dpr));
  const two = snap(Math.min(cap, S.cell * 2 * dpr));
  return { s: [...new Set([one, two])].join(','), w: lightbox.previewWidth() };
}

let warmTimer = 0;
async function warm(silent) {
  if (!state.path) return;
  const sz = warmSizes();
  try {
    const d = await api.warm({ path: state.path, s: sz.s, w: silent ? '' : sz.w, q: S.q, f: fmtOf() });
    if (!d.started && !silent) toast('已有预生成在跑：' + d.path);
    pollWarm();
  } catch (e) {
    if (!silent) $('warmText').textContent = '失败：' + e.message;
  }
}

function pollWarm() {
  clearInterval(warmTimer);
  const tick = async () => {
    const st = await api.warmStatus().catch(() => null);
    if (!st) return;
    const pct = st.total ? Math.round((st.done / st.total) * 100) : 0;
    $('warmBar').style.width = pct + '%';
    $('btnWarm').textContent = st.running ? '停止' : '开始';
    if (st.running) $('warmText').textContent = `${st.done} / ${st.total}`;
    else {
      clearInterval(warmTimer);
      $('warmText').textContent = st.error ? '出错' : st.total ? `完成 ${st.total}${st.failed ? `（${st.failed} 张失败）` : ''}` : '';
      loadCacheStats();
    }
  };
  tick();
  warmTimer = setInterval(tick, 1000);
}

$('btnWarm').onclick = async () => {
  if ($('btnWarm').textContent === '停止') {
    await api.warmCancel().catch(() => {});
    return;
  }
  warm(false);
};

// 小文件夹打开时自动在后台预热整夹（只做拼贴格的尺寸），之后拖到哪都快
function maybeAutoWarm() {
  if (state.images.length && state.images.length <= 600) warm(true);
}

// ------------------------------------------------------------ 顶栏按钮

$('btnZoomIn').onclick = () => wall.zoomCenter(1.25);
$('btnZoomOut').onclick = () => wall.zoomCenter(1 / 1.25);
$('zoomText').onclick = () => wall.zoomCenter(1 / wall.zTarget);

function shuffle() {
  if (!state.images.length) return;
  state.seed = (state.seed + 1) % 100000;
  const b = $('btnShuffle');
  b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin');
  const plane = $('plane');
  const apply = () => {
    wall.setSeed(state.seed);
    plane.classList.remove('leave');
    if (S.motion) { plane.classList.add('enter'); setTimeout(() => plane.classList.remove('enter'), 900); }
    saveViewSoon();
  };
  if (S.motion) { plane.classList.add('leave'); setTimeout(apply, 220); } else apply();
}
$('btnShuffle').onclick = shuffle;

function toggleDrift() {
  const on = $('btnDrift').getAttribute('aria-pressed') !== 'true';
  $('btnDrift').setAttribute('aria-pressed', String(on));
  wall.setDrift(on);
  toast(on ? '漫游中，停手片刻后会继续慢慢飘' : '已停止漫游', 1800);
}
$('btnDrift').onclick = toggleDrift;

// ------------------------------------------------------------ 提示

let hintTimer = setTimeout(hideHint, 9000);
function hideHint() {
  $('hint').classList.add('gone');
  clearTimeout(hintTimer);
}

// ------------------------------------------------------------ 键盘

window.addEventListener('keydown', (e) => {
  if (e.target.matches && e.target.matches('input, textarea')) {
    if (e.key === 'Escape') closeSheets();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape') {
    if (lightbox.isOpen) return lightbox.close();
    return closeSheets();
  }
  if (lightbox.isOpen) return;
  const step = Math.round(Math.min(innerWidth, innerHeight) * 0.45);
  const k = e.key;
  if (k === 'ArrowLeft') wall.nudge(step, 0);
  else if (k === 'ArrowRight') wall.nudge(-step, 0);
  else if (k === 'ArrowUp') wall.nudge(0, step);
  else if (k === 'ArrowDown') wall.nudge(0, -step);
  else if (k === '+' || k === '=') wall.zoomCenter(1.2);
  else if (k === '-' || k === '_') wall.zoomCenter(1 / 1.2);
  else if (k === '0') wall.zoomCenter(1 / wall.zTarget);
  else if (k === 'f' || k === 'F') $('btnFolder').click();
  else if (k === 's' || k === 'S') $('btnSettings').click();
  else if (k === 'r' || k === 'R') shuffle();
  else if (k === 'd' || k === 'D') toggleDrift();
  else return;
  hideHint();
  e.preventDefault();
});

window.addEventListener('resize', () => {
  wall.setThumbOptions({ dpr: Math.min(2, window.devicePixelRatio || 1) });
});

// ------------------------------------------------------------ 启动

(async function boot() {
  applySettings();
  requestAnimationFrame(() => document.body.classList.remove('booting'));
  try {
    const d = await api.roots();
    state.roots = d.roots;
    state.webp = !!d.webp;
    applySettings();
    const q = new URLSearchParams(location.search).get('dir');
    const first = q || (d.roots[0] && d.roots[0].path) || '';
    fs.path = first;
    if (first) await loadFolder(first);
    else toast('没有配置可浏览的目录');
    if (innerWidth < 720) toast('双指缩放 · 拖动浏览 · 点图看大图');
  } catch (e) {
    toast('无法连接后台：' + e.message, 6000);
  }
  // 供验收脚本读状态
  window.__wall = { wall, state, stats: () => wall.stats() };
})();
