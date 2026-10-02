# MusicServer 全量代码检查报告

**检查时间**：2026-10-03
**修复状态**（复查后更新）：P0-1 ~ P0-3、P1-4 ~ P1-16 **全部已修复**（含测试隔离与 isolated-vm 原生构建）；
第五节「文档与代码不一致」已按 `/sources` 与路由实现逐条校准；第八节列出的未复核线索与第四节 P2 项**未动**，留待后续。
各条的修复要点见下文对应条目。
**检查范围**：`src/`（15 文件 / 3,103 行）、`sdk/`（173 文件 / 21,919 行）、`test/`（2 文件 / 1,081 行），共约 26,100 行 TypeScript

**检查方法**：
1. 静态门禁：`tsc`、`tsc --noUnusedLocals --noUnusedParameters`、离线音源测试、冒烟测试
2. 全量模式扫描：`any` 滥用、`@ts-ignore`、TODO/FIXME、调试输出、死代码、硬编码敏感值
3. 四组分区深度审查：HTTP 层 / SDK 核心（认证+取流）/ SDK 平台模块 / 测试与文档
4. 针对性复现验证：对判定为 P0 的问题编写最小复现脚本确认

---

## 一、基线状态

| 检查项 | 结果 |
| --- | --- |
| `pnpm typecheck`（tsc strict） | ✅ 通过 |
| 未使用符号（`--noUnusedLocals`） | ⚠️ 26 处 |
| 离线测试 `test/source-simple-test.ts` | ✅ 8/8 通过 |
| 冒烟测试 `test/smoke-test.ts` | ⚠️ **不稳定**：一次 110/111，一次直接崩溃（见 P1-4） |
| `@ts-ignore` / `@ts-expect-error` | ✅ 0 处（纪律良好） |
| TODO / FIXME / HACK | ✅ 0 处 |
| lint / CI 配置 | ❌ 均无（质量门禁仅 tsc + 冒烟测试） |

---

## 二、P0 阻断级

### P0-1　`POST /login/lr` 路由缺失 —— 懒人听书取流 100% 不可用

**证据链**：
- `README.md:86` 与 `README.md:105` 明确承诺：懒人听书需 `POST /login/lr` 账密登录，且「取流必须登录（免费章节同样要求登录态）」
- `sdk/lr/auth.ts:12` **已完整实现** `login()`（base64 密码 + 会话 Cookie 持久化）
- 但 `sdk/lr/index.ts:53` 只写了 `export { status } from './auth.ts'` —— **没有导出 `login`**
- `src/routes-login.ts` 注册的 28 条路由中**没有任何 lr 相关条目**（逐条列举验证）

**影响**：sdk 层实现了登录能力，却没有任何 HTTP 入口。而 lr 取流强制要求登录态 → **该平台的取流功能完全无法使用**，README 的承诺是空头支票。

**修复**：`sdk/lr/index.ts` 补导出 `login`；`src/routes-login.ts` 参照 `/login/xm` 补 `POST /login/lr`（body: `{account, password}`）与 `DELETE /login/lr`；`/login/status` 加入 `lr` 字段。

---

### P0-2　咪咕解密流异常逃逸 —— 可导致整个服务进程崩溃

**证据链**：
- `src/http/migu-stream.ts:88-92`：`res.on('data', chunk => { ...; onChunk(plain, offset) })` —— `onChunk` 在 EventEmitter 回调中**同步调用**
- `src/routes.ts:317`：该回调内部有 `throw new Error('解密结果不是有效音频')`
- 外层 `src/routes.ts:311-324` 的 `try/catch` 只能捕获 Promise 链上的 reject，**捕不到** EventEmitter 回调抛出的异常
- 全项目**没有任何** `uncaughtException` / `unhandledRejection` 处理器（grep 无匹配）

**复现验证**（`tmp/repro-migu-uncaught.mjs`，已实测）：
```
❌ uncaughtException 逃逸（进程会崩溃）: 解密结果不是有效音频
exit code 9
```

**影响**：当咪咕返回的密流与票据 `fileKey` 不匹配（解密结果非法），或客户端中途断开导致 `reply.raw.write` 抛错时，异常逃逸 → **整个 Node 进程崩溃**，所有在线用户连接同时中断。这是一个远程可触发的单点崩溃。

**修复**：`onChunk` 内不要 `throw`，改为置错误标志 + `res.destroy()` / `reply.raw.destroy()`；或让 `pipeDecryptedMiguStream` 把 `transform`/`onChunk` 的调用包进 `try/catch` 并 `reject`。另建议补一个全局 `uncaughtException` 兜底（至少记日志后优雅退出，而非静默崩溃）。

