// 所有 URL 都是相对路径：页面挂在 nginx 的 /wall/ 下也能用。
// 中文路径一律 encodeURIComponent（http.server 按 latin-1 解请求行）。

async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || 'HTTP ' + r.status);
  }
  return r.json();
}

const q = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => k + '=' + encodeURIComponent(v))
    .join('&');

export const api = {
  roots: () => getJSON('api/roots'),
  folders: (path) => getJSON('api/folders?' + q({ path })),
  cacheStats: (refresh) => getJSON('api/cache_stats?' + q({ refresh: refresh ? 1 : '' })),
  warm: (o) => getJSON('api/warm?' + q(o)),
  warmCancel: () => getJSON('api/warm?cancel=1'),
  warmStatus: () => getJSON('api/warm/status'),

  /** 目录清单。服务端发紧凑格式 {dirs, files:[[目录序号, 文件名, mtime, 字节]]}，这里展开。 */
  async images(path, { refresh = false, signal } = {}) {
    const d = await getJSON('api/images?' + q({ path, refresh: refresh ? 1 : '' }), {
      signal,
      cache: refresh ? 'reload' : 'no-cache',
    });
    const dirs = d.dirs || [];
    const images = new Array(d.files.length);
    for (let i = 0; i < d.files.length; i++) {
      const [di, n, t, s, a] = d.files[i];
      const dir = dirs[di];
      images[i] = { p: dir ? dir + '/' + n : n, n, d: dir, t, s, a: a || 0, i };
    }
    return { path: d.path, images, missing: (d.dims && d.dims.missing) || 0 };
  },
};

/** 拼贴格用的缩略图（短边 s）。 */
export function thumbUrl(im, s, opt) {
  return `api/img?p=${encodeURIComponent(im.p)}&s=${s}&q=${opt.q}&f=${opt.fmt}&v=${im.t}`;
}

/** 大图预览（长边 w）。 */
export function previewUrl(im, w, opt) {
  return `api/img?p=${encodeURIComponent(im.p)}&w=${w}&q=${opt.q}&f=${opt.fmt}&v=${im.t}`;
}

export function rawUrl(im) {
  return `api/img?p=${encodeURIComponent(im.p)}&w=0&v=${im.t}`;
}
