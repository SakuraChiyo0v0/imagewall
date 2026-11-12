// 重绘统计：手机上「图片黑一下 / 面板花屏」的根源是合成层在拖动或静止时反复重新光栅化，
// GPU 来不及就先画底色（棋盘格）。桌面 headless 看不出黑块，但能数出重绘次数。
//
//   node test/paint.mjs [页面地址] [CDP 地址]
//
// 静止 2 秒、拖动 2 秒各数一次 LayerTree.layerPainted（被重新光栅化的层）和像素面积。
// 理想：静止时 0；拖动时只有新进视口的块画一次，不该有覆盖整屏的大层在每帧重画。

const URL_ = process.argv[2] || 'http://127.0.0.1:8899/';
const CDP = process.argv[3] || 'http://127.0.0.1:9334';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tgt = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
let paints = [];
let trace = [], traceDone = null;
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d); pending.delete(d.id); return; }
  if (d.method === 'LayerTree.layerPainted') paints.push(d.params);
  if (d.method === 'Tracing.dataCollected') for (const e of d.params.value) trace.push(e);
  if (d.method === 'Tracing.tracingComplete') traceDone && traceDone();
};
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
const waitFor = async (e, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return; await sleep(100); } };
const touch = (type, x, y) => send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });

const W = 390, H = 844;
await send('Page.enable');
await send('DOM.enable');
await send('DOM.getDocument', { depth: -1 });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 3, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await send('Page.navigate', { url: URL_ });
await waitFor(`(() => { const s = window.__wall && __wall.stats(); return s && s.tiles > 0 && s.loaded === s.tiles && s.active === 0 })()`);
await sleep(1500);
await send('LayerTree.enable');

async function traced(label, fn) {
  trace = [];
  await send('Tracing.start', { categories: 'disabled-by-default-devtools.timeline,devtools.timeline,cc,disabled-by-default-cc.debug,disabled-by-default-devtools.timeline.invalidationTracking', transferMode: 'ReportEvents' });
  await fn();
  const done = new Promise((r) => (traceDone = r));
  await send('Tracing.end');
  await done;
  const c = (n) => trace.filter((e) => e.name === n && (e.ph === 'X' || e.ph === 'B')).length;
  const dur = (n) => trace.filter((e) => e.name === n && e.ph === 'X').reduce((a, e) => a + (e.dur || 0), 0) / 1000;
  const paintEv = trace.filter((e) => e.name === 'Paint' && e.args && e.args.data);
  const byNode = {};
  for (const e of paintEv) { const k = (e.args.data.nodeId || '?') + ':' + Math.round((e.args.data.clip || [0,0,0,0,0,0])[2] || 0); byNode[k] = (byNode[k] || 0) + 1; }
  const nodes = Object.entries(byNode).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const ids = [...new Set(nodes.map(([k]) => +k.split(':')[0]).filter(Boolean))];
  const names = {};
  for (const id of ids) {
    const r = await send('DOM.resolveNode', { backendNodeId: id }).catch(() => null);
    if (r && r.object) {
      const o = await send('Runtime.callFunctionOn', { objectId: r.object.objectId, functionDeclaration: 'function(){ const e = this.nodeType === 1 ? this : this.parentElement; return e ? (e.tagName + (e.id ? "#" + e.id : "") + (e.className && e.className.baseVal === undefined ? "." + String(e.className).split(" ").join(".") : "")) : String(this.nodeName) }', returnByValue: true });
      names[id] = o.result && o.result.value;
    }
  }
  const inv = {};
  for (const e of trace) if (e.name === 'PaintInvalidationTracking' || e.name === 'StyleInvalidatorInvalidationTracking' || e.name === 'LayoutInvalidationTracking') { const d = e.args.data || {}; const k = e.name.replace('InvalidationTracking','') + ':' + (d.reason || d.changedAttribute || d.changedPseudo || '') + ':' + (d.nodeName || '').slice(0,30); inv[k] = (inv[k] || 0) + 1; }
  console.log('  失效原因', JSON.stringify(Object.entries(inv).sort((a,b)=>b[1]-a[1]).slice(0,8)));
  console.log('  按节点', nodes.map(([k, n]) => (names[+k.split(':')[0]] || k) + ' ×' + n).join(' | '));
  const r = { paint: c('Paint'), raster: c('RasterTask'), rasterMs: +dur('RasterTask').toFixed(1), decode: c('ImageDecodeTask') + c('Decode Image'), layerize: c('Layerize') + c('UpdateLayerTree'), commit: c('Commit') };
  console.log(label, JSON.stringify(r));
  return r;
}
const summary = (label) => {
  const area = paints.reduce((a, p) => a + p.clip.width * p.clip.height, 0);
  const big = paints.filter((p) => p.clip.width * p.clip.height > W * H * 0.5).length;
  console.log(`${label}: 重绘 ${paints.length} 次，合计 ${(area / (W * H)).toFixed(1)} 屏面积，其中半屏以上的大块 ${big} 次`);
  return { n: paints.length, area: area / (W * H), big };
};

const tIdle = await traced('静止 2s 追踪', () => sleep(2000));
paints = [];
await sleep(2000);
const idle = summary('静止 2s');

const tDrag = await traced('拖动追踪', async () => { for (let k = 0; k < 2; k++) {
  await touch('touchStart', 300, 600);
  for (let i = 1; i <= 25; i++) { await touch('touchMove', 300 - i * 6, 600 - i * 14); await sleep(16); }
  await touch('touchEnd');
  await sleep(300);
  await touch('touchStart', 100, 200);
  for (let i = 1; i <= 25; i++) { await touch('touchMove', 100 + i * 6, 200 + i * 14); await sleep(16); }
  await touch('touchEnd');
  await sleep(300);
} });
const tSheet = await traced('打开设置面板追踪', async () => { await ev(`document.getElementById('btnSettings').click()`); await sleep(1500); await ev(`document.querySelector('#settingsSheet [data-close]').click()`); await sleep(500); });
paints = [];
for (let k = 0; k < 2; k++) {
  await touch('touchStart', 300, 600);
  for (let i = 1; i <= 25; i++) { await touch('touchMove', 300 - i * 6, 600 - i * 14); await sleep(16); }
  await touch('touchEnd');
  await sleep(300);
  await touch('touchStart', 100, 200);
  for (let i = 1; i <= 25; i++) { await touch('touchMove', 100 + i * 6, 200 + i * 14); await sleep(16); }
  await touch('touchEnd');
  await sleep(300);
}
const drag = summary('拖动 2 个来回');

paints = [];
await ev(`document.getElementById('btnSettings').click()`);
await sleep(1500);
const sheet = summary('打开设置面板后 1.5s');

const layers = await new Promise((r) => {
  const h = (m) => { const d = JSON.parse(m.data); if (d.method === 'LayerTree.layerTreeDidChange' && d.params.layers) { ws.removeEventListener('message', h); r(d.params.layers); } };
  ws.addEventListener('message', h);
  ev('document.body.offsetWidth');
  setTimeout(() => r([]), 3000);
});
const biggest = layers.filter((l) => l.drawsContent).sort((a, b) => b.width * b.height - a.width * a.height)[0];
console.log(`合成层 ${layers.filter((l) => l.drawsContent).length} 个，最大一层 ${biggest ? biggest.width + '×' + biggest.height : '-'}`);

await send('Page.close');
ws.close();
console.log('TRACE', JSON.stringify({ tIdle, tDrag, tSheet }));
