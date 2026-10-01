# 外部音源 —— 简单 API 脚本（.mjs）

社区音源脚本之外的第二种脚本接入：脚本就是普通 Node ES 模块，**只需导出一个 `getMusicUrl` 函数**，无需 preload API 契约（`lx.on` / `lx.request` / crypto 桥接…）。适合自己写的取流脚本。

## 两种脚本对比

| | 社区音源脚本（`.js`） | 简单 API 脚本（`.mjs`） |
|---|---|---|
| 加载器 | `source-ivm.ts`，isolated-vm 硬隔离沙箱 | `source-simple.ts`，进程内直接 `import` |
| 脚本契约 | `lx.on('request')` + `lx.send('inited')` 全套 preload API | 一个 `getMusicUrl` 函数 |
| 能力 | 沙箱内桥接的 http/crypto/zlib | Node 全部能力（fetch / import 任意包） |
| 适用 | 来源不明的第三方混淆脚本 | 自己写、自己审计过的脚本 |

两种脚本都放 `sources/` 目录（不入库），按**文件名混排**成候选链（顺序即优先级），失败自动切换下一个。

## 脚本契约

```js
// sources/99-my-api.mjs
export const sources = ['kw', 'kg', 'tx', 'wy'] // 可选，默认 kw/kg/tx/wy 四平台
export const timeout = 15000                    // 可选，单次取流超时 ms（默认 15000）

export async function getMusicUrl({ source, id, songInfo, quality, signal }) {
  // ...你的取流逻辑
  return 'https://…'   // 播放地址字符串，或 { type, url }
}
```

`getMusicUrl` 参数：

| 参数 | 说明 |
|---|---|
| `source` | 平台 id：`kw` / `kg` / `tx` / `wy`（或脚本自己声明的） |
| `id` | 歌曲 id（已归一：`songmid` / `hash` / `copyrightId` 取第一个非空值） |
| `songInfo` | 原始歌曲信息对象（含 songmid/hash 等原始字段） |
| `quality` | 音质：`128k` / `320k` / `flac` / `flac24bit` |
| `signal` | 取消/超时信号（`AbortSignal`）——调用方取消或超时都会触发；`fetch(url, { signal })` 透传即可支持取消 |

返回值：

- **字符串**：播放地址（最简单）
- **`{ type, url }`**：对象（type 为实际音质，用于音质回退标注）

抛错即本次取流失败，由候选链切换下一候选，不影响服务器。

## 示例

### 最小示例

```js
// sources/99-demo.mjs
export async function getMusicUrl({ source, id, quality }) {
  return `https://your-api.example/get?source=${source}&id=${id}&quality=${quality}`
}
```

### 调用 JSON API 并透传取消信号

```js
// sources/98-my-api.mjs
const API = 'https://your-api.example'

export async function getMusicUrl({ source, id, quality, signal }) {
  const res = await fetch(`${API}/url?source=${source}&id=${id}&quality=${quality}`, { signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const { code, msg, data } = await res.json()
  if (code !== 0) throw new Error(msg || `code=${code}`)
  return data.url
}
```

### 按平台区分逻辑

```js
// sources/97-multi.mjs
export const sources = ['kw', 'kg'] // 只接入 kw/kg，其余平台走候选链中的其它脚本

export async function getMusicUrl({ source, id, quality }) {
  if (source === 'kw') return kwLogic(id, quality)
  return kgLogic(id, quality)
}
```

## 候选链行为

- 顺序 = 文件名排序（`.js` 与 `.mjs` 混排），如 `01-api.js` 优先于 `99-my-api.mjs`
- 某脚本的平台连续失败 **3 次** → 该脚本在该平台降权冷却 **5 分钟**（沉到候选末尾，恢复后自动探测）
- 单脚本无处可切时不做降权，行为与直连失败一致（路由 502）
- `SOURCE_SCRIPT_PATH` 指定单个社区脚本（`.js`）时跳过目录扫描，但 `.mjs` 仍参与候选链

## 启用方式与调试

- 环境变量 `SOURCE_ENABLED=1`（任意非 `0`/`false` 值）启用外部音源；不设置则走内置直连。音源模式下登录态不参与取流，登录自动续期不会启动
- `pnpm dev` 热重载已监听 `sources/` 目录，改脚本保存即自动重启生效
- 日志前缀 `[source-simple]`：加载（平台列表）、每次取流（▶ 开始 / ✔ 完成 / ✖ 失败，含耗时）
- 离线测试：`node test/source-simple-test.ts`（已并入 `pnpm test`）

## 边界

- **无沙箱**：脚本运行在服务器进程内，可访问 fs/process 等——只放自己审计过的代码；不可信脚本用 `.js` 走 [isolated-vm 加载器](source-ivm.md)
- 仅接入**取流**（getMusicUrl）；歌词、封面、榜单等能力始终走内置实现
- 脚本内部自起的长任务（如忽略 signal 的死循环请求）由超时兜底放弃等待，脚本侧仍可能继续在后台运行
