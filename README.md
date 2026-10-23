# 音乐服务器（MusicServer）

多平台音乐聚合 API 服务器，无需浏览器环境。

> **v2.0（Python 版，当前默认分支）**：服务端已全量迁移到 Python 3.12 + FastAPI，14 个平台、
> 各平台登录通道与 Node 版 v1.x 功能对齐（外部音源脚本加载暂未移植）。
> Node/TypeScript 实现（v1.x）保留在 `master` 分支。

## 功能

- **多平台聚合**：酷我（kw）、酷狗（kg）、QQ音乐（tx）、网易云（wy）、咪咕音乐（mg）、千千音乐（bd）、JOOX（joox）、哔哩哔哩（bili）、5sing（5sing）；有声平台：喜马拉雅（xm）、猫耳FM（me）、蜻蜓FM（qt）、懒人听书（lr）；Apple Music（apple，仅 preview 试听）
- **直连取流**：各平台播放地址获取（不依赖第三方 API 服务）
- **完整链路**：搜索、播放地址、歌词（含各平台加密歌词解码）、封面、榜单、热搜、歌单、专辑、歌手、链接解析（歌单/专辑/歌曲网页链接）
- 有声平台（xm/me/qt/lr）与 Apple Music（仅试听）不参与聚合搜索与跨平台匹配，仅支持 source 直查

## 平台能力速查

| 平台 | id | 搜索 | 取流音质 | 歌词 | 封面 | 歌单 | 专辑 | 链接解析 | 登录 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 酷我音乐 | `kw` | ✅ | 128k/320k/flac/flac24bit | ✅ | ✅ | ✅ 列表/详情 | ✅ 搜索/详情 | ✅ 歌曲/专辑/歌单 | — |
| 酷狗音乐 | `kg` | ✅ | 128k/320k/flac/flac24bit | ✅ | ✅ | ✅ 列表/详情 | ✅ 搜索/详情 | ✅ 歌曲/专辑/歌单 | 扫码/短信/账密/token |
| QQ音乐 | `tx` | ✅ | 128k/320k/flac/flac24bit | ✅ | ✅ | ✅ 列表/详情 | ✅ 搜索/详情 | ✅ 歌曲/专辑/歌单 | 扫码/cookie |
| 网易云 | `wy` | ✅ | 128k/320k/flac/flac24bit | ✅ | ✅ | ✅ 列表/详情 | ✅ 搜索/详情 | ✅ 歌曲/专辑/歌单 | 扫码/手机号 |
| 咪咕音乐 | `mg` | ✅ | 64k/128k/320k/flac/flac24bit | ✅ | ✅ | ✅ 搜索/详情/分类 | ✅ 搜索/详情 | ✅ 歌曲/专辑/歌单 | cookie（解锁高档位） |
| 千千音乐 | `bd` | ✅ | 64k/128k/320k/flac | ✅ | ✅ | ✅ 详情/分类 | ✅ 搜索/详情 | ✅ 歌曲/专辑/歌单 | cookie（VIP 曲目） |
| JOOX | `joox` | ✅ | 128k（VIP 为试听片段） | ✅ | ✅ | ✅ 搜索/详情/分类 | ✅ 搜索/详情 | ✅ 歌曲/专辑/歌单 | cookie（VIP 完整曲） |
| 哔哩哔哩 | `bili` | ✅ | 64k/128k/320k/flac/flac24bit（实际命中 B站档位 132k/192k；flac/Hi-Res 需大会员） | ✅ | ✅ | ✅ 搜索/详情（合集/多分P） | — | ✅ 歌曲/歌单 | 扫码 |
| 5sing | `5sing` | ✅ | sq/hq/lq | ✅ | — | ✅ 搜索/详情 | — | ✅ 歌曲/歌单 | cookie（可选） |
| Apple Music | `apple` | ✅ | preview 试听片段 | ✅（需登录） | ✅ | ✅ 搜索/详情/分类 | ✅ 搜索/详情 | ✅ 歌曲/专辑/歌单 | cookie（media-user-token） |
| 喜马拉雅 | `xm` | ✅ | 64k/128k | — | ✅ | — | ✅ 详情 | — | cookie |
| 猫耳FM | `me` | ✅ | 64k/128k | — | ✅ | — | ✅ 详情 | — | token |
| 蜻蜓FM | `qt` | ✅ | 64k/128k | — | ✅ | — | ✅ 详情 | — | — |
| 懒人听书 | `lr` | ✅ | 64k/128k | — | ✅ | — | ✅ 详情 | — | 账密 |

