// 设置存 localStorage。v1 是原型的格式（w/q/cell/names），读的时候迁移过来。

const KEY = 'wall.settings.v2';
const OLD = 'wall.settings.v1';

// 清晰度档位 → 拼贴格缩略图短边上限（再乘设备像素比之前的上限）
export const DETAIL = {
  low: { cap: 320, label: '省流' },
  mid: { cap: 640, label: '标准' },
  high: { cap: 1200, label: '高清' },
  max: { cap: 2400, label: '极致' },
};

export const CELLS = [200, 280, 360, 460];

export const defaults = {
  layout: 'collage',
  detail: 'mid',
  q: 78,
  fmt: 'auto',  // auto = 服务端支持就用 WebP
  cell: 280,
  gap: 4,
  names: false,
  motion: true,
  // 马赛克：目标图用一张半透明原图垫在下面，远看更清楚
  mosaicGhost: true,
  mosaicGhostOpacity: 0.35,
};

export function load() {
  const s = { ...defaults };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) Object.assign(s, JSON.parse(raw));
    else {
      const v1 = JSON.parse(localStorage.getItem(OLD) || 'null');
      if (v1) {
        if (v1.q) s.q = v1.q;
        if (v1.cell) s.cell = v1.cell;
        s.names = !!v1.names;
        if (v1.w) s.detail = v1.w <= 480 ? 'low' : v1.w <= 1200 ? 'mid' : v1.w <= 1600 ? 'high' : 'max';
      }
    }
  } catch (_) { /* 坏数据就用默认 */ }
  if (!DETAIL[s.detail]) s.detail = defaults.detail;
  if (!CELLS.includes(s.cell)) s.cell = defaults.cell;
  return s;
}

export function save(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (_) { /* 隐私模式写不进去就算了 */ }
}
