# 音乐服务器（MusicServer）

多平台音乐聚合 API 服务器，纯 Node.js 实现，无需浏览器环境。

## 功能

- **多平台聚合**：酷我（kw）、酷狗（kg）、QQ音乐（tx）、网易云（wy）、汽水音乐（qs）、咪咕音乐（migu）、千千音乐（bd）、JOOX（jx）、哔哩哔哩（bl）、5sing（5s）；有声平台：喜马拉雅（xm）、猫耳FM（me）、蜻蜓FM（qt）、懒人听书（lr）；Apple Music（apple，仅 preview 试听）
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
| 汽水音乐 | `qs` | ✅ | 128k/320k（登录解锁无损） | ✅ | ✅ | — | — | — | 扫码 |
| 咪咕音乐 | `migu` | ✅ | 64k/128k/320k/flac/flac24bit | ✅ | ✅ | ✅ 搜索/详情/分类 | ✅ 搜索/详情 | ✅ 歌曲/专辑/歌单 | cookie（解锁高档位） |
| 千千音乐 | `bd` | ✅ | 64k/128k/320k/flac | ✅ | ✅ | ✅ 详情/分类 | ✅ 搜索/详情 | ✅ 歌曲/专辑/歌单 | cookie（VIP 曲目） |
| JOOX | `jx` | ✅ | 128k（VIP 为试听片段） | ✅ | ✅ | ✅ 搜索/详情/分类 | ✅ 搜索/详情 | ✅ 歌曲/专辑/歌单 | cookie（VIP 完整曲） |
| 哔哩哔哩 | `bl` | ✅ | 64k/128k/320k/flac/flac24bit（实际命中 B站档位 132k/192k；flac/Hi-Res 需大会员） | ✅ | ✅ | ✅ 搜索/详情（合集/多分P） | — | ✅ 歌曲/歌单 | 扫码 |
| 5sing | `5s` | ✅ | sq/hq/lq | ✅ | — | ✅ 搜索/详情 | — | ✅ 歌曲/歌单 | cookie（可选） |
| Apple Music | `apple` | ✅ | preview 试听片段 | ✅（需登录） | ✅ | ✅ 搜索/详情/分类 | ✅ 搜索/详情 | ✅ 歌曲/专辑/歌单 | cookie（media-user-token） |
| 喜马拉雅 | `xm` | ✅ | 64k/128k | — | ✅ | — | ✅ 详情 | — | cookie |
| 猫耳FM | `me` | ✅ | 64k/128k | — | ✅ | — | ✅ 详情 | — | token |
| 蜻蜓FM | `qt` | ✅ | 64k/128k | — | ✅ | — | ✅ 详情 | — | — |
| 懒人听书 | `lr` | ✅ | 64k/128k | — | ✅ | — | ✅ 详情 | — | 账密 |

> 能力位以 `GET /sources` 返回为准（含 `albumSearch`/`playlist`/`parse` 等新增能力位）。

## 快速开始

```bash
pnpm install
pnpm start       # 默认端口 16688，可用 PORT 环境变量修改（需 Node 22.18+，直接运行 .ts）
pnpm dev         # 开发模式：node --watch 热重载，改动 src/、sdk/ 代码自动重启
pnpm test        # 类型检查（tsc）+ 冒烟测试（自动启动/关闭本地服务器）
pnpm typecheck   # 仅类型检查，不运行
```

环境变量（`PORT`、`SOURCE_*` 等）可写入项目根目录的 `.env` 文件（已 gitignore），启动时自动加载；已存在的真实环境变量优先于 `.env` 文件值。

## HTTP 接口

接口统一为路径参数风格（`/search`、`/find` 搜索类使用 query 参数）。

