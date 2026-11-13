// 三种新形式的验收：无空洞、拖动后不错乱、错列里点开的是同一张、格子键稳定（纯函数）
import fs from 'node:fs';
const [CDP, URL_, OUT] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tgt = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let seq = 0; const pend = new Map(); const errs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d); pend.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); };
const send = (method, params = {}) => Promise.race([new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); }), sleep(15000).then(() => ({}))]);
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
const waitFor = async (e, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return true; await sleep(100); } return false; };
const shot = async (n) => { const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 78 }); if (data) fs.writeFileSync(`${OUT}/${n}.jpg`, Buffer.from(data, 'base64')); };
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
const cover = () => ev(`(() => { let n = 0, tot = 0; const g = (__wall.wall.gap * __wall.wall.z) / 2 + 1;
  for (let y = 6; y < innerHeight - 6; y += 40) for (let x = 6; x < innerWidth - 6; x += 40) {
    tot++; const ok = [[0,0],[g,0],[0,g],[-g,0],[0,-g],[g,g],[-g,-g]].some(([dx,dy]) => { const el = document.elementFromPoint(x+dx,y+dy); return el && (el.closest('.tile') || el.closest('.bar') || el.closest('.hint')); });
    if (ok) n++; }
  return Math.round(n / tot * 100); })()`);
await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const res = {};
for (const id of ['tiltscroll', 'columns', 'grid']) {
  await send('Page.navigate', { url: URL_ });
  await waitFor('window.__wall');
  await ev(`(() => { const s = JSON.parse(localStorage.getItem('wall.settings.v2') || '{}'); s.layout = '${id}'; localStorage.setItem('wall.settings.v2', JSON.stringify(s)); localStorage.removeItem('wall.view.v1'); })()`);
  await send('Page.navigate', { url: URL_ });
  await waitFor('window.__wall && __wall.state.images.length > 0');
  await waitFor(`(() => { const s = __wall.stats(); return s.tiles > 0 && s.loaded === s.tiles })()`);
  await sleep(1200);
  const c0 = await cover();
  await shot('new3-' + id);
  // 拖动一个来回，回到原位
  await mouse('mousePressed', 1100, 600);
  for (let i = 1; i <= 20; i++) { await mouse('mouseMoved', 1100 - i * 30, 600 - i * 18); await sleep(16); }
  for (let i = 19; i >= 0; i--) { await mouse('mouseMoved', 1100 - i * 30, 600 - i * 18); await sleep(16); }
  await mouse('mouseReleased', 1100, 600);
  await sleep(1400);
  const c1 = await cover();
  // 点开一个块，核对打开的就是那张
  let click = null;
  if (c1 === 100 || c0 === 100) {
    const pt = await ev(`(() => { const t = [...document.querySelectorAll('.tile.loaded')].find((el) => { const r = el.getBoundingClientRect(); const cx = r.left + r.width/2, cy = r.top + r.height/2; return cx > innerWidth*0.3 && cx < innerWidth*0.7 && cy > 200 && cy < innerHeight-200; }); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, p: t._rec.im.p }; })()`);
    if (pt) {
      await mouse('mousePressed', pt.x, pt.y); await mouse('mouseReleased', pt.x, pt.y);
      await waitFor(`document.getElementById('lightbox').classList.contains('open')`, 4000);
      await sleep(600);
      const opened = await ev(`document.getElementById('lbName').title`);
      click = { want: pt.p, got: opened, ok: opened === pt.p };
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(600);
      if (id === 'grid') await shot('new3-grid-after-close');
    }
  }
  res[id] = { cover0: c0, cover1: c1, click };
  console.log(id, JSON.stringify(res[id]));
}
// 换形式后列容器有没有残留
await ev(`(() => { const s = JSON.parse(localStorage.getItem('wall.settings.v2')); s.layout = 'collage'; localStorage.setItem('wall.settings.v2', JSON.stringify(s)); })()`);
await send('Page.navigate', { url: URL_ }); await sleep(2500);
console.log('切走后残留的列容器', await ev(`document.querySelectorAll('#plane .col').length`));
console.log('异常', errs.length ? errs.slice(0, 3) : '无');
await send('Page.close'); ws.close();
