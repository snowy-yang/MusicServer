# 音乐服务器（MusicServer）

基于洛雪音乐（lx-music）聚合 SDK 的多平台音乐 API 服务器，纯 Node.js 实现，无需浏览器环境。

## 功能

- **多平台聚合**：酷我（kw）、酷狗（kg）、QQ音乐（tx）、网易云（wy）、咪咕（mg）
- **直连取流**：各平台播放地址获取（不依赖第三方 API 服务）
- **完整链路**：搜索、播放地址、歌词（含各平台加密歌词解码）、封面、榜单、热搜、歌单

## 快速开始

```bash
npm install
npm start        # 默认端口 3300，可用 PORT 环境变量修改
npm test         # 运行冒烟测试（自动启动/关闭本地服务器）
```

## HTTP 接口

| 接口 | 说明 |
| --- | --- |
| `GET /search?name=xxx&singer=xxx&source=kw&page=1&limit=20` | 搜索歌曲（source 省略则聚合所有平台） |
| `GET /find?name=xxx&singer=xxx&albumName=xxx&interval=xxx` | 精确匹配搜索（跨平台去重排序） |
| `GET /url?source=kw&id=228908&quality=320k` | 获取播放地址（quality: 128k/320k/flac/flac24bit） |
| `GET /lyric?source=kw&id=228908` | 获取歌词（返回 lyric/tlyric/lxlyric） |
| `GET /pic?source=kw&id=228908` | 获取封面 |
| `GET /boards?source=kw` | 榜单列表 |
| `GET /board?source=kw&id=93&page=1` | 榜单详情 |
| `GET /hotSearch?source=kw` | 热搜列表 |
| `GET /songList?source=kw&page=1` | 歌单列表 |
| `GET /health` | 健康检查 |

统一返回格式：`{ code: 0, data: ... }` 成功；`{ code: 非0, msg: ... }` 失败。

所有接口默认返回 `Access-Control-Allow-Origin: *`，可直接在浏览器/前端调用。

## 歌曲 ID 约定

- **kw / tx / wy**：`songmid`（如 `228908`、`0039MnYb0qxYhV`）
- **kg**：`hash`（搜索结果的 `hash` 字段；当前环境 kg 取流接口被服务端限制，URL 获取可能失败）
- **mg**：`songmid`（搜索结果的 `songmid` 字段，内部自动换取 contentId）

## 项目结构

```
src/
  server.js         HTTP 服务器入口（npm start 实际启动文件）
  index.js          SDK 根模块（工具函数聚合导出）
  smoke-test.js     冒烟测试（自动启动本地服务器）
  apis/             各平台 URL 直连实现（kw/kg/tx/wy/mg/bd）
  common/           公共模块
    request.js      HTTP 请求（可取消、自动 JSON 解析、gzip/deflate 解压）
    utils.js        工具函数（sizeFormate/formatPlayTime/dateFormat 等）
    message.js      请求错误消息
    ipcNames.js     IPC 事件名（兼容 SDK）
    rendererIpc.js  IPC 本地实现（kw/tx 歌词解码）
    lyricDecode.js  酷我/QQ 歌词解码（替代原 Electron 主进程处理器）
    qrcDecode.js    QQ 歌词 3DES 解密（纯 JS 移植）
    lyricUtils/kg.js 酷狗 krc 歌词解码
musicSdk/          洛雪音乐聚合 SDK（搜索/歌词/榜单等核心逻辑）
  index.js          平台聚合入口
  request.js        SDK 请求模块（转接 src/common/request.js）
  message.js        SDK 消息模块（转接 src/common/message.js）
```

## 关于 lx-music-source-v5.js

项目目录下的 `lx-music-source-v5.js` 是第三方混淆音源脚本。由于内容不可审计，且 Node.js `vm` 不是安全沙箱，服务器代码中**不再直接加载或执行该脚本**，也不依赖它获取播放地址。

如需复用其服务端能力，需要其提供去混淆源码或完整 API 文档。当前 `docs/lx-source-signing.md` 记录了已逆向出的确定性签名部分（`e`、`s2`、`s3`），但脚本内部用于 `to` / `si` 的混淆逻辑尚未安全还原，因此未集成到生产路径。

## 已知限制

- **kg 取流**：酷狗当前环境下 `wwwapi`/`trackercdn`/`m.kugou.com` 等取流接口均被服务端风控（err_code 30020/20010），播放地址获取可能失败；歌词、搜索、榜单正常。
- **kw flac**：`antiserver` 接口对 flac 返回 `refuse`，高音质会回退官方接口（需要 csrf token，token 失效时自动重试）。
- 平台接口随时可能变更，遇失效时可对照 `src/apis/` 内的接口文档调整。
