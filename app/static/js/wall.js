// 无限画布：视口裁剪、块复用、按距离排队加载、惯性 / 平滑缩放 / 漫游。
//
// 坐标：屏幕 = 世界 × z + (tx, ty)。块的位置与选图全部来自 layout/ 下的纯函数，
// 这里只负责「现在屏幕上该有哪些块」和「先加载哪张」。
//
// 防闪烁的三条规矩：
//   1. 已经解码过的缩略图放进 LRU（按 图片+尺寸 记）。块被回收后再出现，直接拿回已解码的 <img>，
//      不重新下载、不做入场动画。
//   2. 块只在「出了保留区」才回收，保留区比加载区大一圈，来回小幅拖动不会反复回收。
//   3. 换更清晰的图时，新图在旧图上面淡入，旧图等新图完全显示后才移除，中间永远有图。

import { getLayout, buildModel } from './layout/index.js';
import { clamp } from './util.js';
import { thumbUrl } from './api.js';

export const ZMIN = 0.3;
export const ZMAX = 2.4;

const BUCKETS = [160, 240, 320, 480, 640, 800, 1200, 1600, 2400];
const snap = (px) => BUCKETS.find((b) => b >= px) || BUCKETS[BUCKETS.length - 1];

const POOL_MAX = 240;       // 复用的块元素上限
const IMG_CACHE = 420;      // 已解码缩略图 LRU 条数
const FRICTION_MS = 320;    // 惯性衰减时间常数（越大滑得越远）
const ZOOM_SMOOTH_MS = 70;  // 平滑缩放的追随时间常数

/** 已解码缩略图的 LRU。key = 图片路径 + 尺寸 + 规格。 */
class ImgCache {
  constructor(max) { this.max = max; this.map = new Map(); }
  key(im, px, opt) { return im.p + '|' + im.t + '|' + px + '|' + opt.q + opt.fmt; }
  /**
   * 取这张图已解码的一档：优先 ≤ want 里最大的；没有就取 > want 里最小的
   * （缩小后显示比需要更清晰的图完全没问题，总比黑一下再重新下载强）。
   */
  best(im, opt, want) {
    let hit = null;
    for (const px of BUCKETS) {
      const el = this.map.get(this.key(im, px, opt));
      if (!el) continue;
      if (px <= want) hit = { el, px };
      else { if (!hit) hit = { el, px }; break; }
    }
    if (hit) {
      const k = this.key(im, hit.px, opt);
      this.map.delete(k);
      this.map.set(k, hit.el);
    }
    return hit;
  }
  put(im, px, opt, el) {
    const k = this.key(im, px, opt);
    this.map.delete(k);
    this.map.set(k, el);
    while (this.map.size > this.max) {
      const [ok, old] = this.map.entries().next().value;
      this.map.delete(ok);
      if (!old.isConnected) old.src = '';
    }
  }
  clear() { this.map.clear(); }
}

export class Wall {
  constructor(stage, plane, hooks = {}) {
    this.stage = stage;
    this.plane = plane;
    this.hooks = hooks;

    this.tx = 0; this.ty = 0; this.z = 1;
    this.zTarget = 1; this.zAnchor = null;
    this.cell = 280; this.gap = 4; this.seed = 0;
    this.layoutId = 'collage';
    this.images = []; this.model = buildModel([]); this.layout = null;
    this.opt = { q: 78, fmt: 'jpeg', cap: 640, dpr: 1 };
    this.motion = true;
    this.maxLoads = 8;

    this.tiles = new Map();   // key → rec
    this.pool = [];
    this.cache = new ImgCache(IMG_CACHE);
    this.gen = 0;

    this.queue = new Set();   // 等待加载的 rec
    this.active = 0;

    this.vx = 0; this.vy = 0; // 惯性速度（屏幕 px / ms）
    this.drift = false;
    this.lastInteract = 0;
    this.raf = 0; this.lastT = 0; this.dirty = true;
    this.upgradeTimer = 0;
    this.net = { fast: true, samples: [] };

    this.pointers = new Map();
    this._bindInput();
    window.addEventListener('resize', () => this.invalidate());
  }

