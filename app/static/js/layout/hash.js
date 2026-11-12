// 布局共用的确定性工具。这里和 layout/ 下所有函数都必须是纯函数：
// 只由参数决定输出，不读全局状态、不用 Math.random。

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

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** 与 n 互质、约为 n·0.618 的步长。只依赖 n。 */
export function strideFor(n) {
  if (n <= 2) return 1;
  let s = Math.max(1, Math.round(n * 0.6180339887));
  while (gcd(s, n) !== 1) s++;
  return s;
}

/** block 的选图起点。 */
export function blockBase(bx, by, n, seed) {
  return hash2(Math.imul(bx, 7919) + seed * 31, Math.imul(by, 104729) - seed * 17) % n;
}

/** 按权重从 opts（[..., 权重] 的数组）里挑一个。 */
export function weighted(opts, r) {
  let total = 0;
  for (const o of opts) total += o[o.length - 1];
  let x = r * total;
  for (const o of opts) {
    const w = o[o.length - 1];
    if (x < w) return o;
    x -= w;
  }
  return opts[opts.length - 1];
}
