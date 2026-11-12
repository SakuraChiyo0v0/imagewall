export const $ = (id) => document.getElementById(id);

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export const reducedMotion = () => document.documentElement.classList.contains('calm');

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

export function fmtDate(t) {
  const d = new Date(t * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtCount(n) {
  return n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + ' 万' : String(n);
}

let toastTimer = 0;
export function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}

/** 显示 / 隐藏一个浮层：先去掉 hidden 再加 .open，让 CSS 过渡有起点；关闭时等过渡结束再 hidden。 */
export function showLayer(el, on) {
  if (on) {
    clearTimeout(el._hideT);
    el.hidden = false;
    // 强制一次布局，保证过渡从初始态开始
    void el.offsetWidth;
    el.classList.add('open');
  } else if (!el.hidden) {
    el.classList.remove('open');
    clearTimeout(el._hideT);
    el._hideT = setTimeout(() => { el.hidden = true; }, reducedMotion() ? 0 : 260);
  }
}