---

### P0-3　登录凭据明文落盘且权限过宽

**证据链**：
- `sdk/auth/store.ts:88`：`writeFileSync(DATA_FILE, JSON.stringify(data, null, 2))` —— 明文 JSON，且**未传 `{ mode: 0o600 }`**
- 实际文件：`data/auth.json` 权限 `-rw-r--r--`（0644），内容为各平台 cookie/token 明文
- 文件覆盖 wy / kg / tx / xm / me / lr / bili / qs 等全部平台凭据

**影响**：任何能读取该目录的本地用户或进程可直接窃取全部平台登录态（等价于账号取流权限）。Windows 上 POSIX 位不完全生效，风险取决于 ACL，但**明文存储**这一点在任意平台都成立。

**修复**：`writeFileSync(..., { mode: 0o600 })`（Windows 侧另设 ACL）；如需更高保障再考虑加密存储（密钥来自环境变量）。

---

## 三、P1 应修

### P1-4　冒烟测试异常路径不清理子实例 → 僵尸进程累积

**证据**：
- `test/smoke-test.ts:81-110` `startLocalServer()` 超时后 `proc.kill()` 再 `reject`
- 主实例之外还有两个**额外实例**：`authServer`（:835）、`rlServer`（:887）
- `:898-899` 的 `rlServer.kill()` / `authServer.kill()` 位于顶层顺序执行，**不在 try/finally 内** —— 一旦中间抛错就不会执行
- `:911-915` 顶层只清理了 `mainServer`（`localServer`），**不涉及额外实例**

**实测后果**：当前机器上有 **6 个 MusicServer 实例在监听**：`16688`（常驻）+ `16690/16691/16692/16693/16790`（测试泄漏，连续端口说明是多轮泄漏累积）。本次审查中冒烟测试崩溃后即留下新实例。

**影响**：每次测试异常就泄漏一个监听端口的 node 进程，长期累积占用内存/端口，且会干扰后续测试判定。

**修复**：用 `try/finally` 或 `process.on('exit')` 统一 kill 所有已启动实例。

---

### P1-5　冒烟测试启动超时 10s 硬编码，且失败时无任何诊断信息

**证据**：`test/smoke-test.ts:91-94`
```js
const timer = setTimeout(() => {
  proc.kill()
  reject(new Error('启动本地服务器超时'))   // ← 未附 stdout
}, 10000)
```
`stdout` 变量已收集子进程输出（:87-89），但 reject 时完全丢弃。

**影响**：本次审查中同一份代码**一次通过（110/111）、一次崩溃**，说明该超时在并发/负载下很脆弱 —— 属于典型的 flaky 测试。而失败信息只有一句「启动本地服务器超时」，无法判断是端口被占、TS 报错还是单纯慢。

**修复**：超时提到 30s；错误信息附带 `stdout` 尾部；区分「进程已退出」与「进程存活但未就绪」。

---

### P1-6　`/song-list/:source` 的 `?limit=` 被文档承诺却静默忽略

**证据**：
- `src/routes.ts:450`：querystring schema 声明了 `limit: pLimit`
- `src/routes.ts:436`：handler 签名为 `(source, page, sortId, tagId)` —— **没有 limit 参数**
- `src/routes.ts:458`：调用时也未传 `request.query.limit`

**影响**：OpenAPI 文档告诉客户端可以传 `?limit=`，实际被丢弃 —— API 契约与实现不符。

**修复**：要么把 limit 透传到 `songList.getList()`，要么从 schema 移除。

---

### P1-7　凭据文件写入非原子 + 解析失败静默清空

**证据**（`sdk/auth/store.ts`）：
- `:84-89` `save()` 直接 `writeFileSync` 覆盖原文件，无 temp+rename。写入过程中进程被杀 → 文件损坏
- `:73-82` `load()` 用 `catch { cache = {} }` 静默吞掉 JSON 解析错误；随后任何 `setCredentials()` 都会用空数据**覆盖重写**损坏文件 → **所有平台凭据一次性丢失**，且无任何日志
- 无跨进程锁：当前环境并存 6 个实例，写操作会互相覆盖

**修复**：写临时文件 + `rename()` 原子替换；解析失败时先备份原文件再重置，并打印告警。

---

### P1-8　过期/错误注释误导维护者

