"""后端测试：python -m unittest discover -s test

起一个真实的 server（临时目录 + 生成的假图），走 HTTP 验证。
"""
import gzip
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="imagewall-test-")
        cls.data = os.path.join(cls.tmp, "data")
        cls.cache = os.path.join(cls.tmp, "cache")
        cls.state = os.path.join(cls.tmp, "state")
        subprocess.run([sys.executable, os.path.join(ROOT, "tools", "make_fixtures.py"), cls.data, "60"],
                       check=True, capture_output=True)
        cls.port = free_port()
        env = dict(os.environ, IMG_DATA_ROOT=cls.data, IMG_ROOTS="图片:漫画:素材", IMG_CACHE=cls.cache, IMG_STATE=cls.state,
                   IMG_CACHE_MAX_MB="0", PYTHONIOENCODING="utf-8")
        cls.proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "app", "server.py"),
                                     "--host", "127.0.0.1", "--port", str(cls.port)],
                                    env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        cls.base = f"http://127.0.0.1:{cls.port}"
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.base + "/api/health", timeout=1)
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def get(self, path, headers=None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        try:
            r = urllib.request.urlopen(req, timeout=20)
            return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def js(self, path):
        code, _h, body = self.get(path)
        self.assertEqual(code, 200, body[:200])
        return json.loads(body)

    def images(self, rel):
        d = self.js("/api/images?path=" + quote(rel))
        paths = [(d["dirs"][i] + "/" + n) for i, n, _t, _s, _a in d["files"]]
        return [p for p in paths if "坏图" not in p], d

    # ------------------------------------------------------------

    def test_roots_and_static(self):
        d = self.js("/api/roots")
        self.assertEqual([r["path"] for r in d["roots"]], ["图片", "漫画", "素材"])
        for p in ("/", "/static/style.css", "/static/js/main.js", "/static/js/layout/collage.js"):
            code, h, _ = self.get(p)
            self.assertEqual(code, 200, p)
        _c, h, _ = self.get("/static/js/main.js")
        self.assertIn("javascript", h["Content-Type"])  # ES module 必须是 JS MIME

    def test_static_etag_304(self):
        _c, h, _ = self.get("/static/style.css")
        code, _h, _ = self.get("/static/style.css", {"If-None-Match": h["ETag"]})
        self.assertEqual(code, 304)

    def test_scan_recursive_and_skips(self):
        paths, d = self.images("图片")
        self.assertEqual(d["count"], len(paths) + 1)  # +1 是坏图
        self.assertTrue(any("/2026/十一月/" in p for p in paths), "没递归进深层目录")
        self.assertFalse(any("@eaDir" in p or "#recycle" in p or "/.hidden/" in p for p in paths))
        self.assertTrue(all(p.startswith("图片/") for p in paths))

    def test_sub_listing_from_ancestor(self):
        all_, _ = self.images("图片")
        sub, _ = self.images("图片/插画")
        self.assertEqual(sub, [p for p in all_ if p.startswith("图片/插画/")])

    def test_sorted_by_mtime_desc(self):
        d = self.js("/api/images?path=" + quote("漫画"))
        ts = [f[2] for f in d["files"]]
        self.assertEqual(ts, sorted(ts, reverse=True))

    def test_gzip_and_etag(self):
        code, h, body = self.get("/api/images?path=" + quote("图片"), {"Accept-Encoding": "gzip"})
        self.assertEqual(h.get("Content-Encoding"), "gzip")
        json.loads(gzip.decompress(body))
        code, _h, _ = self.get("/api/images?path=" + quote("图片"), {"If-None-Match": h["ETag"]})
        self.assertEqual(code, 304)

    def test_path_traversal_403(self):
        for bad in ("其他", "图片/../其他", "../", "/etc", "图片/../../"):
            code, _h, _ = self.get("/api/images?path=" + quote(bad))
            self.assertEqual(code, 403, bad)
        code, _h, _ = self.get("/api/img?p=" + quote("其他/outside.jpg") + "&s=240")
        self.assertEqual(code, 403)

    def test_unencoded_chinese_path(self):
        # 原型的坑：http.server 按 latin-1 解请求行。这里服务端已还原，裸中文也能用
        s = socket.create_connection(("127.0.0.1", self.port))
        s.sendall("GET /api/folders?path=图片 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n".encode("utf-8"))
        resp = b""
        while chunk := s.recv(65536):
            resp += chunk
        s.close()
        self.assertIn(b"200 OK", resp.split(b"\r\n")[0])

    def test_folders_counts(self):
        self.images("图片")  # 先扫一次，folders 才能带数量
        d = self.js("/api/folders?path=" + quote("图片"))
        names = [x["name"] for x in d["dirs"]]
        self.assertIn("插画", names)
        self.assertNotIn("@eaDir", names)
        self.assertNotIn("#recycle", names)
        self.assertTrue(all("count" in x for x in d["dirs"]))
        self.assertEqual(d["parent"], "")

    def test_thumb_short_side_and_cache(self):
        from PIL import Image
        import io
        paths, _ = self.images("图片")
        p = paths[0]
        code, h, body = self.get("/api/img?p=" + quote(p) + "&s=300&q=70")
        self.assertEqual(code, 200)
        self.assertEqual(h["Content-Type"], "image/jpeg")
        im = Image.open(io.BytesIO(body))
        self.assertEqual(min(im.size), 320)  # 300 吸附到 320 档
        self.assertLessEqual(max(im.size) / min(im.size), 2.11)
        self.assertIn("immutable", h["Cache-Control"])
        code, _h, _ = self.get("/api/img?p=" + quote(p) + "&s=300&q=70", {"If-None-Match": h["ETag"]})
        self.assertEqual(code, 304)

    def test_long_image_cropped(self):
        from PIL import Image
        import io
        paths, _ = self.images("图片")
        # 找一张 3000x800 或 600x2600 的源图
        for rel in paths:
            with Image.open(os.path.join(self.data, rel)) as src:
                if max(src.size) / min(src.size) > 3:
                    break
        else:
            self.skipTest("没有超长图")
        _c, _h, body = self.get("/api/img?p=" + quote(rel) + "&s=240")
        im = Image.open(io.BytesIO(body))
        self.assertLessEqual(max(im.size) / min(im.size), 2.11)

    def test_long_edge_and_webp(self):
        from PIL import Image
        import io
        paths, _ = self.images("图片")
        code, h, body = self.get("/api/img?p=" + quote(paths[1]) + "&w=800&f=webp")
        self.assertEqual(code, 200)
        im = Image.open(io.BytesIO(body))
        self.assertEqual(max(im.size), 800)
        self.assertIn(h["Content-Type"], ("image/webp", "image/jpeg"))

    def test_transparent_png(self):
        code, _h, _ = self.get("/api/img?p=" + quote("图片/透明.png") + "&s=240")
        self.assertEqual(code, 200)

    def test_raw_passthrough(self):
        paths, _ = self.images("图片")
        p = next(x for x in paths if x.endswith(".png"))
        code, h, body = self.get("/api/img?p=" + quote(p) + "&w=0")
        self.assertEqual(code, 200)
        self.assertEqual(h["Content-Type"], "image/png")
        with open(os.path.join(self.data, p), "rb") as f:
            self.assertEqual(body, f.read())

    def test_broken_image_422(self):
        code, _h, body = self.get("/api/img?p=" + quote("图片/坏图/broken.jpg") + "&s=240")
        self.assertEqual(code, 422, body)
        code, _h, _ = self.get("/api/img?p=" + quote("图片/坏图/broken.jpg") + "&s=240")
        self.assertEqual(code, 422)  # 记住失败，不再重复解码

    def test_warm(self):
        d = self.js("/api/warm?path=" + quote("漫画") + "&s=160,240&w=800")
        self.assertTrue(d["started"])
        for _ in range(200):
            st = self.js("/api/warm/status")
            if not st["running"]:
                break
            time.sleep(0.1)
        self.assertEqual(st["done"], st["total"])
        self.assertEqual(st["failed"], 0)
        stats = self.js("/api/cache_stats?refresh=1")
        self.assertIn("bytes", stats)

    def test_dims_backfilled(self):
        """尺寸后台补：第一次清单里 aspect 可能是 0，等补完后的清单要带上真实宽高比。"""
        from PIL import Image
        self.js("/api/images?path=" + quote("素材"))
        for _ in range(100):
            if self.js("/api/health")["dimsPending"] == 0:
                break
            time.sleep(0.1)
        time.sleep(0.3)
        d = self.js("/api/images?path=" + quote("素材"))
        self.assertEqual(d["dims"]["missing"], 0)
        for di, n, _t, _s, a in d["files"]:
            with Image.open(os.path.join(self.data, d["dirs"][di], n)) as im:
                self.assertEqual(a, round(im.size[0] * 100 / im.size[1]), n)
        # 尺寸是要长期保留的数据，存在数据目录，不进缩略图缓存目录
        self.assertTrue(os.path.exists(os.path.join(self.state, "dims.json")))
        self.assertFalse(os.path.exists(os.path.join(self.cache, "dims.json")))

    def test_dims_migrates_from_cache(self):
        """旧部署的 dims.json 在缓存目录：新版第一次启动要搬到数据目录，旧文件保留。"""
        tmp = tempfile.mkdtemp(prefix="imagewall-mig-")
        try:
            cache, state = os.path.join(tmp, "cache"), os.path.join(tmp, "state")
            os.makedirs(cache)
            with open(os.path.join(cache, "dims.json"), "w", encoding="utf-8") as f:
                json.dump({"abc": [4, 3]}, f)
            port = free_port()
            env = dict(os.environ, IMG_DATA_ROOT=self.data, IMG_ROOTS="图片", IMG_CACHE=cache, IMG_STATE=state,
                       PYTHONIOENCODING="utf-8")
            p = subprocess.Popen([sys.executable, os.path.join(ROOT, "app", "server.py"),
                                  "--host", "127.0.0.1", "--port", str(port)],
                                 env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    if os.path.exists(os.path.join(state, "dims.json")):
                        break
                    time.sleep(0.1)
                with open(os.path.join(state, "dims.json"), encoding="utf-8") as f:
                    self.assertEqual(json.load(f).get("abc"), [4, 3])
                self.assertTrue(os.path.exists(os.path.join(cache, "dims.json")))
            finally:
                p.terminate()
                p.wait(5)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_palette(self):
        """色板：按清单顺序给每张图一个 24 位颜色；还没算出来的记 -1，之后会补上。"""
        d = self.js("/api/images?path=" + quote("图片"))
        pal = self.js("/api/palette?path=" + quote("图片"))
        self.assertEqual(pal["count"], d["count"])
        self.assertEqual(len(pal["colors"]), d["count"])
        for _ in range(150):
            if self.js("/api/health")["dimsPending"] == 0:
                break
            time.sleep(0.1)
        pal = self.js("/api/palette?path=" + quote("图片"))
        self.assertEqual(pal["missing"], 0, pal["missing"])
        for c in pal["colors"]:
            self.assertGreaterEqual(c, 0)
            self.assertLessEqual(c, 0xFFFFFF)
        # 颜色要和「按方形中心区域取平均」对得上。
        # 色板按扫描顺序（mtime 倒序），和清单里的 files 是同一顺序，但同一 mtime 时
        # 排序可能不同，所以直接按色板回归，先用服务端自己算的值核对一张
        from PIL import Image, ImageOps
        di, n = d["files"][0][0], d["files"][0][1]
        with Image.open(os.path.join(self.data, d["dirs"][di], n)) as im:
            im = ImageOps.exif_transpose(im)
            # 带透明的图：服务端按格子底色混，测试也要一致
            if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
                im = im.convert("RGBA")
                bg = Image.new("RGB", im.size, (17, 19, 24))
                bg.paste(im, mask=im.getchannel("A"))
                im = bg
            else:
                im = im.convert("RGB")
            w, h = im.size
            side = min(w, h)
            box = im.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))
            r, g, bl = box.resize((1, 1), Image.BOX).getpixel((0, 0))
        # 找这张图在色板里的位置（按路径匹配，别假设两边顺序完全一致）
        want_path = d["dirs"][di] + "/" + n
        idx = next(i for i, f in enumerate(d["files"]) if d["dirs"][f[0]] + "/" + f[1] == want_path)
        self.assertEqual(pal["colors"][idx], (r << 16) | (g << 8) | bl)

    def test_palette_etag(self):
        code, h, _ = self.get("/api/palette?path=" + quote("图片"), {"Accept-Encoding": "gzip"})
        self.assertEqual(code, 200)
        self.assertEqual(h.get("Content-Encoding"), "gzip")
        code, _h, _ = self.get("/api/palette?path=" + quote("图片"), {"If-None-Match": h["ETag"]})
        self.assertEqual(code, 304)

    def test_404_and_400(self):
        self.assertEqual(self.get("/api/nope")[0], 404)
        self.assertEqual(self.get("/api/img")[0], 400)
        self.assertEqual(self.get("/static/../server.py")[0], 404)


if __name__ == "__main__":
    unittest.main()
