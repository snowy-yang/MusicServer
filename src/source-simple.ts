// 简单 API 音源脚本加载器（.mjs，进程内直接 import，无沙箱）
//
// 社区音源脚本之外的第二种脚本接入：不要求 preload API 契约（lx.on / lx.request / crypto 桥接…），
// 脚本就是普通 Node ES 模块，export 一个 getMusicUrl 即可，适合自己写的取流脚本。
// 注意：与社区脚本（多为第三方混淆产物）不同，它运行在服务器进程内（无隔离），
// 只放自己审计过的脚本；不可信脚本仍用 .js 走 source-ivm.ts 硬隔离。
//
// 脚本约定（sources/ 目录下的 .mjs 文件，与社区 .js 脚本并存，文件名混排即候选优先级）：
//   export const sources = ['kw', 'kg', 'tx', 'wy']  // 可选，默认四平台
//   export const timeout = 15000                     // 可选，单次取流超时 ms（默认 15000）
//   export async function getMusicUrl({ source, id, songInfo, quality, signal }) {
//     // source: 平台 id；id: 歌曲 id（songmid/hash 归一）；songInfo: 原始歌曲信息对象
//     // quality: 音质（128k/320k/flac/flac24bit）
//     // signal: 取消/超时信号（AbortSignal），fetch(url, { signal }) 透传即可支持取消
//     return 'https://…'   // 播放地址字符串，或 { type, url }
//   }
// 加载失败 / 单次取流抛错 / 超时都只算该候选失败，由 source.ts 候选链切换下一候选，
// 不影响服务器其它请求。

import { pathToFileURL } from 'node:url'

// 默认支持的平台，与 source.ts 的 SOURCES 一致（避免循环引用不互相 import）
const DEFAULT_SOURCES = ['kw', 'kg', 'tx', 'wy']
const DEFAULT_TIMEOUT = 15000

/**
 * 加载简单 API 音源脚本
 * @param {object} [options]
 * @param {string} options.scriptPath 脚本路径（必填，sources/ 扫描逻辑见 source.ts）
 * @returns { apis: Record<source, { getMusicUrl(songInfo, type) → { promise, cancelHttp } }> }
 */
export const createSimpleSource = async({ scriptPath }: Record<string, any> = {}) => {
  if (!scriptPath) throw new Error('缺少脚本路径 scriptPath')
  const mod: any = await import(pathToFileURL(scriptPath).href)
  if (typeof mod.getMusicUrl !== 'function') {
    throw new Error(`简单 API 脚本未导出 getMusicUrl 函数: ${scriptPath}`)
  }
  const sources = Array.isArray(mod.sources) && mod.sources.length ? mod.sources.map(String) : DEFAULT_SOURCES
  const timeoutMs = Number(mod.timeout) > 0 ? Number(mod.timeout) : DEFAULT_TIMEOUT
  console.log(`[source-simple] 已加载 ${scriptPath}（平台: ${sources.join(', ')}）`)

  const getMusicUrlFor = (source: string) => (songInfo: any, type: string) => {
    const requestObj = { cancelHttp() {}, promise: null as any }
    const controller = new AbortController()
    requestObj.cancelHttp = () => controller.abort(new Error('请求已取消'))
    const id = songInfo?.hash || songInfo?.songmid || songInfo?.copyrightId || ''
    const startedAt = Date.now()
    console.log(`[source-simple] ▶ ${source}/${type} id=${id}`)
    const work = Promise.resolve(mod.getMusicUrl({
      source,
      id,
      songInfo,
      quality: type,
      signal: controller.signal,
    }))
    // 超时后放弃等待，脚本仍可能在后台失败：提前挂上 catch 避免 unhandledRejection
    work.catch(() => {})
    requestObj.promise = (async() => {
      let timer: any
      try {
        const result: any = await Promise.race([
          work,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort(new Error('timeout'))
              reject(new Error(`脚本取流超时 (${timeoutMs}ms)`))
            }, timeoutMs)
          }),
        ])
        const url = typeof result === 'string' ? result : result?.url
        if (!url) throw new Error('脚本未返回播放地址')
        console.log(`[source-simple] ✔ ${source}/${type} 完成（${Date.now() - startedAt}ms）`)
        return { type, url }
      } catch (err: any) {
        console.log(`[source-simple] ✖ ${source}/${type} 失败（${Date.now() - startedAt}ms）${err?.message || ''}`)
        throw err
      } finally {
        clearTimeout(timer)
      }
    })()
    return requestObj
  }

  const apis: Record<string, any> = {}
  for (const s of sources) apis[s] = { getMusicUrl: getMusicUrlFor(s) }

  // Record 索引签名：分平台接口同时平铺到顶层（与 source-ivm.ts 返回形状一致）
  const handle: Record<string, any> = {
    env: 'simple',
    sources,
    apis,
    destroy: () => Promise.resolve(),
  }
  return Object.assign(handle, apis)
}

export default { createSimpleSource }
