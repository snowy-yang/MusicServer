# lx 聚合源 —— isolated-vm 加载器

## 架构

```
调用方 ── lx.kw.getMusicUrl(songInfo, type) ──▶ src/apis/lx-source.js（懒加载单例）
                                                  │
                                                  ▼
                                        src/apis/lx-source-ivm.js
                                        isolated-vm 硬隔离沙箱
                                        ┌──────────────────────────┐
                                        │ 原始混淆脚本（升版即换文件） │
                                        │  ↕ 仅经显式桥接通道        │
                                        └──────────────────────────┘
                                         http(白名单) crypto zlib 定时器 console
```

- 接口契约与其它平台适配器一致：`getMusicUrl(songInfo, type) → { promise, cancelHttp }`，resolve → `{ type, url }`
- 脚本升版：替换项目根目录脚本文件（或设 `LX_SOURCE_SCRIPT_PATH`）即可，无需改代码

## 安全模型

| 面 | 措施 |
|---|---|
| 进程 | isolate 无 process/require/fs，内存上限 256MB（可调） |
| HTTP | **默认阻止**；白名单取脚本头部 `SERVER_SCRIPT_CONFIG.apiUrl` 同源，可覆盖 |
| 密钥 | crypto 桥接日志只记操作与长度，不落密钥内容 |
| 观测 | 每个 lx API 调用（on/send/request/utils/dispatch）均有日志，请求含耗时与状态码 |

HTTP 白名单选项（`createIvmLxSource`）：

- `allowedOrigins: string[]` —— 显式指定白名单（覆盖脚本声明）
- `httpFilter: (url) => boolean` —— 自定义判定，优先于 origin 白名单
- `allowAllHttp: true` —— 全部放行（仅调试用）

被拦截的请求会以错误回调返回脚本（`✋` 日志标记），脚本按请求失败自行处理。

## 环境变量（经 lx-source.js 封装）

- `LX_SOURCE_SCRIPT_PATH` —— 脚本文件路径（默认项目根目录 `lx-music-source-v5.js`）
- `LX_SOURCE_LOG=0` —— 关闭日志
- `LX_SOURCE_ALLOW_ALL_HTTP=1` —— 放行全部 HTTP（调试用）

## 已知边界

- `lx.request` 回调的 resp 不含 `raw`/`bytes`（Buffer 无法跨隔离边界，实测脚本未使用）
- `formData` 选项不支持（底层 httpFetch 不支持 multipart）
- `updateAlert` 事件仅记日志，不弹窗