  // ------------------------------------------------------------ 公共接口

  setImages(images, seed = 0) {
    this.images = images;
    this.seed = seed;
    this._rebuild();
  }

  /**
   * 换成更长的清单（前缀不变）：已在屏幕上的块原样保留、不重建，之后新出现的块按完整清单选图。
   * 停手后（或下次换批 / 换形式时）整面墙会自然按完整清单排。
   */
  extendImages(images) {
    this.images = images;
    this.model = buildModel(images, this.seed);
    this.layout = getLayout(this.layoutId).create(this.model);
    // 新布局下同一位置可能是另一张图、另一种形状。旧块全部换成新块，但新块的图来自内存缓存
    // （首屏的图都已下好），拿不到缓存的就先保留旧块，等新块的图到了再撤：画面不会空一下。
    this._swap = new Map(this.tiles);
    this.tiles = new Map();
    this.queue.clear();
    this.invalidate();
  }

  /** 换清单时：新块有图了，把它下面压着的旧块撤掉。 */
  _settleSwap() {
    if (!this._swap) return;
    let left = 0;
    for (const [key, old] of this._swap) {
      let covered = true;
      for (const rec of this.tiles.values()) {
        if (rec.img || rec.el.classList.contains('err')) continue;
        if (rec.x < old.x + old.w && rec.x + rec.w > old.x && rec.y < old.y + old.h && rec.y + rec.h > old.y) { covered = false; break; }
      }
      if (covered) { this._swap.delete(key); this._release(old); } else left++;
    }
    if (!left) this._swap = null;
  }

  setSeed(seed) {
    this.seed = seed;
    this._rebuild();
  }

  setLayoutType(id) {
    if (id === this.layoutId) return;
    this.layoutId = id;
    this._rebuild();
  }

  _rebuild() {
    this.model = buildModel(this.images, this.seed);
    this.layout = getLayout(this.layoutId).create(this.model);
    this.clear();
    this.invalidate();
  }

  setLayout(cell, gap) {
    if (cell === this.cell && gap === this.gap) return;
    // 以屏幕中心为锚换格子大小，换完看到的还是原来那一片
    const cx = this.stage.clientWidth / 2, cy = this.stage.clientHeight / 2;
    const k = cell / this.cell;
    const wx = (cx - this.tx) / this.z, wy = (cy - this.ty) / this.z;
    this.tx = cx - wx * k * this.z;
    this.ty = cy - wy * k * this.z;
    this.cell = cell; this.gap = gap;
    this.clear();
    this.invalidate();
  }

  setThumbOptions(o) {
    const changed = (o.q !== undefined && o.q !== this.opt.q) || (o.fmt !== undefined && o.fmt !== this.opt.fmt);
    const capChanged = o.cap !== undefined && o.cap !== this.opt.cap;
    Object.assign(this.opt, o);
    if (changed) { this.clear(); this.cache.clear(); this.invalidate(); }
    else if (capChanged || o.dpr !== undefined) this._scheduleUpgrade();
  }

  setMotion(on) { this.motion = on; }

  setDrift(on) {
    this.drift = on;
    this.kick();
  }

  view() { return { tx: this.tx, ty: this.ty, z: this.z }; }

  setView(v) {
    this.tx = v.tx; this.ty = v.ty;
    this.z = this.zTarget = clamp(v.z, ZMIN, ZMAX);
    this.zAnchor = null;
    this.vx = this.vy = 0;
    this.invalidate();
  }

  /** 以屏幕点 (px, py) 为锚缩放。smooth=true 时平滑追随。 */
  zoomAt(px, py, factor, smooth = true) {
    const target = clamp((smooth ? this.zTarget : this.z) * factor, ZMIN, ZMAX);
    this.zAnchor = { sx: px, sy: py, wx: (px - this.tx) / this.z, wy: (py - this.ty) / this.z };
    this.zTarget = target;
    if (!smooth || !this.motion) this._applyZoom(target);
    this._touch();
    this.kick();
  }

