// 无限画布：视口裁剪、块复用、按距离排队加载、惯性 / 平滑缩放 / 漫游。
//
// 坐标：屏幕 = 世界 × z + (tx, ty)。布局与选图全部来自 layout.js 的纯函数，
// 这里只负责「现在屏幕上该有哪些块」和「先加载哪张」。

import { BS, memoTiling, pickIndex, strideFor, hash2 } from './layout.js';
import { clamp } from './util.js';
import { thumbUrl } from './api.js';

export const ZMIN = 0.3;
export const ZMAX = 2.4;

const BUCKETS = [160, 240, 320, 480, 640, 800, 1200, 1600, 2400];
const snap = (px) => BUCKETS.find((b) => b >= px) || BUCKETS[BUCKETS.length - 1];

const MAX_LOADS = 8;        // 同时在途的缩略图请求
const POOL_MAX = 240;       // 复用的块元素上限
const FRICTION_MS = 320;    // 惯性衰减时间常数（越大滑得越远）
const ZOOM_SMOOTH_MS = 70;  // 平滑缩放的追随时间常数

export class Wall {
  constructor(stage, plane, hooks = {}) {
    this.stage = stage;
    this.plane = plane;
    this.hooks = hooks;

    this.tx = 0; this.ty = 0; this.z = 1;
    this.zTarget = 1; this.zAnchor = null;
    this.cell = 280; this.gap = 4; this.seed = 0;
    this.images = []; this.stride = 1;
    this.opt = { q: 78, fmt: 'jpeg', cap: 640, dpr: 1 };
    this.motion = true;

    this.tiling = memoTiling();
    this.tiles = new Map();   // key → rec
    this.pool = [];
    this.gen = 0;

    this.queue = new Set();   // 等待加载的 rec
    this.active = 0;

    this.vx = 0; this.vy = 0; // 惯性速度（屏幕 px / ms）
    this.drift = false; this.driftPause = 0;
    this.lastInteract = 0;
    this.raf = 0; this.lastT = 0; this.dirty = true;
    this.upgradeTimer = 0;

    this.pointers = new Map();
    this._bindInput();
    window.addEventListener('resize', () => this.invalidate());
  }

  // ------------------------------------------------------------ 公共接口

  setImages(images, seed = 0) {
    this.images = images;
    this.stride = strideFor(images.length);
    this.seed = seed;
    this.clear();
    this.invalidate();
  }

  setSeed(seed) {
    this.seed = seed;
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
    const changed = o.q !== this.opt.q || o.fmt !== this.opt.fmt || o.cap !== this.opt.cap;
    Object.assign(this.opt, o);
    if (changed) { this.clear(); this.invalidate(); }
  }

  setMotion(on) { this.motion = on; }

