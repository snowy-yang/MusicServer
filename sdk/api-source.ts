// 接口选择层：按 apiSource 配置把请求路由到外部聚合音源或服务器内置直连接口
import apiSourceInfo from './api-source-info.ts'
// 接口模式开关（替代原 lx-music 渲染进程 store 的服务器端替身）：
// 默认 internal 使用内置直连接口；设置 SOURCE_ENABLED（任意非 0/false 值）启用外部聚合音源
const enabled = process.env.SOURCE_ENABLED

export const apiSource = {
  value: enabled && enabled !== '0' && enabled !== 'false' ? 'source' : 'internal',
}

export const userApi = {
  apis: {},
}
import internalApi from './apis/index.ts'
import { createApi as createSourceApi } from './apis/source.ts'

interface SourceApi {
  getMusicUrl(songInfo: any, type: string): { promise: Promise<any>; cancelHttp(): void }
  [key: string]: any
}

const allApi: Record<string, SourceApi> = {
  source_kw: createSourceApi('kw'),
  source_kg: createSourceApi('kg'),
  source_tx: createSourceApi('tx'),
  source_wy: createSourceApi('wy'),
}

const apiList: Record<string, SourceApi | undefined> = {}
const supportQuality: Record<string, any> = {}

for (const api of apiSourceInfo) {
  supportQuality[api.id] = api.supportQualitys
  for (const source of Object.keys(api.supportQualitys)) {
    apiList[`${api.id}_api_${source}`] = allApi[`${api.id}_${source}`]
  }
}

const getAPI = (source: string): SourceApi | undefined => apiList[`${apiSource.value}_api_${source}`]

export const apis = (source: string): SourceApi => {
  if (/^user_api/.test(apiSource.value)) return userApi.apis[source]
  // 服务器内置直连接口
  if (apiSource.value == 'internal') {
    const api = internalApi[source]
    if (api) return api
    throw new Error('Api is not found')
  }
  const api = getAPI(source)
  if (api) return api
  throw new Error('Api is not found')
}

export { supportQuality }