| 接口 | 说明 |
| --- | --- |
| `GET /search/:source/:keyword[/:page]` | 搜索歌曲：平台 id 或 all（聚合，排除 xm/me/qt/lr）；第 1 页可省略页码段，下一页 `/search/kw/稻香/2`；?singer= 附加歌手、?limit= 每页条数 |
| `GET /find/:source/:keyword` | 精确匹配搜索（source 为平台 id 或 all；?singer= ?albumName= ?interval= 辅助匹配，all 时 ?excludeSource= 跳过平台） |
| `GET /url/:source/:id?quality=320k` | 获取播放地址（quality: 64k/128k/320k/flac/flac24bit）。取流链：外部音源（启用时）→ SDK 直连 → 酷我兜底（跨平台匹配，响应 `via` 字段标记实际命中通道） |
| `GET /stream/:source/:id` | 加密流解密代理（source 用 path 段区分：`qs`=汽水解密流、`migu`=咪咕 Z3D/I3D 加密流）。取流响应返回相对地址时使用，服务端下载上游密流并在本地解密回明文音频 |
| `GET /lyric/:source/:id` | 获取歌词（返回 lyric/tlyric/yrc） |
| `GET /pic/:source/:id` | 获取封面 |
| `GET /boards/:source` | 榜单列表 |
| `GET /boards/:source/:boardId[/:page]` | 榜单详情（分页 path 段，第 1 页省略） |
| `GET /hot-search/:source` | 热搜列表 |
| `GET /song-list/:source[/:page]` | 歌单列表（分页 path 段） |
| `GET /singer/:source/:id` | 歌手信息（kg/tx/wy） |
| `GET /singer/:source/:id/songs[/:page]?limit=30` | 歌手歌曲列表（kg/tx/wy） |
| `GET /singer/:source/:id/albums[/:page]?limit=10` | 歌手专辑列表（kg/tx/wy） |
| `GET /album/:source/:id[/:page]` | 专辑详情与曲目（分页为 path 段，第 1 页省略）。支持 kg/kw/tx/wy/xm/me/qt/lr/migu/bd/jx/apple |
| `GET /album/:source/search/:keyword` | 专辑搜索（kg/kw/tx/wy/migu/bd/jx/apple） |
| `GET /playlist/:source/search/:keyword` | 歌单搜索（kg/kw/tx/wy/migu/bd/jx/bl/5s/apple） |
| `GET /playlist/:source/categories` | 歌单分类（kw/kg/tx/wy/migu/bd/jx/bl/5s/apple） |
| `GET /playlist/:source/categories/:categoryId` | 分类下的歌单（同上） |
| `GET /playlist/:source/:id[/:page]?limit=` | 歌单详情与曲目（kw/kg/tx/wy/migu/bd/jx/bl/5s/apple；bl 支持合集/多分P） |
| `POST /parse/song/:source` 等 | 链接解析：body `{ "link": "..." }`，三个端点 `parse/song` / `parse/album` / `parse/playlist`。支持 kw/kg/tx/wy/5s/apple/bl/jx/bd/migu（其中 bl、5s 无 album 端点） |
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
| `POST /login/qs/qr` → `POST /login/qs/qr/check` | 汽水音乐扫码登录（用**汽水音乐 App** 扫一扫——同官方 PC 客户端文案；抖音 App 扫可能不完成确认。登录后解锁完整曲目与无损取流） |
| `POST /login/xm` | 绑定喜马拉雅 cookie（www.ximalaya.com 复制，须含 `1&_token`，解锁付费/已购内容取流） |
| `POST /login/me` | 绑定猫耳FM token（App 抓包或 m.missevan.com 复制，须含 `token=`，解锁付费声音取流） |
| `POST /login/lr` | 懒人听书账号登录（account+password，懒人取流要求登录态，免费章节同样） |
| `POST /login/bl/qr` → `POST /login/bl/qr/check` | 哔哩哔哩扫码登录（B站 App 扫一扫，登录后解锁大会员音质） |
| `DELETE /login/{wy,kg,tx,qs,xm,me,lr,bl}` | 清除对应平台凭据（退出登录） |
| `GET /login/status` | 登录状态（登录后取流/请求自动携带凭据） |
| `GET /sources` | 平台列表（音质与能力） |
| `GET /health` | 健康检查 |
| `GET /docs` `/redoc` `/openapi.json` | 接口文档（Swagger UI / ReDoc / OpenAPI 3.1） |

统一返回格式：`{ code: 0, data: ... }` 成功；`{ code: 非0, msg: ... }` 失败。状态码语义：422 参数校验失败、404 接口或平台不存在、405 方法不允许（带 Allow 头）、502 上游平台失败。

所有接口默认返回 `Access-Control-Allow-Origin: *`，可直接在浏览器/前端调用。

## 歌曲 ID 约定

