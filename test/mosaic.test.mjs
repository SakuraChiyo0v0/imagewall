// node --test test/mosaic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMosaic, mosaic } from '../app/static/js/layout/mosaic.js';
import { buildModel } from '../app/static/js/layout/model.js';

// 造一张目标图：左半边红、右半边蓝
function target(w, h, fn) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x / w, y / h);
      const i = (y * w + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
    }
  return { rgba, w, h, seed: 1 };
}

const grb = (r, g, b) => (r << 16) | (g << 8) | b;

test('按颜色匹配：红的格子配红图，蓝的配蓝图', () => {
  const images = [];
  for (let i = 0; i < 8; i++) images.push({ a: 100 });
  const model = buildModel(images);
  model.colors = [
    grb(230, 30, 30), grb(220, 40, 35), grb(240, 20, 25), grb(210, 45, 40),
    grb(30, 40, 220), grb(35, 35, 210), grb(25, 45, 235), grb(40, 30, 215),
  ];
  const t = target(32, 32, (x) => (x < 0.5 ? [230, 30, 30] : [30, 40, 220]));
  const m = buildMosaic(model, t, { cols: 8, rows: 8 });
  assert.ok(m);
  for (let gy = 0; gy < 8; gy++)
    for (let gx = 0; gx < 8; gx++) {
      const idx = m.cells[gy * 8 + gx];
      const c = model.colors[idx];
      const red = (c >> 16 & 255) > (c & 255);
      if (gx < 4) assert.ok(red, `格子 ${gx},${gy} 应该配红图，实际 ${c.toString(16)}`);
      else assert.ok(!red, `格子 ${gx},${gy} 应该配蓝图，实际 ${c.toString(16)}`);
    }
});

test('同一张图不会铺满整幅画（有使用次数上限）', () => {
  const images = Array.from({ length: 10 }, () => ({ a: 100 }));
  const model = buildModel(images);
  model.colors = Array.from({ length: 10 }, () => grb(250, 250, 250)); // 全是白色，最容易都用同一张
  const t = target(16, 16, () => [250, 250, 250]);
  const m = buildMosaic(model, t, { cols: 20, rows: 20 });
  const used = new Map();
  for (const c of m.cells) used.set(c, (used.get(c) || 0) + 1);
  // 全是同色时不要求每张都用上（颜色一样，用哪张都行），但不能一张铺满
  assert.ok(used.size >= 3, `只用了 ${used.size} 张`);
  const max = Math.max(...used.values());
  assert.ok(max <= m.maxUse, `单张最多用了 ${max} 次，上限 ${m.maxUse}`);
  assert.ok(max / m.cells.length < 0.5, `单张占了 ${(max / m.cells.length * 100) | 0}%`);
  assert.ok(m.cells.every((c) => c >= 0));
});

test('颜色未知的图不参与匹配；全都没有颜色时返回 null', () => {
  const model = buildModel([{ a: 100 }, { a: 100 }]);
  model.colors = [-1, -1];
  assert.equal(buildMosaic(model, target(8, 8, () => [1, 2, 3]), { cols: 4, rows: 4 }), null);
  model.colors = [-1, grb(1, 2, 3)];
  const m = buildMosaic(model, target(8, 8, () => [1, 2, 3]), { cols: 4, rows: 4 });
  assert.ok(m.cells.every((c) => c === 1));
});

test('布局是有边界的：只吐目标图范围内的格子', () => {
  const images = Array.from({ length: 6 }, () => ({ a: 100 }));
  const model = buildModel(images);
  model.colors = images.map((_, i) => grb(40 * i, 40 * i, 40 * i));
  model.mosaic = buildMosaic(model, target(8, 8, () => [128, 128, 128]), { cols: 5, rows: 3 });
  const L = mosaic.create(model);
  assert.deepEqual(L.bounded, { cols: 5, rows: 3 });
  const keys = new Set();
  let outside = 0;
  L.query(-500, -500, 5000, 5000, 100, (key, x, y, w, h) => {
    keys.add(key);
    if (x < 0 || y < 0 || x + w > 500 || y + h > 300) outside++;
  });
  assert.equal(keys.size, 15, '5×3 格');
  assert.equal(outside, 0, '没有越出目标图范围');
});

test('纯函数：同输入同输出', () => {
  const images = Array.from({ length: 12 }, () => ({ a: 100 }));
  const model = buildModel(images);
  model.colors = images.map((_, i) => grb(20 * i, 255 - 20 * i, 80));
  const t = target(16, 16, (x, y) => [x * 255, y * 255, 128]);
  const a = buildMosaic(model, t, { cols: 10, rows: 6 });
  const b = buildMosaic(model, t, { cols: 10, rows: 6 });
  assert.deepEqual([...a.cells], [...b.cells]);
});
