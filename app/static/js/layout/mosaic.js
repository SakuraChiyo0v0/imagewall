// 照片马赛克：把一张目标图切成格子，每格挑颜色最接近的一张图当「像素」。
//
// 和其他形式不同的两点：
//   1. 它是有边界的一幅画，不是无限延伸的墙。目标图之外的地方不放东西。
//   2. 选图不是随机的，是按颜色匹配的（同一张图最多用几次，避免一片蓝天全是同一张）。
//
// model.colors 是每张图的 24 位颜色（0xRRGGBB，-1 表示还不知道）。
// 目标是用户指定的（model.target = 图片下标），或者按种子从清单里挑一张。

import { rng } from './hash.js';

const SEG = 4;            // 每个 block 是 4×4 格
const MAX_REPEAT = 3;     // 同一张图在整幅画里最多用几次（图少时自动放宽）

/** 把颜色量化成 4 位/channel，用来分桶加速查找。 */
const quant = (c) => (((c >> 19) & 0x1f) << 10) | (((c >> 11) & 0x1f) << 5) | ((c >> 3) & 0x1f);

/** 目标图的一个格子要什么颜色：target 是一张缩略图的像素数据。 */
function targetColorAt(tc, w, h, gx, gy, cols, rows) {
  // 目标图按 cols×rows 切成格子，每格取颜色的平均
  const x0 = Math.floor((gx * w) / cols), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / cols));
  const y0 = Math.floor((gy * h) / rows), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / rows));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      r += tc[i]; g += tc[i + 1]; b += tc[i + 2]; n++;
    }
  }
  return n ? [(r / n) | 0, (g / n) | 0, (b / n) | 0] : [0, 0, 0];
}

/**
 * 预先算好整幅画的「格子 → 图片下标」表。cols×rows 次查找，几千格毫秒级。
 * 返回 { cols, rows, cells: Int32Array, used: Map }。
 */