> 能力位以 `GET /sources` 返回为准（含 `albumSearch`/`playlist`/`parse` 等新增能力位）。

## 快速开始（v2.0 Python）

依赖 [uv](https://docs.astral.sh/uv/)（Python 3.12，见 `.python-version`）：

```bash
uv sync                                          # 安装依赖（FastAPI/uvicorn/aiohttp/cryptography/qrcode 等）
uv run uvicorn app.main:app --host 0.0.0.0 --port 16688
                                                 # 默认端口 16688；也可用 PORT 环境变量 + --port $PORT
uv run ruff check app && uv run ruff format --check app   # 规范检查
uv run pyright                                   # 类型检查（基础模式）
uv run pytest                                    # 单元测试（tests/）
```

环境变量（`PORT`、`AUTH_KEY`、`RATE_LIMIT`、`DATA_DIR` 等）可写入项目根目录的 `.env` 文件（已 gitignore），启动时自动加载；已存在的真实环境变量优先于 `.env` 文件值。登录凭据持久化在 `data/auth.json`（0600，原子写入）。

Node/TypeScript 版（v1.x，`master` 分支）：`pnpm install && pnpm start`（需 Node 22.18+，直接运行 `.ts`）。

### 服务器与事件循环（uvicorn / granian）

`scripts/serve.py` 统一启动入口。默认组合按平台确定：

| 平台 | 默认服务器 | 默认事件循环 |
| --- | --- | --- |
| Windows | granian | winloop（未安装则 asyncio） |
| Linux / macOS | granian | rloop（未安装则 uvloop → asyncio） |
| Windows + `--server uvicorn` | uvicorn | asyncio（uvicorn 不支持 winloop） |
| Linux / macOS + `--server uvicorn` | uvicorn | uvloop（未安装则 asyncio） |

事件循环可用 `auto / asyncio / rloop / uvloop / winloop`，参数与环境变量等价
（`SERVER` / `LOOP` / `HOST` / `PORT` / `WORKERS` / `RELOAD`）。`auto` 会在启动器内解析成上表中的具体循环，
启动日志会打印实际使用的组合；显式请求当前平台不可用的循环会直接报错并列出可用项（不会静默降级）。

```bash
uv sync                                                 # 默认依赖已含 granian[rloop/uvloop/winloop/reload]
uv run python scripts/serve.py                          # Windows → granian+winloop；Unix → granian+rloop
uv run python scripts/serve.py --server uvicorn         # Unix → uvicorn+uvloop；Windows → uvicorn+asyncio
uv run python scripts/serve.py --loop rloop             # 仅 Unix（Rust 事件循环）
uv run python scripts/serve.py --loop uvloop            # 仅 Unix
uv run python scripts/serve.py --loop winloop           # 仅 Windows
uv run python scripts/serve.py --server granian --reload    # 热重载（强制单 worker）
```

| 事件循环 | 平台 | 说明 |
| --- | --- | --- |
| `asyncio` | 全平台 | 标准库，始终可用 |
| `rloop` | Unix | Rust 事件循环（`rloop` 包，Windows 无 wheel） |
| `uvloop` | Unix | libuv 事件循环 |
| `winloop` | Windows | uvloop 的 Windows 实现 |

granian 也支持显式指定与默认不同的循环（如 Unix 上 `--loop uvloop`、Windows 上 `--loop asyncio`）。

## HTTP 接口

接口统一为路径参数风格（`/search`、`/find` 搜索类使用 query 参数）。

| 接口 | 说明 |
| --- | --- |
| `GET /search/:source/:keyword[/:page]` | 搜索歌曲：平台 id 或 all（聚合，排除 xm/me/qt/lr/apple）；第 1 页可省略页码段，下一页 `/search/kw/稻香/2`；?singer= 附加歌手、?limit= 每页条数 |
| `GET /find/:source/:keyword` | 精确匹配搜索（source 为平台 id 或 all；?singer= ?albumName= ?interval= 辅助匹配，all 时 ?excludeSource= 跳过平台） |
| `GET /url/:source/:id?quality=320k` | 获取播放地址（quality: 64k/128k/320k/flac/flac24bit）。取流链：SDK 直连 → 酷我兜底（跨平台匹配，响应 `via` 字段标记实际命中通道） |
| `GET /stream/:source/:id` | 加密流解密代理（`mg` 咪咕 Z3D/I3D 加密流）。取流响应返回相对地址时使用，服务端下载上游密流并在本地解密回明文音频 |
| `GET /lyric/:source/:id` | 获取歌词（返回 lyric/tlyric/yrc） |
| `GET /pic/:source/:id` | 获取封面 |
| `GET /boards/:source` | 榜单列表 |
| `GET /boards/:source/:boardId[/:page]` | 榜单详情（分页 path 段，第 1 页省略） |
| `GET /hot-search/:source` | 热搜列表 |
| `GET /song-list/:source[/:page]` | 歌单列表（分页 path 段） |
| `GET /singer/:source/:id` | 歌手信息（kg/tx/wy） |
| `GET /singer/:source/:id/songs[/:page]?limit=30` | 歌手歌曲列表（kg/tx/wy） |
| `GET /singer/:source/:id/albums[/:page]?limit=10` | 歌手专辑列表（kg/tx/wy） |
| `GET /album/:source/:id[/:page]` | 专辑详情与曲目（分页为 path 段，第 1 页省略）。支持 kg/kw/tx/wy/xm/me/qt/lr/mg/bd/joox/apple |
| `GET /album/:source/search/:keyword` | 专辑搜索（kg/kw/tx/wy/mg/bd/joox/apple） |
| `GET /playlist/:source/search/:keyword` | 歌单搜索（kg/kw/tx/wy/mg/bd/joox/bili/5sing/apple） |
| `GET /playlist/:source/categories` | 歌单分类（kw/kg/tx/wy/mg/bd/joox/bili/5sing/apple） |
| `GET /playlist/:source/categories/:categoryId` | 分类下的歌单（同上） |
| `GET /playlist/:source/:id[/:page]?limit=` | 歌单详情与曲目（kw/kg/tx/wy/mg/bd/joox/bili/5sing/apple；bili 支持合集/多分P） |
| `POST /parse/song/:source` 等 | 链接解析：body `{ "link": "..." }`，三个端点 `parse/song` / `parse/album` / `parse/playlist`。支持 kw/kg/tx/wy/5sing/apple/bili/joox/bd/mg（其中 bili、5sing 无 album 端点） |
| `GET /user-playlist/:source` | 个人歌单（仅 tx/wy 有完整实现；需登录，未登录或平台不支持返回 404/502） |
| `POST /login/wy/qr` → `POST /login/wy/qr/check` | 网易云扫码登录（扫码后轮询完成登录） |
| `POST /login/wy/cellphone` | 网易云手机号登录（password 或 captcha） |
| `POST /login/kg/qr` → `POST /login/kg/qr/check` | 酷狗扫码登录（扫码后轮询完成登录） |
| `POST /login/kg/captcha` → `POST /login/kg/cellphone` | 酷狗手机验证码登录 |
| `POST /login/kg/password` | 酷狗账号密码登录（触发 20028 风控时返回 needVerify 挑战，配合 `/login/kg/verify` 提交图形/短信验证后重试） |
| `POST /login/kg/verify` | 提交酷狗风控验证结果（verifycode 为图形验证凭证或短信码） |
| `POST /login/kg` + `userid` | 绑定酷狗 token（App 抓包获取，服务端验证） |
| `POST /login/tx/qr` → `POST /login/tx/qr/check` | QQ 音乐扫码登录（QQ/微信扫一扫，扫码后轮询完成登录） |
| `POST /login/tx` | 绑定 QQ 音乐 cookie（y.qq.com 复制，可选 App 抓包字段供自动续期） |
| `POST /login/xm` | 绑定喜马拉雅 cookie（www.ximalaya.com 复制，须含 `1&_token`，解锁付费/已购内容取流） |
| `POST /login/me` | 绑定猫耳FM token（App 抓包或 m.missevan.com 复制，须含 `token=`，解锁付费声音取流） |
| `POST /login/lr` | 懒人听书账号登录（account+password，懒人取流要求登录态，免费章节同样） |
| `POST /login/bili/qr` → `POST /login/bili/qr/check` | 哔哩哔哩扫码登录（B站 App 扫一扫，登录后解锁大会员音质） |
| `DELETE /login/{wy,kg,tx,xm,me,lr,bili}` | 清除对应平台凭据（退出登录） |
| `GET /login/status` | 登录状态（登录后取流/请求自动携带凭据） |
| `GET /sources` | 平台列表（音质与能力） |
| `GET /health` | 健康检查 |
| `GET /docs` `/redoc` `/openapi.json` | 接口文档（Swagger UI / ReDoc / OpenAPI 3.1） |

统一返回格式：`{ code: 0, data: ... }` 成功；`{ code: 非0, msg: ... }` 失败。状态码语义：422 参数校验失败、404 接口或平台不存在、405 方法不允许（带 Allow 头）、502 上游平台失败。

所有接口默认返回 `Access-Control-Allow-Origin: *`，可直接在浏览器/前端调用。

## 歌曲 ID 约定

- **kw / tx / wy**：`songmid`（如 `228908`、`0039MnYb0qxYhV`）
- **kg**：`hash`（搜索结果的 `hash` 字段）；VIP/付费歌需 `/login/kg` 登录后取流
- **xm**：track id（搜索/专辑结果的 `songmid` 字段）；匿名可取免费曲目（64k/128k 有声档位），付费/VIP 内容 `POST /login/xm` 绑定 cookie 后取流
- **me**：声音 id（搜索结果的 `songmid` 字段）；走 App API 签名通道取免签名明文直链（m4a），匿名可取免费声音，付费内容 `POST /login/me` 绑定 token 后取流
- **qt**：`<channelId>:<programId>` 复合 id（/album/qt 节目列表产出）；audiostream 签名直链（302 到华为云 CDN），匿名可取免费节目
- **lr**：`<bookId>:<section>` 复合 id（/album/lr 章节列表产出）；取流必须 `POST /login/lr` 登录（免费章节同样要求登录态）
- **mg**：`<contentId>|<resourceType>|<formatType>` 三元组（搜索结果/专辑/歌单产出）；取流走 listen-url 多档候选链 + 逐档 Range 探测，命中可访问的最高档（匿名实测可出 flac24bit 真无损），Z3D/I3D 加密流自动改走 `/stream/mg` 解密代理
- **bd**：track id（T 开头，搜索结果的 `songmid`）；免费曲目匿名可出 128k/320k/flac 明文直链，VIP/版权曲目需 cookie
- **joox**：加密后的 track id（含 `=`/`+`，URL 编码后传）；游客 128k，VIP 完整曲需 cookie（`wmid`+`session_key`）
- **bili**：`<bvid>|<cid>`（搜索结果/合集曲目产出）；合集/歌单 id 形如 `season:<id>:<mid>:<bvid>` 或 `bvid:<bvid>`
- **5sing**：`<songId>|<songType>`（如 `932557|yc`，songType 为 yc 原创 / fc 翻唱 / bz 伴奏），URL 路径需编码 `|` 为 `%7C`
- **apple**：数字歌曲 id（搜索结果产出）；取流固定为 `preview` 试听片段（完整曲为 DRM，不在支持范围）

`/url` 在平台直连失败时，自动降级到**酷我**兜底：按歌名/歌手/时长匹配同一首歌后走 kw 通道（匿名可拿无损）。kg 可由 hash 反查歌曲信息；其它平台需要兜底时给 `/url` 传 `name`/`singer`/`interval` 查询参数。

## 调用鉴权与限流

### 调用秘钥（AUTH_KEY）

设置环境变量 `AUTH_KEY` 后，**全部路径**（含文档页、健康检查、不存在的路径）都要求调用秘钥——未授权请求统一返回 401，不暴露 404/401 差异，防止接口被扫描探测。未设置则不鉴权。

```
X-Server-Key: <AUTH_KEY>      # 统一验证头（全部路径）
?exp=&sig=                     # 仅 /stream/* 流代理：短时签名（/url 返回的流地址自动附带）
```

流代理场景（播放器/下载器直接 GET、无法带自定义头）用**短时签名**而非裸秘钥：`/url` 返回的流地址自动附带 `?exp=&sig=`（HMAC 派生，10 分钟有效）——签名泄露仅能在时效窗口内拉当条流，无法反推秘钥或调用其它接口；能带头的客户端仍可对 /stream/* 使用 X-Server-Key。

### 限流（RATE_LIMIT）

per-IP 滑动窗口限流，`RATE_LIMIT` 为每 IP 每分钟允许的请求数（默认 120，设 0 关闭）。超限返回 429 + Retry-After；鉴权失败的请求同样计数（防秘钥爆破）。

## 汽水音乐（已拆分）

汽水音乐（`qs`）已拆分为独立服务端 **SodaServer**（`gitea.4i.hk/hhhge/SodaServer`，本地与 MusicServer 同级）：API 路径兼容（`/search/qs`、`/url/qs`、`/stream/qs`、`/login/qs/*`），凭据文件格式同源可互迁；PC 签名继续复用 qs-signer 部署。

## 外部音源

**v2.0 未移植外部音源加载**（`SOURCE_ENABLED` / `sources/*.js` / `*.mjs` 候选链与 isolated-vm 沙箱不在本分支）。
需要时请使用 `master` 分支的 v1.x（详见该分支 README 与 `docs/source-ivm.md`、`docs/source-simple.md`）。

## 项目结构（v2.0）

```
app/                    Python 应用（FastAPI，Python 3.12）
  main.py               HTTP 入口（装配中间件/异常处理/OpenAPI/路由 + lifespan）
  config.py             环境变量、.env 加载、端口/鉴权/限流/数据目录
  routes/
    music.py            业务路由（搜索/取流/歌词/封面/榜单/歌单/专辑/歌手/解析/流代理）
    login.py            登录路由（wy/kg/tx/bili 扫码与短信账密、xm/me cookie、lr 账密）
    refresh.py          登录态自动续期（启动后延时首轮 + 每 24h，kg/tx）
    system.py           /health、/sources
  http/
    api_error.py        业务错误（统一 JSON 响应）
    auth_gate.py        调用秘钥鉴权（AUTH_KEY，全路径防扫描；/stream/* 可用短时签名）
    rate_limit.py       per-IP 滑动窗口限流（RATE_LIMIT）
    envelope.py         成功响应信封 { code: 0, data }
    stream_sign.py      /stream/* 流地址短时签名（HMAC，10 分钟）
    mg_stream.py        咪咕加密流票据与逐块解密管道
  openapi/
    components.py       OpenAPI 共享 schema
    ui.py               ReDoc 页面
  sdk/
    __init__.py         平台注册表、聚合搜索、跨平台精确匹配
    types.py            契约类型（SongInfo / MusicUrlResult 等）
    auth_store.py       凭据持久化（data/auth.json，0600 + 原子替换）
    common/             request（aiohttp 直连，不跟随 302、保留多值 Set-Cookie）、
                        utils（size_formate/format_play_time/as_dict 等）、qrcode
    auth/               登录协议（wy/kg/kg_simulate/tx/lr/bili）
    apis/               各平台官方直连取流（14 平台，含 CDN 选址/档位降级）
    platforms/          平台模块（每平台一个包，MODULE: Platform + 子模块）
scripts/
  serve.py              启动器（uvicorn / granian，事件循环 rloop/uvloop/winloop 选择与校验）
docs/
  PORTING.md            TS → Python 平台移植契约（目录/子模块协议/签名差异/验收要求）
pyproject.toml          uv 项目定义（默认 granian/uvicorn 依赖、ruff、pyright、pytest 配置）
tests/
  test_serve.py         启动器服务器/循环选择逻辑测试（TS 版 smoke 测试尚未移植）
```

> 分层依赖单向：`routes` → `sdk`，`sdk` 内部自包含。全源码 `.py` 由 uv 管理的 CPython 3.12 直接运行，
> 无编译产物；`ruff` 负责风格与静态检查，`pyright` 负责类型检查。TS 版对照见 `master` 分支。

## 已知限制

- **kg 取流**：匿名仅能获取部分免费资源，VIP/付费歌需 `/login/kg` 登录（扫码/短信/token 均可）后取流，成功响应解析见 `app/sdk/apis/kg.py` 头注释。
- **kw 取流**：主通道 mobi.s 严格校验「返回 bitrate == 请求档位且为明文格式」，档位缺失时沿降级链换档（flac24bit→flac→320k→128k）；web playUrl 回退通道匿名恒 128k。
- **mg 取流**：匿名 PQ(128k) 永远可用，但候选链会优先探测更高档位——多数曲目实际能匿名拿到 SQ/ZQ 真无损直链（上游同款 tone 路径重写 + 逐档探测）；Z3D/I3D 加密候选经 `/stream/mg` 解密后同样可播。HQ/SQ 返回「登录后免费试听」时自动降级到可用的最高档。
- **apple 取流**：只有 preview 试听片段（约 30–90s，AAC/m4a），返回的 `type` 固定为 `preview`，不要当作完整曲。
- **bili 取流**：匿名最高 192k；flac/Hi-Res 需 `/login/bili/qr` 登录大会员账号。CDN 有约 1 小时的 `deadline` 签名，取流结果不宜缓存过久。
- **xm 取流**：签名依赖 `hdaa.shuzilm.cn` 的设备上报；请求层必须直连（不走系统代理，Node 版语义一致）。
- **5sing 歌词**：2026-10-23 实测匿名 `newget` 不返回 `dynamicWords`（搜索结果与多个关键词均如此，Node 版同样），拿不到时接口如实报错。
- **5sing 歌单详情**：依赖 5sing 网页（`5sing.kugou.com/.../dj/...html`）解析曲目；2026-10-02 曾整体 502，2026-10-23 实测已恢复。
- **link 解析**：`/parse/*` 走各平台网页链接解析（需上游有对应实现）；未实现的平台返回 404。
- **多 worker**：限流计数、登录续期调度、咪咕加密流票据都是进程内状态；`WORKERS>1` 时各自独立
  （续期会重复执行、`/stream/mg` 票据可能落到别的 worker）。默认单 worker，多 worker 部署需自行加粘性会话。
- 平台接口随时可能变更，遇失效时可对照 `app/sdk/apis/` 内的接口文档调整。
