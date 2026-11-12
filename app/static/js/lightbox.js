// 大图：画布退到背后、图从格子飞出；左右两张预览露在两侧；背景是当前图的氛围光；
// 底部胶片条；幻灯片播放带缓慢推镜（Ken Burns）。
//
// 位置用一个无界整数 pos 记，图片下标 = pos mod n。左右切换、胶片条、循环都按 pos 算，
// 图少时绕回开头也不会错位。
//
// 每张 slide 是一个按原图宽高比算好大小的「框」，里面叠两张图：缩略图垫底，清晰图到了在上面淡入。
// 框的大小从一开始就是最终大小（宽高比来自清单），所以清晰图到了只是变清楚，不会再变大一次。
// 打开时只给框做 transform / clip-path 动画（从格子飞到中间），不动 filter、不动宽高，
// 手机上也能稳住帧率；氛围光、胶片条、两侧的清晰图都等飞完再开始。

import { $, clamp, esc, fmtBytes, fmtDate, reducedMotion } from './util.js';
import { previewUrl, rawUrl, thumbUrl } from './api.js';

const ZMAX = 8;
const SPAN = 2;        // 当前图左右各保留几张 slide
const STRIP = 12;      // 胶片条左右各几张
const STRIP_W = 62;    // 胶片条每格宽（含间距）
const PLAY_MS = 5000;

const mod = (a, n) => ((a % n) + n) % n;
const SIDE_SCALE = 0.66; // 相邻那张的缩放
const SIDE_FRAC = 0.21;  // 两侧各占的屏幕宽度比例（中间图只占剩下的 58%）
const FAR_SCALE = 0.5;   // 再往外一张的缩放

export class Lightbox {
  constructor({ getList, getOpt, rectFor, thumbFor, thumbElFor, onOpen, onClose }) {
    this.getList = getList;
    this.getOpt = getOpt;
    this.rectFor = rectFor;
    this.thumbFor = thumbFor;
    this.thumbElFor = thumbElFor || (() => null);
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
    this._vp();
    this._bind();
  }

  /** 舞台尺寸缓存：读 clientWidth / getBoundingClientRect 会在 DOM 刚改过时强制整页布局。 */
  _vp() {
    this.vw = window.innerWidth;
    this.vh = window.innerHeight;
  }

