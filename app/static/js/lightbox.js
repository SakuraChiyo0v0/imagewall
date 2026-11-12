// 大图：画布退到背后、图从格子飞出；左右两张预览露在两侧；背景是当前图的氛围光；
// 底部胶片条；幻灯片播放带缓慢推镜（Ken Burns）。
//
// 位置用一个无界整数 pos 记，图片下标 = pos mod n。左右切换、胶片条、循环都按 pos 算，
// 图少时绕回开头也不会错位。

import { $, clamp, esc, fmtBytes, fmtDate, showLayer, reducedMotion } from './util.js';
import { previewUrl, rawUrl, thumbUrl } from './api.js';

const ZMAX = 8;
const SPAN = 2;        // 当前图左右各保留几张 slide
const STRIP = 12;      // 胶片条左右各几张
const STRIP_W = 62;    // 胶片条每格宽（含间距）
const PLAY_MS = 5000;

const mod = (a, n) => ((a % n) + n) % n;

export class Lightbox {
  constructor({ getList, getOpt, rectFor, thumbFor, onOpen, onClose }) {
    this.getList = getList;
    this.getOpt = getOpt;
    this.rectFor = rectFor;
    this.thumbFor = thumbFor;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.root = $('lightbox');
    this.stage = $('lbStage');
    this.track = $('lbTrack');
    this.strip = $('lbStripIn');
    this.amb = [$('lbAmbA'), $('lbAmbB')];
    this.ambI = 0;
    this.pos = 0;
    this.slides = new Map();  // pos → { el, img, im, token }
    this.thumbs = new Map();  // pos → el
    this.openTs = 0;
    this.z = 1; this.x = 0; this.y = 0;
    this.playing = false; this.playT = 0;
    this._bind();
  }

  get isOpen() { return !this.root.hidden && this.root.classList.contains('open'); }
  get img() { const s = this.slides.get(this.pos); return s && s.img; }
  get cur() { const l = this.getList(); return l.length ? l[mod(this.pos, l.length)] : null; }

  previewWidth() {
    const d = Math.max(innerWidth, innerHeight) * Math.min(2, devicePixelRatio || 1);
    if (!this.getOpt().fast) return 1200;
    return d > 1600 ? 2400 : 1600;
  }

  /** rec 可选：有就从那个格子飞出来。 */
  open(im, rec) {
    const list = this.getList();
    const idx = list.indexOf(im);
    if (idx < 0) return;
    this._clearSlides();
    this.pos = idx;
    this.openTs = performance.now();
    showLayer(this.root, true);
    document.body.classList.add('lb-on');
    this.onOpen && this.onOpen();
    this._sync(0, true);
    // 飞出：从格子的位置 / 大小变形到大图的位置
    const s = this.slides.get(this.pos);
    if (rec && s && !reducedMotion()) {
      const from = this.rectFor(im);
      requestAnimationFrame(() => {
        const to = s.img.getBoundingClientRect();
        if (from && to.width) this._flip(s.img, from, to);
      });
    }
  }

  close() {
    if (this.root.hidden) return;
    this.stop();
    const im = this.cur;
    const img = this.img;
    const to = im && this.rectFor(im);
    if (img && to && !reducedMotion() && this.z <= 1.01) {
      const from = img.getBoundingClientRect();
      if (from.width) this._flipBack(img, from, to);
    }
    showLayer(this.root, false);
    document.body.classList.remove('lb-on');
    this.onClose && this.onClose(im);
  }

  step(d) {
    if (!d || !this.getList().length) return;
    this._resetZoom(false);
    this.pos += d;
    this._sync(d, false);
    if (this.playing) this._restartPlay();
  }

  toggle() { this.playing ? this.stop() : this.play(); }

  play() {
    if (this.playing || !this.getList().length) return;
    this.playing = true;
    this.root.classList.add('playing');
    $('lbPlay').setAttribute('aria-pressed', 'true');
    this._restartPlay();
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearTimeout(this.playT);
    this.root.classList.remove('playing');
    $('lbPlay').setAttribute('aria-pressed', 'false');
    const s = this.slides.get(this.pos);
    if (s) s.img.classList.remove('kb');
  }

