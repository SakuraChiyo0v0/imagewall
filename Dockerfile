# imagewall 镜像：Python + Pillow，代码打进镜像。
#
# CI 每次推送到 main / 打 v* 标签时构建并发到 ghcr.io/sakurachiyo0v0/imagewall
# （见 .github/workflows/image.yml）。本地构建：docker build -t imagewall:local .
FROM python:3.12-slim

# Pillow 的 manylinux 轮子自带 libjpeg / libwebp / zlib，不需要系统包
RUN pip install --no-cache-dir "Pillow>=10,<12" \
 && python -c "from PIL import features; assert features.check('webp'), 'Pillow 缺 WebP'"

# 跑成普通用户（uid 1000，和 NAS 上的主用户一致，挂载目录的写权限不用另外放）
RUN useradd -u 1000 -m wall
WORKDIR /app
COPY app/ /app/

ENV IMG_DATA_ROOT=/data \
    IMG_CACHE=/cache \
    IMG_STATE=/state \
    IMG_PORT=8899 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER wall
EXPOSE 8899
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8899/api/health', timeout=4).status == 200 else 1)"
ENTRYPOINT ["python", "/app/server.py"]