export function buildMosaic(model, target, opts = {}) {
  const { cols, rows } = opts;
  const n = model.n;
  if (!n || !target || !target.rgba) return null;
  const colors = model.colors;
  // 参与匹配的图：颜色已知的
  const pool = [];
  for (let i = 0; i < n; i++) if (colors[i] >= 0) pool.push(i);
  if (!pool.length) return null;

  // 按量化色分桶，每桶最多装几张小图；找的时候先看本桶和邻近桶
  const buckets = new Map();
  for (const i of pool) {
    const q = quant(colors[i]);
    let arr = buckets.get(q);
    if (!arr) buckets.set(q, (arr = []));
    arr.push(i);
  }
  // 图库的色域往往比目标图窄（比如一堆深色截图去还原一张亮图），直接按绝对色距匹配
  // 会把整幅画压成一片暗色。这里把目标色按图库实际的明度中位数做一次平移校正，
  // 让「亮的地方」在这批图里也能找到相对最亮的那些。
  const lum = (c) => ((c >> 16 & 255) * 0.299 + (c >> 8 & 255) * 0.587 + (c & 255) * 0.114) / 255;
  const poolLum = pool.map((i) => lum(colors[i])).sort((a, b) => a - b);
  const libMed = poolLum[poolLum.length >> 1];
  // 目标图自身的平均明度
  let tSum = 0, tN = 0;
  const trg = target.rgba;
  for (let i = 0; i < trg.length; i += 4 * 17) {
    tSum += (trg[i] * 0.299 + trg[i + 1] * 0.587 + trg[i + 2] * 0.114) / 255;
    tN++;
  }
  const tMed = tN ? tSum / tN : 0.5;
  const shift = Math.max(-0.35, Math.min(0.35, libMed - tMed));

  const rnd = rng(target.seed >>> 0);
  // 桶内顺序打乱：否则同一格永远配到同一张，整幅画都是同一张图
  for (const arr of buckets.values()) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  const used = new Map();
  // 每张最多用几次。图少时放宽（不然某些颜色没得选，只能拿差很多的图顶上）；
  // 图多时收紧，避免一幅画里同一张反复出现
  const cellsN = cols * rows;
  const avgUse = cellsN / pool.length;
  const maxUse = pool.length <= 32 ? Math.max(4, Math.ceil(avgUse * 4)) : Math.ceil(avgUse * 2) + MAX_REPEAT;
  const cells = new Int32Array(cols * rows).fill(-1);

  const dist2 = (c1, c2) => {
    const r = (c1 >> 16 & 255) - (c2 >> 16 & 255);
    const g = (c1 >> 8 & 255) - (c2 >> 8 & 255);
    const b = (c1 & 255) - (c2 & 255);
    return r * r * 0.3 + g * g * 0.59 + b * b * 0.11; // 人眼对绿最敏感
  };

  const pickFor = (rgb, gx, gy) => {
    // 按图库的明度水平平移目标色（保持色相），避免整幅画被压暗
    if (shift > 0.01) {
      rgb = rgb.map((v) => Math.min(255, v + shift * 255 * (1 - v / 255)));
    } else if (shift < -0.01) {
      rgb = rgb.map((v) => Math.max(0, v * (1 + shift)));
    }
    const want = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    // 本桶里找一个没用满、距离最近的；桶空就从全池里找
    let best = -1, bd = Infinity;
    const wq = quant(want);
    const near = buckets.get(wq);
    const consider = (i) => {
      if ((used.get(i) || 0) >= maxUse) return;
      const d = dist2(want, colors[i]);
      if (d < bd) { bd = d; best = i; }
    };
    if (near) for (let k = 0; k < near.length && k < 24; k++) consider(near[k]);
    // 池子小的时候直接把全池都算一遍，保证一定是最接近的那个
    if (pool.length <= 64) for (const i of pool) consider(i);
    if (best < 0) {
      // 邻近色：把量化值的一两位扰动一下（相邻桶颜色接近）
      for (let dq = 1; dq <= 9 && best < 0; dq++) {
        for (const q of [wq ^ dq, wq ^ (dq << 8), wq ^ (dq << 16)]) {
          const arr = buckets.get(q);
          if (arr) for (let k = 0; k < arr.length && k < 8; k++) consider(arr[k]);
          if (best >= 0) break;
        }
      }
    }
    if (best < 0) {
      // 都不满足：从全池随机挑一张重复最少的
      best = pool[(rnd() * pool.length) | 0];
    }
    used.set(best, (used.get(best) || 0) + 1);
    return best;
  };

  for (let gy = 0; gy < rows; gy++)
    for (let gx = 0; gx < cols; gx++) {
      // 抖动：按格子的位置微调目标色，避免大片同色区域出现规则条纹
      const [r, g, b] = targetColorAt(target.rgba, target.w, target.h, gx, gy, cols, rows);
      const j = 6;
      cells[gy * cols + gx] = pickFor([
        Math.max(0, Math.min(255, r + ((rnd() - 0.5) * 2 * j) | 0)),
        Math.max(0, Math.min(255, g + ((rnd() - 0.5) * 2 * j) | 0)),
        Math.max(0, Math.min(255, b + ((rnd() - 0.5) * 2 * j) | 0)),
      ], gx, gy);
    }

  return { cols, rows, cells, maxUse };
}

export const mosaic = {
  id: 'mosaic',
  label: '马赛克',
  create(model) {
    const m = model.mosaic;
    if (!m || m.cells.length === 0) {
      return { query() {} };
    }
    const { cols, rows, cells } = m;
    return {
      bounded: { cols, rows },
      query(x0, y0, x1, y1, C, cb) {
        // 世界坐标 → 格子：每个格子的边长是 cell（C），整幅画是 cols×rows 格
        const gx0 = Math.max(0, Math.floor(x0 / C)), gx1 = Math.min(cols - 1, Math.floor(x1 / C));
        const gy0 = Math.max(0, Math.floor(y0 / C)), gy1 = Math.min(rows - 1, Math.floor(y1 / C));
        for (let gy = gy0; gy <= gy1; gy++)
          for (let gx = gx0; gx <= gx1; gx++) {
            const idx = cells[gy * cols + gx];
            if (idx < 0) continue;
            cb('m' + gx + ',' + gy, gx * C, gy * C, C, C, idx, 1);
          }
      },
    };
  },
};
