// 手机 + 弱网复现：390×844、DPR 3、CPU 降速 4×、120KB/s + 300ms 延迟。
//
//   node test/mobile.mjs [页面地址] [CDP 地址] [截图目录]
//
// 记录：首屏多久出完图、拖动时每帧的「已显示过图的位置变成没图」次数、长帧（>50ms）数量、
// 同时在途请求峰值、合成层数量；以及打开设置面板时有没有 backdrop-filter。

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
let inflight = 0, peak = 0, reqs = 0, bytes = 0;
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d); pending.delete(d.id); return; }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Network.requestWillBeSent' && d.params.request.url.includes('/api/img?')) { inflight++; reqs++; peak = Math.max(peak, inflight); }
  if ((d.method === 'Network.loadingFinished' || d.method === 'Network.loadingFailed') && inflight > 0) inflight--;
  if (d.method === 'Network.loadingFinished') bytes += d.params.encodedDataLength || 0;
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (e, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return Date.now() - t; await sleep(100); } return -1; };
const shot = async (name) => { if (!OUT) return; const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }); fs.writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(data, 'base64')); };
const touch = (type, x, y) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Emulation.setCPUThrottlingRate', { rate: 4 });
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: 120 * 1024, uploadThroughput: 40 * 1024 });
await send('Storage.clearDataForOrigin', { origin: new URL(URL_).origin, storageTypes: 'all' });

const t0 = Date.now();
await send('Page.navigate', { url: URL_ });
const tList = await waitFor('window.__wall && __wall.state.images.length > 0', 120000);
await shot('m1-list');
const VIS = `(() => { const W = __wall.wall; let n = 0, ok = 0;
  for (const r of W.tiles.values()) {
    const sx = r.x * W.z + W.tx, sy = r.y * W.z + W.ty;
    if (sx + r.w * W.z < 0 || sy + r.h * W.z < 0 || sx > innerWidth || sy > innerHeight) continue;
    n++; if (r.img) ok++;
  } return { n, ok }; })()`;
const tFirst = await waitFor(`(() => { const v = ${VIS}; return v.n && v.ok >= 1 })()`, 120000);
await sleep(1500);
const at2 = await ev(VIS);
await shot('m2-2s');
const tAll = await waitFor(`(() => { const v = ${VIS}; return v.n && v.ok === v.n })()`, 120000);
console.log(`清单到达 ${(t0 && tList / 1000).toFixed(1)}s，第一张图 ${((tList + tFirst) / 1000).toFixed(1)}s，清单后 1.5s 出图 ${at2.ok}/${at2.n}，视口全部出图 ${tAll < 0 ? '超时' : ((tList + tFirst + 1500 + tAll) / 1000).toFixed(1) + 's'}`);
console.log(`请求 ${reqs} 个，在途峰值 ${peak}，下载 ${(bytes / 1024).toFixed(0)}KB`);
await shot('m3-loaded');

// 拖动：逐帧记录闪烁和长帧
await ev(`(() => {
  const F = window.__flick = { seen: new Set(), n: 0, long: 0, frames: 0, last: performance.now(), on: true, why: {} };
  const loop = (t) => {
    if (!F.on) return;
    F.frames++; if (t - F.last > 50) F.long++; F.last = t;
    const W = __wall.wall;
    for (const r of W.tiles.values()) {
      const sx = r.x * W.z + W.tx, sy = r.y * W.z + W.ty;
      if (sx + r.w * W.z < 0 || sy + r.h * W.z < 0 || sx > innerWidth || sy > innerHeight) continue;
      const k = Math.round(r.x) + ',' + Math.round(r.y);
      // 「看得见」= 块里任意一张 img 完全不透明（升级清晰度时旧图垫在下面也算）
      const shown = [...r.el.querySelectorAll('img')].some((im) => im.isConnected && +getComputedStyle(im).opacity > 0.95);
      if (shown) F.seen.add(k);
      else if (F.seen.has(k)) { F.n++; const w = !r.el.querySelector('img') ? 'noimg' : 'op'; F.why[w] = (F.why[w] || 0) + 1; }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})()`);
