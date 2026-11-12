// 大图：从格子位置飞出来（FLIP），左右切换，滚轮 / 双击 / 双指缩放，拖动平移，下滑关闭。

import { $, clamp, esc, fmtBytes, fmtDate, showLayer, reducedMotion } from './util.js';
import { previewUrl, rawUrl } from './api.js';

const ZMAX = 8;

export class Lightbox {
  constructor({ getList, getOpt, rectFor, onClose }) {
    this.getList = getList;
    this.getOpt = getOpt;
    this.rectFor = rectFor;
    this.onClose = onClose;
    this.root = $('lightbox');
    this.stage = $('lbStage');
    this.img = $('lbImg');
    this.idx = -1;
    this.openTs = 0;
    this.z = 1; this.x = 0; this.y = 0;
    this.loadToken = 0;
    this._bind();
  }

  get isOpen() { return !this.root.hidden && this.root.classList.contains('open'); }

  previewWidth() {
    const d = Math.max(innerWidth, innerHeight) * Math.min(2, devicePixelRatio || 1);
    return d > 1600 ? 2400 : 1600;
  }

  /** rec 可选：有就从那个格子飞出来。 */
  open(im, rec) {
    const list = this.getList();
    this.idx = list.indexOf(im);
    if (this.idx < 0) return;
    this.openTs = performance.now();
    showLayer(this.root, true);
    document.body.classList.add('lb-on');
    this._show(im, rec);
  }

  close() {
    if (this.root.hidden) return;
    const im = this.getList()[this.idx];
    const to = im && this.rectFor(im);
    this.loadToken++;
    if (to && !reducedMotion() && this.z === 1) {
      // 飞回格子
      const from = this.img.getBoundingClientRect();
      if (from.width) this._flip(this.img, from, to, true);
    }
    showLayer(this.root, false);
    document.body.classList.remove('lb-on');
    this.onClose && this.onClose(im);
  }

  step(d) {
    const list = this.getList();
    if (!list.length) return;
    this.idx = (this.idx + d + list.length) % list.length;
    this._show(list[this.idx], null, d);
  }

  // ------------------------------------------------------------

  _show(im, rec, dir = 0) {
    const opt = this.getOpt();
    const token = ++this.loadToken;
    this._resetZoom(false);
    this._meta(im);

    const thumb = rec && rec.img && rec.img.complete ? rec.img.src : '';
    const url = previewUrl(im, this.previewWidth(), { q: Math.max(85, opt.q), fmt: opt.fmt });
    const img = this.img;
    img.classList.remove('ready', 'from-l', 'from-r');
    this.root.classList.add('loading');

    // 先放格子里那张缩略图（已在缓存里），大图到了再换，切换不会闪黑
    if (thumb) {
      img.src = thumb;
      img.classList.add('ready');
      if (rec && !reducedMotion()) {
        requestAnimationFrame(() => {
          const to = img.getBoundingClientRect();
          if (to.width) this._flip(img, this.rectFor(im) || rec.el.getBoundingClientRect(), to, false);
        });
      }
    } else {
      img.removeAttribute('src');
      if (dir) img.classList.add(dir > 0 ? 'from-r' : 'from-l');
    }

    const full = new Image();
    full.decoding = 'async';
    full.onload = () => {
      (full.decode ? full.decode() : Promise.resolve()).catch(() => {}).then(() => {
        if (token !== this.loadToken) return;
        img.src = url;
        img.classList.remove('from-l', 'from-r');
        img.classList.add('ready');
        this.root.classList.remove('loading');
      });
    };
    full.onerror = () => {
      if (token !== this.loadToken) return;
      this.root.classList.remove('loading');
      if (!thumb) $('lbErr').hidden = false;
    };
    $('lbErr').hidden = true;
    full.src = url;

    // 预取左右两张
    const list = this.getList();
    for (const d of [1, -1]) {
      const n = list[(this.idx + d + list.length) % list.length];
      if (n && n !== im) new Image().src = previewUrl(n, this.previewWidth(), { q: Math.max(85, opt.q), fmt: opt.fmt });
    }
  }

  _meta(im) {
    const list = this.getList();
    $('lbName').textContent = im.n;
    $('lbName').title = im.p;
    $('lbInfo').innerHTML =
      `<span>${esc(im.d || '')}</span><span>${fmtDate(im.t)}</span><span>${fmtBytes(im.s)}</span>` +
      `<span class="mono">${this.idx + 1} / ${list.length}</span>`;
    $('lbRaw').href = rawUrl(im);
  }