- **kw / tx / wy**：`songmid`（如 `228908`、`0039MnYb0qxYhV`）
- **kg**：`hash`（搜索结果的 `hash` 字段）；VIP/付费歌需 `/login/kg` 登录后取流
- **qs**：track id（搜索结果的 `songmid` 字段）；匿名仅 30s 试听，`/login/qs/qr` 登录后走解密流代理取完整曲目
- **xm**：track id（搜索/专辑结果的 `songmid` 字段）；匿名可取免费曲目（64k/128k 有声档位），付费/VIP 内容 `POST /login/xm` 绑定 cookie 后取流
- **me**：声音 id（搜索结果的 `songmid` 字段）；走 App API 签名通道取免签名明文直链（m4a），匿名可取免费声音，付费内容 `POST /login/me` 绑定 token 后取流
- **qt**：`<channelId>:<programId>` 复合 id（/album/qt 节目列表产出）；audiostream 签名直链（302 到华为云 CDN），匿名可取免费节目
- **lr**：`<bookId>:<section>` 复合 id（/album/lr 章节列表产出）；取流必须 `POST /login/lr` 登录（免费章节同样要求登录态）
- **migu**：`<contentId>|<resourceType>|<formatType>` 三元组（搜索结果/专辑/歌单产出）；取流走 listen-url 多档候选链 + 逐档 Range 探测，命中可访问的最高档（匿名实测可出 flac24bit 真无损），Z3D/I3D 加密流自动改走 `/stream/migu` 解密代理
- **bd**：track id（T 开头，搜索结果的 `songmid`）；免费曲目匿名可出 128k/320k/flac 明文直链，VIP/版权曲目需 cookie
- **jx**：加密后的 track id（含 `=`/`+`，URL 编码后传）；游客 128k，VIP 完整曲需 cookie（`wmid`+`session_key`）
- **bl**：`<bvid>|<cid>`（搜索结果/合集曲目产出）；合集/歌单 id 形如 `season:<id>:<mid>:<bvid>` 或 `bvid:<bvid>`
- **5s**：`<songId>|<songType>`（如 `932557|yc`，songType 为 yc 原创 / fc 翻唱 / bz 伴奏），URL 路径需编码 `|` 为 `%7C`
- **apple**：数字歌曲 id（搜索结果产出）；取流固定为 `preview` 试听片段（完整曲为 DRM，不在支持范围）

`/url` 在外部音源与平台直连都失败时，自动降级到**酷我**兜底：按歌名/歌手/时长匹配同一首歌后走 kw 通道（匿名可拿无损）。kg 可由 hash 反查歌曲信息；其它平台需要兜底时给 `/url` 传 `name`/`singer`/`interval` 查询参数。

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

## 外部音源

设置 `SOURCE_ENABLED=1` 后取流优先走外部音源（默认未设置时直接走 SDK 官方直连接口；是否启用由服务端在 `src/server.ts` 决策）。两种脚本都放 `sources/` 目录（不入库），按文件名混排成候选链：取流失败自动切换下一个，某平台连续失败 3 次的脚本降权冷却 5 分钟；整条音源链失败后回落 SDK 直连、再失败走酷我兜底（见上文取流链）。音源候选链只覆盖 kw/kg/tx/wy（音源脚本协议无 qs 平台，`/url/qs` 始终走 SDK）。音源模式下登录态不参与取流，登录自动续期不会启动（手动 `POST /login/refresh` 仍可用）。详见 [docs/source-ivm.md](docs/source-ivm.md) 与 [docs/source-simple.md](docs/source-simple.md)。

**社区音源脚本（`.js`）** —— 通用格式，isolated-vm 硬隔离沙箱执行（详见 `src/source-ivm.ts` 头注释），文件名排序即优先级；`SOURCE_SCRIPT_PATH` 可改为指定目录外单脚本，`SOURCE_LOG=0` 关闭请求日志，`SOURCE_ALLOW_ALL_HTTP=1` 放开 HTTP 白名单（调试用）。

**简单 API 脚本（`.mjs`）** —— 进程内直接加载、无沙箱的第二套极简契约，只需导出一个 `getMusicUrl`，适合自己写的取流脚本（运行于服务器进程内，请只放自己审计过的代码）：