for (let k = 0; k < 3; k++) {
  await touch('touchStart', 300, 600);
  for (let i = 1; i <= 20; i++) { await touch('touchMove', 300 - i * 10, 600 - i * 22); await sleep(16); }
  await touch('touchEnd');
  await sleep(1200);
  await touch('touchStart', 100, 160);
  for (let i = 1; i <= 20; i++) { await touch('touchMove', 100 + i * 10, 160 + i * 22); await sleep(16); }
  await touch('touchEnd');
  await sleep(1200);
}
await sleep(1500);
const f = await ev('({ n: __flick.n, why: __flick.why, long: __flick.long, frames: __flick.frames })');
await ev('__flick.on = false');
console.log(`拖动 3 个来回：闪烁 ${f.n} 帧次 ${JSON.stringify(f.why)}，长帧 ${f.long}/${f.frames}`);
await shot('m4-after-drag');

const layers = await send('LayerTree.enable').then(() => null).catch(() => null);
const comp = await ev(`(() => {
  const all = [...document.querySelectorAll('*')];
  const bf = all.filter((e) => { const s = getComputedStyle(e); return s.backdropFilter && s.backdropFilter !== 'none'; }).length;
  const wc = all.filter((e) => getComputedStyle(e).willChange !== 'auto').length;
  return { backdrop: bf, willChange: wc, tiles: __wall.stats().tiles, imgs: document.querySelectorAll('#plane img').length, cached: __wall.stats().cached };
})()`);
console.log('合成相关', JSON.stringify(comp));

await ev(`document.getElementById('btnSettings').click()`);
await sleep(800);
await shot('m5-settings');
const sheet = await ev(`(() => { const s = getComputedStyle(document.getElementById('settingsSheet')); return { bf: s.backdropFilter, bg: s.backgroundColor } })()`);
console.log('设置面板', JSON.stringify(sheet));
console.log('脚本异常', errors.length ? errors.slice(0, 3) : '无');

await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await send('Emulation.setCPUThrottlingRate', { rate: 1 });
await send('Page.close');
ws.close();

// ---- 首屏 → 完整清单切换那一刻会不会闪：重新打开，从第一张图出来起逐帧盯着，直到完整清单到达后 3 秒
{
  const tgt2 = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
  const w2 = new WebSocket(tgt2.webSocketDebuggerUrl);
  await new Promise((r) => (w2.onopen = r));
  let s2 = 0; const p2 = new Map();
  w2.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && p2.has(d.id)) { p2.get(d.id)(d.result || d); p2.delete(d.id); } };
  const send2 = (method, params = {}) => new Promise((r) => { const id = ++s2; p2.set(id, r); w2.send(JSON.stringify({ id, method, params })); });
  const ev2 = async (e) => (await send2('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
  await send2('Page.enable');
  await send2('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await send2('Network.enable');
  await send2('Network.setCacheDisabled', { cacheDisabled: true });
  await send2('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: 120 * 1024, uploadThroughput: 40 * 1024 });
  // 页面一建立就开始盯（addScriptToEvaluateOnNewDocument）
  await send2('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__sw = { seen: new Set(), n: 0, fullAt: 0, frames: 0 };
    const loop = () => {
      const F = window.__sw;
      if (window.__wall) {
        const W = __wall.wall;
        if (!F.fullAt && __wall.state.images.length > 400) F.fullAt = performance.now();
        const pts = [];
        for (let y = 60; y < innerHeight; y += 60) for (let x = 20; x < innerWidth; x += 60) pts.push([x, y]);
        for (const [x, y] of pts) {
          const el = document.elementFromPoint(x, y);
          const t = el && el.closest('.tile');
          const shown = t && [...t.querySelectorAll('img')].some((im) => +getComputedStyle(im).opacity > 0.95);
          const k = x + ',' + y;
          if (shown) F.seen.add(k); else if (F.seen.has(k)) F.n++;
        }
        F.frames++;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);` });
  await send2('Page.navigate', { url: URL_ });
  const t = Date.now();
  while (Date.now() - t < 90000) { const v = await ev2('window.__sw && window.__sw.fullAt'); if (v) break; await sleep(200); }
  await sleep(3000);
  const r = await ev2('({ n: __sw.n, frames: __sw.frames, full: !!__sw.fullAt, imgs: __wall.state.images.length })');
  console.log(`首屏→完整清单切换：闪烁 ${r.n} 帧次（${r.frames} 帧），完整清单 ${r.full ? '已到 ' + r.imgs + ' 张' : '未到'}`);
  await send2('Page.close');
  w2.close();
}
