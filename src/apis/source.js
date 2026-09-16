// 外部聚合音源统一入口（isolated-vm 懒加载封装）
// 内部委托 source-ivm.js 在硬隔离沙箱中执行音源脚本。
// 首次调用 getMusicUrl 时才加载并初始化隔离环境，后续复用同一实例。
// 统一接口约定：source.kw.getMusicUrl(songInfo, type) → { promise, cancelHttp }，resolve → { type, url }
//
// 脚本来源（优先级）：
//   1. 环境变量 SOURCE_SCRIPT_PATH 指定的脚本文件
//   2. sources/ 目录下按文件名排序的第一个 .js（脚本文件不入库，见 .gitignore）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createIvmSource } from './source-ivm.js'

export const SOURCES = ['kw', 'kg', 'tx', 'wy', 'mg']

const SOURCES_DIR = fileURLToPath(new URL('../../sources/', import.meta.url))

const resolveScriptPath = () => {
  const custom = process.env.SOURCE_SCRIPT_PATH
  if (custom) return custom
  if (!fs.existsSync(SOURCES_DIR)) {
    throw new Error(`音源目录不存在: ${SOURCES_DIR}（将脚本放入 sources/ 目录，或用 SOURCE_SCRIPT_PATH 指定）`)
  }
  const files = fs.readdirSync(SOURCES_DIR).filter(f => f.toLowerCase().endsWith('.js')).sort()
  if (!files.length) {
    throw new Error('sources/ 目录下没有 .js 音源脚本（将脚本放入该目录，或用 SOURCE_SCRIPT_PATH 指定）')
  }
  if (files.length > 1) {
    console.log(`[source] sources/ 下有 ${files.length} 个脚本，使用 ${files[0]}（可用 SOURCE_SCRIPT_PATH 指定）`)
  }
  return path.join(SOURCES_DIR, files[0])
}

let sharedPromise = null

const getShared = () => {
  if (!sharedPromise) {
    // 配置可经环境变量调整，与项目其它适配器保持一致风格
    sharedPromise = createIvmSource({
      scriptPath: resolveScriptPath(),
      log: process.env.SOURCE_LOG !== '0',
      allowAllHttp: process.env.SOURCE_ALLOW_ALL_HTTP === '1',
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
      const api = await getShared()
      if (!api[source]) throw new Error(`脚本不支持的平台: ${source}`)
      inner = api[source].getMusicUrl(songInfo, type)
      return inner.promise
    })()
    return requestObj
  },
})

// 兼容导出：musicSdk/api-source.js 以 createApi(source) 方式接入聚合音源
export const createApi = apiFor

const sourceApi = {}
for (const s of SOURCES) sourceApi[s] = apiFor(s)

// 预热：提前触发脚本加载与初始化（可选调用）
sourceApi.init = getShared

export default sourceApi
