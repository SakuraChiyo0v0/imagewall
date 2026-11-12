# imagewall

无界图片墙：选一个文件夹，把它和所有子文件夹里的图片铺成一张可以往任何方向一直拖的拼贴画布。

- 后端一个 Python 文件（标准库 + Pillow），前端原生 ES Module，无框架、无构建、无 npm 依赖
- 跑在 NAS 的 Docker 里，局域网浏览器 / 手机直接打开

## 功能

| | |
|-|-|
| 画布 | 无边界拖动、松手惯性、滚轮平移、Ctrl/⌘+滚轮或双指缩放（0.3–2.4×，平滑追随）、方向键滑动 |
| 形式 | 拼贴（按横竖图分配格子形状）/ 等高行（按原比例，几乎不裁切）/ 网格 / **照片马赛克**，设置里切换；**布局和选图都是坐标的纯函数**，拖走再回来还是同一张 |
| 换一批 | 换一个种子，得到另一套同样确定的布局（按文件夹记住） |
| 漫游 | 画布缓慢自动飘移，有人操作就停，停手后渐渐恢复 |
| 大图 | 从格子飞出、画布退到背后、背景是当前图的氛围光；两侧露出前后两张，拖动整条跟手；胶片条；`P` 幻灯片播放；滚轮 / 双击 / 双指放大到 8×，下滑关闭；可看原图 |
| 动效 | 加载前微光占位、入场由模糊到清晰、悬停微放大、切换文件夹淡出淡入；设置里可整体关闭 |
| 清晰度 | 按格子在屏幕上的实际像素（含设备像素比）取缩略图，停手后自动换更清晰的；四档上限，外网用「省流」 |
| 格式 | JPEG / WebP（同画质小约 30%） |
| 文件夹 | 逐级进入、面包屑、子目录图片数、输入筛选、键盘上下选择 |
| 预生成 | 按当前设置批量生成整个文件夹的缩略图；600 张以内的文件夹打开时自动在后台预热；前台有人看图时自动让路 |
| 记忆 | 设置、每个文件夹的视图位置与种子都存在 localStorage |

快捷键（大图里 `P` 播放、←/→ 切换）：`F` 文件夹　`S` 设置　`R` 换一批　`D` 漫游　`+`/`-`/`0` 缩放　方向键平移　`Esc` 关闭

## 性能相关的设计

- **视口裁剪 + 元素池**：只保留视口外一圈的块，离开的块回收复用，DOM 常驻几十到两百个节点
- **不闪**：已解码的缩略图进内存 LRU，块被回收后再出现直接放回；块出了更大的保留区才回收；换清晰图时新图盖在旧图上淡入
- **弱网自适应**：按实际耗时判断网速，慢时降并发、先只要小图
- **按距离排队加载**：同时最多 8 个请求，离视口中心（并向运动方向前瞻）最近的先加载；首次加载优先于升级清晰度；滑出视口的请求立即取消
- **后台解码**：`img.decode()` 解完再插进 DOM，滑动时不卡主线程
- **短边缩略图**：拼贴格是方的，缩略图按短边生成，超过 2.1:1 的长图先居中裁掉两头；尺寸吸附到固定档位，缓存不会碎
- **一次解码多份规格**：预生成时一张原图只解码一次，按从大到小依次缩出各档
- **清单只编码一次**：目录清单用紧凑数组格式（目录去重），JSON 与 gzip 在扫描时生成一次，带 ETag；子目录直接从已缓存的祖先清单里过滤；过期后先返回旧清单、后台重扫
- **缓存上限**：默认 8 GB，超过后按最久未访问清理（命中时刷新 mtime）
- **坏图记忆**：解码失败的图 10 分钟内不再重试

## 照片马赛克

每张图当一个「像素」：把目标图切成格子，每格挑颜色最接近的那张图填进去。远看是原图，放大后每格都是完整的一张照片。

- 主色在后台算（读图片尺寸时顺带），存 `state/colors.json`；`GET /api/palette` 一次给全部
- 同一张图的重复次数有上限，不会出现「一片蓝天全是同一张」
- 设置里可叠一层半透明原图（远看更清楚，放大后自动淡出）
- 马赛克下「换一批」= 换一张目标图；默认挑横图（竖图在横屏上会缩得很小）
- 它是有边界的画，其他三种形式仍是无限画布