  zoomCenter(factor) {
    this.zoomAt(this.stage.clientWidth / 2, this.stage.clientHeight / 2, factor);
  }

  /** 平移一段距离（屏幕 px）。有动效时转成初速度，滑过去。 */
  nudge(dx, dy) {
    this._touch();
    if (this.motion) {
      this.vx += dx / FRICTION_MS;
      this.vy += dy / FRICTION_MS;
    } else {
      this.tx += dx; this.ty += dy;
    }
    this.kick();
  }

  invalidate() { this.dirty = true; this.kick(); }

  clear() {
    if (this._swap) { for (const rec of this._swap.values()) this._release(rec); this._swap = null; }
    for (const rec of this.tiles.values()) this._release(rec);
    this.tiles.clear();
    this.queue.clear();
  }

  /** rec 在屏幕上的矩形。 */
  rectOf(rec) {
    const r = this.stage.getBoundingClientRect();
    return {
      left: r.left + rec.x * this.z + this.tx,
      top: r.top + rec.y * this.z + this.ty,
      width: rec.w * this.z,
      height: rec.h * this.z,
    };
  }

  /** 找当前画布上显示某张图的块（离屏幕中心最近的那个）。 */
  findRec(im) {
    let best = null, bd = Infinity;
    const cx = (this.stage.clientWidth / 2 - this.tx) / this.z;
    const cy = (this.stage.clientHeight / 2 - this.ty) / this.z;
    for (const rec of this.tiles.values()) {
      if (rec.im !== im) continue;
      const d = (rec.x + rec.w / 2 - cx) ** 2 + (rec.y + rec.h / 2 - cy) ** 2;
      if (d < bd) { bd = d; best = rec; }
    }
    return best;
  }

  /** 当前视口内的块（大图背景用）。 */
  visibleRecs() {
    const vw = this.stage.clientWidth, vh = this.stage.clientHeight, out = [];
    for (const r of this.tiles.values()) {
      const sx = r.x * this.z + this.tx, sy = r.y * this.z + this.ty;
      if (sx + r.w * this.z > 0 && sy + r.h * this.z > 0 && sx < vw && sy < vh) out.push(r);
    }
    return out;
  }

  /** 已解码的缩略图 URL（大图打开时先用它，不用等网络）。 */
  cachedThumb(im) {
    const hit = this.cache.best(im, this.opt, 99999);
    return hit ? hit.el.src : '';
  }

  stats() {
    let loaded = 0;
    for (const r of this.tiles.values()) if (r.img) loaded++;
    return {
      tiles: this.tiles.size, loaded, queued: this.queue.size, active: this.active,
      pool: this.pool.length, cached: this.cache.map.size, fast: this.net.fast, maxLoads: this.maxLoads,
    };
  }

  // ------------------------------------------------------------ 帧循环

  kick() {
    if (!this.raf) {
      this.lastT = performance.now();
      this.raf = requestAnimationFrame((t) => this._frame(t));
    }
  }