**证据**：`sdk/auth/store.ts:3`
```
// 注意：store.js 为 tsc 就地发射产物（不入库）；改逻辑只改本文件，然后 pnpm build
```
但：`tsconfig.json` 已是 `noEmit: true`，`package.json` **没有 `build` 脚本**，项目已全面改为「无编译产物、改完即跑」。磁盘上也确认无 `.js` 残留。

**影响**：按注释执行 `pnpm build` 会失败，且误导开发者以为存在发射产物。

**修复**：删掉该行注释。

---

### P1-9　酷狗 krc 歌词解码：Promise 永不 settle，请求挂死

**证据**：`sdk/kg/krcDecode.ts:9-10`
```js
const decodeLyric = str => new Promise((resolve, reject) => {
  if (!str.length) return          // ← 既未 resolve 也未 reject
```
`return` 只结束了执行器函数，Promise 永久停在 pending。

**影响**：上游返回空 krc 歌词时，调用方的 `await` 永久挂起 —— 连接与内存无法释放，客户端只能等自己超时。

**修复**：`if (!str.length) return resolve('')`

---

### P1-10　酷狗歌词重试调错方法

**证据**：`sdk/kg/lyric.ts:72` —— 在 `getLyricDownload(id, accessKey, fmt, tryNum)` 内部重试时调用的是
```js
let tryRequestObj = (this.getLyric as any)(id, accessKey, fmt, ++tryNum)
```
应为 `this.getLyricDownload(...)`。`getLyric` 与 `getLyricDownload` 参数语义不同，且 `as any` 恰好掩盖了这个错误。

**影响**：HTTP 非 200 时的重试实际走了另一个方法，重试逻辑失效（还会掩盖类型错误）。

**修复**：改为 `this.getLyricDownload(id, accessKey, fmt, ++tryNum)`；顺带移除 `as any`。

---

### P1-11　酷我歌单详情：重试参数错位（序号被当成页码）

**证据**：
- `sdk/kw/songList.ts:196`：`return this.getListDetail(id, ++tryNum)`
- `sdk/kw/songList.ts:373`：`getListDetail(id, page, retryNum = 0)` —— 第二个参数是 **page**

同一文件 `:175`、`:206` 都正确写成 `getListDetail(id, page, ++tryNum)`，唯独 `:196` 漏了 `page`。

**影响**：重试时请求的页码被替换成 `tryNum`（1/2/3…），而不是用户请求的页；同时重试计数没有真正传递。

**修复**：补上 `page`，与 `:206` 对齐。

---

### P1-12　酷我歌单详情 URL 模板多余 `}`

**证据**：`sdk/kw/songList.ts:203`
```
...&pid=${id}&pn=${page - 1}}&rn=${this.limit_song}&...
                              ↑ 多了一个右花括号
```

**影响**：请求 URL 携带非法字符，目前依赖上游容错；上游一旦收紧解析该接口即失效。

**修复**：删掉多余的 `}`。

---

### P1-13　冒烟测试未做环境隔离：取流用例实际走外部音源，且会改写真实凭据

**证据**：
- `test/smoke-test.ts:84` 以 `env: { ...process.env, PORT, ...envExtra }` 启动子实例 —— 完整继承当前进程环境
- `.env:1` 为 `SOURCE_ENABLED=true` → 主实例以**音源模式**启动，`/url` 用例优先走 `sources/` 脚本链
- 子实例工作目录即项目根，`data/auth.json` 是**真实凭据文件**（无测试专用路径）

**影响**：① `/url` 用例并未验证 SDK 官方直连通道，SDK 侧回归可被外部音源掩盖（**测试假通过**）；② `/login/refresh` 等用例会读写真实 `data/auth.json` —— 本地跑一次测试就可能覆盖真实登录态。

**修复**：测试显式传 `SOURCE_ENABLED: ''`；新增 `DATA_DIR` 环境变量让测试实例使用独立数据文件。

---

### P1-14　`pnpm-workspace.yaml` 使用非官方键 → isolated-vm 沙箱实际不可用

**证据**：
- `pnpm-workspace.yaml` 全文仅两行：`allowBuilds:` / `isolated-vm: true`
- `pnpm --version` = 12.4.1；放行构建脚本的字段应为 `onlyBuiltDependencies`，`allowBuilds` 不生效
- `node_modules/isolated-vm` 目录存在，但 `out/*.node` **不存在** → 原生模块从未构建
- 离线测试实测输出：`未安装 isolated-vm，无法启用隔离执行音源…切换下一候选脚本`

**影响**：`src/source-ivm.ts` 的「硬隔离沙箱」在部署时静默失效 —— 社区 `.js` 音源脚本全部被跳过，而 README 把它描述为可用的第一类音源。安全隔离能力名存实亡，且无显著告警。

