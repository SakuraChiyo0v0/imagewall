// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BS, tiling, pickIndex, strideFor, hash2, memoTiling } from '../app/static/js/layout.js';

test('每个 block 铺满、无重叠、不越界', () => {
  let blocks = 0, tiles = 0;
  for (const seed of [0, 1, 99]) {
    for (let by = -12; by <= 12; by++) {
      for (let bx = -12; bx <= 12; bx++) {
        const grid = new Uint8Array(BS * BS);
        for (const t of tiling(bx, by, seed)) {
          assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= BS && t.y + t.h <= BS, '越界');
          for (let y = t.y; y < t.y + t.h; y++)
            for (let x = t.x; x < t.x + t.w; x++) {
              assert.equal(grid[y * BS + x], 0, '重叠');
              grid[y * BS + x] = 1;
            }
          tiles++;
        }
        assert.ok(grid.every((v) => v === 1), '有空洞');
        blocks++;
      }
    }
  }
  assert.ok(blocks === 3 * 625 && tiles > blocks * 8);
});

test('布局与选图是纯函数：同输入同输出', () => {
  const a = JSON.stringify(tiling(-3, 7));
  for (let i = 0; i < 5; i++) assert.equal(JSON.stringify(tiling(-3, 7)), a);
  const memo = memoTiling(4);
  for (let i = 0; i < 50; i++) memo(i, -i); // 撑爆缓存
  assert.equal(JSON.stringify(memo(-3, 7)), a);
  assert.equal(pickIndex(5, -2, 3, 1000, strideFor(1000)), pickIndex(5, -2, 3, 1000, strideFor(1000)));
  assert.equal(hash2(1, 2), hash2(1, 2));
});

test('换一批（seed）确实换了布局', () => {
  let diff = 0;
  for (let i = 0; i < 20; i++) if (JSON.stringify(tiling(i, i)) !== JSON.stringify(tiling(i, i, 1))) diff++;
  assert.ok(diff > 10);
});

test('形状占比在预期范围', () => {
  const area = { '1x1': 0, '2x1': 0, '1x2': 0, '2x2': 0 };
  let n = 0;
  for (let by = 0; by < 60; by++)
    for (let bx = 0; bx < 60; bx++)
      for (const t of tiling(bx, by)) { area[t.w + 'x' + t.h]++; n++; }
  const p = (k) => area[k] / n;
  assert.ok(p('1x1') > 0.5 && p('1x1') < 0.75, '1x1 ' + p('1x1'));
  assert.ok(p('2x2') > 0.05 && p('2x2') < 0.16, '2x2 ' + p('2x2'));
});

test('图片够多时一个 block 内不重复', () => {
  for (const n of [16, 17, 100, 12455]) {
    const s = strideFor(n);
    for (let by = -5; by < 5; by++)
      for (let bx = -5; bx < 5; bx++) {
        const lay = tiling(bx, by);
        const seen = new Set(lay.map((t) => pickIndex(bx, by, t.i, n, s)));
        assert.equal(seen.size, lay.length, `n=${n} block ${bx},${by}`);
      }
  }
});

test('选图下标始终在范围内（含 1、2 张的极端）', () => {
  for (const n of [1, 2, 3, 7, 31]) {
    const s = strideFor(n);
    for (let i = 0; i < 16; i++) {
      const k = pickIndex(-9, 4, i, n, s);
      assert.ok(Number.isInteger(k) && k >= 0 && k < n);
    }
  }
  assert.equal(pickIndex(0, 0, 0, 0, 1), -1);
});
