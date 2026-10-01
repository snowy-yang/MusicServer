// 外部聚合音源统一入口（服务端持有：SDK 只含官方平台接口，取流是否重定向到外部由 server 决策）
// 两种脚本接入方式，放在 sources/ 目录按文件名混排成候选链（顺序即优先级）：
//   1. 社区音源脚本（.js）：委托 source-ivm.ts 在硬隔离沙箱中执行（首次调用才加载初始化）。
//      也可用环境变量 SOURCE_SCRIPT_PATH 指定目录外单脚本（此时跳过 .js 扫描，.mjs 仍参与）
//   2. 简单 API 脚本（.mjs）：source-simple.ts 进程内直接 import，无沙箱，
//      只需导出 getMusicUrl —— 契约见 source-simple.ts 头注释
// 多候选时启用失败切换与降权：取流失败自动切换下一个候选重试（实例懒创建，
// 首次被用到才加载）；某候选的平台连续失败达 FAIL_LIMIT 次进入冷却
// ——选候选时沉到末尾，冷却期满自动恢复探测，成功一次即清零计数。
// 统一接口约定：source.kw.getMusicUrl(songInfo, type) → { promise, cancelHttp }，resolve → { type, url }

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIvmSource } from './source-ivm.ts'
import { createSimpleSource } from './source-simple.ts'

export const SOURCES = ['kw', 'kg', 'tx', 'wy']

const SOURCES_DIR = fileURLToPath(new URL('../sources/', import.meta.url))

// 连续失败阈值与降权冷却时长（毫秒）
const FAIL_LIMIT = 3
const COOLDOWN_MS = 5 * 60_000

interface SourceSlot {
  path: string
  name: string // 文件名，日志与健康度记录的标识
  kind: 'ivm' | 'simple' // .js → 社区脚本（沙箱）；.mjs → 简单 API（进程内直载）
  instance: Promise<any> | null
}

const resolveSlots = (): SourceSlot[] => {
  const make = (p: string, kind: SourceSlot['kind']): SourceSlot => ({ path: p, name: path.basename(p), kind, instance: null })
  const custom = process.env.SOURCE_SCRIPT_PATH
  const hasDir = fs.existsSync(SOURCES_DIR)
  if (!custom && !hasDir) {
    throw new Error(`音源目录不存在: ${SOURCES_DIR}（将脚本放入 sources/ 目录，或用 SOURCE_SCRIPT_PATH 指定）`)
  }
  const slots: SourceSlot[] = []
  if (custom) slots.push(make(custom, 'ivm'))
  // 指定 SOURCE_SCRIPT_PATH 时跳过 .js 扫描（保持单脚本语义），.mjs 简单脚本仍参与候选链
  if (hasDir) {
    for (const f of fs.readdirSync(SOURCES_DIR).sort()) {
      const lower = f.toLowerCase()
      if (lower.endsWith('.mjs') || (!custom && lower.endsWith('.js'))) {
        slots.push(make(path.join(SOURCES_DIR, f), lower.endsWith('.mjs') ? 'simple' : 'ivm'))
      }
    }
  }
  if (!slots.length) {
    throw new Error('sources/ 目录下没有音源脚本（.js = 社区脚本 / .mjs = 简单 API 脚本，或用 SOURCE_SCRIPT_PATH 指定）')
  }
  return slots
}

// 懒解析候选脚本（保持"首次取流才碰磁盘"的原语义，目录缺失不阻塞启动）
let slots: SourceSlot[] | null = null
const getSlots = (): SourceSlot[] => {
  if (!slots) {
    slots = resolveSlots()
    if (slots.length > 1) {
      console.log(`[source] ${slots.length} 个音源脚本进入候选链（顺序即优先级，失败自动切换）: ${slots.map(s => s.name).join(' → ')}`)
    }
  }
  return slots
}

// 健康度按「脚本 × 平台」计：某平台取流失败只降权该组合，不影响同一脚本的其他平台。
// 仅多脚本时启用——单脚本无处可切，行为与原来一致。
const failCounts = new Map<string, number>()
const cooldownUntil = new Map<string, number>()

const healthKey = (slot: SourceSlot, source: string) => `${slot.name}:${source}`

const markFail = (slot: SourceSlot, source: string) => {
  if (getSlots().length < 2) return
  const key = healthKey(slot, source)
  const count = (failCounts.get(key) ?? 0) + 1
  failCounts.set(key, count)
  if (count >= FAIL_LIMIT) {
    cooldownUntil.set(key, Date.now() + COOLDOWN_MS)
    console.log(`[source] ${slot.name} 的 ${source} 连续失败 ${count} 次，降权 ${COOLDOWN_MS / 1000}s（候选末尾）`)
  }
}

const markOk = (slot: SourceSlot, source: string) => {
  if (getSlots().length < 2) return
  const key = healthKey(slot, source)
  failCounts.delete(key)
  if (cooldownUntil.delete(key)) console.log(`[source] ${slot.name} 的 ${source} 恢复正常`)
}

const isDemoted = (slot: SourceSlot, source: string) =>
  (cooldownUntil.get(healthKey(slot, source)) ?? 0) > Date.now()

// 候选顺序：该平台处于降权冷却期的脚本沉到末尾，其余保持文件名序
const rankedSlots = (source: string): SourceSlot[] => {
  const list = getSlots()
  return list.length < 2
    ? list
    : [...list].sort((a, b) => Number(isDemoted(a, source)) - Number(isDemoted(b, source)))
}

const getInstance = (slot: SourceSlot): Promise<any> => {
  if (!slot.instance) {
    const load = slot.kind === 'simple'
      ? createSimpleSource({ scriptPath: slot.path })
      : createIvmSource({
          scriptPath: slot.path,
          log: process.env.SOURCE_LOG !== '0',
          allowAllHttp: process.env.SOURCE_ALLOW_ALL_HTTP === '1',
        })
    // 配置可经环境变量调整，与项目其它适配器保持一致风格
    slot.instance = load.catch(err => {
      slot.instance = null // 失败允许下次重试
      throw err
    })
  }
  return slot.instance
}

const apiFor = (source) => ({
  getMusicUrl(songInfo, type) {
    const requestObj = { cancelHttp() {}, promise: null as any }
    let inner: any = null
    requestObj.cancelHttp = () => inner?.cancelHttp()
    requestObj.promise = (async () => {
      const candidates = rankedSlots(source)
      let lastErr: any = null
      for (const slot of candidates) {
        try {
          const api = await getInstance(slot)
          if (!api[source]) throw new Error(`脚本不支持的平台: ${source}`)
          const req = api[source].getMusicUrl(songInfo, type)
          inner = req // cancelHttp 始终取消当前在飞的尝试
          const result = await req.promise
          markOk(slot, source)
          return result
        } catch (err) {
          markFail(slot, source)
          lastErr = err
          if (candidates.length > 1) {
            console.log(`[source] ${slot.name} 取流失败（${source}）: ${(err as any)?.message}，切换下一候选脚本`)
          }
        }
      }
      throw lastErr ?? new Error('没有可用的音源脚本')
    })()
    return requestObj
  },
})

// 单平台接入（server.ts 使用默认导出 sourceApi；createApi 供测试直接构造候选链）
export const createApi = apiFor

const sourceApi: Record<string, any> = {}
for (const s of SOURCES) sourceApi[s] = apiFor(s)

// 预热：提前触发首个候选脚本的加载与初始化（可选调用）
sourceApi.init = () => getInstance(getSlots()[0])

export default sourceApi
