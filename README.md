# 音乐服务器（MusicServer）

多平台音乐聚合 API 服务器，纯 Node.js 实现，无需浏览器环境。

## 功能

- **多平台聚合**：酷我（kw）、酷狗（kg）、QQ音乐（tx）、网易云（wy）
- **直连取流**：各平台播放地址获取（不依赖第三方 API 服务）
- **完整链路**：搜索、播放地址、歌词（含各平台加密歌词解码）、封面、榜单、热搜、歌单

## 快速开始

```bash
pnpm install
pnpm start       # 默认端口 16688，可用 PORT 环境变量修改（需 Node 22.18+，直接运行 .ts）
pnpm dev         # 开发模式：node --watch 热重载，改动 src/、sdk/ 代码自动重启
pnpm test        # 类型检查（tsc）+ 冒烟测试（自动启动/关闭本地服务器）
pnpm typecheck   # 仅类型检查，不运行
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
| `GET /album/:source/:id?page=1` | 专辑详情与曲目（kg/kw/tx） |
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

## 项目结构

```
src/                HTTP 应用层（Fastify 服务器，全部 TypeScript 源码）
  server.ts         HTTP 服务器入口（pnpm start 实际启动文件）
  routes.ts         业务路由（JSON Schema 校验 + OpenAPI 元数据）
  routes-login.ts   登录路由（wy 扫码/手机号、kg token、tx cookie）
  http/
    api-error.ts    业务错误类型（404/502 等 → 统一 JSON 响应）
  openapi/
    components.ts   OpenAPI 共享 schema（与路由校验同源）
    ui.ts           ReDoc 页面模板
sdk/                音乐聚合 SDK（自包含：平台模块 + 取流 + 凭据 + 基础设施；kw/kg/tx/wy 四平台）
  index.ts          平台聚合入口（通用工具转发，实现在 common/utils.ts）
  api-source.ts     接口选择层（internal 内置直连 / sources/ 外部音源脚本，SOURCE_ENABLED 切换）
  apis/             各平台 URL 直连取流实现（kw/kg/tx/wy）+ 外部音源加载器（source.ts / source-ivm.ts）
  auth/             登录态与登录协议（store.ts 持久化凭据到 data/auth.json；wy.ts 扫码/手机号、kg.ts token）
  common/           SDK 基础设施
    request.ts      HTTP 请求（可取消、自动 JSON 解析、gzip/deflate 解压）
    utils.ts        工具函数（sizeFormate/formatPlayTime/dateFormat 等）
    message.ts      请求错误消息
    ipcNames.ts     IPC 事件名（兼容 lx-music 结构）
    rendererIpc.ts  IPC 本地实现（kw/tx 歌词解码）
    lyricDecode.ts  酷我/QQ 歌词解码
    qrcDecode.ts    QQ 歌词 3DES 解密（纯 JS 移植）
    lyricUtils/kg.ts 酷狗 krc 歌词解码
test/
  smoke-test.ts     冒烟测试（pnpm test 运行，自动启动/关闭本地服务器）
```

> 分层依赖严格单向：`src` → `sdk`，`sdk` 内部自包含（不反向依赖 src）。源码统一为 TypeScript（import 一律写 `.ts` 后缀），由 Node ≥22.18 的原生类型剥离直接运行——**无编译产物**，改完即跑；tsc 仅用于类型检查（`pnpm typecheck`）。代码只使用可剥离的 TS 语法（无 enum/namespace/参数属性），新增代码也须遵守。

## 已知限制

- **kg 取流**：酷狗当前环境下 `wwwapi`/`trackercdn`/`m.kugou.com` 等取流接口均被服务端风控（err_code 30020/20010），播放地址获取可能失败；歌词、搜索、榜单正常。
- **kw flac**：`antiserver` 接口对 flac 返回 `refuse`，高音质会回退官方接口（需要 csrf token，token 失效时自动重试）。
- 平台接口随时可能变更，遇失效时可对照 `src/apis/` 内的接口文档调整。
