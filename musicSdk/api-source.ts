// 接口选择层：按 apiSource 配置把请求路由到 v5 聚合源或服务器内置直连接口
import apiSourceInfo from './api-source-info.ts'
import { apiSource, userApi } from '../src/renderer/store.js'
import internalApi from '../src/apis/index.js'
import { createApi as createLxSourceApi } from '../src/apis/lx-source.js'

interface SourceApi {
  getMusicUrl(songInfo: any, type: string): { promise: Promise<any>; cancelHttp(): void }
  [key: string]: any
}

const allApi: Record<string, SourceApi> = {
  v5_kw: createLxSourceApi('kw'),
  v5_kg: createLxSourceApi('kg'),
  v5_tx: createLxSourceApi('tx'),
  v5_wy: createLxSourceApi('wy'),
  v5_mg: createLxSourceApi('mg'),
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