  _restartPlay() {
    clearTimeout(this.playT);
    const bar = $('lbProg');
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = `lb-prog ${PLAY_MS}ms linear both`;
    const s = this.slides.get(this.pos);
    if (s && !reducedMotion()) {
      s.img.classList.remove('kb');
      void s.img.offsetWidth;
      s.img.style.setProperty('--kb-x', (((this.pos * 37) % 7) - 3) + '%');
      s.img.style.setProperty('--kb-y', (((this.pos * 53) % 5) - 2) + '%');
      s.img.classList.add('kb');
    }
    this.playT = setTimeout(() => this.step(1), PLAY_MS);
  }

  // ------------------------------------------------------------ slides

  _clearSlides() {
    for (const s of this.slides.values()) s.el.remove();
    this.slides.clear();
    for (const el of this.thumbs.values()) el.remove();
    this.thumbs.clear();
  }

  /** 让 [pos-SPAN, pos+SPAN] 的 slide 都在，并摆到各自位置。d = 刚才走的方向（新 slide 从那边进来）。 */
  _sync(d, first, carry = 0) {
    const list = this.getList();
    const n = list.length;
    const span = Math.min(SPAN, Math.floor((n - 1) / 2));
    for (const [p, s] of this.slides) {
      if (Math.abs(p - this.pos) > span) {
        s.el.classList.add('gone');
        s.el.style.transform = this._slideTf(p - this.pos);
        setTimeout(() => s.el.remove(), 500);
        this.slides.delete(p);
      }
    }
    for (let o = -span; o <= span; o++) {
      const p = this.pos + o;
      if (this.slides.has(p)) continue;
      const s = this._makeSlide(p, list[mod(p, n)]);
      // 新进来的从更远处滑进来
      s.el.style.transition = 'none';
      s.el.style.transform = this._slideTf(first ? o : o + Math.sign(d || o || 1));
      s.el.style.opacity = '0';
      this.track.appendChild(s.el);
      this.slides.set(p, s);
    }
    if (carry) {
      // 手势切换：每张先放到「上一刻」在屏幕上的位置（旧下标 + 手指偏移）
      for (const [p, s] of this.slides) {
        if (s.el.style.opacity === '0') continue;
        s.el.style.transition = 'none';
        s.el.style.transform = this._slideTf(p - this.pos + d, carry);
      }
    }
    void this.track.offsetWidth;
    for (const [p, s] of this.slides) {
      const o = p - this.pos;
      s.el.style.transition = '';
      s.el.style.opacity = '';
      s.el.style.transform = this._slideTf(o);
      s.el.classList.toggle('cur', o === 0);
      s.el.classList.toggle('side', o !== 0);
      // 当前与左右各一张要清晰版，更远的只放缩略图
      if (Math.abs(o) <= 1) this._loadFull(s);
    }
    this._meta();
    this._ambient();
    this._strip(first);
  }

  _slideTf(o, extra = 0) {
    const w = this.stage.clientWidth;
    const gap = w < 700 ? w * 0.96 : Math.min(w * 0.58, 980);
    const a = Math.abs(o);
    const s = a === 0 ? 1 : a === 1 ? 0.66 : 0.5;
    const x = o * gap + Math.sign(o) * Math.max(0, a - 1) * gap * 0.25 + extra;
    return `translate3d(${x}px,0,0) scale(${s})`;
  }

  _makeSlide(p, im) {
    const el = document.createElement('div');
    el.className = 'lb-slide';
    const img = new Image();
    img.decoding = 'async';
    img.draggable = false;
    img.alt = '';
    const th = this.thumbFor(im);
    if (th) img.src = th;
    img.onload = () => img.classList.add('ready');
    el.appendChild(img);
    el.dataset.p = p;
    return { el, img, im, p, full: false };
  }

