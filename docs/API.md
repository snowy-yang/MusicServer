# MusicServer 聚合音乐 API

多平台音乐聚合接口：搜索、播放地址、歌词、封面、榜单、歌单、专辑、歌手、链接解析、登录。

共 15 个平台：`kw`（酷我）/ `kg`（酷狗）/ `tx`（QQ音乐）/ `wy`（网易云）/ `qs`（汽水）/ `mg`（咪咕）/
`bd`（千千）/ `joox` / `bili`（哔哩哔哩）/ `5sing` / `apple`（Apple Music，仅试听），
以及有声平台 `xm`（喜马拉雅）/ `me`（猫耳FM）/ `qt`（蜻蜓FM）/ `lr`（懒人听书）。

> **本文档是人工速查版，可能滞后于代码。**
> 接口与参数以服务器自动生成的规范为准（路由 schema 同源，永远与实现同步）：
>
> - **Swagger UI**：`/docs`（可直接调试）
> - **ReDoc**：`/redoc`
> - **OpenAPI 3.1**：`/openapi.json`（可生成各语言客户端）
> - **平台能力位**：`GET /sources` —— 各接口具体支持哪些平台，一律以它的能力位为准，本文不再硬列

## 约定

- 默认端口 **16688**（`PORT` 环境变量可改）。
- **全部接口为路径参数风格**，分页走 path 段且第 1 页可省略：`/search/kw/稻香`、`/search/kw/稻香/2`、
  `/album/kg/123/2`。查询参数只用于修饰（`?quality=`、`?limit=`、`?singer=` 等）。
- 默认返回 `Access-Control-Allow-Origin: *`，可直接在浏览器/前端调用。
- **成功**：`200` + `{"code": 0, "data": ...}`
- **失败**：对应 HTTP 状态码 + `{"code": <状态码>, "msg": "...", "detail": ...}`

| 状态码 | 含义 |
| --- | --- |
| `422` | 参数校验失败（Fastify/Ajv，FastAPI 风格） |
| `404` | 接口不存在，或平台不支持该能力 |
| `405` | 方法不允许（响应带 `Allow` 头） |
| `502` | 上游平台请求失败 |
| `500` | 服务器内部错误 |

### 鉴权与限流

- 设置 `AUTH_KEY` 后**全部路径**都要求 `X-Server-Key: <AUTH_KEY>`（含文档页与 404，防止扫描探测接口存在性）。
- `/stream/*` 流代理例外：播放器无法携带自定义头，改用 `/url` 返回流地址时自动附带的 `?exp=&sig=` 短时签名（HMAC 派生，10 分钟有效）。
- `RATE_LIMIT` 为每 IP 每分钟允许的请求数（默认 120，设 0 关闭），超限返回 `429` + `Retry-After`。

### 歌曲 id 形态

各平台 id 约定（含 `kw` 的 songmid、`kg` 的 hash、`qs`/`xm`/`me` 的 id、`mg` 的三元组、
`qt`/`lr` 的复合 id、`bili` 的 `<bvid>|<cid>` 等）详见 README「歌曲 ID 约定」。
复合 id 含 `|` / `:` 时在 URL 中需编码（`|` → `%7C`）。

## 接口速查

### 系统

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（status / uptime / 平台数） |
| GET | `/sources` | 平台列表：音质与全部能力位（**判断某接口支持哪些平台的唯一依据**） |
| GET | `/` | 302 重定向到 `/docs` |
| GET | `/docs` · `/redoc` · `/openapi.json` | Swagger UI / ReDoc / OpenAPI 3.1 规范 |

### 搜索

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/search/:source/:keyword[/:page]` | 搜索歌曲；`source` 为平台 id 或 `all`（聚合，自带 `noAggregate` 的平台不参与）。`?singer=` 附加歌手、`?limit=` 每页条数 |
| GET | `/find/:source/:keyword` | 精确匹配搜索；`?singer=` `?albumName=` `?interval=` 辅助匹配，`source=all` 时 `?excludeSource=` 跳过平台 |

### 歌曲资源

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/url/:source/:id` | 播放地址；`?quality=`（64k/128k/320k/flac/flac24bit，默认 128k）。取流链：外部音源（启用时）→ SDK 直连 → 酷我兜底（响应 `via` 标记实际命中通道） |
| GET | `/stream/:source/:id` | 加密流解密代理，`source` 用 path 段区分（`qs` 汽水解密流 / `mg` 咪咕 Z3D 加密流）。供 `/url` 返回的相对地址使用，不接受自行构造 |
| GET | `/lyric/:source/:id` | 歌词；可带 `?name=` `?interval=`（部分平台搜索歌词时需要） |
| GET | `/pic/:source/:id` | 封面；可带 `?albumId=`（kg 需要） |

