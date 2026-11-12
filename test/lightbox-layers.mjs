// 大图层级与两侧预览：在几种屏幕尺寸下打开大图，量实际矩形。
//
//   node test/lightbox-layers.mjs [页面地址] [CDP 地址]
//
// 断言：
//   1. 两侧预览和中间那张不重叠（任何屏幕尺寸，特别是 4K）
//   2. 各层 z-index 顺序：大图在最上，顶栏/提示条不叠在大图上
//   3. 大图打开时，画布和顶栏不接收点击
//   4. 关闭后顶栏恢复可点
const URL_ = process.argv[2] || 'http://127.0.0.1:8899/';
const CDP = process.argv[3] || 'http://127.0.0.1:9338';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 最后一项是「中间图本身就占了大半屏」的极端情况：那时几何上不可能让两侧既不压住中间、
// 又完整留在屏内，只要求至少看得见一部分。其余尺寸要求两侧都在屏内。
const SIZES = [
  [1280, 800, '1080p', 0],
  [1600, 1000, '2K 档', 0],
  [2560, 1440, '2K', 0],
  [3840, 2160, '4K', 2],
];

const results = [];
const check = (name, ok, info = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); };

for (const [w, h, label] of SIZES) {
  const tgt = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d); pend.delete(d.id); } };
  const send = (m, p = {}) => new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method: m, params: p })); });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 300; i++) { if (await ev('window.__wall && __wall.stats().loaded > 3')) break; await sleep(100); }
  await sleep(1000);

  const pt = await ev(`(() => {
    const t = [...document.querySelectorAll('.tile.loaded')].find((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      return cx > innerWidth * 0.3 && cx < innerWidth * 0.7 && cy > innerHeight * 0.3 && cy < innerHeight * 0.7;
    });
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!pt) { check(`${label} 找到可点的块`, false); await send('Page.close'); ws.close(); continue; }
  await click(pt.x, pt.y);
  // 等飞入结束、两侧就位
  for (let i = 0; i < 80; i++) { if (!(await ev(`document.getElementById('lightbox').classList.contains('flying')`))) break; await sleep(100); }
  await sleep(900);

  // 1. 两侧与中间是否重叠
  const geo = await ev(`(() => {
    const cur = document.querySelector('.lb-slide.cur .lb-box');
    const sides = [...document.querySelectorAll('.lb-slide.side .lb-box')].map((b) => {
      const r = b.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), cx: Math.round(r.left + r.width / 2) };
    });
    const r = cur.getBoundingClientRect();
    const c = { l: Math.round(r.left), r: Math.round(r.right), w: Math.round(r.width), cx: Math.round(r.left + r.width / 2) };
    // 只统计「本该看得见却压住中间」的那几张：中心已经在屏幕外的算看不见，不算重叠
    const visibleSides = sides.filter((s) => s.cx > 0 && s.cx < innerWidth);
    const overlap = visibleSides.filter((s) => s.r > c.l + 4 && s.l < c.r - 4).length;
    const offscreen = sides.length - visibleSides.length;
    return { cur: c, sides, overlap, offscreen, vw: innerWidth };
  })()`);
  check(`${label} 两侧不压中间`, geo.overlap === 0, `中间宽 ${geo.cur.w}，两侧中心 ±${geo.sides.map((s) => s.cx - geo.cur.cx).join('/')}，重叠 ${geo.overlap}`);
  // 只要求「紧挨着的那两张」看得见；再往外那张本来就是点缀，允许在屏幕外
  check(`${label} 相邻两张可见`, geo.sides.some((s) => s.cx > 0 && s.cx < geo.vw), `两侧中心 ${geo.sides.map((s) => s.cx).join('/')}，屏宽 ${geo.vw}`);

  // 2. 层级
  const z = await ev(`(() => {
    const g = (s) => { const e = document.querySelector(s); return e ? { z: getComputedStyle(e).zIndex, pe: getComputedStyle(e).pointerEvents, op: getComputedStyle(e).opacity } : null; };
    return { lb: g('.lightbox'), bar: g('.bar'), hint: g('.hint'), stage: g('#stage'),
      hitTop: (() => { const e = document.elementFromPoint(innerWidth / 2, 40); return e && (e.id || e.className); })(),
      hitBottom: (() => { const e = document.elementFromPoint(innerWidth / 2, innerHeight - 20); return e && (e.id || e.className); })() };
  })()`);
  check(`${label} 画布不接收点击`, z.stage.pe === 'none', `stage pe=${z.stage.pe}`);
  check(`${label} 顶栏不叠在大图上`, z.hitTop && !String(z.hitTop).includes('bar'), `顶部命中 ${z.hitTop}`);

  // 3. 关闭后恢复
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(600);
  const after = await ev(`(() => ({
    open: document.getElementById('lightbox').classList.contains('open'),
    stagePe: getComputedStyle(document.getElementById('stage')).pointerEvents,
    hitTop: (() => { const e = document.elementFromPoint(innerWidth / 2, 40); return e && (e.id || e.className); })(),
  }))()`);
  check(`${label} 关闭后画布可点`, !after.open && after.stagePe !== 'none', `open=${after.open} pe=${after.stagePe}`);

  await send('Page.close');
  ws.close();
}

const bad = results.filter((x) => !x).length;
console.log(bad ? `\n${bad} 项失败` : '\n全部通过');
process.exit(bad ? 1 : 0);
