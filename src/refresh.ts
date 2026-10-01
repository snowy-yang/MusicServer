// 登录态自动续期调度 —— 启动即刷一轮 + 每 24h 一次
// 各平台凭据独立处理：未登录跳过，单个平台失败不影响另一个。

import { refreshLogin as kgRefreshLogin } from '../sdk/auth/kg.ts'
import { refreshLogin as txRefreshLogin } from '../sdk/auth/tx.ts'

const INTERVAL_MS = 24 * 60 * 60 * 1000
// 启动后延迟触发，避开启动期与 smoke 测试的快速起停
const STARTUP_DELAY_MS = 10_000

let running = false
let startupTimer: NodeJS.Timeout | null = null
let intervalTimer: NodeJS.Timeout | null = null

const log = (msg: string) => console.log(`[${new Date().toISOString()}] [登录续期] ${msg}`)

/** 手动/定时共用的续期入口，返回各平台结果（skipped / refreshed / error） */
export const refreshAll = async(): Promise<Record<string, any>> => {
  if (running) return { skipped: true }
  running = true
  try {
    const result: Record<string, any> = {}
    for (const [name, fn] of [['kg', kgRefreshLogin], ['tx', txRefreshLogin]] as const) {
      try {
        const r = await fn()
        result[name] = r
        if (r.skipped) log(`${name}: 未登录，跳过`)
        else log(`${name}: 登录态已刷新`)
      } catch (err: any) {
        result[name] = { error: err.message }
        log(`${name}: ${err.message}`)
      }
    }
    return result
  } finally {
    running = false
  }
}

/** 注册定时任务（须在 fastify.listen 之前调用以便挂 onClose 钩子） */
export const startRefreshScheduler = (fastify) => {
  fastify.addHook('onClose', () => {
    if (startupTimer) clearTimeout(startupTimer)
    if (intervalTimer) clearInterval(intervalTimer)
  })
  startupTimer = setTimeout(() => {
    void refreshAll()
    intervalTimer = setInterval(() => void refreshAll(), INTERVAL_MS)
    intervalTimer.unref()
  }, STARTUP_DELAY_MS)
  startupTimer.unref()
  log(`已启动自动续期（启动后 ${STARTUP_DELAY_MS / 1000}s 首刷，此后每 ${INTERVAL_MS / 3600000}h 一次）`)
}