### 榜单 / 歌单 / 热搜

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/boards/:source` | 榜单列表 |
| GET | `/boards/:source/:boardId[/:page]` | 榜单详情（分页 path 段）。`boardId` 兼容带前缀 id（`kw__93`）与裸 `bangid`（`93`） |
| GET | `/hot-search/:source` | 热搜词 |
| GET | `/song-list/:source[/:page]` | 歌单列表；`?sortId=` `?tagId=` 各平台词汇不同，省略时用平台默认 |
| GET | `/playlist/:source/:id[/:page]` | 歌单详情与曲目；`?limit=`。bili 支持合集/多分P |
| GET | `/playlist/:source/search/:keyword` | 歌单搜索（`?page=` `?limit=`） |
| GET | `/playlist/:source/categories` | 歌单分类列表 |
| GET | `/playlist/:source/categories/:categoryId` | 分类下的歌单（`?page=` `?limit=`） |
| GET | `/user-playlist/:source` | 个人歌单（需登录；仅 tx/wy 有完整实现，其余 404/502） |

### 歌手 & 专辑

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/singer/:source/:id` | 歌手信息（name/desc/avatar 与歌曲/专辑数量） |
| GET | `/singer/:source/:id/songs[/:page]` | 歌手歌曲列表；`?limit=` |
| GET | `/singer/:source/:id/albums[/:page]` | 歌手专辑列表；`?limit=` |
| GET | `/album/:source/:id[/:page]` | 专辑详情与曲目；`?limit=` |
| GET | `/album/:source/search/:keyword` | 专辑搜索（`?page=` `?limit=`） |

### 链接解析

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/parse/song/:source` | 解析歌曲网页链接 → 歌曲信息，body `{"link": "..."}` |
| POST | `/parse/album/:source` | 解析专辑链接 → 专辑信息与曲目 |
| POST | `/parse/playlist/:source` | 解析歌单链接 → 歌单信息与曲目 |

支持的平台见 `/sources` 的 `parse` 能力位；不支持的平台返回 404。

### 登录

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/login/wy/qr` → `/login/wy/qr/check` | 网易云扫码（`check` body 传 `{"key": "..."}`） |
| POST | `/login/wy/cellphone` | 网易云手机号登录（`password` 明文或 `captcha`） |
| DELETE | `/login/wy` | 退出网易云 |
| POST | `/login/kg/qr` → `/login/kg/qr/check` | 酷狗扫码 |
| POST | `/login/kg/captcha` → `/login/kg/cellphone` | 酷狗短信验证码登录 |
| POST | `/login/kg/password` | 酷狗账密登录（命中风控返回挑战，配合 `/login/kg/verify` 重试） |
| POST | `/login/kg` | 绑定酷狗 token（App 抓包） |
| DELETE | `/login/kg` | 退出酷狗 |
| POST | `/login/tx/qr` → `/login/tx/qr/check` | QQ 音乐扫码 |
| POST | `/login/tx` | 绑定 QQ 音乐 cookie（可选 App 抓包字段供自动续期） |
| DELETE | `/login/tx` | 退出 QQ 音乐 |
| POST | `/login/qs/qr` → `/login/qs/qr/check` | 汽水音乐扫码（用**汽水音乐 App** 扫一扫） |
| DELETE | `/login/qs` | 退出汽水音乐 |
| POST | `/login/xm` · `/login/me` | 绑定喜马拉雅 cookie / 猫耳FM token |
| DELETE | `/login/xm` · `/login/me` | 退出对应平台 |
| POST | `/login/lr` | 懒人听书账号登录（`account` + `password`） |
| DELETE | `/login/lr` | 退出懒人听书 |
| POST | `/login/bili/qr` → `/login/bili/qr/check` | 哔哩哔哩扫码（解锁大会员音质） |
| DELETE | `/login/bili` | 退出哔哩哔哩 |
| POST | `/login/refresh` | 手动触发登录态续期（kg/tx） |
| GET | `/login/status` | 登录状态总览（各平台 `logged` 与账号资料） |

- 凭据持久化于 `data/auth.json`（不入库，文件权限 0600），登录后取流与平台请求自动携带。
- 自动续期：启动 10s 后对 kg/tx 执行一次，此后每 24h 一次（音源模式下不参与取流，自动续期不启动）。

## 响应示例

```jsonc
// GET /url/kw/228908?quality=320k
{ "code": 0, "data": { "type": "320k", "url": "https://..." } }

// GET /lyric/kw/228908
{ "code": 0, "data": { "lyric": "[00:00.00]...", "tlyric": "", "yrc": "" } }

// 参数非法 → 422
{ "code": 422, "msg": "params/source must be equal to one of the allowed values", "detail": [...] }

// 平台不支持该能力 → 404
{ "code": 404, "msg": "不支持的平台: xx" }

// 方法不允许 → 405 + Allow 头
{ "code": 405, "msg": "方法 POST 不允许，请使用 GET, HEAD" }
```
