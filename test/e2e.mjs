// 端到端验收：连一个已启动的 headless Chrome（CDP），不依赖 puppeteer。
//
//   chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<临时目录>
//   node test/e2e.mjs [页面地址] [CDP 地址] [截图输出目录]
//
// 检查：视口覆盖率 100%、首屏图片全部加载、拖动/缩放后仍覆盖、点块开大图、Esc 关闭、
// 设置改动反映到请求参数并持久化、控制台无报错。

const URL_ = process.argv[2] || 'http://127.0.0.1:8899/';
const CDP = process.argv[3] || 'http://127.0.0.1:9333';
const OUT = process.argv[4] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tgt = await (await fetch(CDP + '/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(tgt.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const errors = [];
const reqs = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); return; }
  if (d.method === 'Runtime.exceptionThrown') errors.push('exception: ' + d.params.exceptionDetails.text + ' ' + (d.params.exceptionDetails.exception?.description || ''));
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push('console: ' + d.params.args.map((a) => a.value ?? a.description).join(' '));
  if (d.method === 'Network.responseReceived') {
    const r = d.params.response;
    if (r.status >= 400 && !/broken|坏图|%E5%9D%8F%E5%9B%BE/.test(r.url)) errors.push(r.status + ' ' + r.url.slice(-80));
  }
  if (d.method === 'Network.requestWillBeSent') reqs.push(d.params.request.url);
};
const send = (method, params = {}) => new Promise((r) => {
  const id = ++seq;
  pending.set(id, (d) => r(d.result || d));
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r.result.value;
};
const waitFor = async (expr, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await ev(expr)) return true; await sleep(100); }
  throw new Error('timeout: ' + expr);
};
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
const shot = async (name) => {
  if (!OUT) return;
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
};
const cover = () => ev(`(() => {
  let hit = 0, total = 0;
  for (let y = 6; y < innerHeight - 6; y += 40)
    for (let x = 6; x < innerWidth - 6; x += 40) {
      total++;
      // 采样点可能正好落在块间距那条缝上（取决于停在哪），上下左右挪半个间距再看
      const g = (__wall.wall.gap * __wall.wall.z) / 2 + 1;
      const ok = [[0, 0], [g, 0], [-g, 0], [0, g], [0, -g], [g, g], [-g, -g], [g, -g], [-g, g]].some(([dx, dy]) => {
        const el = document.elementFromPoint(x + dx, y + dy);
        return el && (el.closest('.tile') || el.closest('.bar') || el.closest('.hint'));
      });
      if (ok) hit++;
    }
  return Math.round(hit / total * 100);
})()`);
const allLoaded = `(() => { const s = window.__wall && __wall.stats(); return s && s.tiles > 0 && s.loaded === s.tiles && s.active === 0 })()`;

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  ' + info : '')); };

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
// 清空存储，从默认设置开始
await send('Storage.clearDataForOrigin', { origin: new URL(URL_).origin, storageTypes: 'all' });

const t0 = Date.now();
await send('Page.navigate', { url: URL_ });
await waitFor('window.__wall && __wall.state.images.length > 0', 30000);
await waitFor(allLoaded, 60000);
await sleep(900); // 等入场动画
const s0 = await ev('__wall.stats()');
check('首屏全部加载', s0.loaded === s0.tiles, `${s0.loaded}/${s0.tiles} 块, ${Date.now() - t0}ms`);
check('首屏覆盖率 100%', (await cover()) === 100, (await cover()) + '%');
await shot('1-boot');

// 拖动（慢拖 + 甩出惯性）
await mouse('mousePressed', 1300, 700);
for (let i = 1; i <= 16; i++) { await mouse('mouseMoved', 1300 - i * 45, 700 - i * 30); await sleep(16); }
await mouse('mouseReleased', 1300 - 16 * 45, 700 - 16 * 30);
await sleep(1600);
check('拖动后覆盖率 100%', (await cover()) === 100, (await cover()) + '%');
check('惯性会自己停下', (await waitFor('__wall.wall.vx === 0 && __wall.wall.vy === 0', 6000).then(() => true, () => false)));

// 拖回原点 → 同一位置同一张图（确定性）
const before = await ev(`(() => { const el = document.elementFromPoint(800, 500).closest('.tile'); return el && el._rec.im.p })()`);
await ev('(() => { const w = __wall.wall; w.setView({ tx: w.tx + 3000, ty: w.ty - 2000, z: w.z }); })()');
await sleep(300);
await ev('(() => { const w = __wall.wall; w.setView({ tx: w.tx - 3000, ty: w.ty + 2000, z: w.z }); })()');
await sleep(300);
const after = await ev(`(() => { const el = document.elementFromPoint(800, 500).closest('.tile'); return el && el._rec.im.p })()`);
check('拖远再拖回，同一位置同一张图', before && before === after, before);

