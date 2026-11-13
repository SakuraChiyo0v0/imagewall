// 均匀网格：所有格子一样大。主要用来证明「形式」是可以切换的，也适合快速扫图。

import { blockBase } from './hash.js';

const BS = 4;

export function gridBlock(bx, by, model) {
  const { n, stride, seed } = model;
  if (!n) return [];
  const base = blockBase(bx, by, n, seed);
  const out = [];
  for (let i = 0; i < BS * BS; i++) {
    out.push({ x: i % BS, y: (i / BS) | 0, w: 1, h: 1, i, idx: (base + ((i * stride) % n)) % n });
  }
  return out;
}

export const grid = {
  id: 'grid',
  label: '网格',
  create(model) {
    return {
      // 点开一张时，周围的图被推开、散向四周（模仿 Codrops 的 Grid Zoom）
      explodeOnOpen: true,
      query(x0, y0, x1, y1, C, cb) {
        const bw = BS * C;
        for (let by = Math.floor(y0 / bw); by <= Math.floor(y1 / bw); by++)
          for (let bx = Math.floor(x0 / bw); bx <= Math.floor(x1 / bw); bx++)
            for (const t of gridBlock(bx, by, model)) {
              const x = (bx * BS + t.x) * C, y = (by * BS + t.y) * C;
              if (x > x1 || y > y1 || x + C < x0 || y + C < y0) continue;
              cb(bx + ',' + by + ',' + t.i, x, y, C, C, t.idx, 1);
            }
      },
    };
  },
};