  _loadFull(s) {
    if (s.full) return;
    s.full = true;
    const opt = this.getOpt();
    const url = previewUrl(s.im, this.previewWidth(), { q: Math.max(85, opt.q), fmt: opt.fmt });
    const isCur = () => s.p === this.pos;
    if (isCur()) this.root.classList.add('loading');
    const full = new Image();
    full.decoding = 'async';
    full.onload = () => {
      (full.decode ? full.decode() : Promise.resolve()).catch(() => {}).then(() => {
        if (!s.el.isConnected) return;
        s.img.src = url;
        s.img.classList.add('ready', 'sharp');
        if (isCur()) this.root.classList.remove('loading');
      });
    };
    full.onerror = () => {
      if (isCur()) {
        this.root.classList.remove('loading');
        if (!s.img.complete || !s.img.naturalWidth) $('lbErr').hidden = false;
      }
    };
    full.src = url;
  }

  _meta() {
    const im = this.cur;
    if (!im) return;
    const n = this.getList().length;
    $('lbErr').hidden = true;
    const s = this.slides.get(this.pos);
    this.root.classList.toggle('loading', !!(s && !s.img.classList.contains('sharp')));
    $('lbName').textContent = im.n;
    $('lbName').title = im.p;
    $('lbInfo').innerHTML =
      `<span>${esc(im.d || '')}</span><span>${fmtDate(im.t)}</span><span>${fmtBytes(im.s)}</span>`;
    $('lbCount').textContent = `${mod(this.pos, n) + 1} / ${n}`;
    $('lbRaw').href = rawUrl(im);
  }

  /** 背景氛围光：当前图的超大模糊版，两层交替淡入淡出。 */
  _ambient() {
    const im = this.cur;
    if (!im) return;
    const url = this.thumbFor(im) || thumbUrl(im, 160, this.getOpt());
    const next = this.amb[1 - this.ambI];
    const cur = this.amb[this.ambI];
    const probe = new Image();
    probe.onload = () => {
      next.style.backgroundImage = `url("${url}")`;
      next.classList.add('on');
      cur.classList.remove('on');
      this.ambI = 1 - this.ambI;
    };
    probe.src = url;
  }

  _strip(first) {
    const list = this.getList();
    const n = list.length;
    const span = Math.min(STRIP, Math.floor((n - 1) / 2));
    const opt = this.getOpt();
    for (const [p, el] of this.thumbs) {
      if (Math.abs(p - this.pos) > span + 1) { el.remove(); this.thumbs.delete(p); }
    }
    for (let o = -span - 1; o <= span + 1; o++) {
      const p = this.pos + o;
      let el = this.thumbs.get(p);
      if (!el) {
        const im = list[mod(p, n)];
        el = document.createElement('button');
        el.className = 'lb-th';
        el.dataset.p = p;
        const img = new Image();
        img.decoding = 'async';
        img.alt = '';
        img.loading = 'lazy';
        img.src = this.thumbFor(im) || thumbUrl(im, 160, opt);
        el.appendChild(img);
        if (!first) { el.style.transition = 'none'; el.style.transform = `translateX(${o * STRIP_W}px)`; }
        this.strip.appendChild(el);
        this.thumbs.set(p, el);
      }
    }
    void this.strip.offsetWidth;
    for (const [p, el] of this.thumbs) {
      const o = p - this.pos;
      el.style.transition = '';
      el.style.transform = `translateX(${o * STRIP_W}px) scale(${o ? 1 : 1.18})`;
      el.classList.toggle('on', o === 0);
      el.style.opacity = Math.abs(o) > span ? '0' : String(Math.max(0.25, 1 - Math.abs(o) * 0.07));
    }
  }

  // ------------------------------------------------------------ 飞入飞出

  _flip(el, from, to) {
    const s = Math.max(from.width / to.width, from.height / to.height);
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    el.animate(
      [
        { transform: `translate(${dx}px,${dy}px) scale(${s})`, borderRadius: '10px', filter: 'brightness(1.15)' },
        { transform: 'none', borderRadius: '8px', filter: 'none' },
      ],
      { duration: 460, easing: 'cubic-bezier(.2,.9,.2,1)' },
    );
  }

  _flipBack(el, from, to) {
    const k = Math.max(to.width / from.width, to.height / from.height);
    const ex = to.left + to.width / 2 - (from.left + from.width / 2);
    const ey = to.top + to.height / 2 - (from.top + from.height / 2);
    el.animate(
      [{ transform: 'none', opacity: 1 }, { transform: `translate(${ex}px,${ey}px) scale(${k})`, opacity: 0.6 }],
      { duration: 300, easing: 'cubic-bezier(.4,0,.6,1)', fill: 'forwards' },
    ).onfinish = (e) => e.target.cancel();
  }

