// 确定性无限拼贴。
//
// 这里的函数必须保持「纯」：输出只由参数决定，不读任何全局状态、不用 Math.random。
// 拖走再拖回来，同一位置必须是同一块、同一张图，否则观感直接崩。

export const BS = 4; // 每个 block 是 BS×BS 格

// [宽, 高, 权重]。实际占比约 1×1 63% / 2×1 12% / 1×2 15% / 2×2 10%
export const SHAPES = [
  [1, 1, 46],
  [2, 1, 16],
  [1, 2, 16],
  [2, 2, 22],
];

export function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export function rng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 一个 block 内的拼贴。返回 [{x, y, w, h, i}]，坐标以格为单位、相对 block 左上角。
 * seed 让「换一批」能换出另一套同样确定的布局；不换批时 seed 恒为 0。
 */
export function tiling(bx, by, seed = 0) {
  const rnd = rng(hash2(bx + seed * 1013, by - seed * 7919));
  const used = new Uint8Array(BS * BS);
  const out = [];
  for (let y = 0; y < BS; y++) {
    for (let x = 0; x < BS; x++) {
      if (used[y * BS + x]) continue;
      let total = 0;
      const opts = [];
      for (const s of SHAPES) {
        const [w, h] = s;
        if (x + w > BS || y + h > BS) continue;
        let ok = true;
        for (let dy = 0; dy < h && ok; dy++)
          for (let dx = 0; dx < w; dx++)
            if (used[(y + dy) * BS + x + dx]) { ok = false; break; }
        if (ok) { opts.push(s); total += s[2]; }
      }
      let r = rnd() * total;
      let pick = opts[0];
      for (const o of opts) { if (r < o[2]) { pick = o; break; } r -= o[2]; }
      const [w, h] = pick;
      for (let dy = 0; dy < h; dy++)
        for (let dx = 0; dx < w; dx++) used[(y + dy) * BS + x + dx] = 1;
      out.push({ x, y, w, h, i: out.length });
    }
  }
  return out;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** 与 n 互质、约为 n·0.618 的步长。只依赖 n，同一份清单永远一样。 */
export function strideFor(n) {
  if (n <= 2) return 1;
  let s = Math.max(1, Math.round(n * 0.6180339887));
  while (gcd(s, n) !== 1) s++;
  return s;
}

/**
 * 第 (bx, by) 个 block 里第 i 块放第几张图。
 * 同一 block 内按与 n 互质的步长取，图片 ≥ 16 张时一个 block 内不会出现重复。
 */
export function pickIndex(bx, by, i, n, stride, seed = 0) {
  if (n <= 0) return -1;
  const base = hash2(Math.imul(bx, 7919) + seed * 31, Math.imul(by, 104729) - seed * 17) % n;
  return (base + ((i * stride) % n)) % n;
}

/** 带容量上限的记忆化：tiling 是纯函数，缓存只为省 CPU。 */
export function memoTiling(limit = 6000) {
  let map = new Map();
  let seedOf = 0;
  return function get(bx, by, seed = 0) {
    if (seed !== seedOf) { map = new Map(); seedOf = seed; }
    const k = bx + ',' + by;
    let v = map.get(k);
    if (!v) {
      v = tiling(bx, by, seed);
      if (map.size >= limit) map = new Map();
      map.set(k, v);
    }
    return v;
  };
}
