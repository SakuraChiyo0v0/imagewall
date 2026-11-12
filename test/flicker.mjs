// 频闪 / 弱网验收：连已启动的 headless Chrome（CDP）。
//
//   node test/flicker.mjs [页面地址] [CDP 地址]
//
// 频闪：在页面里每帧扫一遍视口内的块，记下「这个位置已经显示过图」；之后同一位置
// 又变成没图或半透明，就算一次闪烁。拖远再拖回、显示文件名、缩放都要 0 次。
// 弱网：模拟 400ms 延迟 + 200KB/s，统计视口内所有块都出图要多久、有没有坏块。

const URL_ = process.argv[2] || 'http://127.0.0.1:8899/';
const CDP = process.argv[3] || 'http://127.0.0.1:9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tgt = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((r) => {
  const id = ++seq;
  pending.set(id, (d) => r(d.result || d));
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expr, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(expr)) return Date.now() - t0; await sleep(80); }
  return -1;
};
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
const results = [];
const check = (name, ok, info = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); };

const PROBE = `(() => {
  const F = window.__flick = { seen: new Set(), n: 0, where: [], on: true };
  const loop = () => {
    if (!F.on) return;
    const W = __wall.wall, vw = innerWidth, vh = innerHeight;
    for (const r of W.tiles.values()) {
      const sx = r.x * W.z + W.tx, sy = r.y * W.z + W.ty;
      if (sx + r.w * W.z < 0 || sy + r.h * W.z < 0 || sx > vw || sy > vh) continue;
      const k = Math.round(r.x) + ',' + Math.round(r.y);
      // 看得见 = 块里任意一张 img 完全不透明（换清晰图时旧图垫在下面，也算看得见）
      const shown = [...r.el.querySelectorAll('img')].some((im) => +getComputedStyle(im).opacity > 0.95);
      if (shown) F.seen.add(k);
      else if (F.seen.has(k)) {
        F.n++;
        const why = !r.img ? 'noimg' : !r.img.isConnected ? 'detached' : 'op=' + getComputedStyle(r.img).opacity + ' cls=' + r.img.className;
        F.why = F.why || {}; F.why[why.replace(/[0-9.]+/, (m) => m.slice(0, 3))] = (F.why[why.replace(/[0-9.]+/, (m) => m.slice(0, 3))] || 0) + 1;
        if (F.where.length < 5) F.where.push(k);
      }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})()`;
const allShown = `(() => { const W = __wall.wall; let n = 0, ok = 0, err = 0;
  for (const r of W.tiles.values()) {
    const sx = r.x * W.z + W.tx, sy = r.y * W.z + W.ty;
    if (sx + r.w * W.z < 0 || sy + r.h * W.z < 0 || sx > innerWidth || sy > innerHeight) continue;
    n++; if (r.img) ok++; if (r.el.classList.contains('err')) err++;
  }
  return n > 0 && ok === n ? { n, err } : null; })()`;

async function boot(names) {
  await send('Storage.clearDataForOrigin', { origin: new URL(URL_).origin, storageTypes: 'all' });
  await send('Page.navigate', { url: URL_ });
  await waitFor('window.__wall && __wall.state.images.length > 0');
  if (names) await ev(`document.getElementById('tgNames').click()`);
  await waitFor(`(() => { const s = __wall.stats(); return s.tiles > 0 && s.loaded === s.tiles && s.active === 0 })()`, 60000);
  await sleep(1200);
}

async function dragBackAndForth() {
  // 慢拖 1800px 出去再原路拖回来，保证不触发惯性
  await mouse('mousePressed', 1300, 500);
  for (let i = 1; i <= 36; i++) { await mouse('mouseMoved', 1300 - i * 50, 500 - i * 12); await sleep(20); }
  await sleep(400);
  for (let i = 35; i >= 0; i--) { await mouse('mouseMoved', 1300 - i * 50, 500 - i * 12); await sleep(20); }
  await sleep(150);
  await mouse('mouseReleased', 1300, 500);
  await sleep(800);
}

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });

for (const names of [false, true]) {
  const tag = names ? '（显示文件名）' : '';
  await boot(names);
  await ev(PROBE);
  await dragBackAndForth();
  let f = await ev('({ n: __flick.n, where: __flick.why })');
  check('拖远再拖回无闪烁' + tag, f.n === 0, `${f.n} 帧次 ${JSON.stringify(f.where)}`);

  await ev('__flick.n = 0; __flick.where = []; __flick.why = {}');
  for (let i = 0; i < 6; i++) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '-', text: '-' }); await sleep(120); }
  await sleep(1500);
  for (let i = 0; i < 6; i++) { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '+', text: '+' }); await sleep(120); }
  await sleep(2500);
  f = await ev('({ n: __flick.n, where: __flick.why })');
  check("缩小再放大无闪烁" + tag, f.n === 0, `${f.n} 帧次 ${JSON.stringify(f.where)}`);
  await ev('__flick.on = false');
}

// ---------------- 弱网
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 200 * 1024, uploadThroughput: 64 * 1024 });
await send('Storage.clearDataForOrigin', { origin: new URL(URL_).origin, storageTypes: 'all' });
await send('Page.navigate', { url: URL_ });
await waitFor('window.__wall && __wall.state.images.length > 0', 60000);
const t = await waitFor(allShown, 90000);
const st = await ev(allShown);
check('弱网下视口内所有块都出图', t >= 0, `${(t / 1000).toFixed(1)}s ${JSON.stringify(st)}`);
check('弱网下无坏块', st && st.err === 0);
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await send('Network.setCacheDisabled', { cacheDisabled: false });

check('无脚本异常', errors.length === 0, errors.slice(0, 3).join(' | '));
await send('Page.close').catch(() => {});
ws.close();
process.exit(results.every(Boolean) ? 0 : 1);
