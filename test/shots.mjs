// 截几张图看效果：三种形式各一张、大图打开动画中途和稳定后、手机尺寸大图。
//   node test/shots.mjs [页面地址] [CDP 地址] <输出目录>
import fs from 'node:fs';

const URL_ = process.argv[2] || 'http://127.0.0.1:8899/';
const CDP = process.argv[3] || 'http://127.0.0.1:9333';
const OUT = process.argv[4];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tgt = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result || d); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
const waitFor = async (e, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return; await sleep(100); } };
const shot = async (name) => { const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 }); fs.writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(data, 'base64')); };
const loaded = `(() => { const s = window.__wall && __wall.stats(); return s && s.tiles > 0 && s.loaded === s.tiles })()`;
const size = (w, h, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile });

await send('Page.enable');
await size(1600, 1000);
for (const id of ['collage', 'justified', 'grid']) {
  await send('Page.navigate', { url: URL_ });
  await waitFor('window.__wall && __wall.state.images.length > 0');
  await ev(`(() => { const s = JSON.parse(localStorage.getItem('wall.settings.v2') || '{}'); s.layout = '${id}'; localStorage.setItem('wall.settings.v2', JSON.stringify(s)); })()`);
  await send('Page.reload');
  await waitFor(loaded);
  await sleep(1200);
  await shot('layout-' + id);
}
await ev(`(() => { const s = JSON.parse(localStorage.getItem('wall.settings.v2')); s.layout = 'collage'; localStorage.setItem('wall.settings.v2', JSON.stringify(s)); })()`);
await send('Page.reload');
await waitFor(loaded);
await sleep(1000);

const open = async () => {
  const pt = await ev(`(() => { const t = [...document.querySelectorAll('.tile.loaded')].find((el) => { const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2; return cx > innerWidth * .3 && cx < innerWidth * .7 && cy > innerHeight * .3 && cy < innerHeight * .7 }) || document.querySelector('.tile.loaded'); const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
};
await open();
await sleep(170);
await shot('lb-flying');
await sleep(1600);
await shot('lb-open');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', text: 'p' });
await sleep(2400);
await shot('lb-playing');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(600);

await size(390, 844, true);
await send('Page.reload');
await waitFor(loaded);
await sleep(1000);
await shot('mobile-wall');
await open();
await sleep(1600);
await shot('mobile-lb');

await send('Page.close');
ws.close();