  _frame(t) {
    this.raf = 0;
    const dt = Math.min(64, t - this.lastT || 16);
    this.lastT = t;
    let busy = false;

    if (this.zAnchor && Math.abs(this.zTarget - this.z) > 1e-4) {
      const k = 1 - Math.exp(-dt / ZOOM_SMOOTH_MS);
      this._applyZoom(this.z + (this.zTarget - this.z) * k);
      busy = true;
    } else if (this.zAnchor) {
      this._applyZoom(this.zTarget);
      this.zAnchor = null;
      this._scheduleUpgrade();
    }

    if (this.vx || this.vy) {
      this.tx += this.vx * dt;
      this.ty += this.vy * dt;
      const f = Math.exp(-dt / FRICTION_MS);
      this.vx *= f; this.vy *= f;
      if (Math.abs(this.vx) < 0.01 && Math.abs(this.vy) < 0.01) {
        this.vx = this.vy = 0;
        this._scheduleUpgrade();
      }
      this.dirty = true;
      busy = true;
    }

    // 漫游：缓慢斜向飘，有人操作就停，停手 2.5s 后渐渐恢复
    if (this.drift && !this.pointers.size) {
      const idle = t - this.lastInteract;
      if (idle > 2500) {
        const ramp = Math.min(1, (idle - 2500) / 1500);
        const sp = 0.028 * ramp;
        this.tx -= sp * dt;
        this.ty -= sp * 0.62 * dt;
        this.dirty = true;
      }
      busy = true;
    }

    if (this.dirty) {
      this.dirty = false;
      this.plane.style.transform = `translate3d(${this.tx}px,${this.ty}px,0) scale(${this.z})`;
      this._render();
      this.hooks.onView && this.hooks.onView();
    }
    this._pump();
    if (busy || this.dirty) this.kick();
  }

  _applyZoom(z) {
    const a = this.zAnchor;
    this.z = z;
    if (a) {
      this.tx = a.sx - a.wx * z;
      this.ty = a.sy - a.wy * z;
    }
    this.dirty = true;
  }

  _touch() { this.lastInteract = performance.now(); }

  // ------------------------------------------------------------ 渲染

  _render() {
    if (!this.model.n || !this.layout) { if (this.tiles.size) this.clear(); return; }
    const C = this.cell, G = this.gap, z = this.z;
    const vw = this.stage.clientWidth, vh = this.stage.clientHeight;
    // 加载区：视口外一圈；保留区再大一圈。只有出了保留区的块才回收
    const pad = C * 0.6, keep = C * 2.2;
    const x0 = -this.tx / z, y0 = -this.ty / z;
    const x1 = (vw - this.tx) / z, y1 = (vh - this.ty) / z;
    if ((x1 - x0) * (y1 - y0) > C * C * 2400) return; // 防御：理论上 ZMIN 下到不了
    const gen = ++this.gen;
    const frag = document.createDocumentFragment();

    this.layout.query(x0 - pad, y0 - pad, x1 + pad, y1 + pad, C, (key, x, y, w, h, idx, short) => {
      let rec = this.tiles.get(key);
      if (!rec) {
        rec = this._create(key, x + G / 2, y + G / 2, Math.max(1, w - G), Math.max(1, h - G), idx, short);
        this.tiles.set(key, rec);
        frag.appendChild(rec.el);
      }
      rec.gen = gen;
    });
    if (frag.childNodes.length) {
      // 换清单期间：新块先插在旧块下面，旧块挡着，等新块出图再撤旧块
      if (this._swap && this.plane.firstChild) this.plane.insertBefore(frag, this.plane.firstChild);
      else this.plane.appendChild(frag);
    }
    if (this._swap) this._settleSwap();

    const kx0 = x0 - keep, ky0 = y0 - keep, kx1 = x1 + keep, ky1 = y1 + keep;
    for (const [key, rec] of this.tiles) {
      if (rec.gen === gen) continue;
      if (rec.x > kx1 || rec.y > ky1 || rec.x + rec.w < kx0 || rec.y + rec.h < ky0) {
        this.tiles.delete(key);
        this._release(rec);
      }
    }
  }

  _create(key, x, y, w, h, idx, short) {
    const im = this.images[idx];
    let el = this.pool.pop();
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile';
      const name = document.createElement('span');
      name.className = 'name';
      el.appendChild(name);
      el._name = name;
    }
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    // 占位色：用图片路径的哈希取一个暗色相；同一张图每次都是同一个颜色
    let hh = 0;
    for (let i = 0; i < im.p.length; i += 3) hh = (hh * 31 + im.p.charCodeAt(i)) | 0;
    el.style.setProperty('--ph', String(Math.abs(hh) % 360));
    // 整墙入场时按离屏幕中心的距离错开，像从中间铺开
    const sx = (x + w / 2) * this.z + this.tx - this.stage.clientWidth / 2;
    const sy = (y + h / 2) * this.z + this.ty - this.stage.clientHeight / 2;
    el.style.setProperty('--d', Math.min(420, Math.hypot(sx, sy) * 0.35) + 'ms');
    el._name.textContent = im.n;
    el.classList.remove('err', 'loaded');
    const rec = { key, el, im, x, y, w, h, short, img: null, px: 0, want: 0, loader: null, gen: 0 };
    el._rec = rec;

