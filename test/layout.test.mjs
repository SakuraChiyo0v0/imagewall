// node --test test/layout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collageBlock, BS } from '../app/static/js/layout/collage.js';
import { justifiedSegment } from '../app/static/js/layout/justified.js';
import { LAYOUTS, buildModel } from '../app/static/js/layout/index.js';
import { hash2, strideFor } from '../app/static/js/layout/hash.js';

// 按真实图库的比例造清单：截图横图多、插画竖图多、少量方图和长图；一部分尺寸未知
function images(n, knownRatio = 1) {
  const pool = [178, 178, 160, 133, 70, 75, 56, 100, 100, 300, 30];
  return Array.from({ length: n }, (_, i) => ({ a: hash2(i, 3) % 100 < knownRatio * 100 ? pool[hash2(i, 9) % pool.length] : 0 }));
}

function checkCover(blockFn, model, range = 10) {
  for (let by = -range; by <= range; by++)
    for (let bx = -range; bx <= range; bx++) {
      const grid = new Uint8Array(BS * BS);
      for (const t of blockFn(bx, by, model)) {
        assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= BS && t.y + t.h <= BS, '越界');
        assert.ok(t.idx >= 0 && t.idx < model.n, '下标越界');
        for (let y = t.y; y < t.y + t.h; y++)
          for (let x = t.x; x < t.x + t.w; x++) {
            assert.equal(grid[y * BS + x], 0, `重叠 ${bx},${by}`);
            grid[y * BS + x] = 1;
          }
      }
      assert.ok(grid.every((v) => v === 1), `有空洞 ${bx},${by}`);
    }
}

test('拼贴：铺满、无重叠、不越界（尺寸已知 / 未知 / 混合 / 极少图）', () => {
  for (const [n, k] of [[500, 1], [500, 0], [500, 0.5], [3, 1], [1, 0], [12455, 0.7]]) {
    checkCover(collageBlock, buildModel(images(n, k), 0));
    checkCover(collageBlock, buildModel(images(n, k), 7), 3);
  }
});

test('拼贴：纯函数，同输入同输出', () => {
  const m1 = buildModel(images(800), 0), m2 = buildModel(images(800), 0);
  for (let i = -5; i < 5; i++) assert.deepEqual(collageBlock(i, -i * 3, m1), collageBlock(i, -i * 3, m2));
});

test('拼贴：图片 ≥ 16 张时 block 内不重复', () => {
  for (const n of [16, 17, 100, 12455]) {
    const m = buildModel(images(n), 0);
    for (let by = -6; by < 6; by++)
      for (let bx = -6; bx < 6; bx++) {
        const lay = collageBlock(bx, by, m);
        assert.equal(new Set(lay.map((t) => t.idx)).size, lay.length, `n=${n}`);
      }
  }
});

test('拼贴：格子形状跟着图走（裁切少）', () => {
  const m = buildModel(images(2000), 0);
  let match = 0, total = 0, crop = 0;
  for (let by = 0; by < 40; by++)
    for (let bx = 0; bx < 40; bx++)
      for (const t of collageBlock(bx, by, m)) {
        const a = m.aspect[t.idx], c = t.w / t.h;
        total++;
        if ((a > 1.25 && c > 1) || (a < 0.8 && c < 1) || (a >= 0.8 && a <= 1.25 && c === 1)) match++;
        // 被裁掉的面积比例
        crop += 1 - Math.min(a, c) / Math.max(a, c);
      }
  assert.ok(match / total > 0.7, `形状匹配 ${(match / total * 100).toFixed(0)}%`);
  assert.ok(crop / total < 0.3, `平均裁掉 ${(crop / total * 100).toFixed(0)}%`);
});

test('拼贴：大小块都有，不是一片 1×1', () => {
  const m = buildModel(images(2000), 0);
  const area = {};
  let n = 0;
  for (let by = 0; by < 40; by++)
    for (let bx = 0; bx < 40; bx++)
      for (const t of collageBlock(bx, by, m)) { const k = t.w * t.h; area[k] = (area[k] || 0) + 1; n++; }
  assert.ok((area[1] || 0) / n < 0.6, '1×1 太多');
  assert.ok(((area[4] || 0) + (area[6] || 0)) / n > 0.05, '大块太少');
});

