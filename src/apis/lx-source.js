// lx 聚合源统一入口（isolated-vm 懒加载封装）
// 内部委托 lx-source-ivm.js 在硬隔离沙箱中执行原始脚本（签名方案已放弃：v5 的
// to/si 为脚本内部哈希、服务端独立校验，直连复刻不可行，详见 docs/lx-source-ivm.md）。
// 首次调用 getMusicUrl 时才加载并初始化隔离环境，后续复用同一实例。
// 统一接口约定：lx.kw.getMusicUrl(songInfo, type) → { promise, cancelHttp }，resolve → { type, url }

import { createIvmLxSource } from './lx-source-ivm.js'

export const SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg']

let sharedPromise = null

const getShared = () => {
  if (!sharedPromise) {
    // 配置可经环境变量调整，与项目其它适配器保持一致风格
    sharedPromise = createIvmLxSource({
      scriptPath: process.env.LX_SOURCE_SCRIPT_PATH || undefined,
      log: process.env.LX_SOURCE_LOG !== '0',
      allowAllHttp: process.env.LX_SOURCE_ALLOW_ALL_HTTP === '1',
    }).catch(err => {
      sharedPromise = null // 失败允许下次重试
      throw err
    })
  }
  return sharedPromise
}

const apiFor = (source) => ({
  getMusicUrl(songInfo, type) {
    const requestObj = { cancelHttp() {}, promise: null }
    let inner = null
    requestObj.cancelHttp = () => inner?.cancelHttp()
    requestObj.promise = (async () => {
      const lx = await getShared()
      if (!lx[source]) throw new Error(`脚本不支持的平台: ${source}`)
      inner = lx[source].getMusicUrl(songInfo, type)
      return inner.promise
    })()
    return requestObj
  },
})

// 兼容导出：musicSdk/api-source.js 以 createApi(source) 方式接入 v5_* 聚合源
export const createApi = apiFor

const lxSource = {}
for (const s of SOURCES) lxSource[s] = apiFor(s)

// 预热：提前触发脚本加载与初始化（可选调用）
lxSource.init = getShared

export default lxSource