1.2 万张图首次算出全部主色约十几分钟（只读文件头，后台慢慢跑，不挡前台）。

## 加一种展示形式

在 `app/static/js/layout/` 写一个模块，导出 `{ id, label, create(model) }`，`create` 返回
`{ query(x0, y0, x1, y1, cell, cb) }`：对世界坐标矩形内的每一块调用 `cb(key, x, y, w, h, 图片下标, 短边格数)`。
再在 `layout/index.js` 的 `LAYOUTS` 里登记一行。画布、加载、大图、设置面板都不用改。

`query` 必须是纯的：同一份清单、同一个种子、同一个矩形，永远吐出同样的块和图。`model` 里有每张图的宽高比（`aspect`）
和分类（`cls`），见 `layout/model.js`。

## 部署

```bash
docker compose -f deploy/docker-compose.yml up -d
```

镜像 `ghcr.io/sakurachiyo0v0/imagewall`，目录与升级见 [docs/部署.md](docs/部署.md)。

## 运行

```bash
pip install Pillow
IMG_DATA_ROOT=/path/to/data IMG_ROOTS=图片:漫画 IMG_CACHE=/tmp/wall-cache \
  python app/server.py --port 8899
```

| 环境变量 | 默认 | 说明 |
|-|-|-|
| `IMG_DATA_ROOT` | `/data` | 数据根 |
| `IMG_ROOTS` | `图片:漫画:素材` | 允许浏览的根目录，冒号分隔，相对数据根 |
| `IMG_CACHE` | `/cache` | 缩略图缓存目录 |
| `IMG_CACHE_MAX_MB` | `8192` | 缓存上限，`0` 不限 |
| `IMG_SCAN_TTL` | `60` | 目录清单多久算过期（秒） |
| `IMG_WORKERS` | `min(4, CPU)` | 同时生成缩略图的线程数 |

所有路径参数都会 `realpath` 后校验必须落在允许的根目录内，否则 403。

Docker 与 nginx 反代的部署方式见 [docs/部署.md](docs/部署.md)。

## 接口

| 路径 | 参数 | 返回 |
|-|-|-|
| `GET /api/roots` | — | `{roots, version, webp, buckets}` |
| `GET /api/folders` | `path` | `{path, parent, dirs:[{name, path, count?}], count?}`（只列一层；扫过的目录带图片数） |
| `GET /api/images` | `path`, `refresh` | `{path, count, dirs:[目录], files:[[目录序号, 文件名, mtime, 字节]]}`，mtime 倒序 |
| `GET /api/img` | `p` + `s`（短边）或 `w`（长边，`0` 原图）, `q`, `f=jpeg\|webp` | 图片；带 ETag 与 `immutable` |
| `GET /api/warm` | `path`, `s`/`w`（逗号分隔多档）, `q`, `f`；`cancel=1` 停止 | 预生成状态 |
| `GET /api/warm/status` | — | `{running, done, total, failed, path}` |
| `GET /api/cache_stats` | `refresh` | `{count, bytes, max}` |

## 测试

```bash
node --test test/layout.test.mjs          # 各形式：无空洞 / 无重叠 / 确定性 / 形状跟图走 / block 内不重复
python -m unittest discover -s test       # 后端：用生成的假图起真实 server 走 HTTP
```

端到端验收（视口覆盖率、首屏加载、拖动 / 缩放、大图、设置持久化、控制台报错），连一个 headless Chrome：

```bash
python tools/make_fixtures.py /tmp/wall-data 500
IMG_DATA_ROOT=/tmp/wall-data IMG_CACHE=/tmp/wall-cache python app/server.py --port 8899 &
chrome --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/wall-prof &
node test/e2e.mjs http://127.0.0.1:8899/ http://127.0.0.1:9333 /tmp/shots
node test/flicker.mjs http://127.0.0.1:8899/ http://127.0.0.1:9333   # 逐帧检测闪烁 + 模拟弱网
```

## 不做的事

上传 / 编辑 / 删除 / 收藏、账号系统（外网鉴权放在 nginx 层）、把图片写进数据库、旋转画布、瀑布流。

## License

MIT
