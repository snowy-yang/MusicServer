# MusicServer 聚合音乐 API

多平台音乐聚合接口：搜索、播放地址、歌词、封面、榜单、歌单。
支持平台：**kw**（酷我）/ **kg**（酷狗）/ **tx**（QQ音乐）/ **wy**（网易云）/ **mg**（咪咕）。

> 本文档为静态速查版。交互式文档以服务器实际输出为准：
>
> - **Swagger UI**：`http://localhost:3300/docs`（可直接调试）
> - **ReDoc**：`http://localhost:3300/redoc`
> - **OpenAPI 3.1**：`http://localhost:3300/openapi.json`（可生成各语言客户端）

## 约定

- **成功**：`200` + `{"code": 0, "data": ...}`
- **失败**：对应 HTTP 状态码 + `{"code": <状态码>, "msg": "...", "detail": ...}`
  - `422` 参数校验失败（缺失、非法音质、页码越界等）
  - `404` 接口不存在 / 平台不支持该能力
  - `405` 方法不允许（仅支持 GET）
  - `502` 上游平台请求失败
  - `500` 服务器内部错误
- 服务器支持 CORS（`*`），仅接受 `GET`。
- 每个资源接口同时提供**路径参数风格**（规范）与**query 风格**（旧版兼容，已在文档中标记 deprecated）。
- 平台歌曲 id 的形态：kw/tx/wy/mg 用 `songmid`，kg 用 `hash`，mg 亦可用 `copyrightId`。

## 接口速查

### 系统

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 302 重定向到 `/docs` |
| GET | `/health` | 健康检查：`{status, uptime, platforms}` |
| GET | `/sources` | 平台列表：id、名称、音质、能力矩阵 |
| GET | `/docs` | Swagger UI 交互文档 |
| GET | `/redoc` | ReDoc 文档 |
| GET | `/openapi.json` | OpenAPI 3.1 规范 |

### 搜索

| 方法 | 路径 | 关键参数 |
| --- | --- | --- |
| GET | `/search` | `name`(必填)、`singer`、`source`(省略=聚合)、`page=1`、`limit=20`(≤100) |
| GET | `/find` | `name`(必填)、`singer`、`albumName`、`interval`、`excludeSource` |

`/search` 指定 `source` 时只查该平台（失败返回 502）；省略时聚合全部平台，失败的平台静默跳过。
`/find` 按歌手、歌名、专辑、时长综合打分，返回排序后的匹配列表。

### 歌曲资源（规范路由）

| 方法 | 路径 | 关键参数 |
| --- | --- | --- |
| GET | `/url/:source/:id` | `quality`(128k/320k/flac/flac24bit，默认 128k)、`albumId` |
| GET | `/lyric/:source/:id` | `name`、`interval`（部分平台搜索歌词时需要） |
| GET | `/pic/:source/:id` | `albumId`（kg 需要） |

旧版兼容：`/url?source=&id=&quality=`、`/lyric?source=&id=`、`/pic?source=&id=`。

### 榜单（规范路由）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/boards/:source` | 榜单列表 `{list:[{id,name,bangid}]}` |
| GET | `/boards/:source/:boardId` | 榜单详情，`page=1`，返回歌曲列表 |

旧版兼容：`/boards?source=`（列表）、`/board?source=&id=&page=`（详情）。

### 歌单 & 热搜（规范路由）

| 方法 | 路径 | 关键参数 |
| --- | --- | --- |
| GET | `/song-list/:source` | `page=1`、`sortId=3`、`tagId=0`（平台相关） |
| GET | `/hot-search/:source` | 无 |

旧版兼容：`/songList?source=&page=&sortId=&tagId=`、`/hotSearch?source=`。

## 响应数据示例

```jsonc
// GET /search?source=kw&name=稻香&limit=2
{ "code": 0, "data": { "source": "kw", "list": [ /* SongInfo */ ], "page": 1, "limit": 2 } }

// SongInfo（节选）
{
  "songmid": "28423286", "hash": "...", "copyrightId": "...", "albumId": "...",
  "name": "稻香", "singer": "周杰伦", "source": "kw", "interval": "03:43",
  "albumName": "魔杰座", "img": "https://...",
  "types": [{ "type": "320k", "size": "9.8M" }],
  "_types": { "320k": { "size": "9.8M" } },
  "typeUrl": {}
}

// GET /url/kw/28423286?quality=320k
{ "code": 0, "data": { "type": "320k", "url": "http://..." } }

// GET /lyric/kw/28423286
{ "code": 0, "data": { "lyric": "[ti:稻香]...", "tlyric": "", "lxlyric": "..." } }

// 422 示例
{ "code": 422, "msg": "不支持的音质: 999k", "detail": { "enum": ["128k","320k","flac","flac24bit"] } }
```

## 客户端生成

`/openapi.json` 兼容 OpenAPI 3.1，可直接用工具生成客户端：

```bash
npx openapi-typescript http://localhost:3300/openapi.json -o api-types.ts
```
