// 拼贴：每 BS×BS 格一个 block，图先定、形状跟着图走。
//
// 对 block 里每个空格，按确定的顺序取候选图，按它的宽高比选格子形状：
// 横图 → 2×1 / 3×2，竖图 → 1×2 / 2×3，方图 → 1×1 / 2×2，全景 → 3×1，长条 → 1×3。
// 当前位置放不下候选图想要的形状时，往后看几张，找一张放得下的（保证裁切最少）。
// 尺寸还不知道的图按原来的随机权重混排。

import { hash2, rng, blockBase, weighted } from './hash.js';
import { UNKNOWN, SQUARE, WIDE, TALL, PANO, STRIP } from './model.js';

export const BS = 4;
const LOOK = 8; // 最多往后看几张候选（越大形状与图片越般配，但算得越多）

// [宽, 高, 权重]
const SHAPES = {
  // 这套权重决定「远看的大小块对比」。1×1 太多会显得碎，大块多才像拼贴
  [UNKNOWN]: [[1, 1, 34], [2, 1, 20], [1, 2, 20], [2, 2, 26]],
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
  // ---- 第一步：只按「位置 + 种子」排出形状，完全不看图片清单 ----
  //
  // 这一点很关键：首屏会先用「前 400 张」的小清单渲染，完整清单（上万个）到了再换一次。
  // 如果形状跟着图片总数或图片类型变，加载中的占位框和最终结果就会对不上 ——
  // 表现出来就是「占位是 2×2，最后变成两三个小块」。
  const shapeRnd = rng(hash2(bx + seed * 1013, by - seed * 7919) ^ 0x9e3779b9);
  const used = new Uint8Array(BS * BS);
  const out = [];
  for (let y = 0; y < BS; y++) {
    for (let x = 0; x < BS; x++) {
      if (used[y * BS + x]) continue;
      const opts = SHAPES[UNKNOWN].filter(([w, h]) => fits(used, x, y, w, h));
      const [w, h] = weighted(opts.length ? opts : [[1, 1, 1]], shapeRnd());
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++) used[(y + dy) * BS + x + dx] = 1;
      out.push({ x, y, w, h, i: out.length, idx: 0 });
    }
  }
  // ---- 第二步：给每个格子挑一张图，尽量挑形状对得上的 ----
  //
  // 形状已经定死了，这里只能在「放哪些图」上让步：横格子优先横图，竖格子优先竖图。
  // 挑不到合适的就用序列里的下一张，宁可裁一点，也不让版式抖。
  const base = blockBase(bx, by, n, seed);
  // 序列位置不等于图片下标：stride 与 n 互质时，序列绕一圈会回到同一张图。
  // 所以按「图片下标」去重，而不是按序列位置。
  const seqLen = out.length + LOOK;
  const usedIdx = new Set();
  const seqIdx = (k) => (base + ((k * stride) % n)) % n;
  for (const t of out) {
    const wantWide = t.w > t.h;
    const fitsShape = (c) =>
      c === UNKNOWN ||
      (wantWide && (c === WIDE || c === PANO)) ||
      (!wantWide && t.h > t.w && (c === TALL || c === STRIP)) ||
      (t.w === t.h && c === SQUARE);
    // 先在没被用过的候选里找形状对得上的；找不到就取第一个没被用过的。
    // 始终标记已用，保证一个 block 内不重复。
    let pick = -1, fallback = -1;
    for (let k = 0; k < seqLen; k++) {
      const idx = seqIdx(k);
      if (usedIdx.has(idx)) continue;
      if (fallback < 0) fallback = idx;
      if (fitsShape(cls[idx])) { pick = idx; break; }
    }
    // 图比块还少时（比如只有 3 张图却要放 13 块）必然重复，这是图库本身的限制
    if (pick < 0) pick = fallback >= 0 ? fallback : seqIdx(0);
    usedIdx.add(pick);
    t.idx = pick;
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
