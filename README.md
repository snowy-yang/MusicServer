# 音乐服务器（MusicServer）

多平台音乐聚合 API 服务器，纯 Node.js 实现，无需浏览器环境。

## 功能

- **多平台聚合**：酷我（kw）、酷狗（kg）、QQ音乐（tx）、网易云（wy）、咪咕（mg）
- **直连取流**：各平台播放地址获取（不依赖第三方 API 服务）
- **完整链路**：搜索、播放地址、歌词（含各平台加密歌词解码）、封面、榜单、热搜、歌单

## 快速开始

```bash
pnpm install
pnpm start       # 默认端口 16688，可用 PORT 环境变量修改
pnpm test        # 运行冒烟测试（自动启动/关闭本地服务器）
```

## HTTP 接口

接口统一为路径参数风格（`/search`、`/find` 搜索类使用 query 参数）。

| 接口 | 说明 |
| --- | --- |
| `GET /search?name=xxx&singer=xxx&source=kw&page=1&limit=20` | 搜索歌曲（source 省略则聚合所有平台） |
| `GET /find?name=xxx&singer=xxx&albumName=xxx&interval=xxx` | 精确匹配搜索（跨平台去重排序） |
| `GET /url/:source/:id?quality=320k` | 获取播放地址（quality: 128k/320k/flac/flac24bit） |
| `GET /lyric/:source/:id` | 获取歌词（返回 lyric/tlyric/yrc） |
| `GET /pic/:source/:id` | 获取封面 |
| `GET /boards/:source` | 榜单列表 |
| `GET /boards/:source/:boardId` | 榜单详情 |
| `GET /hot-search/:source` | 热搜列表 |
| `GET /song-list/:source?page=1` | 歌单列表 |
| `GET /singer/:source/:id` | 歌手信息（kg/tx/wy） |
| `GET /singer/:source/:id/songs?page=1&limit=30` | 歌手歌曲列表（kg/tx/wy） |
| `GET /singer/:source/:id/albums?page=1&limit=10` | 歌手专辑列表（kg/tx/wy） |
| `GET /album/:source/:id?page=1` | 专辑详情与曲目（kg/kw/mg/tx） |
| `POST /login/wy/qr` → `POST /login/wy/qr/check` | 网易云扫码登录（扫码后轮询完成登录） |
| `POST /login/wy/cellphone` | 网易云手机号登录（password 或 captcha） |
| `POST /login/kg` + `userid` | 绑定酷狗 token（App 抓包获取，服务端验证） |
| `GET /login/status` | 登录状态（登录后取流/请求自动携带凭据） |
| `GET /sources` | 平台列表（音质与能力） |
| `GET /health` | 健康检查 |
| `GET /docs` `/redoc` `/openapi.json` | 接口文档（Swagger UI / ReDoc / OpenAPI 3.1） |

统一返回格式：`{ code: 0, data: ... }` 成功；`{ code: 非0, msg: ... }` 失败。状态码语义：422 参数校验失败、404 接口或平台不存在、405 方法不允许（带 Allow 头）、502 上游平台失败。

所有接口默认返回 `Access-Control-Allow-Origin: *`，可直接在浏览器/前端调用。

## 歌曲 ID 约定

- **kw / tx / wy**：`songmid`（如 `228908`、`0039MnYb0qxYhV`）
- **kg**：`hash`（搜索结果的 `hash` 字段；当前环境 kg 取流接口被服务端限制，URL 获取可能失败）
- **mg**：`songmid`（搜索结果的 `songmid` 字段，内部自动换取 contentId）

## 项目结构

```
src/
  server.js         HTTP 服务器入口（pnpm start 实际启动文件，Fastify）
  routes.js         业务路由（JSON Schema 校验 + OpenAPI 元数据）
  smoke-test.js     冒烟测试（自动启动本地服务器）
  index.js          SDK 根模块（工具函数聚合导出）
  http/             HTTP 层
    api-error.js    业务错误类型（404/502 等 → 统一 JSON 响应）
  openapi/          文档层
    components.js   OpenAPI 共享 schema（与路由校验同源）
    ui.js           ReDoc 页面模板
  apis/             各平台 URL 直连实现（kw/kg/tx/wy/mg/bd）
    source.js       外部音源懒加载入口（sources/ 目录脚本，不入库）
    source-ivm.js   isolated-vm 隔离执行器
  common/           公共模块
    request.js      HTTP 请求（可取消、自动 JSON 解析、gzip/deflate 解压）
    utils.js        工具函数（sizeFormate/formatPlayTime/dateFormat 等）
    message.js      请求错误消息
    ipcNames.js     IPC 事件名（兼容 SDK）
    rendererIpc.js  IPC 本地实现（kw/tx 歌词解码）
    lyricDecode.js  酷我/QQ 歌词解码（替代原 Electron 主进程处理器）
    qrcDecode.js    QQ 歌词 3DES 解密（纯 JS 移植）
    lyricUtils/kg.js 酷狗 krc 歌词解码
musicSdk/           音乐聚合 SDK（搜索/歌词/榜单等核心逻辑，TypeScript 源码）
  index.js          平台聚合入口
  request.js        SDK 请求模块（转接 src/common/request.js）
  message.js        SDK 消息模块（转接 src/common/message.js）
```

> TypeScript 源码（`src/apis/index.ts`、`musicSdk/**/*.ts`）经 `pnpm run build`（tsc）就地发射为 `.js` 产物后运行。

## 已知限制

- **kg 取流**：酷狗当前环境下 `wwwapi`/`trackercdn`/`m.kugou.com` 等取流接口均被服务端风控（err_code 30020/20010），播放地址获取可能失败；歌词、搜索、榜单正常。
- **kw flac**：`antiserver` 接口对 flac 返回 `refuse`，高音质会回退官方接口（需要 csrf token，token 失效时自动重试）。
- 平台接口随时可能变更，遇失效时可对照 `src/apis/` 内的接口文档调整。
