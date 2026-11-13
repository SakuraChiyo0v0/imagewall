// 错列：图片排成若干列，相邻列错开半行、拖动时上下错动方向相反，像一列列在互相滑动。
//
// 做法极简：每列有自己的纵向起跑线（错开 0.2–0.8 行），画布给每一列单独一个容器，
// 拖动 / 惯性时按列速度做一个很小的视差位移（见 wall.js 的 _applyColumnShift）。
// 列容器只改 transform，不碰块本身，所以不会引起重绘。

import { blockBase, hash2 } from './hash.js';

const H_RATIO = 1.15; // 格子高宽比（竖图多，稍高一点好看）

/** 第 col 列第 r 张的图片下标。纯函数。 */
export function columnCell(col, r, model) {
  const { n, stride, seed } = model;
  if (!n) return -1;
  const base = blockBase(col, 0, n, seed);
  return (base + (((r * stride) % n) + n) % n) % n;
}

export const columns = {
  id: 'columns',
  label: '错列',
  create(model) {
    const offOf = (col) => ((hash2(col, 4241) % 1000) / 1000) * 0.7; // 0 ~ 0.7 行
    const memo = new Map();
    const cellOf = (col, r) => {
      const k = col + ',' + r;
      let v = memo.get(k);
      if (v === undefined) {
        v = columnCell(col, r, model);
        if (memo.size > 6000) memo.clear();
        memo.set(k, v);
      }
      return v;
    };

    return {
      /** 告诉画布：这个形式要按列分组，相邻列反方向错动。 */
      parallax: {
        speed: (col) => (col % 2 ? -0.28 : 0.28),
      },
      query(x0, y0, x1, y1, C, cb) {
        const RH = C * H_RATIO;
        const c0 = Math.floor(x0 / C), c1 = Math.floor(x1 / C);
        for (let col = c0; col <= c1; col++) {
          const x = col * C;
          if (x > x1 || x + C < x0) continue;
          const off = offOf(col) * RH;
          const r0 = Math.floor((y0 - off) / RH) - 1;
          const r1 = Math.floor((y1 - off) / RH) + 1;
          for (let r = r0; r <= r1; r++) {
            const y = off + r * RH;
            if (y > y1 || y + RH < y0) continue;
            const idx = cellOf(col, r);
            if (idx < 0) continue;
            cb('c' + col + ',' + r, x, y, C, RH, idx, Math.min(1, RH / C), col);
          }
        }
      },
    };
  },
};
