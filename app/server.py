#!/usr/bin/env python3
"""imagewall 后端：目录扫描 + 按需缩略图 + 磁盘缓存。

单文件，只依赖标准库与 Pillow。

环境变量:
  IMG_DATA_ROOT     数据根（默认 /data）
  IMG_ROOTS         允许浏览的根目录，冒号分隔，相对 IMG_DATA_ROOT（如 图片:漫画:素材）
  IMG_CACHE         缩略图缓存目录（默认 /cache）
  IMG_CACHE_MAX_MB  缓存上限，超过后按最久未访问清理（默认 8192，0 = 不限）
  IMG_SCAN_TTL      目录清单多久算过期（秒，默认 60；过期后先返回旧清单、后台重扫）
  IMG_WORKERS       同时生成缩略图的线程数（默认 min(4, CPU 数)）
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlparse

from PIL import Image, ImageOps, features

VERSION = "1.0.0"


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


DATA_ROOT = os.path.realpath(os.environ.get("IMG_DATA_ROOT", "/data"))
CACHE_DIR = os.path.realpath(os.environ.get("IMG_CACHE", "/cache"))
ROOTS = [r.strip("/ ") for r in os.environ.get("IMG_ROOTS", "图片:漫画:素材").split(":") if r.strip("/ ")]
ROOTS_REAL = [os.path.realpath(os.path.join(DATA_ROOT, r)) for r in ROOTS]
SCAN_TTL = _env_int("IMG_SCAN_TTL", 60)
CACHE_MAX = _env_int("IMG_CACHE_MAX_MB", 8192) * 1024 * 1024
WORKERS = max(1, _env_int("IMG_WORKERS", min(4, os.cpu_count() or 2)))

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")

IMG_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".avif", ".jfif"}
RAW_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jfif": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".bmp": "image/bmp", ".gif": "image/gif", ".avif": "image/avif",
}
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
    ".json": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json",
}
SKIP_DIRS = {"#recycle", "@eaDir", ".git", "node_modules"}

# 缩略图尺寸只取这些档位：前端怎么算都落在有限几档上，缓存不会碎成无数个尺寸
BUCKETS = (160, 240, 320, 480, 640, 800, 1200, 1600, 2400, 3840)
# 拼贴格最扁是 2:1，超过这个比例的图（长截图、全景）生成缩略图时先居中裁掉两头，省字节
MAX_ASPECT = 2.1
TILE_BG = (17, 19, 24)
HAS_WEBP = bool(features.check("webp"))
LANCZOS = getattr(Image, "Resampling", Image).LANCZOS


def snap(px: int) -> int:
    for b in BUCKETS:
        if b >= px:
            return b
    return BUCKETS[-1]


def natural_key(s: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


# ---------------------------------------------------------------- 路径

def resolve(rel: str) -> str:
    """把相对路径解析成绝对路径，并确保落在允许的根目录内（不在就抛 PermissionError → 403）。"""
    rel = (rel or "").replace("\\", "/").strip("/")
    if "\x00" in rel:
        raise PermissionError("bad path")
    full = os.path.realpath(os.path.join(DATA_ROOT, rel))
    if not any(full == r or full.startswith(r + os.sep) for r in ROOTS_REAL):
        raise PermissionError("path outside roots")
    return full


def rel_of(full: str) -> str:
    return os.path.relpath(full, DATA_ROOT).replace(os.sep, "/")


def is_root(rel: str) -> bool:
    return rel in ROOTS


# ---------------------------------------------------------------- 目录清单

class Listing:
    """一次扫描的结果。entries 按 mtime 倒序：(目录相对路径, 文件名, mtime, 字节数)。

    JSON 在构建时编码一次、gzip 一次，之后每个请求直接发字节，不再重复 dumps。
    """

    __slots__ = ("rel", "entries", "ts", "body", "gz", "etag", "_dir_counts")

    def __init__(self, rel: str, entries: list, ts: float):
        self.rel = rel
        self.entries = entries
        self.ts = ts
        dirs, idx, files = [], {}, []
        for d, n, t, s in entries:
            i = idx.get(d)
            if i is None:
                i = idx[d] = len(dirs)
                dirs.append(d)
            files.append([i, n, t, s])
        self.body = json.dumps(
            {"path": rel, "count": len(files), "dirs": dirs, "files": files},
            ensure_ascii=False, separators=(",", ":"),
        ).encode()
        self.gz = gzip.compress(self.body, 6)
        self.etag = '"L' + hashlib.sha1(self.body).hexdigest()[:20] + '"'
        self._dir_counts = None

    def dir_counts(self) -> dict:
        if self._dir_counts is None:
            c: dict = {}
            for d, _n, _t, _s in self.entries:
                c[d] = c.get(d, 0) + 1
            self._dir_counts = c
        return self._dir_counts

    def count_under(self, rel: str) -> int:
        pre = rel + "/"
        return sum(n for d, n in self.dir_counts().items() if d == rel or d.startswith(pre))


def _walk(full: str, rel: str) -> list:
    out = []
    stack = [(full, rel)]
    while stack:
        d, drel = stack.pop()
        try:
            it = os.scandir(d)
        except OSError:
            continue
        with it:
            for e in it:
                name = e.name
                try:
                    if e.is_dir(follow_symlinks=False):
                        if not name.startswith(".") and name not in SKIP_DIRS:
                            stack.append((e.path, drel + "/" + name))
                        continue
                    if os.path.splitext(name)[1].lower() not in IMG_EXT or not e.is_file():
                        continue
                    st = e.stat()
                except OSError:
                    continue
                out.append((drel, name, int(st.st_mtime), st.st_size))
    # 同 mtime 时按路径排，保证每次扫描顺序一致 → 前端哈希选图稳定
    out.sort(key=lambda x: (-x[2], x[0], x[1]))
    return out


class Library:
    """目录清单缓存：过期了先给旧的、后台重扫；子目录能从已缓存的祖先清单里直接过滤出来。"""

    MAX_LISTINGS = 16

    def __init__(self):
        self.lock = threading.Lock()
        self.cache: dict[str, Listing] = {}
        self.inflight: dict[str, threading.Event] = {}
        self.refreshing: set = set()

    def _store(self, lst: Listing) -> None:
        self.cache.pop(lst.rel, None)
        self.cache[lst.rel] = lst
        while len(self.cache) > self.MAX_LISTINGS:
            self.cache.pop(next(iter(self.cache)))

    def _covering(self, rel: str):
        """已缓存的、覆盖 rel 的最近清单（自身或祖先）。调用方持锁。"""
        p = rel
        while True:
            hit = self.cache.get(p)
            if hit:
                return hit
            if "/" not in p:
                return None
            p = p.rsplit("/", 1)[0]

    def peek(self, rel: str):
        with self.lock:
            return self._covering(rel)

    def get(self, rel: str, force: bool = False) -> Listing:
        now = time.time()
        owner = False
        with self.lock:
            if not force:
                hit = self.cache.get(rel)
                if hit:
                    if now - hit.ts > SCAN_TTL:
                        self._refresh_async(rel)
                    return hit
                anc = self._covering(rel)
                if anc and now - anc.ts <= SCAN_TTL:
                    pre = rel + "/"
                    sub = [e for e in anc.entries if e[0] == rel or e[0].startswith(pre)]
                    lst = Listing(rel, sub, anc.ts)
                    self._store(lst)
                    return lst
            ev = self.inflight.get(rel)
            if ev is None:
                ev = self.inflight[rel] = threading.Event()
                owner = True
        if owner:
            try:
                return self._build(rel)
            finally:
                with self.lock:
                    self.inflight.pop(rel, None)
                ev.set()
        ev.wait(120)
        with self.lock:
            hit = self.cache.get(rel)
        if hit is None:
            raise RuntimeError("scan failed")
        return hit

    def _build(self, rel: str) -> Listing:
        full = resolve(rel)
        entries = _walk(full, rel) if os.path.isdir(full) else []
        lst = Listing(rel, entries, time.time())
        with self.lock:
            self._store(lst)
        return lst

    def _refresh_async(self, rel: str) -> None:
        if rel in self.refreshing:
            return
        self.refreshing.add(rel)

        def job():
            try:
                self._build(rel)
            except Exception:  # noqa: BLE001
                pass
            finally:
                with self.lock:
                    self.refreshing.discard(rel)

        threading.Thread(target=job, daemon=True).start()


LIB = Library()


def subdirs(rel: str) -> dict:
    full = resolve(rel)
    rel = rel_of(full)
    names = []
    try:
        with os.scandir(full) as it:
            for e in it:
                if e.name.startswith(".") or e.name in SKIP_DIRS:
                    continue
                try:
                    if e.is_dir():
                        names.append(e.name)
                except OSError:
                    pass
    except OSError:
        pass
    names.sort(key=natural_key)
    cover = LIB.peek(rel)
    dirs = []
    for n in names:
        item = {"name": n, "path": rel + "/" + n}
        if cover is not None:
            item["count"] = cover.count_under(item["path"])
        dirs.append(item)
    parent = "" if is_root(rel) else rel.rsplit("/", 1)[0]
    out = {"path": rel, "parent": parent, "dirs": dirs}
    if cover is not None:
        out["count"] = cover.count_under(rel)
    return out


# ---------------------------------------------------------------- 缩略图

class Spec:
    """一份缩略图规格。mode: 's' 短边（拼贴格用）/ 'w' 长边（大图用）。"""

    __slots__ = ("mode", "px", "q", "fmt")

    def __init__(self, mode: str, px: int, q: int, fmt: str):
        self.mode, self.px, self.q, self.fmt = mode, px, q, fmt

    @property
    def ext(self) -> str:
        return "webp" if self.fmt == "webp" else "jpg"

    @property
    def ctype(self) -> str:
        return "image/webp" if self.fmt == "webp" else "image/jpeg"


def cache_file(rel: str, st: os.stat_result, spec: Spec) -> str:
    key = hashlib.sha1(
        f"{rel}|{int(st.st_mtime)}|{st.st_size}|{spec.mode}{spec.px}|{spec.q}|{spec.fmt}".encode()
    ).hexdigest()
    return os.path.join(CACHE_DIR, key[:2], key[2:] + "." + spec.ext)


def _load(fp: str, need: int) -> Image.Image:
    im = Image.open(fp)
    if need and im.format == "JPEG":
        try:
            im.draft("RGB", (need, need))  # JPEG 解码时直接按 1/2、1/4、1/8 降采样，快一个数量级
        except Exception:  # noqa: BLE001
            pass
    im = ImageOps.exif_transpose(im)
    if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, TILE_BG)
        bg.paste(im, mask=im.getchannel("A"))
        im = bg
    elif im.mode != "RGB":
        try:
            im = im.convert("RGB")
        except Exception:  # noqa: BLE001  16 位灰度之类
            im = im.convert("I").point(lambda v: v / 256).convert("RGB")
    return im


def _shape(im: Image.Image, spec: Spec) -> Image.Image:
    w, h = im.size
    if spec.mode == "s":
        if w > h * MAX_ASPECT:
            nw = int(h * MAX_ASPECT)
            x = (w - nw) // 2
            im = im.crop((x, 0, x + nw, h))
        elif h > w * MAX_ASPECT:
            nh = int(w * MAX_ASPECT)
            y = (h - nh) // 2
            im = im.crop((0, y, w, y + nh))
        w, h = im.size
        short = min(w, h)
        if short > spec.px:
            k = spec.px / short
            im = im.resize((max(1, round(w * k)), max(1, round(h * k))), LANCZOS, reducing_gap=3.0)
    else:
        if max(w, h) > spec.px:
            k = spec.px / max(w, h)
            im = im.resize((max(1, round(w * k)), max(1, round(h * k))), LANCZOS, reducing_gap=3.0)
    return im


def _save(im: Image.Image, spec: Spec, out: str) -> None:
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = f"{out}.{os.getpid()}.{threading.get_ident()}.tmp"
    if spec.fmt == "webp":
        im.save(tmp, "WEBP", quality=spec.q, method=4)
    else:
        im.save(tmp, "JPEG", quality=spec.q, optimize=True, progressive=True)
    os.replace(tmp, out)


def render(fp: str, jobs: list) -> None:
    """一次解码，生成多份规格。jobs: [(spec, out_path)]。"""
    # draft 保证解码后两边都 ≥ 请求值：短边规格正好够用，长边规格偏保守但不会糊
    base = _load(fp, max(s.px for s, _ in jobs))
    for spec, out in jobs:
        if spec.mode == "w":
            _save(_shape(base, spec), spec, out)
    # 短边规格从大到小生成，小的用上一份结果再缩，省掉一次大图缩放
    src = base
    for spec, out in sorted((j for j in jobs if j[0].mode == "s"), key=lambda j: -j[0].px):
        src = _shape(src, spec)
        _save(src, spec, out)


class Generator:
    """缩略图生成：同一文件不并发生成两次；总并发受信号量限制；坏图记 10 分钟不再重试。"""

    def __init__(self, workers: int):
        self.sem = threading.BoundedSemaphore(workers)
        self.lock = threading.Lock()
        self.inflight: dict[str, threading.Event] = {}
        self.failed: dict[str, float] = {}
        self.interactive = 0  # 正在等的前台请求数；预生成看到 >0 就让路

    def ensure(self, fp: str, jobs: list, interactive: bool = True) -> None:
        """确保 jobs 里的输出都存在。失败抛 ValueError。"""
        todo = [(s, o) for s, o in jobs if not os.path.exists(o)]
        if not todo:
            return
        key = todo[0][1]
        now = time.time()
        with self.lock:
            if now - self.failed.get(key, 0) < 600:
                raise ValueError("decode failed recently")
            ev = self.inflight.get(key)
            owner = ev is None
            if owner:
                ev = self.inflight[key] = threading.Event()
            if interactive:
                self.interactive += 1
        try:
            if not owner:
                ev.wait(60)
                if not os.path.exists(key):
                    raise ValueError("generation failed")
                return
            try:
                with self.sem:
                    render(fp, todo)
            except Exception as e:  # noqa: BLE001
                with self.lock:
                    self.failed[key] = time.time()
                    if len(self.failed) > 5000:
                        self.failed.clear()
                raise ValueError(f"{type(e).__name__}: {e}") from e
            finally:
                with self.lock:
                    self.inflight.pop(key, None)
                ev.set()
        finally:
            if interactive:
                with self.lock:
                    self.interactive -= 1


GEN = Generator(WORKERS)


def parse_spec(qs: dict) -> Spec | None:
    """从查询参数解析规格。s=短边，w=长边（w=0 原图 → None）。"""
    def num(k, d):
        try:
            return int(qs.get(k, [d])[0] or d)
        except ValueError:
            return d

    q = max(40, min(95, num("q", 80)))
    f = (qs.get("f", ["jpeg"])[0] or "jpeg").lower()
    fmt = "webp" if f == "webp" and HAS_WEBP else "jpeg"
    if "s" in qs:
        return Spec("s", snap(max(1, num("s", 480))), q, fmt)
    w = num("w", 800)
    if w <= 0:
        return None
    return Spec("w", snap(w), q, fmt)


def parse_sizes(v: str, mode: str, q: int, fmt: str) -> list:
    out = []
    for part in (v or "").split(","):
        part = part.strip()
        if part.isdigit() and int(part) > 0:
            s = Spec(mode, snap(int(part)), q, fmt)
            if all(x.px != s.px for x in out):
                out.append(s)
    return out


# ---------------------------------------------------------------- 预生成

WARM = {"running": False, "done": 0, "total": 0, "failed": 0, "path": "", "error": "", "cancel": False}
WARM_LOCK = threading.Lock()


def _warm_job(lst: Listing, specs: list) -> None:
    lock = threading.Lock()

    def one(entry):
        if WARM["cancel"]:
            return
        d, n, _t, _s = entry
        rel = d + "/" + n
        try:
            fp = resolve(rel)
            st = os.stat(fp)
            # 前台有请求在等就让路，别跟正在看图的人抢 CPU
            while GEN.interactive > 0 and not WARM["cancel"]:
                time.sleep(0.03)
            GEN.ensure(fp, [(s, cache_file(rel, st, s)) for s in specs], interactive=False)
        except Exception:  # noqa: BLE001
            with lock:
                WARM["failed"] += 1
        with lock:
            WARM["done"] += 1

    try:
        with ThreadPoolExecutor(max_workers=max(1, WORKERS // 2 or 1)) as ex:
            list(ex.map(one, lst.entries))
    except Exception as e:  # noqa: BLE001
        WARM["error"] = f"{type(e).__name__}: {e}"
    finally:
        WARM["running"] = False
        JANITOR.poke()


def start_warm(rel: str, specs: list) -> dict:
    with WARM_LOCK:
        if WARM["running"]:
            return dict(WARM, started=False)
        lst = LIB.get(rel)
        WARM.update(running=True, done=0, total=len(lst.entries), failed=0, path=lst.rel, error="", cancel=False)
    threading.Thread(target=_warm_job, args=(lst, specs), daemon=True).start()
    return dict(WARM, started=True)


# ---------------------------------------------------------------- 缓存清理

CACHE_NAME = re.compile(r"^[0-9a-f]{38}\.(jpg|webp)$")
TMP_NAME = re.compile(r"^[0-9a-f]{38}\.(jpg|webp)\.\d+\.\d+\.tmp$")
SUB_NAME = re.compile(r"^[0-9a-f]{2}$")


class Janitor:
    """统计缓存占用；超过上限按 mtime（命中时会刷新）删最久没用的。只删认得的文件名。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.stats = {"count": 0, "bytes": 0, "max": CACHE_MAX, "ts": 0.0, "removed": 0}
        self.event = threading.Event()

    def poke(self) -> None:
        self.event.set()

    def scan(self) -> None:
        files = []
        total = 0
        now = time.time()
        try:
            subs = [e for e in os.scandir(CACHE_DIR) if e.is_dir() and SUB_NAME.match(e.name)]
        except OSError:
            subs = []
        for sub in subs:
            try:
                with os.scandir(sub.path) as it:
                    for e in it:
                        try:
                            if CACHE_NAME.match(e.name):
                                st = e.stat()
                                files.append((st.st_mtime, st.st_size, e.path))
                                total += st.st_size
                            elif TMP_NAME.match(e.name) and now - e.stat().st_mtime > 3600:
                                os.remove(e.path)
                        except OSError:
                            pass
            except OSError:
                pass
        removed = 0
        if CACHE_MAX and total > CACHE_MAX:
            files.sort()
            target = CACHE_MAX * 0.9
            for _m, size, path in files:
                if total <= target:
                    break
                try:
                    os.remove(path)
                    total -= size
                    removed += 1
                except OSError:
                    pass
        with self.lock:
            self.stats = {"count": len(files) - removed, "bytes": total, "max": CACHE_MAX,
                          "ts": time.time(), "removed": self.stats["removed"] + removed}

    def run(self) -> None:
        while True:
            try:
                self.scan()
            except Exception:  # noqa: BLE001
                pass
            self.event.wait(600)
            self.event.clear()
            time.sleep(2)

    def get(self) -> dict:
        with self.lock:
            return dict(self.stats)


