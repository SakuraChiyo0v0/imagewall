// 布局的输入模型：图片清单 + 种子 → 布局需要的全部信息。
// 布局函数只看模型，所以「同一份清单 + 同一个种子」永远得到同一张墙。

import { strideFor } from './hash.js';

// 按宽高比把图片分成几类，决定它适合什么形状的格子
export const UNKNOWN = 0, SQUARE = 1, WIDE = 2, TALL = 3, PANO = 4, STRIP = 5;

export function classify(aspect) {
  if (!aspect) return UNKNOWN;
  if (aspect > 2.4) return PANO;
  if (aspect > 1.25) return WIDE;
  if (aspect >= 0.8) return SQUARE;
  if (aspect >= 0.42) return TALL;
  return STRIP;
}

/** images: [{ a: 宽高比×100，未知为 0 }]。 */
export function buildModel(images, seed = 0) {
  const n = images.length;
  const cls = new Uint8Array(n);
  const aspect = new Float32Array(n);
  let known = 0;
  for (let i = 0; i < n; i++) {
    const a = (images[i].a || 0) / 100;
    aspect[i] = a;
    cls[i] = classify(a);
    if (a) known++;
  }
  // colors：每张图的 24 位主色（-1 = 还不知道），只有马赛克要用
  return { n, stride: strideFor(n), cls, aspect, seed, known, colors: null, mosaic: null };
}