  setDrift(on) {
    this.drift = on;
    this.driftPause = 0;
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

  /** 以屏幕点 (px, py) 为锚缩放。smooth=true 时平滑追随（按钮 / 键盘 / 鼠标滚轮）。 */
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
      // 惯性滑行总距离 = v × τ
      this.vx += dx / FRICTION_MS;
      this.vy += dy / FRICTION_MS;
    } else {
      this.tx += dx; this.ty += dy;
    }
    this.kick();
  }

  invalidate() { this.dirty = true; this.kick(); }

  clear() {
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

  stats() {
    let loaded = 0;
    for (const r of this.tiles.values()) if (r.img) loaded++;
    return { tiles: this.tiles.size, loaded, queued: this.queue.size, active: this.active, pool: this.pool.length };
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

    // 平滑缩放
    if (this.zAnchor && Math.abs(this.zTarget - this.z) > 1e-4) {
      const k = 1 - Math.exp(-dt / ZOOM_SMOOTH_MS);
      this._applyZoom(this.z + (this.zTarget - this.z) * k);
      busy = true;
    } else if (this.zAnchor) {
      this._applyZoom(this.zTarget);
      this.zAnchor = null;
      this._scheduleUpgrade();
    }

    // 惯性
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

  _touch() {
    this.lastInteract = performance.now();
  }

  // ------------------------------------------------------------ 渲染

  _render() {
    const n = this.images.length;
    if (!n) { if (this.tiles.size) this.clear(); return; }
    const C = this.cell, G = this.gap, z = this.z;
    const vw = this.stage.clientWidth, vh = this.stage.clientHeight;
    const pad = C * 0.6; // 视口外多留一圈，拖动时边缘不露底
    const x0 = -this.tx / z - pad, y0 = -this.ty / z - pad;
    const x1 = (vw - this.tx) / z + pad, y1 = (vh - this.ty) / z + pad;
    const bw = BS * C;
    const bx0 = Math.floor(x0 / bw), bx1 = Math.floor(x1 / bw);
    const by0 = Math.floor(y0 / bw), by1 = Math.floor(y1 / bw);
    if ((bx1 - bx0 + 1) * (by1 - by0 + 1) > 900) return; // 防御：理论上 ZMIN 下到不了
    const gen = ++this.gen;
    const frag = document.createDocumentFragment();

    for (let by = by0; by <= by1; by++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const lay = this.tiling(bx, by, this.seed);
        for (let k = 0; k < lay.length; k++) {
          const t = lay[k];
          const x = (bx * BS + t.x) * C, y = (by * BS + t.y) * C;
          const w = t.w * C, h = t.h * C;
          if (x > x1 || y > y1 || x + w < x0 || y + h < y0) continue;
          const key = bx + ',' + by + ',' + t.i;
          let rec = this.tiles.get(key);
          if (!rec) {
            rec = this._create(bx, by, t, x + G / 2, y + G / 2, w - G, h - G);
            this.tiles.set(key, rec);
            frag.appendChild(rec.el);
          }
          rec.gen = gen;
        }
      }
    }
    if (frag.childNodes.length) this.plane.appendChild(frag);

    for (const [key, rec] of this.tiles) {
      if (rec.gen !== gen) {
        this.tiles.delete(key);
        this._release(rec);
      }
    }
  }

  _create(bx, by, t, x, y, w, h) {
    const im = this.images[pickIndex(bx, by, t.i, this.images.length, this.stride, this.seed)];
    let el = this.pool.pop();
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile';
      const name = document.createElement('span');
      name.className = 'name';
      el.appendChild(name);
    }
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    const hh = hash2(bx * 31 + t.i, by * 17 - t.i);
    // 占位底色：按位置取一个很暗的色相，加载前不是一片死灰
    el.style.setProperty('--ph', String(hh % 360));
    el.style.setProperty('--d', ((hh >>> 9) % 140) + 'ms');
    el.firstChild.textContent = im.n;
    el.classList.remove('err');
    const rec = { el, im, x, y, w, h, short: Math.min(t.w, t.h), img: null, px: 0, want: 0, loader: null, gen: 0 };
    el._rec = rec;
    this._want(rec);
    return rec;
  }

  _release(rec) {
    this.queue.delete(rec);
    if (rec.loader) {
      rec.loader.src = '';
      rec.loader = null;
      this.active--;
    }
    if (rec.img) { rec.img.remove(); rec.img = null; }
    rec.el._rec = null;
    rec.el.remove();
    if (this.pool.length < POOL_MAX) this.pool.push(rec.el);
  }

  // ------------------------------------------------------------ 加载调度

  _desiredPx(rec) {
    const px = rec.short * this.cell * this.z * this.opt.dpr;
    return snap(Math.min(this.opt.cap, Math.max(120, px)));
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
    }, 180);
  }

  _pump() {
    if (!this.queue.size || this.active >= MAX_LOADS) return;
    const vw = this.stage.clientWidth, vh = this.stage.clientHeight;
    const cx = (vw / 2 - this.tx) / this.z, cy = (vh / 2 - this.ty) / this.z;
    // 往运动方向前瞻：正在滑向哪边，那边先加载
    const lx = cx - this.vx * 400 / this.z, ly = cy - this.vy * 400 / this.z;
    while (this.active < MAX_LOADS && this.queue.size) {
      let best = null, bd = Infinity;
      for (const rec of this.queue) {
        // 首次加载远比升级清晰度要紧
        const d = ((rec.x + rec.w / 2 - lx) ** 2 + (rec.y + rec.h / 2 - ly) ** 2) * (rec.px ? 9 : 1);
        if (d < bd) { bd = d; best = rec; }
      }
      this.queue.delete(best);
      this._load(best);
    }
  }

  _load(rec) {
    const px = rec.want;
    if (rec.loader) { rec.loader.src = ''; rec.loader = null; this.active--; }
    const ld = new Image();
    ld.decoding = 'async';
    ld.draggable = false;
    ld.alt = '';
    rec.loader = ld;
    this.active++;
    const done = () => {
      if (rec.loader !== ld) return false; // 已被回收或换了新的请求
      rec.loader = null;
      this.active--;
      return true;
    };
    ld.onload = () => {
      // decode() 在后台线程解码，解完再插进 DOM，滑动时不卡主线程
      const dec = ld.decode ? ld.decode() : Promise.resolve();
      dec.catch(() => {}).then(() => {
        if (!done()) return;
        const first = !rec.img;
        if (first) ld.className = 'in';
        else ld.className = 'on';
        rec.el.insertBefore(ld, rec.el.firstChild);
        if (rec.img) rec.img.remove();
        rec.img = ld;
        rec.px = px;
        if (first) {
          if (this.motion) void ld.offsetWidth; // 先让 .in 生效一次，过渡才有起点
          ld.className = 'on';
        }
        this._pump();
      });
    };
    ld.onerror = () => {
      if (!done()) return;
      if (!rec.img) rec.el.classList.add('err');
      rec.px = Math.max(rec.px, px); // 别反复重试同一档
      this._pump();
    };
    ld.src = thumbUrl(rec.im, px, this.opt);
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
      if (!this.pointers.has(e.pointerId)) return;
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
        if (moved >= 8) {
          st.classList.add('dragging');
          this.hooks.onInteract && this.hooks.onInteract();
        }
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
        st.classList.remove('dragging');
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
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);

    st.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._touch();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? st.clientHeight : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if (e.ctrlKey || e.metaKey) {
        // 触控板捏合是一串很小的 delta，鼠标滚轮是一格 100 左右；两种都走平滑追随
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
