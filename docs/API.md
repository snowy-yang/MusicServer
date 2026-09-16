# MusicServer 聚合音乐 API

多平台音乐聚合接口：搜索、播放地址、歌词、封面、榜单、歌单。支持平台：**kw**（酷我）/ **kg**（酷狗）/ **tx**（QQ音乐）/ **wy**（网易云）/ **mg**（咪咕）。

> 本文档为静态速查版。交互式文档以服务器实际输出为准：
>
> - **Swagger UI**：`http://localhost:16688/docs`（可直接调试）
> - **ReDoc**：`http://localhost:16688/redoc`
> - **OpenAPI 3.1**：`http://localhost:16688/openapi.json`（可生成各语言客户端）

## 约定

- 默认端口 **16688**（可用 `PORT` 环境变量修改）。
- 仅支持 `GET` 方法；服务器支持 CORS（`Access-Control-Allow-Origin: *`）。
- **成功**：`200` + `{"code": 0, "data": ...}`
- **失败**：对应 HTTP 状态码 + `{"code": <状态码>, "msg": "...", "detail": ...}`
  - `422` 参数校验失败（缺失、非法音质、页码越界等，FastAPI 风格）
  - `404` 接口不存在 / 平台不支持该能力
  - `405` 方法不允许（响应带 `Allow` 头）
  - `502` 上游平台请求失败
  - `500` 服务器内部错误
- 资源类接口统一为**路径参数风格**；`/search`、`/find` 搜索类接口使用 query 参数。
- 平台歌曲 id 形态：kw/tx/wy/mg 用 `songmid`，kg 用 `hash`（mg 内部自动换取 contentId）。

## 接口速查

### 系统

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查（status / uptime / 平台数） |
| GET | `/sources` | 支持的平台及其音质、能力（search/url/lyric/pic/boards/hotSearch/songList/singer/album） |
| GET | `/` | 302 重定向到 `/docs` |
| GET | `/docs` | Swagger UI 文档页 |
| GET | `/redoc` | ReDoc 阅读版文档 |
| GET | `/openapi.json` | OpenAPI 3.1 规范文档 |

### 搜索

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/search?name=稻香&singer=周杰伦&source=kw&page=1&limit=20` | 搜索歌曲；`source` 省略时聚合全部平台，失败的平台跳过 |
| GET | `/find?name=稻香&singer=周杰伦&albumName=魔杰座&interval=03:43&excludeSource=kw` | 跨平台精确匹配，按歌手/歌名/专辑/时长综合排序 |

### 歌曲资源

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/url/:source/:id` | 播放地址；query 可带 `quality`（128k/320k/flac/flac24bit，默认 128k）与 `albumId`（kg 需要） |
| GET | `/lyric/:source/:id` | 歌词；可带 `name`/`interval`（部分平台搜索歌词时需要） |
| GET | `/pic/:source/:id` | 封面；可带 `albumId`（kg 需要） |

### 榜单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/boards/:source` | 榜单列表 |
| GET | `/boards/:source/:boardId` | 榜单详情；可带 `page`。`boardId` 兼容榜单列表的带前缀 `id`（`kw__93`）与裸 `bangid`（`93`） |

### 歌单 & 热搜

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/hot-search/:source` | 热搜词 |
| GET | `/song-list/:source` | 歌单列表；可带 `page`/`sortId`/`tagId`。`sortId`/`tagId` 各平台词汇不同（kw `new`/`hot`、tx `5`/`2`、kw 标签为 `173-digest` 形态等），`sortId` 省略时用平台默认 |

### 歌手 & 专辑

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/singer/:source/:id` | 歌手信息（name/desc/avatar 与歌曲/专辑数量）。支持 kg/tx/wy |
| GET | `/singer/:source/:id/songs` | 歌手歌曲列表；可带 `page`/`limit`（默认 20）。支持 kg/tx/wy |
| GET | `/singer/:source/:id/albums` | 歌手专辑列表；可带 `page`/`limit`。支持 kg/tx/wy |
| GET | `/album/:source/:id` | 专辑详情与曲目列表；可带 `page`/`limit`（limit 仅 kg 生效）。支持 kg/mg；kw 专辑上游接口已失效暂不支持 |

歌手/专辑 id 来源：搜索结果条目包含 `albumId`；歌手 id 需从平台方获取（不在搜索结果中）。

## 响应示例

```jsonc
// GET /url/kw/228908?quality=320k
{ "code": 0, "data": { "type": "320k", "url": "https://..." } }

// GET /lyric/kw/228908
{ "code": 0, "data": { "lyric": "[00:00.00]...", "tlyric": "", "yrc": "" } }

// 参数缺失
// 422
{ "code": 422, "msg": "querystring must have required property 'name'", "detail": [...] }

// 平台不支持该能力
// 404
{ "code": 404, "msg": "不支持的平台: xx" }

// 方法不允许
// 405 + Allow: GET
{ "code": 405, "msg": "方法 POST 不允许，请使用 GET" }
```
