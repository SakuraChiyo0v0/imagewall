// 动效验收：这两种效果只有动起来才看得见，静态截图证明不了。
//
//   node test/motion.mjs [页面地址] [CDP 地址] [截图目录]
//
// ① 错列：拖动时相邻列上下反向错动。逐列记录拖动前后的屏幕位移，检查
//    奇偶列位移方向相反、且「列与列的位移差」随拖动增大（不是整体一起挪）。
// ② 网格：点开一张时周围的块被推开。点下去后立刻测量各块到点开块的距离有没有变大。
import fs from 'node:fs';

const [URL_ = 'http://127.0.0.1:8899/', CDP = 'http://127.0.0.1:9337', OUT = ''] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tgt = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const pend = new Map();
const errs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result || d); pend.delete(d.id); return; }
  if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
};
const send = (method, params = {}) => Promise.race([
  new Promise((r) => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })); }),
  sleep(15000).then(() => ({})),
]);
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description || r.exceptionDetails.text).slice(0, 300));
  return r.result.value;
};
const waitFor = async (e, ms = 40000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e)) return true; await sleep(100); } return false; };
const shot = async (n) => { if (!OUT) return; const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 78 }); if (data) fs.writeFileSync(`${OUT}/${n}.jpg`, Buffer.from(data, 'base64')); };
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
const results = [];
const check = (name, ok, info = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); };

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

async function boot(layout) {
  await send('Page.navigate', { url: URL_ });
  await waitFor('window.__wall && window.__wall.state');
  await ev(`(() => { const s = JSON.parse(localStorage.getItem('wall.settings.v2') || '{}'); s.layout = '${layout}'; localStorage.setItem('wall.settings.v2', JSON.stringify(s)); localStorage.removeItem('wall.view.v1'); })()`);
  await send('Page.navigate', { url: URL_ });
  await waitFor('window.__wall && __wall.state.images.length > 0');
  await waitFor(`(() => { const s = __wall.stats(); return s.tiles > 0 && s.loaded === s.tiles })()`);
  await sleep(1200);
}

// ---------------------------------------------------------------- ① 错列
await boot('columns');
// 量「列相对平面的偏移」：容器跟着平面一起动，看它的屏幕位置会把平面位移算进去
const colShift = () => ev(`(() => {
  const W = __wall.wall; const out = {};
  for (const [c, g] of W.cols) {
    const t = g.el.style.transform || '';
    const i = t.indexOf(',');
    const j = t.indexOf('px', i);
    out[c] = i > 0 && j > i ? parseFloat(t.slice(i + 1, j)) : 0;
  }
  return out;
})()`);
const before = await colShift();
// 慢拖 260px（不靠惯性），拖动过程中量一次
await mouse('mousePressed', 900, 500);
for (let i = 1; i <= 20; i++) { await mouse('mouseMoved', 900, 500 - i * 13); await sleep(16); }
await sleep(120);
const during = await colShift();
await shot('motion-columns-dragging');
await mouse('mouseReleased', 900, 500 - 20 * 13);
await sleep(1500);
const after = await colShift();
const cols = Object.keys(before).map(Number).sort((a, b) => a - b);
const dDuring = cols.map((c) => during[c] - before[c]);
const dAfter = cols.map((c) => after[c] - before[c]);
const even = cols.filter((c) => c % 2 === 0), odd = cols.filter((c) => c % 2 !== 0);
const avg = (arr, idxs) => idxs.reduce((a, c) => a + (during[c] - before[c]), 0) / Math.max(1, idxs.length);
check('错列：拖动时奇偶列位移方向相反', Math.sign(avg(cols, even)) !== Math.sign(avg(cols, odd)) && Math.abs(avg(cols, even)) > 1,
  `偶列 ${avg(cols, even).toFixed(1)}px / 奇列 ${avg(cols, odd).toFixed(1)}px`);
check('错列：列与列之间确实拉开了', Math.max(...dDuring) - Math.min(...dDuring) > 4, `最大差值 ${(Math.max(...dDuring) - Math.min(...dDuring)).toFixed(1)}px`);
check('错列：松手停稳后各列回到静止位置', dAfter.every((v) => Math.abs(v) < 2), `残余 ${dAfter.map((v) => v.toFixed(1)).join(',')}`);

// ---------------------------------------------------------------- ② 网格推开
await boot('grid');
const pt = await ev(`(() => {
  const t = [...document.querySelectorAll('.tile.loaded')].find((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return cx > innerWidth * 0.35 && cx < innerWidth * 0.65 && cy > 250 && cy < innerHeight - 250;
  });
  if (!t) return null;
  const r = t.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, key: t._rec.key };
})()`);
if (!pt) {
  check('网格：找到可点的块', false);
} else {
  // 记录点开前所有块的中心到目标块的距离
  const dist = (key) => ev(`(() => {
    const W = __wall.wall; const me = [...W.tiles.values()].find((r) => r.key === '${key}');
    if (!me) return null;
    const cx = me.el.getBoundingClientRect().left + me.el.getBoundingClientRect().width / 2;
    const cy = me.el.getBoundingClientRect().top + me.el.getBoundingClientRect().height / 2;
    const out = [];
    for (const r of W.tiles.values()) {
      if (r.key === '${key}') continue;
      const b = r.el.getBoundingClientRect();
      out.push(Math.hypot(b.left + b.width / 2 - cx, b.top + b.height / 2 - cy));
    }
    out.sort((a, b) => a - b);
    return out.slice(0, 8);
  })()`);
  const d0 = await dist(pt.key);
  await mouse('mousePressed', pt.x, pt.y);
  await mouse('mouseReleased', pt.x, pt.y);
  await sleep(220);           // 推开的动画进行中
  const d1 = await dist(pt.key);
  await shot('motion-grid-exploded');
  const grew = d0 && d1 ? d1.filter((v, i) => v > d0[i] + 3).length : 0;
  check('网格：点开时周围的块被推开', grew >= 4, `最近 8 块里 ${grew} 块变远`);
  await waitFor(`document.getElementById('lightbox').classList.contains('open')`, 4000);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(900);
  const d2 = await dist(pt.key);
  const back = d2 && d0 ? d2.filter((v, i) => Math.abs(v - d0[i]) < 3).length : 0;
  check('网格：关闭后周围的块收回原位', back >= 6, `${back}/8 回到原位`);
  await shot('motion-grid-restored');
}

check('无脚本异常', errs.length === 0, errs.slice(0, 2).join(' | '));
await send('Page.close');
ws.close();
console.log(results.every(Boolean) ? '\n全部通过' : '\n有失败项');
process.exit(results.every(Boolean) ? 0 : 1);