```js
// sources/99-my-api.mjs —— dev 热重载模式下保存即自动重启生效
export const sources = ['kw', 'kg', 'tx', 'wy'] // 可选，默认四平台
export const timeout = 15000                    // 可选，单次取流超时 ms（默认 15000）

export async function getMusicUrl({ source, id, songInfo, quality, signal }) {
  // source: 平台 id（kw/kg/tx/wy）；id: 歌曲 id（songmid/hash）
  // quality: 128k/320k/flac/flac24bit
  // signal: 取消/超时信号（AbortSignal），fetch(url, { signal }) 透传即可支持取消
  const res = await fetch(`https://your-api/get?source=${source}&id=${id}&quality=${quality}`, { signal })
  const { data } = await res.json()
  return data.url // 播放地址字符串，或 { type, url }
}
```

## 项目结构

```
src/                HTTP 应用层（Fastify 服务器，全部 TypeScript 源码）
  server.ts         HTTP 服务器入口（pnpm start 实际启动文件）
  routes.ts         业务路由（JSON Schema 校验 + OpenAPI 元数据）
  routes-login.ts   登录路由（wy 扫码/手机号、kg 扫码/短信/账密+风控验证/token、tx 扫码/cookie、qs 汽水扫码、
                    bl 扫码、xm/me cookie 绑定、lr 账密）
  source.ts         外部音源候选链（SOURCE_ENABLED 时 /url 取流优先走 sources/ 脚本，失败回落 SDK）
  source-ivm.ts     社区音源脚本加载器（isolated-vm 硬隔离沙箱）
  source-simple.ts  简单 API 音源脚本加载器（.mjs 进程内直载）
  http/
    api-error.ts    业务错误类型（404/502 等 → 统一 JSON 响应）
    auth-gate.ts    调用秘钥鉴权（AUTH_KEY，全路径防扫描；/stream/* 可改用短时签名）
    rate-limit.ts   per-IP 滑动窗口限流（RATE_LIMIT，默认 120/分钟）
    stream-sign.ts  /stream/* 流地址短时签名（HMAC 派生，10 分钟有效）
    migu-stream.ts  咪咕加密流票据登记与逐块解密管道
  openapi/
    components.ts   OpenAPI 共享 schema（与路由校验同源）
    ui.ts           ReDoc 页面模板
sdk/                音乐聚合 SDK（仅官方平台：平台模块 + 官方直连取流 + 凭据 + 基础设施；15 个平台）
  index.ts          平台聚合入口（通用工具转发，实现在 common/utils.ts）
  apis/             各平台官方 URL 直连取流实现（15 平台）
  auth/             登录态与登录协议（store.ts 持久化凭据到 data/auth.json；wy.ts 扫码/手机号、kg.ts 扫码/短信/token/续期、tx.ts 扫码/cookie/续期）
  common/           SDK 基础设施
    request.ts      HTTP 请求（可取消、自动 JSON 解析、gzip/deflate 解压）
    utils.ts        工具函数（sizeFormate/formatPlayTime/dateFormat 等）
    message.ts      请求错误消息
  kg/ kw/ tx/ wy/ qs/ migu/ qian/ joox/ bili/ 5sing/ apple/ xm/ me/ qt/ lr/
                    平台模块（搜索/歌词/榜单/歌单/专辑/链接解析等；qs 含字节系参数签名与音频解密 crypto/，
                    migu 含 Z3D 流解密，bili 含扫码登录）
  apis/             kw.ts kg.ts tx.ts wy.ts qs.ts migu.ts qian.ts joox.ts bili.ts 5sing.ts apple.ts …
test/
  smoke-test.ts     冒烟测试（自动启动/关闭本地服务器，验证各平台接口）
  source-simple-test.ts  简单 API 音源脚本加载器测试（离线）
```

> 分层依赖严格单向：`src` → `sdk`，`sdk` 内部自包含（不反向依赖 src）。源码统一为 TypeScript（import 一律写 `.ts` 后缀），由 Node ≥22.18 的原生类型剥离直接运行——**无编译产物**，改完即跑；tsc 仅用于类型检查（`pnpm typecheck`）。代码只使用可剥离的 TS 语法（无 enum/namespace/参数属性），新增代码也须遵守。

## 已知限制

- **kg 取流**：匿名仅能获取部分免费资源，VIP/付费歌需 `/login/kg` 登录（扫码/短信/token 均可）后取流，成功响应解析见 `sdk/apis/kg.ts` 头注释。
- **kw 取流**：主通道 mobi.s 严格校验「返回 bitrate == 请求档位且为明文格式」，档位缺失时沿降级链换档（flac24bit→flac→320k→128k）；web playUrl 回退通道匿名恒 128k。
- **qs 取流**：匿名仅 30s 试听；完整曲目需 `/login/qs/qr` 用**汽水音乐 App** 扫码登录，取流走 `/stream/qs/:id` 解密流代理（一次性下载解密回明文，不支持 Range）。
- **migu 取流**：匿名 PQ(128k) 永远可用，但候选链会优先探测更高档位——多数曲目实际能匿名拿到 SQ/ZQ 真无损直链（上游同款 tone 路径重写 + 逐档探测）；Z3D/I3D 加密候选经 `/stream/migu` 解密后同样可播。HQ/SQ 返回「登录后免费试听」时自动降级到可用的最高档。
- **apple 取流**：只有 preview 试听片段（约 30–90s，AAC/m4a），返回的 `type` 固定为 `preview`，不要当作完整曲。
- **bl 取流**：匿名最高 192k；flac/Hi-Res 需 `/login/bl/qr` 登录大会员账号。CDN 有约 1 小时的 `deadline` 签名，取流结果不宜缓存过久。
- **5s 歌单详情**：依赖 5sing 网页（`5sing.kugou.com/.../dj/...html`）解析曲目；2026-10-02 实测该站点网页层整体 502（搜索/取流/歌词等手机端 API 不受影响）。上游同样依赖该页面，待站点恢复即自动可用。
- **link 解析**：`/parse/*` 走各平台网页链接解析（需上游有对应实现）；未实现的平台返回 404。
- 平台接口随时可能变更，遇失效时可对照 `sdk/apis/` 内的接口文档调整。
