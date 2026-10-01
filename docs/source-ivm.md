# 外部聚合音源 —— isolated-vm 加载器

## 架构

```
调用方 ── source.kw.getMusicUrl(songInfo, type) ──▶ src/source.ts（懒加载候选链）
                                                      │
                                                      ▼
                                            src/source-ivm.ts
                                            isolated-vm 硬隔离沙箱
                                            ┌──────────────────────────┐
                                            │ 音源脚本（升版即换文件）      │
                                            │  ↕ 仅经显式桥接通道          │
                                            └──────────────────────────┘
                                             http(白名单) crypto zlib 定时器 console
```

- 接口契约与其它平台适配器一致：`getMusicUrl(songInfo, type) → { promise, cancelHttp }`，resolve → `{ type, url }`
- 脚本来源：默认自动读取 `sources/` 目录下按文件名排序的第一个 `.js`；也可用 `SOURCE_SCRIPT_PATH` 显式指定
- 脚本升版：替换 `sources/` 目录下的脚本文件即可，无需改代码
- 脚本文件含第三方混淆内容，不入库（`.gitignore` 已排除 `sources/`）

## 安全模型

| 面 | 措施 |
|---|---|
| 进程 | isolate 无 process/require/fs，内存上限 256MB（可调） |
| HTTP | **默认阻止**；白名单取脚本头部 `SERVER_SCRIPT_CONFIG.apiUrl` 同源，可覆盖 |
| 密钥 | crypto 桥接日志只记操作与长度，不落密钥内容 |
| 观测 | 每个音源 API 调用（on/send/request/utils/dispatch）均有日志，请求含耗时与状态码 |

HTTP 白名单选项（`createIvmSource`）：

- `allowedOrigins: string[]` —— 显式指定白名单（覆盖脚本声明）
- `httpFilter: (url) => boolean` —— 自定义判定，优先于 origin 白名单
- `allowAllHttp: true` —— 全部放行（仅调试用）

被拦截的请求会以错误回调返回脚本（`✋` 日志标记），脚本按请求失败自行处理。

## 启用方式

设置环境变量 `SOURCE_ENABLED`（任意非 `0`/`false` 值）后启动服务器，取流请求即走音源；
不设置或为空则使用内置直连接口。歌词、封面、榜单等其余能力始终走内置实现。

## 环境变量（经 source.js 封装）

- `SOURCE_ENABLED=1` —— 启用音源（见上）
- `SOURCE_SCRIPT_PATH` —— 脚本文件路径（缺省扫描 `sources/` 目录）
- `SOURCE_LOG=0` —— 关闭日志
- `SOURCE_ALLOW_ALL_HTTP=1` —— 放行全部 HTTP（调试用）

## 已知边界

- 音源请求回调的 resp 不含 `raw`/`bytes`（Buffer 无法跨隔离边界，实测脚本未使用）
- `formData` 选项不支持（底层 httpFetch 不支持 multipart）
- `updateAlert` 事件仅记日志，不弹窗
- 沙箱内全局对象名 `lx` 为第三方脚本依赖的 API 契约名，不可改名（见 `source-ivm.js` GLUE 注释）