// 缩到最小
for (let i = 0; i < 8; i++) await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '-', text: '-' });
await sleep(1200);
const zmin = await ev('__wall.wall.z');
await waitFor(allLoaded, 60000).catch(() => {});
check('缩到最小覆盖率 100%', (await cover()) === 100, `z=${zmin.toFixed(2)} ${(await cover())}% ${(await ev('__wall.stats().tiles'))} 块`);
await shot('2-zoomed-out');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '0', text: '0' });
await sleep(1000);

// 点块 → 大图
const pt = await ev(`(() => {
  // 缩到最小时块很小，要求整块都在视口内可能一块都找不到；只看中心点落在中间区域
  const tiles = [...document.querySelectorAll('.tile.loaded')];
  const inside = (el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return cx > 200 && cx < innerWidth - 200 && cy > 200 && cy < innerHeight - 200;
  };
  const t = tiles.find(inside) || tiles.find((el) => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    return cx > 80 && cx < innerWidth - 80 && cy > 80 && cy < innerHeight - 80;
  });
  if (!t || !t._rec) return null;
  const r = t.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, p: t._rec.im.p };
})()`);
if (!pt) { console.log('FAIL 一个块都没找到'); }
await mouse('mousePressed', pt.x, pt.y);
await mouse('mouseReleased', pt.x, pt.y);
await waitFor(`document.getElementById('lightbox').classList.contains('open')`, 3000);
await waitFor(`(() => { const b = document.querySelector('.lb-slide.cur .lb-box.sharp img.lb-full'); return b && b.src.includes('w=') })()`, 15000);
// 两侧预览和胶片条在飞入落地后才补上
await waitFor(`!document.getElementById('lightbox').classList.contains('flying')`, 3000);
await sleep(200);
check('两侧有预览', (await ev(`document.querySelectorAll('.lb-slide.side').length`)) >= 2);
check('胶片条有缩略图', (await ev(`document.querySelectorAll('.lb-th').length`)) > 4);
await sleep(700);
check('点块打开大图', true, pt.p);
check('大图是被点的那张', (await ev(`document.getElementById('lbName').title`)) === pt.p);
await shot('3-lightbox');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
await sleep(400);
check('→ 切到下一张', (await ev(`document.getElementById('lbName').title`)) !== pt.p);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(500);
check('Esc 关闭大图', await ev(`!document.getElementById('lightbox').classList.contains('open')`));

// 设置：清晰度切到省流 → 请求 s 不超过 320，刷新后保持
await ev(`document.getElementById('btnSettings').click()`);
await sleep(400);
await shot('4-settings');
await ev(`document.querySelector('#segDetail [data-v="low"]').click()`);
await sleep(300);
// 已经清晰的块不会降级重下；看刷新后新建的块请求了多大
await send('Network.setCacheDisabled', { cacheDisabled: true });
reqs.length = 0;
await send('Page.reload');
await waitFor('window.__wall && __wall.state.images.length > 0', 30000);
await sleep(2500);
await send('Network.setCacheDisabled', { cacheDisabled: false });
const sizes = reqs.filter((u) => u.includes('/api/img?')).map((u) => +new URL(u).searchParams.get('s')).filter(Boolean);
check('省流档请求 s≤320', sizes.length > 0 && Math.max(...sizes) <= 320, `${sizes.length} 个请求，最大 s=${Math.max(...sizes)}`);
check('刷新后设置保持', (await ev(`JSON.parse(localStorage.getItem('wall.settings.v2')).detail`)) === 'low');
await ev(`localStorage.setItem('wall.settings.v2', JSON.stringify({ ...JSON.parse(localStorage.getItem('wall.settings.v2')), detail: 'mid' }))`);

// 文件夹面板
await ev(`document.getElementById('btnFolder').click()`);
await waitFor(`document.querySelectorAll('#fList .item').length > 0`, 5000);
await sleep(500);
await shot('5-folders');
check('文件夹面板列出子目录', (await ev(`document.querySelectorAll('#fList .item').length`)) > 0);

check('控制台无报错', errors.length === 0, errors.slice(0, 5).join(' | '));

await send('Page.close').catch(() => {});
ws.close();
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} 项失败` : '\n全部通过');
process.exit(bad.length ? 1 : 0);
