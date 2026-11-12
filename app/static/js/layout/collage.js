// 拼贴：每 BS×BS 格一个 block，图先定、形状跟着图走。
//
// 对 block 里每个空格，按确定的顺序取候选图，按它的宽高比选格子形状：
// 横图 → 2×1 / 3×2，竖图 → 1×2 / 2×3，方图 → 1×1 / 2×2，全景 → 3×1，长条 → 1×3。
// 当前位置放不下候选图想要的形状时，往后看几张，找一张放得下的（保证裁切最少）。
// 尺寸还不知道的图按原来的随机权重混排。

import { hash2, rng, blockBase, weighted } from './hash.js';
import { UNKNOWN, SQUARE, WIDE, TALL, PANO, STRIP } from './model.js';

export const BS = 4;
const LOOK = 4; // 最多往后看几张候选

// [宽, 高, 权重]
const SHAPES = {
  [UNKNOWN]: [[1, 1, 46], [2, 1, 16], [1, 2, 16], [2, 2, 22]],
  [SQUARE]: [[1, 1, 60], [2, 2, 40]],
  [WIDE]: [[2, 1, 62], [3, 2, 26], [1, 1, 12]],
  [TALL]: [[1, 2, 56], [2, 3, 30], [1, 1, 14]],
  [PANO]: [[3, 1, 55], [2, 1, 45]],
  [STRIP]: [[1, 3, 55], [1, 2, 45]],
};
// 「放不下理想形状、只能塞 1×1」对这几类图损失很大，宁可换一张
const PICKY = new Set([WIDE, TALL, PANO, STRIP]);

function fits(used, x, y, w, h) {
  if (x + w > BS || y + h > BS) return false;
  for (let dy = 0; dy < h; dy++)
    for (let dx = 0; dx < w; dx++) if (used[(y + dy) * BS + x + dx]) return false;
  return true;
}

/**
 * 一个 block 的拼贴。返回 [{x, y, w, h, i, idx}]：格坐标相对 block 左上角，idx 是图片下标。
 * 纯函数：只由 (bx, by, model) 决定。
 */
export function collageBlock(bx, by, model) {
  const { n, stride, cls, seed } = model;
  if (!n) return [];
  const rnd = rng(hash2(bx + seed * 1013, by - seed * 7919));
  const used = new Uint8Array(BS * BS);
  const base = blockBase(bx, by, n, seed);
  // 候选序列：base, base+stride, ...；与 n 互质，n ≥ 16 时 block 内不重复
  const taken = new Uint8Array(BS * BS + LOOK + 1);
  let head = 0;
  const seqIdx = (k) => (base + ((k * stride) % n)) % n;
  const out = [];

  for (let y = 0; y < BS; y++) {
    for (let x = 0; x < BS; x++) {
      if (used[y * BS + x]) continue;
      while (taken[head]) head++;
      let pickK = -1, opts = null;
      for (let k = head, seen = 0; seen < LOOK && k < taken.length; k++) {
        if (taken[k]) continue;
        seen++;
        const c = cls[seqIdx(k)];
        const ok = SHAPES[c].filter(([w, h]) => fits(used, x, y, w, h));
        const good = PICKY.has(c) ? ok.filter(([w, h]) => w !== h) : ok;
        if (good.length) { pickK = k; opts = good; break; }
      }
      if (pickK < 0) { pickK = head; opts = [[1, 1, 1]]; }
      taken[pickK] = 1;
      const [w, h] = weighted(opts, rnd());
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++) used[(y + dy) * BS + x + dx] = 1;
      out.push({ x, y, w, h, i: out.length, idx: seqIdx(pickK) });
    }
  }
  return out;
}

export const collage = {
  id: 'collage',
  label: '拼贴',
  create(model) {
    const memo = new Map();
    const block = (bx, by) => {
      const k = bx + ',' + by;
      let v = memo.get(k);
      if (!v) {
        v = collageBlock(bx, by, model);
        if (memo.size > 6000) memo.clear();
        memo.set(k, v);
      }
      return v;
    };
    return {
      /** 世界坐标矩形内的所有块。cb(key, x, y, w, h, idx, short)，单位 = 世界 px。 */
      query(x0, y0, x1, y1, C, cb) {
        const bw = BS * C;
        const bx0 = Math.floor(x0 / bw), bx1 = Math.floor(x1 / bw);
        const by0 = Math.floor(y0 / bw), by1 = Math.floor(y1 / bw);
        for (let by = by0; by <= by1; by++)
          for (let bx = bx0; bx <= bx1; bx++)
            for (const t of block(bx, by)) {
              const x = (bx * BS + t.x) * C, y = (by * BS + t.y) * C, w = t.w * C, h = t.h * C;
              if (x > x1 || y > y1 || x + w < x0 || y + h < y0) continue;
              cb(bx + ',' + by + ',' + t.i, x, y, w, h, t.idx, Math.min(t.w, t.h));
            }
      },
    };
  },
};