  // ------------------------------------------------------------ 缩放平移

  _tf() { return `translate(${this.x}px,${this.y}px) scale(${this.z})`; }

  _apply(anim) {
    const img = this.img;
    if (!img) return;
    img.style.transition = anim && !reducedMotion() ? 'transform .3s cubic-bezier(.2,.9,.25,1)' : 'none';
    img.style.transform = this.z === 1 && !this.x && !this.y ? '' : this._tf();
    this.root.classList.toggle('zoomed', this.z > 1.01);
  }

  _resetZoom(anim) { this.z = 1; this.x = 0; this.y = 0; this._apply(anim); }

  _zoomTo(z, cx, cy, anim) {
    if (!this.img) return;
    this.stop();
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
    const img = this.img;
    const iw = img.offsetWidth * this.z, ih = img.offsetHeight * this.z;
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
      if (e.target.closest('#lbPlay')) return this.toggle();
      const th = e.target.closest('.lb-th');
      if (th) return this.step(+th.dataset.p - this.pos);
    });

    $('lbStrip').addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(d) > 4) this.step(d > 0 ? 1 : -1);
    }, { passive: false });

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
        drag = { sx: e.clientX, sy: e.clientY, x: this.x, y: this.y, t: performance.now(), axis: '' };
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: this.z };
        drag = null; moved = 99;
        this._trackTo(0, false);
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
        return;
      }
      if (!drag.axis && moved > 8) drag.axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (drag.axis === 'x') {
        // 横向拖：整条 slide 跟手，两侧预览一起动
        this.stop();
        this._trackTo(dx, false);
      } else if (drag.axis === 'y') {
        const fade = clamp(1 - Math.abs(dy) / 450, 0.2, 1);
        const img = this.img;
        img.style.transition = 'none';
        img.style.transform = `translate(${dx * 0.4}px,${dy}px) scale(${1 - (1 - fade) * 0.35})`;
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
      const axis = drag.axis;
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
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const side = hit && hit.closest('.lb-slide.side');
        if (side) { lastTap = 0; return this.step(+side.dataset.p - this.pos); }
        // 单击空白处关闭（点在图上不关，留给双击）
        if (hit !== this.img && this.z <= 1.01) setTimeout(() => { if (lastTap === now) this.close(); }, 300);
        return;
      }
      if (this.z > 1.01) return;
      const fast = dt < 300;
      if (axis === 'y') {
        if (Math.abs(dy) > 140 || (fast && Math.abs(dy) > 60)) return this.close();
        return this._resetZoom(true);
      }
      if (axis === 'x') {
        const go = Math.abs(dx) > 90 || (fast && Math.abs(dx) > 40);
        if (go) {
          // 轨道瞬间归零、slide 瞬间挪到「换位后但带着手指偏移」的位置，再一起动画到终点：画面连续
          this._trackTo(0, false);
          this.pos += dx < 0 ? 1 : -1;
          this._resetZoom(false);
          this._sync(dx < 0 ? 1 : -1, false, dx);
        } else this._trackTo(0, true);
      }
    };
    st.addEventListener('pointerup', end);
    st.addEventListener('pointercancel', end);

    window.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); this.step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); this.step(-1); }
      else if (e.key === 'p' || e.key === 'P') this.toggle();
      else if (e.key === '+' || e.key === '=') this._zoomTo(this.z * 1.4, innerWidth / 2, innerHeight / 2, true);
      else if (e.key === '-') this._zoomTo(this.z / 1.4, innerWidth / 2, innerHeight / 2, true);
      else if (e.key === '0') this._resetZoom(true);
      else return;
      e.stopImmediatePropagation();
    }, true);

    window.addEventListener('resize', () => { if (this.isOpen) this._sync(0, true); });
  }

  _trackTo(x, anim) {
    this.track.style.transition = anim && !reducedMotion() ? 'transform .5s cubic-bezier(.2,.9,.2,1)' : 'none';
    this.track.style.transform = x ? `translate3d(${x}px,0,0)` : '';
  }
}
