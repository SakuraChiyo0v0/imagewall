// 等高行：每行一样高，图按原比例排，几乎不裁切（类似 Flickr / Google Photos 的 justified 布局）。
//
// 行向左右无限延伸：把每行切成固定宽度的段，段内按顺序放图、按原比例算宽，
// 放满后整体缩放到正好填满段宽。每段只由 (行号, 段号, 模型) 决定，所以同样是纯函数。

import { hash2, blockBase } from './hash.js';

const SEG = 6;    // 每段宽 = SEG × 行高
const MIN_A = 0.5, MAX_A = 2.6; // 宽高比夹在这个范围内，避免极端图占满一段

export function justifiedSegment(row, seg, model, aspectOf) {
  const { n, stride, seed } = model;
  if (!n) return [];
  // 每行错开一点起点，否则上下行的段缝会对齐成一条竖线
  const base = blockBase(seg, row, n, seed);
  const items = [];
  let sum = 0;
  for (let k = 0; k < 12 && sum < SEG; k++) {
    const idx = (base + ((k * stride) % n)) % n;
    let a = aspectOf(idx) || 1;
    a = Math.min(MAX_A, Math.max(MIN_A, a));
    items.push({ idx, a });
    sum += a;
  }
  // 最后一张超出太多就拿掉，让缩放比例更接近 1（裁切更少）
  if (items.length > 1 && sum - items[items.length - 1].a / 2 > SEG) {
    sum -= items.pop().a;
  }
  const k = SEG / sum;
  const out = [];
  let x = 0;
  items.forEach((it, i) => {
    const w = i === items.length - 1 ? SEG - x : it.a * k;
    out.push({ x, w, i, idx: it.idx });
    x += w;
  });
  return out;
}

export const justified = {
  id: 'justified',
  label: '等高行',
  create(model) {
    const aspectOf = (i) => (model.aspect ? model.aspect[i] : 0);
    const memo = new Map();
    const segment = (row, seg) => {
      const key = row + ',' + seg;
      let v = memo.get(key);
      if (!v) {
        v = justifiedSegment(row, seg, model, aspectOf);
        if (memo.size > 6000) memo.clear();
        memo.set(key, v);
      }
      return v;
    };
    return {
      query(x0, y0, x1, y1, C, cb) {
        const H = C * 1.25; // 行高比拼贴的格子略高，图看起来更大
        const SW = SEG * H;
        for (let row = Math.floor(y0 / H); row <= Math.floor(y1 / H); row++) {
          // 每行整体错开半段以内，段缝不成列
          const off = ((hash2(row, 977) % 1000) / 1000) * SW;
          const y = row * H;
          for (let seg = Math.floor((x0 - off) / SW); seg <= Math.floor((x1 - off) / SW); seg++) {
            for (const t of segment(row, seg)) {
              const x = off + seg * SW + t.x * H, w = t.w * H;
              if (x > x1 || x + w < x0) continue;
              cb('j' + row + ',' + seg + ',' + t.i, x, y, w, H, t.idx, Math.min(w, H) / C);
            }
          }
        }
      },
    };
  },
};