  _flip(el, from, to, back) {
    const sx = from.width / to.width, sy = from.height / to.height;
    const s = Math.max(sx, sy);
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    if (!back) {
      el.animate(
        [
          { transform: `translate(${dx}px,${dy}px) scale(${s})`, borderRadius: '10px' },
          { transform: 'none', borderRadius: '6px' },
        ],
        { duration: 380, easing: 'cubic-bezier(.2,.9,.25,1)' },
      );
    } else {
      // 关闭时 to 是格子、from 是大图
      const k = Math.max(to.width / from.width, to.height / from.height);
      const ex = to.left + to.width / 2 - (from.left + from.width / 2);
      const ey = to.top + to.height / 2 - (from.top + from.height / 2);
      el.animate(
        [{ transform: this._tf() }, { transform: `translate(${ex}px,${ey}px) scale(${k})`, opacity: 0.4 }],
        { duration: 260, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' },
      ).onfinish = (e) => e.target.cancel();
    }
  }

  // ------------------------------------------------------------ 缩放平移

  _tf() { return `translate(${this.x}px,${this.y}px) scale(${this.z})`; }

  _apply(anim) {
    this.img.style.transition = anim && !reducedMotion() ? 'transform .28s cubic-bezier(.2,.9,.25,1)' : 'none';
    this.img.style.transform = this._tf();
    this.root.classList.toggle('zoomed', this.z > 1.01);
  }

  _resetZoom(anim) { this.z = 1; this.x = 0; this.y = 0; this._apply(anim); }

  _zoomTo(z, cx, cy, anim) {
    const r = this.stage.getBoundingClientRect();
    const ox = cx - (r.left + r.width / 2), oy = cy - (r.top + r.height / 2);
    z = clamp(z, 1, ZMAX);
    const k = z / this.z;
    this.x = ox - (ox - this.x) * k;
    this.y = oy - (oy - this.y) * k;
    this.z = z;
    if (z === 1) { this.x = 0; this.y = 0; }
    this._clampPan();
    this._apply(anim);
  }

  _clampPan() {
    const iw = this.img.offsetWidth * this.z, ih = this.img.offsetHeight * this.z;
    const mx = Math.max(0, (iw - this.stage.clientWidth) / 2);
    const my = Math.max(0, (ih - this.stage.clientHeight) / 2);
    this.x = clamp(this.x, -mx, mx);
    this.y = clamp(this.y, -my, my);
  }

  // ------------------------------------------------------------ 事件

  _bind() {
    const root = this.root, st = this.stage;
    root.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return this.close();
      if (e.target.closest('#lbPrev')) return this.step(-1);
      if (e.target.closest('#lbNext')) return this.step(1);
    });

    st.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
      this._zoomTo(this.z * f, e.clientX, e.clientY, false);
    }, { passive: false });

    const ptrs = new Map();
    let drag = null, pinch = null, moved = 0, lastTap = 0;

    st.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      try { st.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1) {
        moved = 0;
        drag = { sx: e.clientX, sy: e.clientY, x: this.x, y: this.y, t: performance.now() };
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: this.z };
        drag = null; moved = 99;
      }
    });

    st.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && ptrs.size >= 2) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this._zoomTo(pinch.z * (d / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2, false);
        return;
      }
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      if (this.z > 1.01) {
        this.x = drag.x + dx; this.y = drag.y + dy;
        this._clampPan();
        this._apply(false);
      } else {
        // 没放大时：横向拖 = 翻页预览，纵向拖 = 下拉关闭
        const fade = Math.abs(dy) > Math.abs(dx) ? clamp(1 - Math.abs(dy) / 500, 0.3, 1) : 1;
        this.img.style.transition = 'none';
        this.img.style.transform = `translate(${dx}px,${dy}px) scale(${1 - (1 - fade) * 0.3})`;
        root.style.setProperty('--lb-bg', String(fade));
      }
    });

    const end = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size) { pinch = null; return; }
      pinch = null;
      root.style.removeProperty('--lb-bg');
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      const dt = performance.now() - drag.t;
      drag = null;
      if (performance.now() - this.openTs < 400) return; // 同一次点击别把刚开的图关掉
      if (moved < 8) {
        const now = performance.now();
        if (now - lastTap < 300) {
          lastTap = 0;
          this._zoomTo(this.z > 1.01 ? 1 : 2.5, e.clientX, e.clientY, true);
          return;
        }
        lastTap = now;
        // 单击背景关闭（点在图上不关，留给双击）
        const onImg = e.target === this.img || document.elementFromPoint(e.clientX, e.clientY) === this.img;
        if (!onImg && this.z <= 1.01) setTimeout(() => { if (lastTap === now) this.close(); }, 300);
        return;
      }
      if (this.z > 1.01) return;
      const fast = dt < 300;
      if (Math.abs(dy) > Math.abs(dx) && (dy > 140 || (fast && dy > 60))) return this.close();
      if (Math.abs(dx) > 90 || (fast && Math.abs(dx) > 40)) return this.step(dx < 0 ? 1 : -1);
      this._resetZoom(true);
    };
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);

    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); this.step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); this.step(-1); }
      else if (e.key === '+' || e.key === '=') this._zoomTo(this.z * 1.4, innerWidth / 2, innerHeight / 2, true);
      else if (e.key === '-') this._zoomTo(this.z / 1.4, innerWidth / 2, innerHeight / 2, true);
      else if (e.key === '0') this._resetZoom(true);
      else return;
      e.stopImmediatePropagation();
    }, true);
  }
}
