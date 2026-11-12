#!/usr/bin/env python3
"""生成本地测试用的假图库（彩色渐变 + 编号），不依赖任何真实图片。

  python tools/make_fixtures.py <输出目录> [张数]

会建出 图片/ 漫画/ 素材/ 三个根，里面有中文目录、深层目录、横竖图、超长图、透明 PNG、
一张坏图、一个 @eaDir 和 #recycle（应被跳过）。
"""
import colorsys
import os
import random
import sys

from PIL import Image, ImageDraw


def img(path, w, h, seed, mode="RGB"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    r = random.Random(seed)
    hue = r.random()
    c1 = tuple(int(v * 255) for v in colorsys.hsv_to_rgb(hue, 0.55, 0.85))
    c2 = tuple(int(v * 255) for v in colorsys.hsv_to_rgb((hue + 0.25) % 1, 0.7, 0.35))
    im = Image.new("RGB", (w, h))
    d = ImageDraw.Draw(im)
    for y in range(0, h, 4):
        t = y / max(1, h - 1)
        d.rectangle([0, y, w, y + 4], fill=tuple(int(a + (b - a) * t) for a, b in zip(c1, c2)))
    for _ in range(6):
        x, y, s = r.randint(0, w), r.randint(0, h), r.randint(min(w, h) // 10, min(w, h) // 3)
        d.ellipse([x - s, y - s, x + s, y + s], outline=(255, 255, 255), width=max(2, s // 12))
    d.text((min(w, h) // 12, min(w, h) // 12), f"#{seed}", fill=(255, 255, 255))
    if mode == "RGBA":
        im = im.convert("RGBA")
        im.putalpha(Image.new("L", (w, h), 160))
    ext = os.path.splitext(path)[1].lower()
    if ext in (".jpg", ".jpeg"):
        im.save(path, "JPEG", quality=85)
    elif ext == ".webp":
        im.save(path, "WEBP", quality=80)
    else:
        im.save(path)


def main():
    out = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 240
    r = random.Random(7)
    sizes = [(1600, 1200), (1200, 1600), (1920, 1080), (1080, 1920), (1000, 1000), (3000, 800), (600, 2600), (800, 600)]
    dirs = ["图片/插画", "图片/插画/2026/十一月", "图片/截图", "图片/壁纸 合集", "漫画/作品A/第01话", "漫画/作品A/第02话", "素材/纹理"]
    for i in range(n):
        d = dirs[i % len(dirs)]
        w, h = sizes[r.randrange(len(sizes))]
        ext = [".jpg", ".png", ".webp", ".jpeg"][i % 4]
        img(os.path.join(out, d, f"{i:05d}_p0{ext}"), w, h, i)
    img(os.path.join(out, "图片/透明.png"), 900, 900, 9001, "RGBA")
    os.makedirs(os.path.join(out, "图片/坏图"), exist_ok=True)
    with open(os.path.join(out, "图片/坏图/broken.jpg"), "wb") as f:
        f.write(b"not an image")
    for skip in ("图片/@eaDir", "图片/#recycle", "图片/.hidden"):
        img(os.path.join(out, skip, "skip.jpg"), 100, 100, 1)
    os.makedirs(os.path.join(out, "其他"), exist_ok=True)
    img(os.path.join(out, "其他/outside.jpg"), 100, 100, 2)
    print(f"fixtures -> {out} ({n} 张)")


if __name__ == "__main__":
    main()