**修复**：改为 `onlyBuiltDependencies: [isolated-vm]` 并确认构建产物就位；ivm 不可用时应在启动日志告警。

---

### P1-15　冒烟测试断言游离在 `test()` 之外，抛错会跳过清理

**证据**：`test/smoke-test.ts:855-858` 的「6 个路径均须 401」断言写成裸 `for` 循环置于顶层，而对应的 `await test(...)` 在 `:859`。任一路径返回非 401 即顶层抛错。

**影响**：抛错直接终止脚本，**跳过结果汇总与末尾的实例清理** —— 与 P1-4 同源，都会留下孤儿 node 进程。

**修复**：把断言包进 `test()`，或统一用 `try/finally` 收尾。

---

### P1-16　`.claude/settings.local.json` 已入库且含本机绝对路径

**证据**：`git ls-files .claude/` 返回 `.claude/settings.local.json`；内容含
`C:\Users\Administrator\.claude\projects\d--MusicServer\memory` 等本机路径。

**影响**：把本机目录结构与本地工具配置写进（README 声明为公开的）仓库，对他人无意义。

**修复**：`git rm --cached .claude/settings.local.json`，并把 `.claude/` 加入 `.gitignore`。

---

## 四、P2 可维护性与卫生

| 类别 | 证据 | 说明 |
| --- | --- | --- |
| 注释掉的死代码 | `sdk/wy/lyric.ts:49-51,240`、`sdk/kw/album.ts:242-246`、`sdk/kg/songList.ts:75-109,778`、`sdk/kw/index.ts:33-37` 等 100+ 处 | 大量整段注释代码（含被注释的 `console.log` 调试行），建议清理 |
| 裸 `console.log(err)` 吞错 | `sdk/wy/songList.ts:103`、`sdk/wy/leaderboard.ts:188`、`sdk/kw/lyric.ts:142`（还会打印完整歌词）、`sdk/kg/songList.ts:279`、`sdk/kg/util.ts:35`、`sdk/tx/utils/index.ts:39`、`sdk/utils.ts:23` | 吞掉异常且无上下文，排障困难 |
| 未使用符号 26 处 | `sdk/index.ts`(3)、`sdk/tx/leaderboard.ts`(2)、`sdk/lr/index.ts`(2)、`sdk/joox/parse.ts`(2)、`sdk/apis/migu.ts`(2) 等 | `tsc --noUnusedLocals` 可复现 |
| `.gitignore` 漏 `.workbuddy/` | `.gitignore` 内容 vs `git status` 显示 `?? .workbuddy/` | 工作记忆目录会被 `git add .` 收进仓库 |
| `tmp/` 占 297 MB / 4,992 文件 | 内含 1753 js / 720 ts / 339 py / 287 tsx / 122 vue | 已 gitignore，但混有大量与本项目无关的代码样本，建议清理磁盘 |
| 无 lint / 无 CI | `.eslintrc`/`.prettierrc`/`.github` 均不存在 | 建议引入 ESLint + 一条 CI 跑类型检查与离线测试 |

---

## 五、文档与代码不一致清单

| 文档位置 | 文档声称 | 代码实际 |
| --- | --- | --- |
| `README.md:86`、`:105` | `POST /login/lr` 存在 | **不存在**（P0-1） |
| `README.md:20`（qs 行） | 歌单 ✅、专辑 ✅ | `sdk/qs/index.ts` 无 `album`/`playlist` 方法，`/sources` 能力位也无 |
| `README.md:20` vs `:66` | 内部自相矛盾 | `:20` 给 qs 专辑打勾，`:66` 的专辑详情平台列表却**不含 qs** |
| `README.md:71` | parse 支持 `5sing/apple/bili/joox/qian/migu` | 实际还支持 **kw / kg / tx / wy**（`sdk/{kw,kg,tx,wy}/parse.ts` 存在，`/sources` 已暴露 `parse` 位） |
| `README.md:68` | 歌单分类仅 `migu/qian/joox/apple` | 实际 **kw / kg / tx / wy** 也有 `playlistCategories` 能力位 |
| `README.md` 登录接口表 | 只列了 POST 登录 | 实际还有 7 个 `DELETE /login/{wy,kg,tx,qs,xm,me,bili}` 退出端点未文档化 |
| `test/smoke-test.ts:642` | `/parse/song/kw` 期望 404 | 实际 200（kw parse 已实现）→ 导致冒烟测试唯一的失败项 |
| `sdk/auth/store.ts:3` | 改完需 `pnpm build` | 无 build 脚本，项目无编译产物（P1-8） |
| `README.md:24` | bili 音质 `64k/128k/192k` | `/sources` 实际为 `64k/128k/320k/flac/flac24bit` |
| `README.md:65` | `/album/:source/:id?page=1`（query 分页） | 分页是 path 段 `/album/{source}/{id}/{page}` |
| `README.md:29-30` | qt / lr 封面标「—」 | `/sources` 显示两者 `pic=true`（实际支持） |
| `README.md:72` | 个人歌单支持 kg/tx/wy/joox/bili/apple | 实际仅 **tx / wy** |
| `README.md:21-26` | migu/qian/joox/apple/5sing 登录列标「cookie」 | 均**没有** `/login/{migu,qian,joox,apple,5sing}` 路由（与 P0-1 同类问题） |
| `docs/API.md` | 与 README 同源的平台/接口描述 | 同样滞后（parse 支持平台、user-playlist 支持集等） |