  get isOpen() { return this.root.classList.contains('open'); }
  /** 当前 slide 的框（缩放、拖动、飞入飞出都作用在它上面）。 */
  get img() { const s = this.slides.get(this.pos); return s && s.box; }
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
    // 格子的屏幕位置先算好：lightbox 一显示，再读布局就要等整页重排
    const from = rec && !reducedMotion() ? this.rectFor(im) : null;
    this._clearSlides();
    this.pos = idx;
    this.openTs = performance.now();
    // 飞的这 ~400ms 里只做一件事：框从格子飞到中间。两侧清晰图、胶片条、氛围光都推迟到落地后
    this.flying = !!from;
    this.root.classList.toggle('flying', this.flying);
    this.root.classList.add('open');
    document.body.classList.add('lb-open');
    this.onOpen && this.onOpen();
    this._sync(0, true);
    const s = this.slides.get(this.pos);
    const land = () => {
      if (!this.flying) return;
      this.flying = false;
      // 落地后的活分两拍做，免得一帧里堆太多：先补两侧 slide 和画布退后，下一拍再排文字和胶片条
      document.body.classList.add('lb-on');
      this._landing = true;
      this._sync(0, true);
      this._landing = false;
      const idle = window.requestIdleCallback || ((f) => setTimeout(f, 60));
      idle(() => {
        if (!this.isOpen || this.flying) return;
        this.root.classList.remove('flying');
        this._meta();
        this._ambient();
        this._strip(true);
      }, { timeout: 250 });
    };
    if (from && s) {
      const a = this._flip(s.box, from, this._targetRect(s));
      a.onfinish = a.oncancel = land;
    } else {
      document.body.classList.add('lb-on');
      land();
    }
    setTimeout(land, 700); // 保底：动画事件丢了也要落地
  }

  /** 当前 slide 的框落地后在屏幕上的矩形（直接算，不读布局）。 */
  _targetRect(s) {
    const W = this.vw, H = this.vh;
    const w = parseFloat(s.box.style.width), h = parseFloat(s.box.style.height);
    const small = W < 700;
    const padT = small ? 56 : 64, padB = small ? 108 : 118;
    const cy = padT + (H - padT - padB) / 2;
    return { left: (W - w) / 2, top: cy - h / 2, width: w, height: h };
  }

  close() {
    if (!this.isOpen) return;
    this.stop();
    this.flying = false;
    this.root.classList.remove('flying');
    const im = this.cur;
    const img = this.img;
    const to = im && this.rectFor(im);
    if (img && to && !reducedMotion() && this.z <= 1.01) {
      const from = img.getBoundingClientRect();
      if (from.width) this._flipBack(img, from, to);
    }
    this.root.classList.remove('open');
    document.body.classList.remove('lb-on', 'lb-open');
    // 关的时候清掉文字、胶片条和 slide：下次打开的第一帧不用先删旧节点、给旧文字排版，
    // 点下去到看见图的那一下能省 50–100ms（手机上尤其明显）
    clearTimeout(this._clrT);
    this._clrT = setTimeout(() => {
      if (this.isOpen) return;
      $('lbName').textContent = ''; $('lbInfo').textContent = '';
      for (const el of this.thumbs.values()) el.remove();
      this.thumbs.clear();
      for (const s of this.slides.values()) s.el.remove();
      this.slides.clear();
    }, 320);
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
    if (s) s.box.classList.remove('kb');
  }

  _restartPlay() {
    clearTimeout(this.playT);
    const bar = $('lbProg');
    bar.style.animation = 'none';
    void bar.offsetWidth;
    bar.style.animation = `lb-prog ${PLAY_MS}ms linear both`;
    const s = this.slides.get(this.pos);
    if (s && !reducedMotion()) {
      s.box.classList.remove('kb');
      void s.box.offsetWidth;
      s.box.style.setProperty('--kb-x', (((this.pos * 37) % 7) - 3) + '%');
      s.box.style.setProperty('--kb-y', (((this.pos * 53) % 5) - 2) + '%');
      s.box.classList.add('kb');
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
    const span = this.flying ? 0 : Math.min(SPAN, Math.floor((n - 1) / 2));
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
      // 打开时当前这张直接可见（飞入动画负责出场）；其余从透明滑进来
      s.el.style.opacity = first && o === 0 ? '' : '0';
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
    // 让上面设的起点生效，下面再设终点才有过渡；只有一张（刚打开）时不需要
    if (this.slides.size > 1) void this.track.offsetWidth;
    for (const [p, s] of this.slides) {
      const o = p - this.pos;
      s.el.style.transition = '';
      s.el.style.opacity = '';
      s.el.style.transform = this._slideTf(o);
      s.el.classList.toggle('cur', o === 0);
      s.el.classList.toggle('side', o !== 0);
      // 当前与左右各一张要清晰版，更远的只放缩略图；飞的时候只加载当前这张
      if (o === 0 || (!this.flying && Math.abs(o) <= 1)) this._loadFull(s);
    }
    if (this.flying || this._landing) return;
    this._meta();
    this._ambient();
    this._strip(first);
  }

  /**
   * 两侧预览的定位：以中间那张为基准，对称排开。
   *
   * 间距必须按「中间图的实际宽度」算，不能按视口宽度乘个系数了事：
   * 4K 屏中间图能有 3000px 宽，固定的 980px 间距会让两侧直接压在中间图上。
   *
   * 但要留出「两侧也看得见」的空间：间距取
   *   中间图半宽 + 相邻那张缩放后半宽 + 留白，再夹在可用宽度内。
   * 这样 1080p 和 4K 都不会重叠，也不会把两侧推到屏幕外。
   */
  _slideTf(o, extra = 0) {
    const a = Math.abs(o);
    if (!a) return `translate3d(${extra}px,0,0) scale(1)`;
    const s = a === 1 ? SIDE_SCALE : FAR_SCALE;
    const step = this._step();               // 相邻两张的中心距
    const x = Math.sign(o) * (step + (a - 1) * step * 0.62);
    return `translate3d(${x + extra}px,0,0) scale(${s})`;
  }

  /** 相邻两张的中心距：既要不压住中间那张，又要让两边露得出来。 */
  _step() {
    const vw = this.vw;
    const curW = this._curWidth();
    // 左右两张的宽度可能差很多（一边横图一边竖图），取更宽的那个来算，否则宽的那边会压过来
    const l = this._neighbourWidth(-1) * SIDE_SCALE;
    const r = this._neighbourWidth(1) * SIDE_SCALE;
    const nbW = Math.max(l, r);
    // 中心距 = 中间半宽 + 邻居渲染后半宽 + 小留白。中间图宽度已经按「两侧各留 SIDE_FRAC」封顶，
    // 所以这个值天然落在屏幕内，不会把两侧挤出去，也不会压住中间图。
    return curW / 2 + nbW / 2 + Math.max(12, vw * 0.008);
  }

  /**
   * 某一侧相邻那张的原始宽度（未缩放）。dir = -1 左 / +1 右。
   * 两侧预览不需要按「大图」的尺寸上限算：那张图上屏之后还要乘 SIDE_SCALE，
   * 按满幅算会让一个超宽邻居算出 900 多像素，把间距撑得离谱。
   * 这里按中间那张的宽度封顶。
   */
  _neighbourWidth(dir = 1) {
    const list = this.getList();
    if (!list.length) return this._curWidth();
    // 优先用这一张自己框的实际宽度（未缩放），它才是真正会占地方的那个尺寸
    const s = this.slides.get(this.pos + dir);
    if (s && s.box && s.box.offsetWidth) return s.box.offsetWidth;
    const w = this._fit(list[mod(this.pos + dir, list.length)], null).w;
    return Math.min(w, this._curWidth());
  }

  /** 中间那张在屏幕上的宽度（还没量到就按可用宽度的上限估算）。 */
  _curWidth() {
    const s = this.slides.get(this.pos);
    if (s && s.box && s.box.offsetWidth) return s.box.offsetWidth;
    // 没量到就按「两侧各留 SIDE_FRAC」后的中间宽度上限估
    const small = this.vw < 700;
    return this.vw * (small ? 0.96 : 0.84);
  }

  /** 大图在屏幕上的最终大小：按原图宽高比放进可用区域（小图不放大到超过原图像素）。 */
  _fit(im, natural) {
    const vw = this.vw, vh = this.vh;
    const small = vw < 700;
    // 中间图最多占中间那一条：两侧各留 SIDE_FRAC 的屏宽给预览。
    // 按比例留（而不是固定像素）是因为屏幕越大，固定像素占的比例越小，
    // 4K 上就会让两侧显得挤在边上。
    const maxW = small ? vw * 0.96 : vw * (1 - SIDE_FRAC * 2);
    const maxH = vh - (small ? 164 : 182);
    let a = (im.a || 0) / 100;
    if (!a && natural && natural.h) a = natural.w / natural.h;
    if (!a) a = 4 / 3;
    let w = Math.min(maxW, maxH * a);
    if (natural && natural.w > 64 && natural.w < w) w = natural.w;
    return { w: Math.round(w), h: Math.round(w / a), known: !!(im.a || natural) };
  }

  _sizeBox(s, natural) {
    const f = this._fit(s.im, natural);
    s.box.style.width = f.w + 'px';
    s.box.style.height = f.h + 'px';
    s.sized = f.known;
  }

  _makeSlide(p, im) {
    const el = document.createElement('div');
    el.className = 'lb-slide';
    const box = document.createElement('div');
    box.className = 'lb-box';
    // 缩略图：直接把格子里已解码的位图画到 canvas 上（同步完成，第一帧就有图）。
    // 新建 <img> 指向同一 URL 也得重新解码，手机上要几十毫秒，飞出来那一下就是空框
    let thumb = null;
    const src = this.thumbElFor(im);
    if (src && src.complete && src.naturalWidth) {
      try {
        const c = document.createElement('canvas');
        c.width = src.naturalWidth; c.height = src.naturalHeight;
        c.getContext('2d').drawImage(src, 0, 0);
        c.className = 'lb-thumb';
        thumb = c;
      } catch (_) { thumb = null; }
    }
    if (!thumb) {
      thumb = new Image();
      thumb.decoding = 'sync';
      thumb.draggable = false;
      thumb.alt = '';
      thumb.className = 'lb-thumb';
      const th = this.thumbFor(im);
      thumb.src = th || thumbUrl(im, 320, this.getOpt());
    }
    box.appendChild(thumb);
    el.appendChild(box);
    el.dataset.p = p;
    const s = { el, box, thumb, im, p, full: false, sized: false, fullImg: null };
    this._sizeBox(s, null);
    return s;
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
    full.draggable = false;
    full.alt = '';
    full.className = 'lb-full';
    full.onload = () => {
      (full.decode ? full.decode() : Promise.resolve()).catch(() => {}).then(() => {
        if (!s.el.isConnected) return;
        // 清单里没有宽高比（尺寸还没读到）时才用实际尺寸修正一次框
        if (!s.sized) this._sizeBox(s, { w: full.naturalWidth, h: full.naturalHeight });
        // 清晰图盖在缩略图上淡入；缩略图留着垫底，不会有空白的一帧
        s.box.appendChild(full);
        requestAnimationFrame(() => full.classList.add('ready'));
        s.box.classList.add('sharp');
        s.fullImg = full;
        if (isCur()) this.root.classList.remove('loading');
      });
    };
    full.onerror = () => {
      if (isCur()) {
        this.root.classList.remove('loading');
        if (s.thumb.tagName === 'IMG' && (!s.thumb.complete || !s.thumb.naturalWidth)) $('lbErr').hidden = false;
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
    this.root.classList.toggle('loading', !!(s && !s.box.classList.contains('sharp')));
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
    let entering = false;
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
        if (!first) { el.style.transition = 'none'; el.style.transform = `translateX(${o * STRIP_W}px)`; entering = true; }
        this.strip.appendChild(el);
        this.thumbs.set(p, el);
      }
    }
    if (entering) void this.strip.offsetWidth;
    for (const [p, el] of this.thumbs) {
      const o = p - this.pos;
      el.style.transition = '';
      el.style.transform = `translateX(${o * STRIP_W}px) scale(${o ? 1 : 1.18})`;
      el.classList.toggle('on', o === 0);
      el.style.opacity = Math.abs(o) > span ? '0' : String(Math.max(0.25, 1 - Math.abs(o) * 0.07));
    }
  }

  // ------------------------------------------------------------ 飞入飞出

  /**
   * 从格子飞到中间。格子是裁过的（object-fit: cover），框是完整比例：起点用 clip-path 把框裁成格子的样子，
   * 边飞边展开，看起来就是格子本身被拉出来。只动 transform 和 clip-path。
   */
  _flip(el, from, to) {
    const s = Math.max(from.width / to.width, from.height / to.height);
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    // 框缩放 s 倍后比格子多出来的部分裁掉（单位：框自身的像素）
    const ix = Math.max(0, (to.width - from.width / s) / 2);
    const iy = Math.max(0, (to.height - from.height / s) / 2);
    const r = 6 / s;
    return el.animate(
      [
        { transform: `translate(${dx}px,${dy}px) scale(${s})`, clipPath: `inset(${iy}px ${ix}px round ${r}px)` },
        { transform: 'none', clipPath: 'inset(0px 0px round 8px)' },
      ],
      { duration: 420, easing: 'cubic-bezier(.2,.85,.25,1)' },
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
        const onImg = hit && this.img && this.img.contains(hit);
        if (!onImg && this.z <= 1.01) setTimeout(() => { if (lastTap === now) this.close(); }, 300);
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

    window.addEventListener('resize', () => {
      this._vp();
      if (!this.isOpen) return;
      for (const s of this.slides.values()) this._sizeBox(s, s.fullImg ? { w: s.fullImg.naturalWidth, h: s.fullImg.naturalHeight } : null);
      this._sync(0, true);
    });
  }

  _trackTo(x, anim) {
    this.track.style.transition = anim && !reducedMotion() ? 'transform .5s cubic-bezier(.2,.9,.2,1)' : 'none';
    this.track.style.transform = x ? `translate3d(${x}px,0,0)` : '';
  }
}
