// 斜铺行错速：整面网格斜着铺开，每一行比上一行多错开一段，横向拖动时有很强的纵深和速度感。
//
// 第 row 行往右偏 row·SHEAR 格，行内每 cell 一张图，按固定步长从清单里取。
// key 里带全世界列号，所以拖动时不会重排；重复的图只来自清单本身（与拼贴、网格一致）。

import { blockBase, strideFor } from './hash.js';

const SHEAR = 0.32;   // 每往下一行，横向多错开多少（× 格宽）
const H_RATIO = 1.15; // 行高 / 格宽（含行间缝）
const MAXLEN = 12;    // 同一行最多试这么多种「每轮几张」

/** 第 row 行在一轮里的图片下标。纯函数。 */
export function tiltRow(row, model, len) {
  const { n, stride, seed } = model;
  if (!n) return [];
  const base = blockBase(row, 0, n, seed);
  const out = [];
  for (let i = 0; i < len; i++) out.push((base + ((i * stride) % n)) % n);
  return out;
}

/**
 * 这一行每轮放几张图：优先取 len ≤ 12 且 len × stride ≡ 0 (mod n) 的最小值。
 * 这样一轮正好用完若干整圈，列号 c 和 c+len 落在同一张图上，水平重复看不出来。
 * 找不到就退回 12。
 */
function roundLen(model) {
  const { n, stride } = model;
  let g = stride, a = n;
  while (a) { const r = g % a; g = a; a = r; }
  const base = Math.max(1, n / g); // 走这么多步正好回到起点
  for (let m = 1; m <= 8; m++) if (base * m <= MAXLEN) return base * m;
  return MAXLEN;
}

export const tiltscroll = {
  id: 'tiltscroll',
  label: '斜铺',
  create(model) {
    const H = 1; // 行高按 C 的倍数在 query 里算
    const len = model.n ? roundLen(model) : MAXLEN;
    const memo = new Map();
    const rowOf = (row) => {
      let v = memo.get(row);
      if (!v) {
        v = tiltRow(row, model, len);
        if (memo.size > 4000) memo.clear();
        memo.set(row, v);
      }
      return v;
    };
    void H;
    return {
      query(x0, y0, x1, y1, C, cb) {
        const RH = C * H_RATIO;
        const yPad = 0; // 行高本身就是格高，行与行之间不留缝，靠块内留白
        const row0 = Math.floor(y0 / RH), row1 = Math.floor(y1 / RH);
        for (let row = row0; row <= row1; row++) {
          const imgs = rowOf(row);
          if (!imgs.length) continue;
          const skew = row * SHEAR * C;   // 斜铺
          const span = len * C;           // 一轮的宽度
          const c0 = Math.floor((x0 - skew) / C), c1 = Math.floor((x1 - skew) / C);
          const y = row * RH + yPad;
          for (let c = c0; c <= c1; c++) {
            const x = skew + c * C;
            if (x > x1 || x + C < x0) continue;
            const idx = imgs[((c % len) + len) % len];
            // 高用 RH：否则每行下面会露出 H_RATIO−1 那一截空洞
            cb('t' + row + ',' + c, x, y, C, RH, idx, Math.min(1, RH / C));
          }
        }
      },
    };
  },
};