---

## 六、环境与仓库卫生

- **6 个 MusicServer 实例在监听**：`16688`（常驻）、`16690`~`16693`、`16790`（测试泄漏，见 P1-4）。建议清理泄漏实例，`16688` 请确认是否为常用常驻服务后再决定。
- **未追踪且会入库的目录**：`signer/`、`tools/`、`.workbuddy/`、`scripts/qs-local-login.mjs` 以及大量新增的 `sdk/**` 模块（5sing/apple/bili/joox/migu/qian/kw·kg·tx·wy 的 parse/playlist 等）。
  - `signer/server.mjs` 本身实现规范（强制 `QS_SIGNER_TOKEN`、设备号脱敏、敏感头不落盘），入库无碍；
  - `tools/mssdk-sign/` 含 `.exe` 与逆向笔记（`REVERSE.md`），**是否入库请自行判断**；
  - `.workbuddy/` 建议加进 `.gitignore`。
- `.gitignore` 已正确覆盖：`node_modules/`、`sources/`、`data/`、`tmp/`、`*.log`、`soda-mssdk/`、`.env`。

---

## 七、建议修复顺序

1. **P0-1**（lr 登录）—— 一行导出 + 一个路由，成本极低，收益是解锁整个平台
2. **P0-2**（migu 崩溃）—— 改 3 行错误处理 + 加全局兜底，消除远程可触发的进程崩溃
3. **P1-4 / P1-5**（测试稳定性）—— 不修则后续每次 CI/回归都可能留下僵尸进程并产生假失败
4. **P1-8 / 第五节文档**（文档同步）—— 顺手即可，避免误导
5. **P0-3 / P1-7**（凭据存储）—— 视部署环境决定优先级
6. P1-6、P2 各项按需清理

---

## 八、附：尚未逐条复核的线索

以下来自分区审查组的摘要，**本轮未逐条复核到行号**，建议作为下一轮排查入口。

**SDK 核心组**（`sdk/index.ts`、`sdk/types.ts`、`sdk/common/request.ts`、`sdk/auth/*`、`sdk/apis/*`）：
- wy 首次登录时账号资料获取失败（cookie 时序问题）
- 请求取消语义失效；migu 候选链的多次探测请求不可取消
- qs 解密时把整段音频读入内存（未走流式）
- `Quality` 类型契约不一致：apple 实际返回 `preview`，但该值不在联合类型内
- 各平台 `cancelHttp` 实现不一致；部分平台把 token 拼进 GET query

**SDK 平台模块组**（本轮已核实 4 条，见 P1-9 ~ P1-12）其余线索：
- `sdk/migu/util.ts:375-378` 解密失败时把函数引用直接拼进异常消息
- `sdk/joox/` 单曲接口未校验上游 `errorCode`（错误探针外泄、响应未解析）
- `sdk/qian/util.ts:82` 附近三个导出函数名与 JSDoc 描述完全对调
- `sdk/bili/util.ts` 内约 6 处结构相同的 AJAX 重试代码

**跨文件重复逻辑**：kw / kg / tx / wy 的 `parse.ts` 与 `playlist.ts` 存在大段相似实现，可考虑抽出公共解析工具。

> 报告前三节的 P0 与 P1-4 ~ P1-12 均有明确代码位置与实际验证依据（其中 P0-2 附最小复现脚本）；本节线索建议复核后再动手。第四组「测试与文档」专项审查仍在进行，其领域（测试有效性、覆盖缺口、文档一致性）本报告已通过独立核对覆盖主要结论。