test('等高行：每段正好填满、无重叠', () => {
  const m = buildModel(images(500), 0);
  const asp = (i) => m.aspect[i];
  for (let row = -5; row < 5; row++)
    for (let seg = -5; seg < 5; seg++) {
      const s = justifiedSegment(row, seg, m, asp);
      let x = 0;
      for (const t of s) { assert.ok(Math.abs(t.x - x) < 1e-6); assert.ok(t.w > 0); x += t.w; }
      assert.ok(Math.abs(x - 6) < 1e-6, '段宽不等于 6');
    }
});

test('所有形式：query 纯、key 唯一', () => {
  const m = buildModel(images(600), 0);
  for (const L of LAYOUTS) {
    if (L.id === 'mosaic') continue; // 有边界，单独测（见 mosaic.test.mjs）
    const a = [], b = [];
    L.create(m).query(-2000, -1500, 2000, 1500, 280, (...r) => a.push(r.join('|')));
    L.create(m).query(-2000, -1500, 2000, 1500, 280, (...r) => b.push(r.join('|')));
    assert.deepEqual(a, b, L.id + ' 不纯');
    const keys = a.map((r) => r.split('|')[0]);
    assert.equal(new Set(keys).size, keys.length, L.id + ' key 重复');
    // 采样点覆盖
    if (L.id === 'mosaic') continue;
    const rects = a.map((r) => r.split('|').slice(1, 5).map(Number));
    for (let y = -1400; y < 1400; y += 97)
      for (let x = -1900; x < 1900; x += 97)
        assert.ok(rects.some(([rx, ry, w, h]) => x >= rx && x < rx + w && y >= ry && y < ry + h), `${L.id} 空洞 ${x},${y}`);
  }
});

test('步长与 n 互质', () => {
  const g = (a, b) => (b ? g(b, a % b) : a);
  for (const n of [1, 2, 3, 16, 100, 12455]) assert.equal(g(strideFor(n), n), 1);
});

test('斜铺：行高与格高一致（不留横缝）、行与行错开', () => {
  const m = buildModel(images(300), 0);
  const L = LAYOUTS.find((l) => l.id === 'tiltscroll').create(m);
  const rows = new Map();
  L.query(-1500, -1200, 1500, 1200, 280, (k, x, y, w, h) => {
    rows.set(k.split(',')[0], { y, h, x });
  });
  const list = [...rows.values()].sort((a, b) => a.y - b.y);
  assert.ok(list.length >= 4);
  for (let i = 1; i < list.length; i++) {
    assert.ok(Math.abs(list[i].y - (list[i - 1].y + list[i - 1].h)) < 0.01, '行之间有缝');
    assert.ok(list[i].x !== list[i - 1].x, '行没有斜铺错位');
  }
});

test('错列：相邻列纵向错位，且列内不重叠', () => {
  const m = buildModel(images(300), 0);
  const L = LAYOUTS.find((l) => l.id === 'columns').create(m);
  const perCol = new Map();
  L.query(0, -1200, 2000, 1200, 280, (k, x, y, w, h, idx, short, col) => {
    if (!perCol.has(col)) perCol.set(col, []);
    perCol.get(col).push({ x, y, h, key: k });
  });
  assert.ok(perCol.size >= 3, '列数太少');
  const starts = [...perCol.values()].map((a) => Math.min(...a.map((v) => v.y)));
  assert.ok(new Set(starts.map((v) => Math.round(v))).size > 1, '各列没有错开');
  for (const arr of perCol.values()) {
    const sorted = arr.sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i].y >= sorted[i - 1].y + sorted[i - 1].h - 0.01, '同列重叠');
    }
  }
});

test('网格形式声明了「点开时推开周围」，其他形式没有', () => {
  const m = buildModel(images(50), 0);
  for (const L of LAYOUTS) {
    const v = L.create(m);
    assert.equal(!!v.explodeOnOpen, L.id === 'grid', L.id);
  }
});