JANITOR = Janitor()


def touch(path: str) -> None:
    """命中缓存时刷新 mtime，让清理按"最久没被看过"删。半天内只刷一次，避免每次命中都写盘。"""
    try:
        if time.time() - os.stat(path).st_mtime > 43200:
            os.utime(path, None)
    except OSError:
        pass


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "imagewall/" + VERSION
    timeout = 60

    def log_message(self, fmt, *args):  # noqa: D401
        pass

    # ---------- 发送 ----------
    def _send(self, code: int, ctype: str, body: bytes = b"", headers: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD" and body:
            self.wfile.write(body)

    def _not_modified(self, etag: str, headers: dict | None = None) -> bool:
        inm = self.headers.get("If-None-Match")
        if inm and etag in [t.strip() for t in inm.split(",")]:
            self.send_response(304)
            self.send_header("ETag", etag)
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        return False

    def _gzip_ok(self) -> bool:
        return "gzip" in (self.headers.get("Accept-Encoding") or "")

    def send_json(self, obj, code: int = 200) -> None:
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
        self._send(code, "application/json; charset=utf-8", body, {"Cache-Control": "no-store"})

    def send_listing(self, lst: Listing) -> None:
        h = {"Cache-Control": "no-cache", "ETag": lst.etag, "Vary": "Accept-Encoding"}
        if self._not_modified(lst.etag, {"Cache-Control": "no-cache"}):
            return
        if self._gzip_ok():
            h["Content-Encoding"] = "gzip"
            return self._send(200, "application/json; charset=utf-8", lst.gz, h)
        return self._send(200, "application/json; charset=utf-8", lst.body, h)

    def send_path(self, path: str, ctype: str, cache: str, etag: str, extra: dict | None = None) -> None:
        h = {"Cache-Control": cache, "ETag": etag}
        h.update(extra or {})
        if self._not_modified(etag, {"Cache-Control": cache}):
            return
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        for k, v in h.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            while True:
                chunk = f.read(256 * 1024)
                if not chunk:
                    break
                self.wfile.write(chunk)

    _static_gz: dict = {}

    def send_static(self, full: str) -> None:
        ext = os.path.splitext(full)[1].lower()
        ctype = STATIC_TYPES.get(ext, "application/octet-stream")
        st = os.stat(full)
        etag = f'"S{int(st.st_mtime_ns)}-{st.st_size}"'
        # no-cache = 每次都问一下，没变就 304：改完前端文件刷新即生效，又不用重传
        h = {"Cache-Control": "no-cache", "ETag": etag, "Vary": "Accept-Encoding"}
        if self._not_modified(etag, {"Cache-Control": "no-cache"}):
            return
        if ext in (".html", ".js", ".css", ".svg", ".json") and self._gzip_ok() and st.st_size > 1024:
            key = full + etag
            gz = self._static_gz.get(key)
            if gz is None:
                with open(full, "rb") as f:
                    gz = gzip.compress(f.read(), 6)
                self._static_gz[key] = gz
            h["Content-Encoding"] = "gzip"
            return self._send(200, ctype, gz, h)
        return self.send_path(full, ctype, "no-cache", etag, {"Vary": "Accept-Encoding"})

    # ---------- 路由 ----------
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        raw = self.path
        try:
            # http.server 按 latin-1 解请求行；没 urlencode 的中文在这里还原成 UTF-8
            raw = raw.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
        u = urlparse(raw)
        qs = parse_qs(u.query, keep_blank_values=True)
        path = u.path

        def arg(k: str, default: str = "") -> str:
            return qs.get(k, [default])[0]

        try:
            if path in ("/", "/index.html"):
                return self.send_static(os.path.join(APP_DIR, "index.html"))

            if path.startswith("/static/"):
                full = os.path.realpath(os.path.join(STATIC_DIR, path[len("/static/"):]))
                if not full.startswith(STATIC_DIR + os.sep) or not os.path.isfile(full):
                    return self.send_json({"error": "not found"}, 404)
                return self.send_static(full)

            if path == "/api/health":
                return self.send_json({"ok": True, "version": VERSION})

            if path == "/api/roots":
                return self.send_json({
                    "roots": [{"name": r.split("/")[-1], "path": r} for r in ROOTS],
                    "version": VERSION, "webp": HAS_WEBP, "buckets": BUCKETS, "maxAspect": MAX_ASPECT,
                })

            if path == "/api/folders":
                return self.send_json(subdirs(arg("path")))

            if path == "/api/images":
                rel = rel_of(resolve(arg("path")))
                return self.send_listing(LIB.get(rel, force=arg("refresh") == "1"))

            if path == "/api/img":
                return self.serve_img(arg("p"), qs)

            if path == "/api/warm":
                if arg("cancel") == "1":
                    WARM["cancel"] = True
                    return self.send_json(dict(WARM))
                q = max(40, min(95, int(arg("q", "80") or 80)))
                fmt = "webp" if arg("f") == "webp" and HAS_WEBP else "jpeg"
                specs = parse_sizes(arg("s"), "s", q, fmt) + parse_sizes(arg("w"), "w", q, fmt)
                if not specs:
                    return self.send_json({"error": "s or w required"}, 400)
                rel = rel_of(resolve(arg("path")))
                return self.send_json(start_warm(rel, specs))

            if path == "/api/warm/status":
                return self.send_json(dict(WARM))

            if path == "/api/cache_stats":
                if arg("refresh") == "1":
                    JANITOR.poke()
                return self.send_json(JANITOR.get())

            return self.send_json({"error": "not found"}, 404)
        except PermissionError:
            return self.send_json({"error": "path not allowed"}, 403)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        except FileNotFoundError:
            return self.send_json({"error": "not found"}, 404)
        except Exception as e:  # noqa: BLE001
            try:
                return self.send_json({"error": f"{type(e).__name__}: {e}"}, 500)
            except OSError:
                return

    def serve_img(self, rel: str, qs: dict) -> None:
        if not rel:
            return self.send_json({"error": "p required"}, 400)
        fp = resolve(rel)
        if not os.path.isfile(fp):
            return self.send_json({"error": "not found"}, 404)
        rel = rel_of(fp)
        st = os.stat(fp)
        spec = parse_spec(qs)
        if spec is None:  # 原图：原样发文件，不转码、不进缓存
            ext = os.path.splitext(fp)[1].lower()
            name = os.path.basename(fp)
            return self.send_path(
                fp, RAW_TYPES.get(ext, "application/octet-stream"), "public, max-age=86400",
                f'"R{int(st.st_mtime)}-{st.st_size}"',
                {"Content-Disposition": "inline; filename*=UTF-8''" + quote(name)},
            )
        out = cache_file(rel, st, spec)
        if os.path.exists(out):
            touch(out)
        else:
            try:
                GEN.ensure(fp, [(spec, out)])
            except ValueError as e:
                return self.send_json({"error": f"cannot decode: {e}"}, 422)
        etag = '"' + os.path.basename(out).split(".")[0][:24] + '"'
        return self.send_path(out, spec.ctype, "public, max-age=31536000, immutable", etag)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64


def main() -> None:
    ap = argparse.ArgumentParser(description="imagewall")
    ap.add_argument("--port", type=int, default=_env_int("IMG_PORT", 8899))
    ap.add_argument("--host", default=os.environ.get("IMG_HOST", "0.0.0.0"))
    a = ap.parse_args()
    os.makedirs(CACHE_DIR, exist_ok=True)
    for r, real in zip(ROOTS, ROOTS_REAL):
        print(f"[wall] root {r} -> {real} exists={os.path.isdir(real)}", flush=True)
    threading.Thread(target=JANITOR.run, daemon=True).start()
    srv = Server((a.host, a.port), Handler)
    print(f"[wall] v{VERSION} on {a.host}:{a.port} workers={WORKERS} webp={HAS_WEBP} "
          f"cache_max={CACHE_MAX // 1048576}MB", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