    // 已经解码过就直接放上去，不做入场
    const hit = this.cache.best(im, this.opt, this._desiredPx(rec));
    if (hit) {
      if (!hit.el.isConnected) this._attach(rec, hit.el, hit.px, false);
      else {
        // 同一张图正显示在别的块上（图少时会重复）：复制一份，数据在内存缓存里，解码很快
        const cp = new Image();
        cp.decoding = 'async';
        cp.src = hit.el.src;
        (cp.decode ? cp.decode() : Promise.resolve()).catch(() => {}).then(() => {
          if (rec.el._rec === rec && !rec.img) this._attach(rec, cp, hit.px, false);
        });
      }
    }
    this._want(rec);
    return rec;
  }

  _release(rec) {
    this.queue.delete(rec);
    if (this.hotEl === rec.el) this._hot(null);
    if (rec.loader) {
      rec.loader.onload = rec.loader.onerror = null;
      // 已经开始下载的不取消：多半马上就到，进 LRU 下次直接用；还没开始的才中止
      if (!rec.loader._started) rec.loader.src = '';
      rec.loader = null;
      this.active--;
    }
    for (const img of rec.el.querySelectorAll('img')) img.remove();
    rec.img = null;
    rec.el._rec = null;
    rec.el.remove();
    if (this.pool.length < POOL_MAX) this.pool.push(rec.el);
  }

  // ------------------------------------------------------------ 加载调度

  _desiredPx(rec) {
    const px = rec.short * this.cell * this.z * this.opt.dpr;
    let cap = this.opt.cap;
    // 弱网：先只要一档小图，停手后再按清晰度升级
    if (!this.net.fast && !rec.px) cap = Math.min(cap, 320);
    return snap(Math.min(cap, Math.max(120, px)));
  }

  _want(rec) {
    const px = this._desiredPx(rec);
    if (px > rec.px && px !== rec.want) {
      rec.want = px;
      this.queue.add(rec);
    }
  }

  _scheduleUpgrade() {
    clearTimeout(this.upgradeTimer);
    this.upgradeTimer = setTimeout(() => {
      for (const rec of this.tiles.values()) if (!rec.loader) this._want(rec);
      this._pump();
    }, this.net.fast ? 180 : 600);
  }

  _pump() {
    if (!this.queue.size || this.active >= this.maxLoads) return;
    const vw = this.stage.clientWidth, vh = this.stage.clientHeight;
    const cx = (vw / 2 - this.tx) / this.z, cy = (vh / 2 - this.ty) / this.z;
    // 往运动方向前瞻：正在滑向哪边，那边先加载
    const lx = cx - this.vx * 400 / this.z, ly = cy - this.vy * 400 / this.z;
    const moving = this.vx || this.vy || this.pointers.size || this.zAnchor;
    while (this.active < this.maxLoads && this.queue.size) {
      let best = null, bd = Infinity;
      for (const rec of this.queue) {
        // 首次加载远比升级清晰度要紧；在动的时候不升级
        if (rec.px && moving) continue;
        const d = ((rec.x + rec.w / 2 - lx) ** 2 + (rec.y + rec.h / 2 - ly) ** 2) * (rec.px ? 9 : 1);
        if (d < bd) { bd = d; best = rec; }
      }
      if (!best) return;
      this.queue.delete(best);
      this._load(best);
    }
  }

  _load(rec) {
    const px = rec.want;
    const im = rec.im;
    const opt = { q: this.opt.q, fmt: this.opt.fmt };
    const ld = new Image();
    ld.decoding = 'async';
    ld.draggable = false;
    ld.alt = '';
    rec.loader = ld;
    this.active++;
    const t0 = performance.now();
    const done = () => {
      if (rec.loader !== ld) return false; // 已被回收或换了新的请求
      rec.loader = null;
      this.active--;
      return true;
    };
    ld.onload = () => {
      this._netSample(performance.now() - t0, px);
      // decode() 在后台线程解码，解完再插进 DOM，滑动时不卡主线程
      (ld.decode ? ld.decode() : Promise.resolve()).catch(() => {}).then(() => {
        this.cache.put(im, px, opt, ld);
        if (!done()) return;
        this._attach(rec, ld, px, !rec.img && this.motion && !this._swap);
        if (this._swap) this._settleSwap();
        this._pump();
      });
    };
    ld.onerror = () => {
      if (!done()) return;
      if (!rec.img) rec.el.classList.add('err');
      rec.px = Math.max(rec.px, px); // 别反复重试同一档
      this._pump();
    };
    ld._started = true;
    ld.src = thumbUrl(im, px, this.opt);
  }

  /** 把一张已解码的图放进块。animate：首次出现时做入场；升级清晰度时新图盖在旧图上淡入。 */
  _attach(rec, img, px, animate) {
    const prev = rec.img;
    if (prev === img) return;
    img.className = '';
    if (animate) {
      img.classList.add('in');
      rec.el.insertBefore(img, rec.el._name);
      void img.offsetWidth; // 先让 .in 生效一次，过渡才有起点
      img.classList.replace('in', 'on');
    } else if (prev) {
      // 升级：新图在上层淡入，旧图在下面垫着；新图的过渡真正结束后才移除旧图。
      // 中途又来一次升级时，上一张「新图」也只是变成垫底的旧图，同样等最新那张淡入完才一起移除。
      img.classList.add('up');
      rec.el.insertBefore(img, rec.el._name);
      void img.offsetWidth;
      img.classList.add('on');
      const drop = () => {
        if (rec.img !== img) return;
        for (const o of rec.el.querySelectorAll('img')) if (o !== img) o.remove();
        img.classList.remove('up');
        img.classList.add('now');
      };
      img.addEventListener('transitionend', drop, { once: true });
      setTimeout(drop, 700); // 关了动效或标签页在后台时 transitionend 不来
    } else {
      img.classList.add('on', 'now');
      rec.el.insertBefore(img, rec.el._name);
    }
    rec.img = img;
    rec.px = Math.max(rec.px, px);
    rec.el.classList.add('loaded');
  }

  /** 按缩略图实际耗时判断网速：慢就少并发、先要小图。 */
  _netSample(ms, px) {
    const s = this.net.samples;
    s.push(ms / Math.max(1, (px / 320) ** 2));
    if (s.length > 12) s.shift();
    if (s.length < 4) return;
    const med = [...s].sort((a, b) => a - b)[s.length >> 1];
    const fast = med < 650;
    if (fast !== this.net.fast) {
      this.net.fast = fast;
      this.maxLoads = fast ? 8 : 4;
      this.hooks.onNet && this.hooks.onNet(fast);
    }
  }

  _hotAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    this._hot(hit && hit.closest('.tile'));
  }

  _hot(el) {
    if (el === this.hotEl) return;
    if (this.hotEl) this.hotEl.classList.remove('hot');
    this.hotEl = el;
    if (el) el.classList.add('hot');
  }

  // ------------------------------------------------------------ 输入

  _bindInput() {
    const st = this.stage;
    let drag = null, pinch = null, moved = 0, downT = 0;
    let samples = [];

    const sample = (x, y) => {
      const t = performance.now();
      samples.push({ x, y, t });
      while (samples.length > 2 && t - samples[0].t > 90) samples.shift();
    };

    st.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return;
      try { st.setPointerCapture(e.pointerId); } catch (_) { /* 某些浏览器对合成事件会抛 */ }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.vx = this.vy = 0;
      this.zAnchor = null; this.zTarget = this.z;
      this._touch();
      if (this.pointers.size === 1) {
        moved = 0; downT = performance.now();
        drag = { px: e.clientX, py: e.clientY, tx: this.tx, ty: this.ty };
        samples = [];
        sample(e.clientX, e.clientY);
      } else if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        pinch = {
          d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
          mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
          z0: this.z, tx0: this.tx, ty0: this.ty,
        };
        moved = 99; // 双指不算点击
      }
    });

    st.addEventListener('pointermove', (e) => {
      if (!this.pointers.has(e.pointerId)) {
        // 鼠标悬停：只给指针下那一块加 .hot
        if (e.pointerType === 'mouse' && !this.vx && !this.vy) this._hotAt(e.clientX, e.clientY);
        return;
      }
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this._touch();
      if (this.pointers.size >= 2 && pinch) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const z = clamp(pinch.z0 * (d / pinch.d), ZMIN, ZMAX);
        const k = z / pinch.z0;
        this.z = this.zTarget = z;
        this.tx = mx - (pinch.mx - pinch.tx0) * k;
        this.ty = my - (pinch.my - pinch.ty0) * k;
        this.invalidate();
        return;
      }
      if (drag && this.pointers.size === 1) {
        const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
        moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
        if (moved >= 8 && !this.dragging) {
          this.dragging = true;
          st.classList.add('dragging');
          this._hot(null);
        }
        if (moved >= 8) this.hooks.onInteract && this.hooks.onInteract();
        this.tx = drag.tx + dx;
        this.ty = drag.ty + dy;
        sample(e.clientX, e.clientY);
        this.invalidate();
      }
    });

    const end = (e) => {
      if (!this.pointers.has(e.pointerId)) return;
      const single = this.pointers.size === 1;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 0) {
        if (this.dragging) { this.dragging = false; st.classList.remove('dragging'); }
        drag = null; pinch = null;
        if (single && moved < 8 && e.type === 'pointerup' && performance.now() - downT < 600) {
          // setPointerCapture 后 click 的 target 是 stage，必须按坐标找块
          const hit = document.elementFromPoint(e.clientX, e.clientY);
          const el = hit && hit.closest('.tile');
          if (el && el._rec && this.hooks.onOpen) this.hooks.onOpen(el._rec);
        } else if (single && samples.length >= 2) {
          sample(e.clientX, e.clientY);
          const a = samples[0], b = samples[samples.length - 1];
          const dt = b.t - a.t;
          if (dt > 0 && performance.now() - b.t < 60) {
            const max = 4.5;
            this.vx = this.motion ? clamp((b.x - a.x) / dt, -max, max) : 0;
            this.vy = this.motion ? clamp((b.y - a.y) / dt, -max, max) : 0;
            if (Math.abs(this.vx) < 0.05 && Math.abs(this.vy) < 0.05) this.vx = this.vy = 0;
          }
          if (!this.vx && !this.vy) this._scheduleUpgrade();
        } else {
          this._scheduleUpgrade();
        }
        this._touch();
        this.kick();
      } else if (this.pointers.size === 1) {
        const p = [...this.pointers.values()][0];
        drag = { px: p.x, py: p.y, tx: this.tx, ty: this.ty };
        samples = [];
        pinch = null;
      }
    };
    st.addEventListener('pointerleave', () => this._hot(null));
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);

    st.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._touch();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? st.clientHeight : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        this.zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0022));
      } else {
        this.vx = this.vy = 0;
        if (e.shiftKey && !dx) this.tx -= dy;
        else { this.tx -= dx; this.ty -= dy; }
        this.hooks.onInteract && this.hooks.onInteract();
        this.invalidate();
        this._scheduleUpgrade();
      }
    }, { passive: false });
  }
}
