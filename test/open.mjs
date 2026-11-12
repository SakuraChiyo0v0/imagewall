// 打开大图的过程：手机尺寸 + CPU 降速 4× + 弱网。
//
//   node test/open.mjs [页面地址] [CDP 地址] [截图目录]
//
// 点一个格子后，在页面里逐帧记录：
//   - 帧间隔（> 34ms 算掉帧）
//   - 当前大图在屏幕上的矩形
// 检查：
//   1. 第一帧看得见的大图，位置大小接近被点的格子（从格子飞出来，而不是凭空出现）
//   2. 动画结束时的大小 = 清晰大图加载完后的大小（不会先显示小缩略图、之后再「放大」一次）
//   3. 打开动画期间（前 600ms）掉帧数

import fs from 'node:fs';

const URL_ = process.argv[2] || 'http://127.0.0.1:8899/';
const CDP = process.argv[3] || 'http://127.0.0.1:9334';
const OUT = process.argv[4] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tgt = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d); pending.delete(d.id); return; }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (e, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return true; await sleep(100); } return false; };
const shot = async (name) => { if (!OUT) return; const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }); fs.writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(data, 'base64')); };

const results = [];
const check = (name, ok, info = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); };

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
const mobile = !process.env.DESKTOP;
await send('Emulation.setDeviceMetricsOverride', mobile
  ? { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
  : { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

await send('Storage.clearDataForOrigin', { origin: new URL(URL_).origin, storageTypes: 'local_storage' });
await send('Page.navigate', { url: URL_ });
await waitFor(`(() => { const s = window.__wall && __wall.stats(); return s && s.tiles > 0 && s.loaded === s.tiles && s.active === 0 })()`);
await sleep(1200);

// 大图走弱网 + 慢 CPU；缩略图已经在缓存里
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: 150 * 1024, uploadThroughput: 50 * 1024 });
await send('Emulation.setCPUThrottlingRate', { rate: mobile ? 4 : 1 });

// 记录器：点下去之后每帧记一次
await ev(`(() => {
  const R = window.__open = { frames: [], t0: 0, on: true };
  const cur = () => document.querySelector('.lb-slide.cur .lb-box');
  const loop = (t) => {
    if (!R.on) return;
    if (R.t0) {
      const img = cur();
      let rect = null, op = 0;
      if (img && img.isConnected) {
        const b = img.getBoundingClientRect();
        rect = [b.left, b.top, b.width, b.height].map(Math.round);
        op = +getComputedStyle(img).opacity * +getComputedStyle(document.getElementById('lightbox')).opacity;
      }
      // 框里有没有画面：canvas 缩略图，或已解码的 img
      const th = document.querySelector('.lb-slide.cur .lb-thumb');
      const pic = !!th && (th.tagName === 'CANVAS' ? th.width > 0 : th.complete && th.naturalWidth > 0);
      R.frames.push({ t: t - R.t0, rect, op, pic, full: !!document.querySelector('.lb-slide.cur .lb-box.sharp') });
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})()`);

const tile = await ev(`(() => {
  const W = __wall.wall;
  // 直接问画布：找出一个「中心落在安全区域内」的块，再用同一条公式算它的屏幕位置
  const safe = (x, y) => x > innerWidth * 0.25 && x < innerWidth * 0.75 && y > innerHeight * 0.3 && y < innerHeight * 0.7;
  let best = null;
  for (const r of W.tiles.values()) {
    if (!r.img) continue;
    const cx = (r.x + r.w / 2) * W.z + W.tx, cy = (r.y + r.h / 2) * W.z + W.ty;
    if (safe(cx, cy)) { best = { r, cx, cy }; break; }
  }
  if (!best) { const r = [...W.tiles.values()].find((v) => v.img); best = { r, cx: Math.min(innerWidth - 60, Math.max(60, (r.x + r.w / 2) * W.z + W.tx)), cy: Math.min(innerHeight - 160, Math.max(170, (r.y + r.h / 2) * W.z + W.ty)) }; }
  const { r, cx, cy } = best;
  return { x: cx, y: cy, rect: [r.x * W.z + W.tx, r.y * W.z + W.ty, r.w * W.z, r.h * W.z].map(Math.round), a: r.im.a };
})()`);

await ev('__open.t0 = performance.now()');
if (mobile) {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tile.x, y: tile.y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
} else {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tile.x, y: tile.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tile.x, y: tile.y, button: 'left', clickCount: 1 });
}
await sleep(120); await shot('o1-120ms');
await sleep(230); await shot('o2-350ms');
await sleep(500); await shot('o3-850ms');
await waitFor(`!!document.querySelector('.lb-slide.cur .lb-box.sharp')`, 30000);
await sleep(800);
await shot('o4-sharp');
await ev('__open.on = false');
const R = await ev('__open.frames');

console.log('前几帧', JSON.stringify(R.slice(0, 8).map((f) => [Math.round(f.t), f.rect && f.rect[2], +f.op.toFixed(2)])));
const seen = R.filter((f) => f.rect && f.rect[2] > 0 && f.op > 0.05);
const first = seen[0];
const anim = R.filter((f) => f.t < 600);
const gaps = [];
for (let i = 1; i < anim.length; i++) gaps.push(anim[i].t - anim[i - 1].t);
const long = gaps.filter((g) => g > 34).length;
console.log('长帧出现在', JSON.stringify(gaps.map((g, i) => [Math.round(anim[i].t), Math.round(g)]).filter(([, g]) => g > 34)));
const worst = Math.round(Math.max(0, ...gaps));
const firstSeenAt = first ? Math.round(first.t) : -1;
const at = (ms) => { let f = null; for (const x of R) if (x.t <= ms && x.rect) f = x; return f; };
const settled = at(700);
const sharp = R.filter((f) => f.full && f.rect).pop();

console.log(`被点的格子 ${JSON.stringify(tile.rect)}，第一帧看得见的大图 ${first ? JSON.stringify(first.rect) : '-'}（${firstSeenAt}ms）`);
console.log(`700ms 时 ${settled ? JSON.stringify(settled.rect) : '-'}，清晰图到了以后 ${sharp ? JSON.stringify(sharp.rect) : '-'}`);
const near = (a, b, tol) => a && b && Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol && Math.abs(a[2] - b[2]) < tol * 2;
check('从被点的格子飞出来', first && first.t < 120 && near(first.rect, tile.rect, Math.max(30, tile.rect[2] * 0.2)), `第一帧 ${firstSeenAt}ms`);
const blank = seen.filter((f) => !f.pic).length;
check('飞出来时框里一直有图', first && first.pic && blank === 0, `空框 ${blank} 帧`);
check('动画结束后不再变大小', settled && sharp && Math.abs(settled.rect[2] - sharp.rect[2]) <= 2 && Math.abs(settled.rect[3] - sharp.rect[3]) <= 2,
  settled && sharp ? `宽 ${settled.rect[2]} → ${sharp.rect[2]}` : '');
check('打开动画不掉帧', long <= 2, `600ms 内 ${anim.length} 帧，>34ms 的 ${long} 次，最长 ${worst}ms`);
check('无脚本异常', errors.length === 0, errors.slice(0, 2).join(' | '));

await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await send('Emulation.setCPUThrottlingRate', { rate: 1 });
await send('Page.close');
ws.close();
process.exit(results.every(Boolean) ? 0 : 1);
